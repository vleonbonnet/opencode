import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Form } from "@opencode/core/form"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import type { testEffect } from "../../lib/effect"
import { toolIdentity, executeTool } from "../../lib/tool"

/** The web search tool fixture of the upstream WebSearchTool tests, which host these. */
export interface Harness<R, E> {
  readonly it: ReturnType<typeof testEffect<R, E>>
  readonly setup: Effect.Effect<
    {
      formRequests: Form.CreateInput[]
      formResponse: Form.TerminalState
      formWait: Effect.Effect<void>
      readonly registry: Tool.Interface
    },
    never,
    R | Scope.Scope
  >
  readonly sessionID: Session.ID
}

export const forkTests = <R, E>({ it, setup, sessionID }: Harness<R, E>) =>
  describe("WebSearchTool registration (fork)", () => {
    it.effect("waits for the consent answer however long it takes", () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        const answered = yield* Deferred.make<void>()
        fixture.formWait = Deferred.await(answered)
        fixture.formResponse = { status: "answered", answer: { choice: "allow" } }
        const search = yield* executeTool(fixture.registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-late", name: "websearch", input: { query: "effect" } },
        }).pipe(Effect.forkChild({ startImmediately: true }))
        while (fixture.formRequests.length === 0) yield* Effect.yieldNow
        yield* TestClock.adjust("10 minutes")
        yield* Deferred.succeed(answered, undefined)
        expect(yield* Fiber.join(search)).toMatchObject({ status: "completed" })
        expect(fixture.formRequests).toHaveLength(1)
      }),
    )
  })
