import { batch, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { OpenCodeClient, OpenCodeEvent, SessionPromptInput } from "../promise"
import { isSeqUnavailableError } from "../promise"
import { createData } from "./data"
import type { CreateDataInput } from "./data"
import { Engine } from "./engine/engine"

type SessionApi = Pick<OpenCodeClient["session"], "snapshot" | "log" | "prompt">

const ambientSessionEvents = new Set<OpenCodeEvent["type"]>([
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.agent.selected",
  "session.model.selected",
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export function createEngineTransport(api: () => SessionApi): Engine.SessionTransport {
  return {
    snapshot(sessionID) {
      return api().snapshot({ sessionID, recent: 200 })
    },
    async *stream(sessionID, after, signal) {
      try {
        for await (const item of api().log(
          { sessionID, after, follow: true, ephemeral: true },
          signal ? { signal } : undefined,
        )) {
          if (item.type !== "session.forked") yield item
        }
      } catch (error) {
        if (isSeqUnavailableError(error)) throw new Engine.SeqUnavailable()
        throw error
      }
    },
    async submit(input) {
      try {
        await api().prompt({ sessionID: input.sessionID, id: input.id, ...input.request })
      } catch (error) {
        if (isTypedError(error)) throw new Engine.SubmitRejected(error.message)
        throw error
      }
    },
  }
}

export function createEngineData(config: CreateDataInput) {
  const legacy = createData({
    ...config,
    event: {
      on: config.event.on,
      listen(handler) {
        return config.event.listen((event) => {
          if (event.name.startsWith("session.") && !ambientSessionEvents.has(event.name)) return
          handler(event)
        })
      },
    },
  })
  const [views, setViews] = createStore<Record<string, Engine.SessionView>>({})
  const engines = new Map<string, Promise<Engine.SessionEngine>>()
  const failures = new Set<(failure: Engine.IntentFailure) => void>()
  const cleanups = new Set<() => void>()
  const transport = createEngineTransport(() => config.api().session)

  const update = (sessionID: string, view: Engine.SessionView) => {
    batch(() => {
      setViews(sessionID, reconcile(view))
      legacy.session.remember(view.session)
      view.children.forEach(legacy.session.remember)
    })
  }

  const ensure = (sessionID: string) => {
    const existing = engines.get(sessionID)
    if (existing) return existing
    const created = Engine.createSessionEngine(sessionID, transport).then((engine) => {
      update(sessionID, engine.view())
      cleanups.add(engine.subscribe((view) => update(sessionID, view)))
      cleanups.add(engine.subscribeFailures((failure) => failures.forEach((listener) => listener(failure))))
      return engine
    })
    engines.set(sessionID, created)
    void created.catch(() => engines.delete(sessionID))
    return created
  }

  onCleanup(() => {
    cleanups.forEach((cleanup) => cleanup())
    engines.forEach((engine) => void engine.then((handle) => handle.stop()))
  })

  return {
    ...legacy,
    session: {
      ...legacy.session,
      sync(sessionID: string) {
        return ensure(sessionID).then(() => undefined)
      },
      status(sessionID: string) {
        return views[sessionID]?.active ?? legacy.session.status(sessionID)
      },
      input: {
        list(sessionID: string) {
          return views[sessionID]?.pending.filter((item) => item.type !== "compaction").map((item) => item.id) ?? []
        },
        has(sessionID: string, inboxID: string) {
          return views[sessionID]?.pending.some((item) => item.type !== "compaction" && item.id === inboxID) ?? false
        },
      },
      pending: {
        list(sessionID: string) {
          return views[sessionID]?.pending ?? []
        },
        sync(sessionID: string) {
          return ensure(sessionID).then(() => undefined)
        },
        invalidate() {},
      },
      message: {
        list(sessionID: string) {
          return views[sessionID]?.messages ?? []
        },
        get(sessionID: string, messageID: string) {
          return views[sessionID]?.messages.find((message) => message.id === messageID)
        },
        sync(sessionID: string) {
          return ensure(sessionID).then(() => undefined)
        },
        invalidate() {},
      },
      async prompt(input: SessionPromptInput) {
        return (await ensure(input.sessionID)).submit({
          id: input.id ?? undefined,
          text: input.text,
          files: input.files,
          agents: input.agents,
          skills: input.skills,
          metadata: input.metadata,
          delivery: input.delivery,
          resume: input.resume,
        })
      },
      failures: {
        listen(listener: (failure: Engine.IntentFailure) => void) {
          failures.add(listener)
          return () => failures.delete(listener)
        },
      },
    },
  }
}

function isTypedError(error: unknown): error is { readonly _tag: string; readonly message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    "message" in error &&
    typeof error.message === "string"
  )
}

export type EngineData = ReturnType<typeof createEngineData>
