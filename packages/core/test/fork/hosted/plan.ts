import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai/effect"
import { Effect, Scope } from "effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/core/agent"
import { it } from "../../lib/effect"

/** The plan plugin harness of the upstream plan plugin tests, which host these. */
export interface Harness {
  readonly run: () => Effect.Effect<
    {
      readonly persisted: ReadonlyArray<string>
      readonly contextHook: (input: SessionContext) => Effect.Effect<void>
    },
    unknown,
    Scope.Scope
  >
  readonly request: (agent: Agent.ID, messages: Array<Message>) => SessionContext
  readonly plan: Agent.ID
}

export const forkTests = ({ run, request, plan }: Harness) =>
  describe("plan plugin reminders (fork)", () => {
    it.effect("shapes a dry run's request like a real one without persisting the reminder", () =>
      Effect.gen(function* () {
        const { persisted, contextHook } = yield* run()
        const messages = [Message.user("what agent are you?")]
        yield* contextHook({ ...request(plan, messages), dryRun: true })
        expect(messages).toHaveLength(2)
        const first = messages[0]?.content[0]
        expect(first?.type === "text" && first.text).toContain("You are in Plan mode")
        expect(persisted).toHaveLength(0)
      }),
    )
  })
