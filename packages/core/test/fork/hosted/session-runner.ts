import { describe, expect } from "bun:test"
import { LLMEvent, type LLMRequest } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import type { Bus } from "@opencode/core/bus"
import { Permission } from "@opencode/core/permission"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { Tool } from "@opencode/core/tool"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import type { Info as ToolInfo } from "@opencode/schema/tool"
import { Expected } from "../../lib/session-message"
import { host } from "../../plugin/host"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** What these scenarios use of the upstream runner scenario, with the Sessions whose drain named a declined call. */
export interface Scenario {
  readonly llm: { readonly push: (...responses: ReadonlyArray<Provided>) => Effect.Effect<void> }
  readonly admit: (text: string) => Effect.Effect<unknown, unknown, unknown>
  readonly resume: Effect.Effect<unknown, unknown, unknown>
  readonly runPrompt: (text: string) => Effect.Effect<unknown, unknown, unknown>
  readonly requests: ReadonlyArray<LLMRequest>
  readonly context: Effect.Effect<ReadonlyArray<unknown>, unknown, unknown>
  readonly bus: Bus.Interface
  readonly declineReports: ReadonlyArray<Session.ID>
}

/** The session runner harness of the upstream SessionRunnerLLM tests, which host these. */
export interface Harness {
  readonly scenario: (name: string, body: (s: Scenario) => Generator<Provided, void, Provided>) => void
  readonly transformTools: (
    registry: Tool.Interface,
    tools: Readonly<Record<string, ToolInfo>>,
    options?: Tool.Options,
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly sessionID: Session.ID
  readonly systemTexts: (request: LLMRequest) => ReadonlyArray<string>
}

export const forkTests = ({ scenario, transformTools, sessionID, systemTexts }: Harness) =>
  describe("SessionRunnerLLM (fork)", () => {
    scenario("sends plan and build the same tools while each agent's rules decide its calls", function* (s) {
      const agents = yield* Agent.Service
      const plan = Agent.ID.make("plan")
      // Plan wholly denies two write tools that build allows; alone, plan's request would leave them out.
      yield* agents.transform((editor) =>
        editor.update(plan, (agent) => {
          agent.mode = "primary"
          agent.permissions.push(
            { action: "note_write", resource: "*", effect: "deny" },
            { action: "catalog_write", resource: "*", effect: "deny" },
          )
        }),
      )
      const registry = yield* Tool.Service
      const writes: string[] = []
      const writer = (name: string): ToolInfo => ({
        name,
        description: "Write a note",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: ({ text }) => Effect.sync(() => (writes.push(text), { output: { text } })),
      })
      yield* transformTools(registry, { note_write: writer("note_write") }, { codemode: false })
      yield* transformTools(registry, { catalog_write: writer("catalog_write") }, { codemode: true })

      yield* s.llm.push(TestLLM.toolCall("call-build-note", "note_write", { text: "build" }), TestLLM.stop())
      yield* s.runPrompt("Build writes")
      yield* s.bus.publish(SessionEvent.AgentSelected, { sessionID, agent: plan })
      yield* s.llm.push(TestLLM.toolCall("call-plan-note", "note_write", { text: "plan" }), TestLLM.stop())
      yield* s.runPrompt("Plan writes")

      expect(s.requests).toHaveLength(4)
      const [build, , planned] = s.requests
      expect(build?.tools.map((tool) => tool.name)).toContain("note_write")
      expect(build?.system.map((part) => part.text).join("\n")).toContain("catalog_write")
      // Byte-identical tools and system prompt, and no instruction update: the Code Mode catalog did not change.
      expect(planned?.tools).toEqual(build?.tools)
      expect(planned?.system).toEqual(build?.system)
      expect(systemTexts(planned!)).toEqual([])
      expect(writes).toEqual(["build"])
      expect((yield* s.context).at(-2)).toMatchObject(
        Expected.assistant({}, [
          Expected.failedTool(
            { id: "call-plan-note" },
            { error: { type: "permission.rejected", message: "The plan agent is not permitted to use note_write." } },
          ),
        ]),
      )
    })

    for (const codemode of [false, true]) {
      for (const origin of ["tool", "effect-hook", "promise-hook"] as const) {
        for (const outcome of ["deny", "decline", "feedback"] as const) {
          scenario(`permission outcomes: ${origin} ${outcome} via ${codemode ? "Code Mode" : "direct"}`, function* (s) {
            const registry = yield* Tool.Service
            const hooks = yield* PluginHooks.Service
            const reason = outcome === "feedback" ? "Use staging instead" : "Policy forbids production"
            const check =
              outcome === "decline"
                ? Effect.die(new Permission.DeclinedError())
                : Effect.fail(
                    new Tool.Error({
                      message: reason,
                      error:
                        outcome === "feedback"
                          ? new Permission.CorrectedError({ feedback: reason })
                          : new Permission.BlockedError({
                              permission: "deploy",
                              resources: ["production"],
                              rules: [],
                              reason,
                            }),
                    }),
                  )
            let executed = false
            yield* transformTools(
              registry,
              {
                guarded: {
                  name: "guarded",
                  description: "Exercise a permission outcome",
                  input: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    (origin === "tool" ? check : Effect.void).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          executed = true
                          return { output: "unexpected execution" }
                        }),
                      ),
                    ),
                },
              },
              { codemode },
            )
            if (origin === "effect-hook")
              yield* hooks.register("tool", "execute.before", (event) =>
                event.tool === "guarded" ? check : Effect.void,
              )
            if (origin === "promise-hook") {
              yield* PluginPromise.fromPromise({
                id: "permission-outcome",
                async setup(context) {
                  await context.tool.hook("execute.before", async (event) => {
                    if (event.tool === "guarded")
                      await context.permission.assert({
                        sessionID: event.sessionID,
                        action: "deploy",
                        resources: ["production"],
                      })
                  })
                },
              }).effect(
                host({
                  tool: { ...host().tool, hook: (name, callback) => hooks.register("tool", name, callback) },
                  permission: { ...host().permission, assert: () => check },
                }),
              )
            }
            yield* s.admit("Exercise permission outcome")
            yield* s.llm.push(
              codemode
                ? TestLLM.toolCall("call-guarded", "execute", { code: "return await tools.guarded({})" })
                : TestLLM.toolCall("call-guarded", "guarded", {}),
              TestLLM.stop(),
            )
            const exit = yield* s.resume.pipe(Effect.exit)
            expect(executed).toBe(false)
            expect(s.requests).toHaveLength(outcome === "decline" ? 1 : 2)
            expect(s.declineReports).toEqual(outcome === "decline" ? [sessionID] : [])
            if (outcome === "decline") {
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
              expect(yield* s.context).toMatchObject([
                Expected.user("Exercise permission outcome"),
                Expected.assistant({}, [
                  Expected.failedTool(
                    { id: "call-guarded" },
                    { error: { type: "aborted", message: "The user declined this tool call" } },
                  ),
                ]),
              ])
            } else {
              expect(Exit.isSuccess(exit)).toBe(true)
              expect(JSON.stringify(yield* s.context)).toContain(reason)
            }
          })
        }
      }
    }

    for (const code of [
      'try { await tools.declined({}) } catch (error) { return "caught" }',
      "return await Promise.allSettled([tools.declined({})])",
      'tools.declined({}); return "not awaited"',
    ]) {
      scenario(`Code Mode cannot swallow a user decline: ${code}`, function* (s) {
        const registry = yield* Tool.Service
        yield* transformTools(
          registry,
          {
            declined: {
              name: "declined",
              description: "User declines approval",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.die(new Permission.DeclinedError()),
            },
          },
          { codemode: true },
        )
        yield* s.admit("Decline inside Code Mode")
        yield* s.llm.push(TestLLM.toolCall("call-declined", "execute", { code }), TestLLM.stop())
        const exit = yield* s.resume.pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(s.requests).toHaveLength(1)
        expect(s.declineReports).toEqual([sessionID])
      })
    }

    // A declined call stops the turn as the user's own stop; the step names it before interrupting, so settlement
    // releases the turn instead of reading the interrupt as an unowned teardown and resuming it after a restart.
    scenario("names a decline after an ordinary tool error, wrapped or not, as the user's stop", function* (s) {
      const registry = yield* Tool.Service
      yield* transformTools(
        registry,
        {
          failed: {
            name: "failed",
            description: "Fail normally before the declined call",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.fail(new Tool.Error({ message: "Ordinary tool failure" })),
          },
          declined: {
            name: "declined",
            description: "Fail because the user declined approval",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new Permission.DeclinedError()),
          },
          wrapped: {
            name: "wrapped",
            description: "Fail with a decline attached to a tool error",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.fail(new Tool.Error({ message: "Wrapped decline", error: new Permission.DeclinedError() })),
          },
        },
        { codemode: false },
      )
      yield* s.admit("Call declined")
      yield* s.llm.push(
        TestLLM.toolCalls(
          LLMEvent.toolCall({ id: "call-failed", name: "failed", input: {} }),
          LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
          LLMEvent.toolCall({ id: "call-wrapped", name: "wrapped", input: {} }),
        ),
      )
      const exit = yield* s.resume.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(s.declineReports).toEqual([sessionID])
    })

    scenario("names a dismissed question as the user's stop", function* (s) {
      const registry = yield* Tool.Service
      yield* transformTools(
        registry,
        {
          question: {
            name: "question",
            description: "Ask the user",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new QuestionTool.CancelledError()),
          },
        },
        { codemode: false },
      )
      yield* s.admit("Ask then stop")
      yield* s.llm.push(TestLLM.toolCall("call-question", "question", {}), [])
      const run = yield* s.resume.pipe(Effect.exit, Effect.forkChild)
      const exit = yield* Fiber.join(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(s.declineReports).toEqual([sessionID])
    })
  })
