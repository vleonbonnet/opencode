import { batch, onCleanup } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
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
        await api().prompt({ ...input.request, sessionID: input.sessionID, id: input.id })
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
  const families = new Set<string>()
  const invalidated = new Set<string>()
  const failures = new Set<(failure: Engine.IntentFailure) => void>()
  const cleanups = new Set<() => void>()
  const transport = createEngineTransport(() => config.api().session)
  let connected = false

  const update = (sessionID: string, view: Engine.SessionView) => {
    batch(() => {
      setViews(sessionID, reconcile(structuredClone(view)))
      const current = legacy.session.get(sessionID)
      if (!current || current.time.updated <= view.session.time.updated) {
        legacy.session.remember(structuredClone(view.session))
      }
      if (families.has(sessionID)) {
        view.children.forEach((child) => legacy.session.remember(structuredClone(child)))
      }
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

  const sync = async (sessionID: string) => {
    const engine = await ensure(sessionID)
    if (invalidated.delete(sessionID)) await engine.refresh()
    await engine.ready()
  }

  cleanups.add(
    config.event.on("server.connected", () => {
      if (!connected) {
        connected = true
        return
      }
      engines.forEach((engine) => void engine.then((handle) => handle.refresh()).catch(() => undefined))
    }),
  )

  onCleanup(() => {
    cleanups.forEach((cleanup) => cleanup())
    engines.forEach((engine) => void engine.then((handle) => handle.stop()))
  })

  return {
    ...legacy,
    on: config.event.on,
    listen: config.event.listen,
    session: {
      ...legacy.session,
      async sync(sessionID: string, options?: { readonly children?: boolean }) {
        if (options?.children) families.add(sessionID)
        await sync(sessionID)
        if (!options?.children) return
        const view = views[sessionID]
        view?.children.forEach((child) => legacy.session.remember(structuredClone(unwrap(child))))
      },
      invalidate(sessionID: string) {
        invalidated.add(sessionID)
      },
      status(sessionID: string) {
        if (views[sessionID]?.active === "running") return "running"
        return legacy.session.status(sessionID)
      },
      input: {
        list(sessionID: string) {
          return (
            views[sessionID]?.pending.filter((item) => item.type !== "compaction").map((item) => item.id) ??
            legacy.session.input.list(sessionID)
          )
        },
        has(sessionID: string, inboxID: string) {
          return (
            views[sessionID]?.pending.some((item) => item.type !== "compaction" && item.id === inboxID) ??
            legacy.session.input.has(sessionID, inboxID)
          )
        },
      },
      pending: {
        list(sessionID: string) {
          void ensure(sessionID)
          return [...(views[sessionID]?.pending ?? [])]
        },
        sync(sessionID: string) {
          return sync(sessionID)
        },
        invalidate(sessionID: string) {
          invalidated.add(sessionID)
        },
      },
      message: {
        list(sessionID: string) {
          void ensure(sessionID)
          return [...(views[sessionID]?.messages ?? [])]
        },
        get(sessionID: string, messageID: string) {
          void ensure(sessionID)
          return views[sessionID]?.messages.find((message) => message.id === messageID)
        },
        sync(sessionID: string) {
          return sync(sessionID)
        },
        invalidate(sessionID: string) {
          invalidated.add(sessionID)
        },
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
