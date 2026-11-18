import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import type { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { it } from "../lib/effect"
import { readInitial } from "../lib/instructions"
import { toolNodeReplacements } from "../lib/tool"

// The catalog fixtures of the upstream McpInstructions tests.
const instructions = (server: string, text: string) =>
  ({ server: Mcp.ServerName.make(server), instructions: text }) satisfies Mcp.ServerInstructions

const schema = { type: "object" as const }
const tool = (server: string, name = "search") =>
  ({ server: Mcp.ServerName.make(server), name, inputSchema: schema }) satisfies Mcp.Tool

const layer = AppNodeBuilder.build(LayerNode.group([McpInstructions.node, McpTool.node, Tool.node]), [
  ...toolNodeReplacements(),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Mcp.node.replace(
    Layer.mock(Mcp.Service, {
      awaitStartup: () => Effect.void,
      instructions: () =>
        Effect.succeed([instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")]),
      tools: () => Effect.succeed([tool("alpha", "write"), tool("beta")]),
    }),
  ),
])

// Instructions follow the tool snapshot, so they are shared across an exposure and bound by its ceilings as it is.
const load = (permissions: Permission.Ruleset, options?: Tool.SnapshotOptions) =>
  Effect.gen(function* () {
    const mcpTools = yield* McpTool.Service
    const registry = yield* Tool.Service
    const service = yield* McpInstructions.Service
    yield* mcpTools.flush
    return (yield* service.load(yield* registry.snapshot(permissions, options)).pipe(Effect.flatMap(readInitial))).text
  })

describe("McpInstructions", () => {
  it.effect("renders the instructions any ruleset of a shared exposure can reach", () =>
    Effect.gen(function* () {
      const plan = [{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" as const }]
      const build = [{ action: McpTool.name("beta", "search"), resource: "*", effect: "deny" as const }]
      const both = yield* load(plan, { exposure: [plan, build] })

      expect(both).toContain('<server name="alpha">')
      expect(both).toContain('<server name="beta">')
      expect(yield* load(build, { exposure: [build, plan] })).toBe(both)
      expect(yield* load(plan)).not.toContain('<server name="alpha">')
    }).pipe(Effect.provide(layer)),
  )

  it.effect("omits instructions a delegation ceiling puts out of reach, whatever the exposure allows", () =>
    Effect.gen(function* () {
      const delegator = { sessionID: SessionSchema.ID.make("ses_parent"), agent: Agent.ID.make("plan") }
      const ceiling = (rules: Permission.Ruleset): Permission.Ceiling => ({
        delegator,
        rules: [{ action: "*", resource: "*", effect: "allow" }, ...rules],
      })
      const bounded = yield* load([], {
        exposure: [[]],
        ceilings: [ceiling([{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" }])],
      })

      expect(bounded).not.toContain('<server name="alpha">')
      expect(bounded).toContain('<server name="beta">')
      // Without execute, Code Mode server tools are exposed directly, so their instructions stay.
      const direct = yield* load([], {
        exposure: [[]],
        ceilings: [ceiling([{ action: "execute", resource: "*", effect: "deny" }])],
      })
      expect(direct).toContain('<server name="alpha">')
      expect(direct).toContain('<server name="beta">')
    }).pipe(Effect.provide(layer)),
  )
})
