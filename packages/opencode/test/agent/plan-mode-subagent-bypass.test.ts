import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

// `deriveSubagentSessionPermission` is imported from production. The test
// exercises the actual helper that task.ts uses to build the subagent's
// session permission, so any regression in that helper trips this test.

it.instance("subagent permissions take precedence over parent agent restrictions", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    const generalAgent = yield* Agent.use.get("general")

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    const parentSessionPermission: PermissionV1.Ruleset = []

    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: generalAgent!,
    })

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).not.toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.instance("subagent's own read-only restriction remains effective", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.use.get("explore")
    expect(explore).toBeDefined()

    const parentSessionPermission: PermissionV1.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
  }),
)

it.instance(
  "custom subagent can explicitly enable edits denied to its parent agent",
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.use.get("plan")
      const my = yield* Agent.use.get("my_subagent")
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: PermissionV1.Ruleset = []
      const subagentSessionPermission = deriveSubagentSessionPermission({
        parentSessionPermission,
        subagent: my!,
      })
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("allow")
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
          permission: {
            edit: "allow",
          },
        },
      },
    },
  },
)

it.effect("subagent self permissions are preserved", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        bash: "allow",
        task: {
          "*": "deny",
          worker: "allow",
        },
        edit: "allow",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.effect("subagent inherits parent session deny rules as hard runtime ceilings", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "allow",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ bash: "deny" }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
  }),
)

it.effect("plan-mode subagent inherits parent approval and protected-path rules", () =>
  Effect.sync(() => {
    const general = testAgent({ name: "general", mode: "subagent", permission: { edit: "allow", bash: "allow" } })
    const parent = Permission.fromConfig({
      edit: { "*": "ask", "*.pem": "deny" },
      bash: { "*": "allow", "rm *": "deny" },
    })
    const effective = Permission.merge(
      general.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ edit: { "src/locked.ts": "deny" } }),
        parentAgentPermission: parent,
        subagent: general,
      }),
    )

    expect(Permission.evaluate("edit", "src/app.ts", effective).action).toBe("ask")
    expect(Permission.evaluate("edit", "src/locked.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "secret.pem", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "rm -rf src", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
  }),
)

it.effect("plan-mode subagent does not resurrect parent restrictions the parent overrides", () =>
  Effect.sync(() => {
    const explore = testAgent({
      name: "explore",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        external_directory: { "*": "ask", "/tmp/tool-output/*": "allow" },
      },
    })
    const parent = Permission.merge(
      Permission.fromConfig({
        "*": "allow",
        question: "deny",
        external_directory: { "*": "ask", "/tmp/tool-output/*": "allow" },
      }),
      Permission.fromConfig({
        question: "allow",
        external_directory: { "/data/plans/*": "allow" },
        edit: { "*": "deny", ".opencode/plans/*.md": "allow" },
      }),
      Permission.fromConfig({ external_directory: "allow" }),
    )
    const effective = Permission.merge(
      Permission.merge(explore.permission, Permission.fromConfig({ external_directory: "allow" })),
      deriveSubagentSessionPermission({ parentSessionPermission: [], parentAgentPermission: parent, subagent: explore }),
    )

    expect(Permission.evaluate("external_directory", "/elsewhere/*", parent).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/elsewhere/*", effective).action).toBe("allow")
    // Parent allows that override a parent deny must not widen the subagent.
    expect(Permission.evaluate("question", "*", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", ".opencode/plans/x.md", effective).action).toBe("deny")
  }),
)

it.effect("plan-mode subagent keeps parent exceptions only where the subagent allows them", () =>
  Effect.sync(() => {
    const explore = testAgent({
      name: "explore",
      mode: "subagent",
      permission: {
        "*": "deny",
        external_directory: { "*": "ask", "/tmp/tool-output/*": "allow" },
      },
    })
    const parent = Permission.fromConfig({
      external_directory: { "*": "ask", "/tmp/tool-output/*": "allow", "/data/plans/*": "allow" },
    })
    const effective = Permission.merge(
      explore.permission,
      deriveSubagentSessionPermission({ parentSessionPermission: [], parentAgentPermission: parent, subagent: explore }),
    )

    expect(Permission.evaluate("external_directory", "/elsewhere/*", effective).action).toBe("ask")
    expect(Permission.evaluate("external_directory", "/tmp/tool-output/x", effective).action).toBe("allow")
    expect(Permission.evaluate("external_directory", "/data/plans/x", effective).action).toBe("ask")
  }),
)

it.instance(
  "plan-delegated explore honours user external_directory allow",
  () =>
    Effect.gen(function* () {
      const plan = yield* Agent.use.get("plan")
      const explore = yield* Agent.use.get("explore")
      const effective = Permission.merge(
        explore!.permission,
        deriveSubagentSessionPermission({
          parentSessionPermission: [],
          parentAgentPermission: plan!.permission,
          subagent: explore!,
        }),
      )

      expect(Permission.evaluate("external_directory", "/elsewhere/project/*", effective).action).toBe("allow")
      expect(Permission.evaluate("edit", "/elsewhere/project/x.ts", effective).action).toBe("deny")
      expect(Permission.evaluate("question", "*", effective).action).toBe("deny")
    }),
  { config: { permission: { external_directory: "allow" } } },
)

it.instance("plan-delegated explore still asks for external directories by default", () =>
  Effect.gen(function* () {
    const plan = yield* Agent.use.get("plan")
    const explore = yield* Agent.use.get("explore")
    const effective = Permission.merge(
      explore!.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgentPermission: plan!.permission,
        subagent: explore!,
      }),
    )

    expect(Permission.evaluate("external_directory", "/elsewhere/project/*", effective).action).toBe("ask")
    expect(Permission.evaluate("external_directory", path.join(Global.Path.tmp, "x"), effective).action).toBe(
      "allow",
    )
  }),
)
