import type {
  EventLogSynced,
  SessionCompactionDelta,
  SessionInboxInfo,
  SessionInboxItem,
  SessionMessageInfo,
  SessionReasoningDelta,
  SessionTextDelta,
  SessionToolInputDelta,
  SessionToolProgress,
  SessionUsageUpdated,
} from "../../promise"
import { SessionFold } from "./fold"
import type { DurableSessionEvent, SessionFoldState, SessionSnapshot } from "./fold"

export type EphemeralSessionEvent =
  | SessionTextDelta
  | SessionReasoningDelta
  | SessionToolInputDelta
  | SessionToolProgress
  | SessionCompactionDelta
  | SessionUsageUpdated

export type SessionStreamItem = DurableSessionEvent | EphemeralSessionEvent | EventLogSynced

export type Intent = {
  readonly id: string
  readonly sessionID: string
  readonly item: Extract<SessionInboxItem, { readonly type: "user" | "synthetic" }>
  readonly created: number
}

export type SubmitInput = {
  readonly id: string
  readonly sessionID: string
  readonly item: Intent["item"]
}

export type IntentFailure = {
  readonly intent: Intent
  readonly reason: string
}

export class SubmitRejected extends Error {
  readonly _tag = "SubmitRejected"

  constructor(readonly reason: string) {
    super(reason)
  }
}

export class SeqUnavailable extends Error {
  readonly _tag = "SeqUnavailable"
}

export interface SessionTransport {
  readonly snapshot: (sessionID: string) => Promise<SessionSnapshot>
  readonly stream: (sessionID: string, after: number) => AsyncIterable<SessionStreamItem>
  readonly submit: (input: SubmitInput) => Promise<void>
}

export type SessionView = SessionFoldState & {
  readonly pending: ReadonlyArray<SessionInboxInfo>
}

export interface SessionEngine {
  readonly sessionID: string
  readonly view: () => SessionView
  readonly submit: (input: {
    readonly text: string
    readonly files?: Extract<Intent["item"], { readonly type: "user" }>["payload"]["files"]
    readonly agents?: Extract<Intent["item"], { readonly type: "user" }>["payload"]["agents"]
    readonly skills?: Extract<Intent["item"], { readonly type: "user" }>["payload"]["skills"]
    readonly metadata?: Extract<Intent["item"], { readonly type: "user" }>["payload"]["metadata"]
    readonly delivery?: Intent["item"]["delivery"]
    readonly id?: string
  }) => Intent
  readonly subscribe: (listener: (view: SessionView) => void) => () => void
  readonly subscribeFailures: (listener: (failure: IntentFailure) => void) => () => void
  readonly settled: () => Promise<void>
  readonly stop: () => void
}

export type SessionEngineOptions = {
  readonly makeID?: () => string
  readonly now?: () => number
  readonly reconnect?: () => Promise<void>
}

type Overlay = ReadonlyMap<string, OverlayEntry>

type OverlayEntry =
  | { readonly type: "text"; readonly messageID: string; readonly ordinal: number; readonly value: string }
  | { readonly type: "reasoning"; readonly messageID: string; readonly ordinal: number; readonly value: string }
  | { readonly type: "tool-input"; readonly messageID: string; readonly toolID: string; readonly value: string }
  | {
      readonly type: "tool-progress"
      readonly messageID: string
      readonly toolID: string
      readonly metadata: SessionToolProgress["data"]["metadata"]
    }
  | { readonly type: "compaction"; readonly value: string }
  | { readonly type: "usage"; readonly value: SessionUsageUpdated["data"] }

type EngineState = {
  readonly folded: SessionFoldState
  readonly outbox: ReadonlyArray<Intent>
  readonly overlay: Overlay
  readonly synced: boolean
}

