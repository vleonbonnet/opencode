import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Mcp } from "@opencode/core/mcp/index"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import type { Permission } from "@opencode/core/permission"
import { SessionSchema } from "@opencode/core/session/schema"
import { McpTool } from "@opencode/core/tool/mcp"
import { it } from "../lib/effect"
import { readInitial } from "../lib/instructions"

// The catalog fixtures of the upstream McpInstructions tests.
const instructions = (server: string, text: string) =>
  ({ server: Mcp.ServerName.make(server), instructions: text }) satisfies Mcp.ServerInstructions

const schema = { type: "object" as const }
const tool = (server: string, name = "search") =>
  ({ server: Mcp.ServerName.make(server), name, inputSchema: schema }) satisfies Mcp.Tool

const layer = (catalog: () => Mcp.ServerInstructions[], tools: () => Mcp.Tool[]) =>
  AppNodeBuilder.build(McpInstructions.node, [
    Mcp.node.replace(
      Layer.mock(Mcp.Service, {
        instructions: () => Effect.succeed(catalog()),
        tools: () => Effect.succeed(tools()),
      }),
    ),
  ])

describe("McpInstructions", () => {
  it.effect("renders the instructions any ruleset of a shared exposure can reach", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const plan = [{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" as const }]
      const build = [{ action: McpTool.name("beta", "search"), resource: "*", effect: "deny" as const }]
      const both = (yield* service.load(plan, [plan, build]).pipe(Effect.flatMap(readInitial))).text

      expect(both).toContain('<server name="alpha">')
      expect(both).toContain('<server name="beta">')
      expect((yield* service.load(build, [build, plan]).pipe(Effect.flatMap(readInitial))).text).toBe(both)
      expect((yield* service.load(plan).pipe(Effect.flatMap(readInitial))).text).not.toContain('<server name="alpha">')
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")],
          () => [tool("alpha", "write"), tool("beta")],
        ),
      ),
    ),
  )

  it.effect("omits instructions a delegation ceiling puts out of reach, whatever the exposure allows", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const delegator = { sessionID: SessionSchema.ID.make("ses_parent"), agent: Agent.ID.make("plan") }
      const ceiling = (rules: Permission.Ruleset): Permission.Ceiling => ({
        delegator,
        rules: [{ action: "*", resource: "*", effect: "allow" }, ...rules],
      })
      const bounded = (yield* service
        .load([], [[]], [ceiling([{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" }])])
        .pipe(Effect.flatMap(readInitial))).text

      expect(bounded).not.toContain('<server name="alpha">')
      expect(bounded).toContain('<server name="beta">')
      // Without execute, Code Mode server tools are exposed directly, so their instructions stay.
      const direct = (yield* service
        .load([], [[]], [ceiling([{ action: "execute", resource: "*", effect: "deny" }])])
        .pipe(Effect.flatMap(readInitial))).text
      expect(direct).toContain('<server name="alpha">')
      expect(direct).toContain('<server name="beta">')
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")],
          () => [tool("alpha", "write"), tool("beta")],
        ),
      ),
    ),
  )
})
