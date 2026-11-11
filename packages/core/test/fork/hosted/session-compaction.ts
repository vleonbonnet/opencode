import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { SessionCompaction } from "@opencode/core/session/compaction"
import type { SessionContext } from "@opencode/core/session/context"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** The compaction harness of the upstream SessionCompaction tests, which host these. */
export interface Harness {
  readonly it: { readonly effect: (name: string, body: () => Effect.Effect<unknown, unknown, Provided>) => void }
  readonly insertSession: (id: Session.ID) => Effect.Effect<Session.Info, unknown, unknown>
  readonly loaded: (session: Session.Info, messages: ReadonlyArray<SessionMessage.Info>) => SessionContext.Loaded
  readonly storeMessages: (
    sessionID: Session.ID,
    messages: ReadonlyArray<SessionMessage.Info>,
  ) => Effect.Effect<void, unknown, unknown>
  readonly textUser: (text: string) => SessionMessage.User
  readonly measured: (text: string, input: number) => SessionMessage.Assistant
  readonly precomputeHistory: () => { readonly due: ReadonlyArray<SessionMessage.Info> }
}

export const forkTests = ({
  it,
  insertSession,
  loaded,
  storeMessages,
  textUser,
  measured,
  precomputeHistory,
}: Harness) =>
  describe("SessionCompaction (fork)", () => {
    it.effect("a completed compaction reports the estimated prompt of the next request", () =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const store = yield* SessionStore.Service
        const compaction = yield* SessionCompaction.Service
        const session = yield* insertSession(Session.ID.make("ses_compaction_next_prompt"))
        const update = SessionMessage.System.make({
          id: SessionMessage.ID.create(),
          type: "system",
          text: `Updated instructions ${"x".repeat(4_000)}`,
          time: { created: DateTime.makeUnsafe(0) },
        })
        const kept = textUser("Kept question")
        // The last step measured 120k tokens; that size is what the compaction just replaced.
        yield* storeMessages(session.id, [
          textUser("Earlier question"),
          measured("Earlier answer", 120_000),
          update,
          kept,
          measured("Kept answer", 121_000),
        ])
        const ended = yield* bus
          .subscribe(SessionEvent.Compaction.Ended)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow
        // As the runner delivers `/compact`: the compaction's message opens, then history loads with it.
        const inputID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: session.id, reason: "manual", inputID })
        const context = loaded(session, yield* store.context(session.id))
        // Added while the summary is written, so it is part of the next request.
        yield* bus.publish(SessionEvent.Synthetic, { sessionID: session.id, text: `Shell output ${"y".repeat(2_000)}` })
        expect(yield* compaction.compact({ reason: "manual", context, inputID })).toEqual({ status: "completed" })

        const history = yield* store.context(session.id)
        expect(history).toMatchObject([
          { type: "compaction", status: "completed", metadata: { keepID: kept.id } },
          { type: "synthetic" },
        ])
        // The next request sends the summary with its kept text and the shell output, and the system prompt that
        // completing the compaction rebuilt with the instruction update in it.
        const next = SessionCompaction.estimateContext(loaded(session, [update, ...history]))
        expect(next).toBeLessThan(10_000)
        expect(next).toBeGreaterThan(SessionCompaction.estimateContext(loaded(session, history)))
        expect(history[0]).toMatchObject({ context: next })
        expect(Array.from(yield* Fiber.join(ended)).map((event) => event.data.context)).toEqual([next])
      }),
    )

    it.effect("an automatic compaction reports the estimated prompt of the step it resumes", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        const compaction = yield* SessionCompaction.Service
        const session = yield* insertSession(Session.ID.make("ses_auto_compaction_next_prompt"))
        const history = precomputeHistory().due
        yield* storeMessages(session.id, history)
        expect(yield* compaction.compact({ reason: "auto", context: loaded(session, history) })).toEqual({
          status: "completed",
        })
        const next = yield* store.context(session.id)
        const checkpoint = next[0]
        if (next.length !== 1 || checkpoint?.type !== "compaction" || checkpoint.status !== "completed")
          return yield* Effect.die("Missing checkpoint")
        // Far below the 182k the last step measured, which the summary replaced.
        expect(checkpoint.context).toBe(SessionCompaction.estimateContext(loaded(session, next)))
        expect(checkpoint.context).toBeLessThan(10_000)
      }),
    )
  })
