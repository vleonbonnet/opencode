import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Tool } from "@opencode/core/tool"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { tmpdirScoped } from "../../fixture/tmpdir"
import { executeTool, toolIdentity } from "../../lib/tool"
import { host } from "../../plugin/host"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any
type Live = (name: string, body: () => Effect.Effect<unknown, unknown, Provided>, opts?: number) => void

/** The subagent tool harness of the upstream SubagentTool tests, which host these. */
export interface Harness {
  readonly it: { readonly live: Live }
  readonly parentModel: Model.Ref
  readonly outputSessionID: (value: unknown) => Session.ID
  readonly withSubagent: (location: Location.Ref) => Effect.Effect<void, unknown, unknown>
}

/**
 * The subagent tool's context hook in LOCATION, which describes the subagents a request offers. The upstream harness
 * registers the plugin without session hooks, so its hooks are registered once more here, without its tool or jobs.
 */
const subagentContextHook = (location: Location.Ref) =>
  Effect.gen(function* () {
    let context: ((event: SessionHooks["context"]) => Effect.Effect<void>) | undefined
    const locations = yield* LocationServiceMap.Service
    yield* SubagentTool.Plugin.effect(
      host({
        session: {
          hook: (name, callback) =>
            Effect.sync(() => {
              // Hook names and callbacks are correlated, but the generic registration API does not narrow them.
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              if (name === "context") context = callback as (event: SessionHooks["context"]) => Effect.Effect<void>
              return { dispose: Effect.void }
            }),
        },
        tool: {
          transform: () => Effect.succeed({ dispose: Effect.void }),
          reload: () => Effect.void,
          list: () => Effect.succeed([]),
          hook: () => Effect.succeed({ dispose: Effect.void }),
        },
      }),
    ).pipe(
      // The context hook never runs subagent jobs, which the upstream supervisor keeps to itself.
      Effect.provide(Layer.mock(SubagentJob.Service, {})),
      Effect.provide(locations.get(location)),
    )
    if (!context) return yield* Effect.die("the subagent plugin registered no context hook")
    return context
  })

