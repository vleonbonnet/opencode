import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { jsonSchema } from "ai"
import { SessionTools } from "@/session/tools"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((name: string, input: { toolID: string }, output: { description: string; parameters: unknown }) => {
      if (name === "tool.definition" && input.toolID === "test_mcp_tool") {
        output.description = "Local MCP metadata"
        output.parameters = jsonSchema({
          type: "object",
          properties: { query: { type: "string", description: "Local query description" } },
          required: ["query"],
        })
      }
      return Effect.void
    }) as Plugin.Interface["trigger"],
  }),
)

const mcpLayer = Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({}),
  tools: () =>
    Effect.succeed({
      test_mcp_tool: {
        def: {
          name: "test",
          description: "Remote MCP metadata",
          inputSchema: { type: "object", properties: {} },
        },
        client: {} as MCP.McpTool["client"],
      },
      denied_mcp_tool: {
        def: {
          name: "denied",
          description: "Remote MCP tool",
          inputSchema: { type: "object", properties: {} },
        },
        client: {} as MCP.McpTool["client"],
      },
    }),
})

const testLayer = Layer.mergeAll(
  pluginLayer,
  mcpLayer,
  Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
  Layer.mock(Permission.Service, {}),
  Layer.mock(Truncate.Service, {}),
  RuntimeFlags.layer(),
)

const it = testEffect(testLayer)

const session = {
  id: SessionID.make("ses_test"),
  slug: "test",
  projectID: ProjectV2.ID.make("project_test"),
  directory: "",
  title: "Test session",
  version: "1.0",
  time: { created: 0, updated: 0 },
} satisfies Session.Info

const processor = {
  message: { id: MessageID.make("msg_test") } as SessionV1.Assistant,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
}

describe("session.tools MCP definitions", () => {
  it.instance("applies tool.definition overrides to MCP tools", () =>
    Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent: { name: "test", mode: "primary", options: {}, permission: [] },
        model: ProviderTest.model(),
        session,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {
          cancel: () => Effect.void,
          resolvePromptParts: () => Effect.succeed([]),
          prompt: () => Effect.die("unused"),
        },
      })

      const tool = tools.test_mcp_tool
      expect(tool?.description).toBe("Local MCP metadata")
      expect((tool?.inputSchema as any).jsonSchema.properties.query.description).toBe("Local query description")
    }),
  )

  it.instance("hides denied MCP tools", () =>
    Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent: {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "denied_mcp_tool", pattern: "*", action: "deny" }],
        },
        model: ProviderTest.model(),
        session,
        processor,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {
          cancel: () => Effect.void,
          resolvePromptParts: () => Effect.succeed([]),
          prompt: () => Effect.die("unused"),
        },
      })

      expect(tools.denied_mcp_tool).toBeUndefined()
      expect(tools.test_mcp_tool).toBeDefined()
    }),
  )
})
