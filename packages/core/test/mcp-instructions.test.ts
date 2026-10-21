import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Mcp } from "@opencode/core/mcp/index"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import type { Permission } from "@opencode/core/permission"
import { SessionSchema } from "@opencode/core/session/schema"
import { McpTool } from "@opencode/core/tool/mcp"
import { it } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"

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
  it.effect("renders instructions for servers with at least one permitted tool", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const generation = yield* service
        .load([
          [
            { action: McpTool.name("alpha", "restricted"), resource: "*", effect: "deny" },
            { action: McpTool.name("hidden", "search"), resource: "*", effect: "deny" },
          ],
        ])
        .pipe(Effect.flatMap(readInitial))

      expect(generation.text).toBe(
        [
          "<mcp_instructions>",
          '  <server name="alpha">',
          '    Use tools from this server through `execute` under `tools["alpha"]`.',
          "    Alpha line one",
          "    Alpha line two",
          "  </server>",
          '  <server name="beta">',
          '    Use tools from this server through `execute` under `tools["beta"]`.',
          "    Beta instructions",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }).pipe(
      Effect.provide(
        layer(
          () => [
            instructions("beta", "Beta instructions"),
            instructions("unused", "No tools"),
            instructions("hidden", "Denied tool"),
            instructions("alpha", "Alpha line one\nAlpha line two"),
          ],
          () => [tool("alpha"), tool("alpha", "restricted"), tool("beta"), tool("hidden")],
        ),
      ),
    ),
  )

  it.effect("omits instructions when the agent cannot use execute", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const generation = yield* service
        .load([[{ action: "execute", resource: "*", effect: "deny" }]])
        .pipe(Effect.flatMap(readInitial))

      expect(generation.text).toBe("")
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions")],
          () => [tool("alpha")],
        ),
      ),
    ),
  )

  it.effect("renders the instructions any ruleset of a shared exposure can reach", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const plan = [{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" as const }]
      const build = [{ action: McpTool.name("beta", "search"), resource: "*", effect: "deny" as const }]
      const both = (yield* service.load([plan, build]).pipe(Effect.flatMap(readInitial))).text

      expect(both).toContain('<server name="alpha">')
      expect(both).toContain('<server name="beta">')
      expect((yield* service.load([build, plan]).pipe(Effect.flatMap(readInitial))).text).toBe(both)
      expect((yield* service.load([plan]).pipe(Effect.flatMap(readInitial))).text).not.toContain('<server name="alpha">')
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
        .load([[]], [ceiling([{ action: McpTool.name("alpha", "write"), resource: "*", effect: "deny" }])])
        .pipe(Effect.flatMap(readInitial))).text

      expect(bounded).not.toContain('<server name="alpha">')
      expect(bounded).toContain('<server name="beta">')
      expect(
        (yield* service
          .load([[]], [ceiling([{ action: "execute", resource: "*", effect: "deny" }])])
          .pipe(Effect.flatMap(readInitial))).text,
      ).toBe("")
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")],
          () => [tool("alpha", "write"), tool("beta")],
        ),
      ),
    ),
  )

  it.effect("keeps MCP instructions when Code Mode is disabled and execute is denied", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const generation = yield* service
        .load([[{ action: "execute", resource: "*", effect: "deny" }]])
        .pipe(Effect.flatMap(readInitial))

      expect(generation.text).toBe(
        [
          "<mcp_instructions>",
          '  <server name="alpha">',
          "    Alpha instructions",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions")],
          () => [
            {
              server: Mcp.ServerName.make("alpha"),
              name: "search",
              inputSchema: schema,
              codemode: false,
            } satisfies Mcp.Tool,
          ],
        ),
      ),
    ),
  )

  it.effect("replaces a server entry when Code Mode is disabled for it", () => {
    let tools: Mcp.Tool[] = [tool("alpha")]
    return Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const initialized = yield* service.load([[]]).pipe(Effect.flatMap(readInitial))

      tools = [{ ...tool("alpha"), codemode: false }]
      const changed = yield* readUpdate(yield* service.load([[]]), initialized)
      expect(changed.text).toBe(
        [
          "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
          '  <server name="alpha">',
          "    Alpha instructions",
          "  </server>",
        ].join("\n"),
      )
    }).pipe(
      Effect.provide(
        layer(
          () => [instructions("alpha", "Alpha instructions")],
          () => tools,
        ),
      ),
    )
  })

  it.effect("renders additions, changes, and removal", () => {
    let catalog = [instructions("alpha", "Alpha instructions")]
    const tools = [tool("alpha"), tool("beta")]
    return Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const initialized = yield* service.load([[]]).pipe(Effect.flatMap(readInitial))

      catalog = [instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")]
      const added = yield* readUpdate(yield* service.load([[]]), initialized)
      expect(added.text).toBe(
        [
          "New MCP server instructions are available in addition to those previously listed:",
          '  <server name="beta">',
          '    Use tools from this server through `execute` under `tools["beta"]`.',
          "    Beta instructions",
          "  </server>",
        ].join("\n"),
      )

      catalog = [instructions("alpha", "Updated alpha"), instructions("beta", "Beta instructions")]
      const changed = yield* readUpdate(yield* service.load([[]]), added)
      expect(changed.text).toBe(
        [
          "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
          '  <server name="alpha">',
          '    Use tools from this server through `execute` under `tools["alpha"]`.',
          "    Updated alpha",
          "  </server>",
        ].join("\n"),
      )

      catalog = [instructions("beta", "Beta instructions")]
      const removed = yield* readUpdate(yield* service.load([[]]), changed)
      expect(removed.text).toBe("Instructions for the following MCP servers are no longer available: alpha.")

      catalog = []
      expect((yield* readUpdate(yield* service.load([[]]), removed)).text).toBe(
        "MCP server instructions are no longer available.",
      )
    }).pipe(
      Effect.provide(
        layer(
          () => catalog,
          () => tools,
        ),
      ),
    )
  })
})