export const forkTests = ({ it, parentModel, outputSessionID, withSubagent }: Harness) => {
  const planAgent = Agent.ID.make("plan")

  /** A parent Session with helpers to delegate from it (or its descendants) and to read a Session's decisions. */
  const planDelegation = (
    directory: string,
    input: {
      readonly permissions?: Permission.Ruleset
      readonly plan: Permission.Ruleset
      readonly subagents?: Readonly<Record<string, Permission.Ruleset>>
    },
  ) =>
    Effect.gen(function* () {
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location, model: parentModel, permissions: input.permissions })
      yield* withSubagent(parent.location)
      const locations = yield* LocationServiceMap.Service
      const scope = locations.get(parent.location)
      yield* Agent.Service.use((agents) =>
        agents.transform((editor) => {
          editor.update(planAgent, (agent) => {
            agent.mode = "primary"
            agent.permissions.push(...input.plan)
          })
          for (const [id, permissions] of Object.entries(input.subagents ?? {}))
            editor.update(Agent.ID.make(id), (agent) => {
              agent.mode = "subagent"
              agent.permissions.push(...permissions)
            })
        }),
      ).pipe(Effect.provide(scope))
      const registry = yield* Tool.Service.pipe(Effect.provide(scope))
      const permission = yield* Permission.Service.pipe(Effect.provide(scope))
      const delegate = (call: {
        readonly from?: Session.ID
        readonly as: Agent.ID
        readonly agent: string
        readonly id: string
        readonly sessionID?: Session.ID
      }) =>
        executeTool(registry, {
          sessionID: call.from ?? parent.id,
          ...toolIdentity,
          agent: call.as,
          call: {
            type: "tool-call",
            id: call.id,
            name: SubagentTool.name,
            input: {
              agent: call.agent,
              description: "review",
              prompt: "review this",
              ...(call.sessionID === undefined ? {} : { sessionID: call.sessionID }),
            },
          },
        }).pipe(
          Effect.map((result) => {
            expect(result).toMatchObject({ status: "completed" })
            return outputSessionID(result.metadata)
          }),
        )
      const decide = (sessionID: Session.ID, action: string, resource: string) =>
        permission
          .ask({ sessionID, action, resources: [resource], save: [] })
          .pipe(Effect.map((result) => result.effect))
      return { parent, sessions, scope, permission, delegate, decide }
    })

  describe("SubagentTool (fork)", () => {
    it.live("holds plan-delegated children to plan's decision wherever rules overlap", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const plans = path.join(dir.path, "plans")
            const guard: Permission.Rule = { action: "shell", resource: "rm *", effect: "deny" }
            const { delegate, decide } = yield* planDelegation(dir.path, {
              permissions: [guard],
              plan: [
                // Which subagents plan may launch does not bind what the subagent may launch.
                { action: "subagent", resource: "*", effect: "deny" },
                { action: "subagent", resource: "reviewer", effect: "allow" },
                { action: "subagent", resource: "keeper", effect: "allow" },
                { action: "edit", resource: "*", effect: "deny" },
                { action: "edit", resource: path.join(plans, "*"), effect: "allow" },
                { action: "edit", resource: "keys/*", effect: "allow" },
                { action: "edit", resource: "*.pem", effect: "deny" },
                { action: "shell", resource: "*", effect: "deny" },
                { action: "shell", resource: "cat *", effect: "allow" },
                { action: "shell", resource: "*>*", effect: "deny" },
              ],
              subagents: {
                keeper: [
                  { action: "edit", resource: "*", effect: "deny" },
                  { action: "edit", resource: "keys/*", effect: "allow" },
                ],
              },
            })

            const general = yield* delegate({ as: planAgent, agent: "reviewer", id: "call-general" })
            expect(yield* decide(general, "edit", path.join(dir.path, "src", "app.ts"))).toBe("deny")
            expect(yield* decide(general, "edit", path.join(plans, "next.md"))).toBe("allow")
            expect(yield* decide(general, "read", path.join(dir.path, "README.md"))).toBe("allow")
            expect(yield* decide(general, "shell", "rm -rf src")).toBe("deny")
            expect(yield* decide(general, "shell", "cat a")).toBe("allow")
            expect(yield* decide(general, "shell", "ls")).toBe("deny")
            // Plan's cat exception overlaps its redirect deny without containing it; plan denies the redirect.
            expect(yield* decide(general, "shell", "cat a > b")).toBe("deny")
            expect(yield* decide(general, SubagentTool.name, "explore")).toBe("allow")

            const keeper = yield* delegate({ as: planAgent, agent: "keeper", id: "call-keeper" })
            expect(yield* decide(keeper, "edit", "keys/notes.md")).toBe("allow")
            expect(yield* decide(keeper, "edit", path.join(plans, "next.md"))).toBe("deny")
            // The subagent's exception and plan's allow both cover the key, but plan denies it as a .pem file.
            expect(yield* decide(keeper, "edit", "keys/server.pem")).toBe("deny")
          }),
        ),
      ),
    )

    it.live("holds plan-delegated children to plan's rules for every spelling and names the rule that asks", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const push: Permission.Rule = { action: "shell", resource: "git push *", effect: "ask" }
            const cleanup = "Run `agent-cleanup -- PATH...` instead."
            const { permission, delegate } = yield* planDelegation(dir.path, {
              plan: [
                { action: "subagent", resource: "reviewer", effect: "allow" },
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "rm *", effect: "deny" },
                { action: "shell", resource: "rm -r *", effect: "deny", message: cleanup },
                push,
              ],
              subagents: { reviewer: [{ action: "shell", resource: "*", effect: "allow" }] },
            })
            const child = yield* delegate({ as: planAgent, agent: "reviewer", id: "call-spellings" })
            const ask = (resource: string, alternate: string) =>
              permission.ask({ sessionID: child, action: "shell", resources: [resource], alternates: [[alternate]] })

            // Only the bare spelling matches plan's deny.
            expect((yield* ask("/usr/bin/rm -rf src", "rm -rf src")).effect).toBe("deny")
            // The child is told why plan denies it, after whose rule denies it.
            const blocked = yield* permission
              .assert({ sessionID: child, action: "shell", resources: ["rm -r src"] })
              .pipe(Effect.flip)
            expect(blocked.message).toBe(
              `Permission denied: shell. The ${planAgent} agent that delegated this task does not permit it. ${cleanup}`,
            )
            // The child's own rules allow the push; plan's ask decides it, through the bare spelling.
            const asked = yield* ask("/usr/bin/git push origin", "git push origin")
            expect(asked.effect).toBe("ask")
            expect((yield* permission.get(asked.id))?.reasons).toEqual([
              { resource: "/usr/bin/git push origin", spelling: "git push origin", rule: push },
            ])
            yield* permission.reply({ requestID: asked.id, reply: "once" })
          }),
        ),
      ),
    )

    it.live("holds every descendant of a plan delegation to plan's current rules", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
            )
            const scout = Agent.ID.make("scout")
            const { delegate, decide, sessions, scope } = yield* planDelegation(dir.path, {
              plan: [
                { action: "edit", resource: "*", effect: "deny" },
                { action: "notes_write", resource: "*", effect: "deny" },
              ],
              // A read-only subagent that may launch subagents of its own.
              subagents: {
                scout: [
                  { action: "edit", resource: "*", effect: "deny" },
                  { action: SubagentTool.name, resource: "*", effect: "allow" },
                ],
              },
            })
            const source = path.join(dir.path, "src", "app.ts")

            const child = yield* delegate({ as: planAgent, agent: "scout", id: "call-scout" })
            const grandchild = yield* delegate({ from: child, as: scout, agent: "reviewer", id: "call-nested" })
            expect(yield* decide(grandchild, "edit", source)).toBe("deny")
            expect(yield* decide(grandchild, "notes_write", "*")).toBe("deny")
            expect(yield* decide(grandchild, "read", path.join(dir.path, "README.md"))).toBe("allow")

            // Reloading the child's agent with looser rules does not loosen plan's.
            yield* Agent.Service.use((agents) =>
              agents.transform((editor) =>
                editor.update(scout, (agent) => {
                  agent.permissions.push({ action: "edit", resource: "*", effect: "allow" })
                }),
              ),
            ).pipe(Effect.provide(scope))
            expect(yield* decide(child, "edit", source)).toBe("deny")
            // Neither does switching the child to an agent that allows edits outside the subagent tool.
            yield* sessions.switchAgent({ sessionID: child, agent: Agent.ID.make("reviewer") })
            expect(yield* decide(child, "edit", source)).toBe("deny")
            expect(yield* decide(child, "notes_write", "*")).toBe("deny")
          }),
        ),
      ),
    )

    it.live("keeps host-set child rules and plan's ceiling whoever continues the child", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const guard: Permission.Rule = { action: "shell", resource: "rm *", effect: "deny" }
            const { parent, delegate, decide, sessions } = yield* planDelegation(dir.path, {
              permissions: [guard],
              plan: [{ action: "edit", resource: "*", effect: "deny" }],
            })
            const source = path.join(dir.path, "src", "app.ts")
            const child = yield* delegate({ as: planAgent, agent: "reviewer", id: "call-plan" })
            const host: Permission.Rule = { action: "webfetch", resource: "*", effect: "deny" }
            yield* sessions.setPermissions({ sessionID: child, permissions: [host] })

            // Build continuing the child neither replaces the host's rules nor lifts plan's.
            yield* delegate({ as: toolIdentity.agent, agent: "reviewer", id: "call-build", sessionID: child })
            expect((yield* sessions.get(child)).permissions).toEqual([host])
            expect(yield* decide(child, "edit", source)).toBe("deny")
            expect(yield* decide(child, "webfetch", "https://example.com")).toBe("deny")
            // The parent session's deny still binds the child after the host replaced the child's rules.
            expect(yield* decide(child, "shell", "rm -rf src")).toBe("deny")
            expect(yield* decide(child, "shell", "git status")).toBe("allow")

            yield* delegate({ as: planAgent, agent: "reviewer", id: "call-plan-again", sessionID: child })
            expect((yield* sessions.get(child)).permissions).toEqual([host])
            expect(yield* decide(child, "edit", source)).toBe("deny")
            // Each delegating Session and agent is recorded once, in order.
            expect((yield* sessions.get(child)).delegators).toEqual([
              { sessionID: parent.id, agent: planAgent },
              { sessionID: parent.id, agent: toolIdentity.agent },
            ])
          }),
        ),
      ),
    )

    it.live("lists the same subagents for every selectable agent while each agent's rules decide launches", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const hook = yield* subagentContextHook(parent.location)
            const locations = yield* LocationServiceMap.Service
            const scope = locations.get(parent.location)
            const plan = Agent.ID.make("plan")
            const hidden = { action: SubagentTool.name, resource: "fallback", effect: "deny" } as const
            yield* Agent.Service.use((agents) =>
              agents.transform((editor) => {
                editor.update(plan, (agent) => {
                  agent.mode = "primary"
                  agent.permissions.push({ action: SubagentTool.name, resource: "reviewer", effect: "deny" }, hidden)
                })
                // Every other selectable agent, including the harness's spare primary agent, denies the fallback too.
                for (const id of [toolIdentity.agent, Agent.ID.make("primary")])
                  editor.update(id, (agent) => {
                    agent.permissions.push(hidden)
                  })
              }),
            ).pipe(Effect.provide(scope))
            const describeFor = (agent: Agent.ID) =>
              Effect.gen(function* () {
                const event = {
                  sessionID: parent.id,
                  agent,
                  model: parentModel,
                  system: [],
                  messages: [],
                  options: {},
                  tools: { [SubagentTool.name]: { description: "Spawn a subagent", input: {} } },
                } satisfies SessionHooks["context"]
                yield* hook(event)
                return event.tools[SubagentTool.name].description
              })

            const planned = yield* describeFor(plan)
            // Build may launch the reviewer, so plan lists it too; both deny the fallback, so neither lists it.
            expect(planned).toBe(yield* describeFor(toolIdentity.agent))
            expect(planned).toContain("- reviewer:")
            expect(planned).not.toContain("- fallback:")

            const registry = yield* Tool.Service.pipe(Effect.provide(scope))
            expect(
              yield* executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                agent: plan,
                call: {
                  type: "tool-call",
                  id: "call-plan-reviewer",
                  name: SubagentTool.name,
                  input: { agent: "reviewer", description: "review", prompt: "review this" },
                },
              }),
            ).toMatchObject({ status: "error", error: { type: "permission.rejected" } })
          }),
        ),
      ),
    )

    it.live("lists for a child Session its own agent's subagents within what its delegators allow", () =>
      tmpdirScoped().pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const fallback: Permission.Rule = { action: SubagentTool.name, resource: "fallback", effect: "deny" }
            const helper = Agent.ID.make("helper")
            const { parent, delegate, sessions, scope } = yield* planDelegation(dir.path, {
              permissions: [fallback],
              plan: [],
            })
            const hook = yield* subagentContextHook(parent.location)
            // A user may also select the helper, so in a root Session it shares the other agents' exposure.
            yield* Agent.Service.use((agents) =>
              agents.transform((editor) =>
                editor.update(helper, (agent) => {
                  agent.mode = "all"
                  agent.permissions.push({ action: SubagentTool.name, resource: "reviewer", effect: "deny" })
                }),
              ),
            ).pipe(Effect.provide(scope))
            const describeFor = (sessionID: Session.ID) =>
              Effect.gen(function* () {
                const event = {
                  sessionID,
                  agent: helper,
                  model: parentModel,
                  system: [],
                  messages: [],
                  options: {},
                  tools: { [SubagentTool.name]: { description: "Spawn a subagent", input: {} } },
                } satisfies SessionHooks["context"]
                yield* hook(event)
                return event.tools[SubagentTool.name].description
              })

            expect(yield* describeFor(parent.id)).toContain("- reviewer:")
            const child = yield* delegate({ as: toolIdentity.agent, agent: "helper", id: "call-helper" })
            // Without the copy of the parent's rules, only the delegating Session's deny still hides the fallback.
            yield* sessions.setPermissions({ sessionID: child, permissions: [] })
            const listed = yield* describeFor(child)
            expect(listed).not.toContain("- reviewer:")
            expect(listed).not.toContain("- fallback:")
            expect(listed).toContain("- helper:")
          }),
        ),
      ),
    )
  })
}