export async function createSessionEngine(
  sessionID: string,
  transport: SessionTransport,
  options: SessionEngineOptions = {},
): Promise<SessionEngine> {
  let counter = 0
  const makeID = options.makeID ?? (() => `msg_${Date.now().toString(36)}_${++counter}`)
  const now = options.now ?? Date.now
  const reconnect = options.reconnect ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
  let state: EngineState = {
    folded: SessionFold.fromSnapshot(await transport.snapshot(sessionID)),
    outbox: [],
    overlay: new Map(),
    synced: false,
  }
  const listeners = new Set<(view: SessionView) => void>()
  const failureListeners = new Set<(failure: IntentFailure) => void>()
  const settled = new Set<() => void>()
  const sent = new Set<string>()
  let stopped = false
  let sending = false

  const publish = (next: EngineState) => {
    state = next
    const view = render(state)
    listeners.forEach((listener) => listener(view))
    if (state.outbox.length > 0) return
    settled.forEach((resolve) => resolve())
    settled.clear()
  }

  const applySnapshot = (snapshot: SessionSnapshot) => {
    const folded = SessionFold.fromSnapshot(snapshot)
    const acknowledged = new Set([
      ...folded.messages.map((message) => message.id),
      ...folded.inbox.map((item) => item.id),
    ])
    publish({
      folded,
      outbox: state.outbox.filter((intent) => !acknowledged.has(intent.id)),
      overlay: new Map(),
      synced: false,
    })
  }

  const applyDurable = (event: DurableSessionEvent) => {
    if (event.type === "session.inbox.enqueued") sent.delete(event.data.inboxID)
    publish({
      folded: SessionFold.apply(state.folded, event),
      outbox:
        event.type === "session.inbox.enqueued"
          ? state.outbox.filter((intent) => intent.id !== event.data.inboxID)
          : state.outbox,
      overlay: clearOverlay(state.overlay, event),
      synced: state.synced,
    })
    send()
  }

  const reject = (intent: Intent, reason: string) => {
    publish({ ...state, outbox: state.outbox.filter((item) => item.id !== intent.id) })
    failureListeners.forEach((listener) => listener({ intent, reason }))
  }

  const send = () => {
    if (!state.synced || sending || stopped) return
    const intent = state.outbox[0]
    if (!intent || sent.has(intent.id)) return
    sending = true
    sent.add(intent.id)
    void (async () => {
      try {
        await transport.submit({ id: intent.id, sessionID, item: intent.item })
      } catch (error) {
        if (!(error instanceof SubmitRejected)) return
        sent.delete(intent.id)
        reject(intent, error.reason)
      }
    })().finally(() => {
      sending = false
      send()
    })
  }

  const sync = async () => {
    while (!stopped) {
      try {
        for await (const item of transport.stream(sessionID, state.folded.seq)) {
          if (stopped) return
          if (item.type === "log.synced") {
            sent.clear()
            publish({ ...state, synced: true })
            send()
            continue
          }
          if ("durable" in item) {
            applyDurable(item)
            continue
          }
          publish({ ...state, overlay: applyOverlay(state.overlay, item) })
        }
      } catch (error) {
        if (error instanceof SeqUnavailable) {
          try {
            applySnapshot(await transport.snapshot(sessionID))
          } catch {
            await reconnect()
          }
          continue
        }
      }
      if (stopped) return
      publish({ ...state, synced: false })
      await reconnect()
    }
  }

  void sync()

  return {
    sessionID,
    view: () => render(state),
    submit(input) {
      const intent: Intent = {
        id: input.id ?? makeID(),
        sessionID,
        created: now(),
        item: {
          type: "user",
          delivery: input.delivery ?? "steer",
          payload: {
            text: input.text,
            files: input.files,
            agents: input.agents,
            skills: input.skills,
            metadata: input.metadata,
          },
        },
      }
      publish({ ...state, outbox: [...state.outbox, intent] })
      send()
      return intent
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeFailures(listener) {
      failureListeners.add(listener)
      return () => failureListeners.delete(listener)
    },
    settled() {
      if (state.outbox.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => settled.add(resolve))
    },
    stop() {
      stopped = true
      publish({ ...state, synced: false })
    },
  }
}

export function render(state: Pick<EngineState, "folded" | "outbox" | "overlay">): SessionView {
  const pending = [
    ...state.folded.inbox,
    ...state.outbox.map(
      (intent): SessionInboxInfo => ({
        id: intent.id,
        sessionID: intent.sessionID,
        timeCreated: intent.created,
        ...intent.item,
      }),
    ),
  ]
  const messages = applyOverlayToMessages(
    [
      ...state.folded.messages,
      ...pending.flatMap((item): ReadonlyArray<SessionMessageInfo> => {
        if (state.folded.messages.some((message) => message.id === item.id)) return []
        if (item.type === "user")
          return [{ id: item.id, type: "user", ...item.payload, time: { created: item.timeCreated } }]
        if (item.type === "synthetic")
          return [{ id: item.id, type: "synthetic", ...item.payload, time: { created: item.timeCreated } }]
        return []
      }),
    ],
    state.overlay,
  )
  const usage = state.overlay.get("usage")
  return {
    ...state.folded,
    session:
      usage?.type === "usage"
        ? { ...state.folded.session, cost: usage.value.cost, tokens: usage.value.tokens }
        : state.folded.session,
    messages,
    pending,
  }
}

function applyOverlay(overlay: Overlay, event: EphemeralSessionEvent): Overlay {
  const next = new Map(overlay)
  switch (event.type) {
    case "session.text.delta": {
      const key = partKey("text", event.data.assistantMessageID, event.data.ordinal)
      const current = next.get(key)
      next.set(key, {
        type: "text",
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        value: (current?.type === "text" ? current.value : "") + event.data.delta,
      })
      return next
    }
    case "session.reasoning.delta": {
      const key = partKey("reasoning", event.data.assistantMessageID, event.data.ordinal)
      const current = next.get(key)
      next.set(key, {
        type: "reasoning",
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        value: (current?.type === "reasoning" ? current.value : "") + event.data.delta,
      })
      return next
    }
    case "session.tool.input.delta": {
      const key = toolKey("tool-input", event.data.assistantMessageID, event.data.id)
      const current = next.get(key)
      next.set(key, {
        type: "tool-input",
        messageID: event.data.assistantMessageID,
        toolID: event.data.id,
        value: (current?.type === "tool-input" ? current.value : "") + event.data.delta,
      })
      return next
    }
    case "session.tool.progress":
      next.set(toolKey("tool-progress", event.data.assistantMessageID, event.data.id), {
        type: "tool-progress",
        messageID: event.data.assistantMessageID,
        toolID: event.data.id,
        metadata: event.data.metadata,
      })
      return next
    case "session.compaction.delta": {
      const current = next.get("compaction")
      next.set("compaction", {
        type: "compaction",
        value: (current?.type === "compaction" ? current.value : "") + event.data.text,
      })
      return next
    }
    case "session.usage.updated":
      next.set("usage", { type: "usage", value: event.data })
      return next
  }
}

function clearOverlay(overlay: Overlay, event: DurableSessionEvent): Overlay {
  const next = new Map(overlay)
  switch (event.type) {
    case "session.text.ended":
      next.delete(partKey("text", event.data.assistantMessageID, event.data.ordinal))
      return next
    case "session.reasoning.ended":
      next.delete(partKey("reasoning", event.data.assistantMessageID, event.data.ordinal))
      return next
    case "session.tool.input.ended":
    case "session.tool.called":
      next.delete(toolKey("tool-input", event.data.assistantMessageID, event.data.id))
      return next
    case "session.tool.success":
    case "session.tool.failed":
      next.delete(toolKey("tool-progress", event.data.assistantMessageID, event.data.id))
      return next
    case "session.compaction.ended":
    case "session.compaction.failed":
      next.delete("compaction")
      return next
    case "session.step.ended":
    case "session.step.failed":
    case "session.usage.recorded":
      next.delete("usage")
      return next
    default:
      return next
  }
}

function applyOverlayToMessages(messages: ReadonlyArray<SessionMessageInfo>, overlay: Overlay) {
  return messages.map((message): SessionMessageInfo => {
    if (message.type === "compaction" && message.status === "running") {
      const entry = overlay.get("compaction")
      return entry?.type === "compaction" ? { ...message, summary: message.summary + entry.value } : message
    }
    if (message.type !== "assistant") return message
    const content = message.content.map((part, ordinal) => {
      if (part.type === "text") {
        const entry = overlay.get(partKey("text", message.id, ordinal))
        return entry?.type === "text" ? { ...part, text: part.text + entry.value } : part
      }
      if (part.type === "reasoning") {
        const entry = overlay.get(partKey("reasoning", message.id, ordinal))
        return entry?.type === "reasoning" ? { ...part, text: part.text + entry.value } : part
      }
      const input = overlay.get(toolKey("tool-input", message.id, part.id))
      if (input?.type === "tool-input" && part.state.status === "streaming")
        return { ...part, state: { ...part.state, input: part.state.input + input.value } }
      const progress = overlay.get(toolKey("tool-progress", message.id, part.id))
      if (progress?.type === "tool-progress" && part.state.status === "running")
        return { ...part, state: { ...part.state, metadata: progress.metadata } }
      return part
    })
    return content.some((part, index) => part !== message.content[index]) ? { ...message, content } : message
  })
}

function partKey(type: "text" | "reasoning", messageID: string, ordinal: number) {
  return `${type}:${messageID}:${ordinal}`
}

function toolKey(type: "tool-input" | "tool-progress", messageID: string, toolID: string) {
  return `${type}:${messageID}:${toolID}`
}

export * as Engine from "./engine"
