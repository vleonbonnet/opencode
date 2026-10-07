import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionTools } from "@/session/tools"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

// What the fakes saw, reset by each test through `fresh`.
let asked: { permission: string; patterns: readonly string[] }[] = []
let hookInputs: any[] = []
let mcpCalls: unknown[] = []
let builtinCalls: unknown[] = []

// Describes a write to any `path` argument as an `edit` of that path, the way
// a plugin that knows an MCP server's file tools would.
const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((name: string, input: any, output: any) =>
      Effect.sync(() => {
        if (name !== "tool.permission") return output
        hookInputs.push(input)
        if (typeof input.args?.path === "string")
          output.checks.push({
            permission: "edit",
            patterns: [input.args.path],
            metadata: { filepath: input.args.path },
          })
        return output
      })) as Plugin.Interface["trigger"],
  }),
)

// Applies the agent's rules as the real service does, but answers every
// prompt with "once" so a test can see what asked.
const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) =>
      Effect.gen(function* () {
        asked.push({ permission: input.permission, patterns: input.patterns })
        for (const pattern of input.patterns) {
          if (Permission.evaluate(input.permission, pattern, input.ruleset).action === "deny")
            return yield* new (yield* Effect.promise(
              () => import("@opencode-ai/core/v1/permission"),
            )).PermissionV1.DeniedError({
              ruleset: input.ruleset,
            })
        }
      }),
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const mcpLayer = Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({}),
  tools: () =>
    Effect.succeed({
      srv_write: {
        def: {
          name: "write",
          description: "writes a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        client: {
          callTool: async (params: { arguments?: unknown }) => {
            mcpCalls.push(params.arguments)
            return { content: [{ type: "text", text: "written" }] }
          },
        } as unknown as MCP.McpTool["client"],
      },
    }),
})

const registryLayer = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({
    ids: () => Effect.succeed(["touch"]),
    all: () => Effect.succeed([]),
    named: () => Effect.die("unused"),
    tools: () =>
      Effect.succeed([
        {
          id: "touch",
          description: "a built-in tool",
          parameters: Schema.Struct({}),
          jsonSchema: { type: "object", properties: {} },
          execute: (args: unknown) =>
            Effect.sync(() => {
              builtinCalls.push(args)
              return { title: "touch", metadata: {}, output: "touched" }
            }),
        } satisfies Tool.Def,
      ]),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    pluginLayer,
    permissionLayer,
    mcpLayer,
    registryLayer,
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    RuntimeFlags.layer(),
  ),
)

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

const allowAll: PermissionV1.Rule = { permission: "*", pattern: "*", action: "allow" }

function fresh() {
  asked = []
  hookInputs = []
  mcpCalls = []
  builtinCalls = []
}

const call = Effect.fn("test.call")(function* (
  name: string,
  agent: string,
  rules: PermissionV1.Rule[],
  args: object,
  exposure?: PermissionV1.Rule[][],
) {
  const tools = yield* SessionTools.resolve({
    exposure,
    agent: { name: agent, mode: "primary", options: {}, permission: rules },
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
  const execute = tools[name]?.execute
  if (!execute) throw new Error(`${name} is missing`)
  return yield* Effect.promise(
    (): Promise<Exit.Exit<void>> =>
      Promise.resolve(
        execute(args, { toolCallId: "call_1", abortSignal: new AbortController().signal, messages: [] }),
      ).then(
        () => Exit.void,
        (error: unknown) => Exit.die(error),
      ),
  )
})

describe("session.tools tool.permission", () => {
  it.instance("runs an MCP tool's added checks against the calling agent's rules, after its own", () =>
    Effect.gen(function* () {
      fresh()
      const exit = yield* call("srv_write", "build", [allowAll], { path: "src/a.ts" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(hookInputs).toEqual([
        { tool: "srv_write", agent: "build", sessionID: session.id, callID: "call_1", args: { path: "src/a.ts" } },
      ])
      expect(asked).toEqual([
        { permission: "srv_write", patterns: ["*"] },
        { permission: "edit", patterns: ["src/a.ts"] },
      ])
      expect(mcpCalls).toEqual([{ path: "src/a.ts" }])
    }),
  )

  it.instance("an edit rule refuses an MCP write the tool's own rule allows", () =>
    Effect.gen(function* () {
      fresh()
      const rules: PermissionV1.Rule[] = [allowAll, { permission: "edit", pattern: "*AGENTS.md", action: "deny" }]
      const exit = yield* call("srv_write", "build", rules, { path: "docs/AGENTS.md" })
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("prevents you from using")
      expect(mcpCalls).toEqual([])
    }),
  )

  it.instance("the same write passes for another path under the same rules", () =>
    Effect.gen(function* () {
      fresh()
      const rules: PermissionV1.Rule[] = [allowAll, { permission: "edit", pattern: "*AGENTS.md", action: "deny" }]
      const exit = yield* call("srv_write", "build", rules, { path: "docs/README.md" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(mcpCalls).toEqual([{ path: "docs/README.md" }])
    }),
  )

  it.instance(
    "a tool the agent denies, listed because another agent allows it, is refused before any added check",
    () =>
      Effect.gen(function* () {
        fresh()
        const rules: PermissionV1.Rule[] = [allowAll, { permission: "srv_write", pattern: "*", action: "deny" }]
        const exit = yield* call("srv_write", "plan", rules, { path: "src/a.ts" }, [[allowAll], rules])
        expect(Exit.isFailure(exit)).toBe(true)
        expect(asked).toEqual([{ permission: "srv_write", patterns: ["*"] }])
        expect(mcpCalls).toEqual([])
      }),
  )

  it.instance("built-in tools pass through the hook too, before they run", () =>
    Effect.gen(function* () {
      fresh()
      const rules: PermissionV1.Rule[] = [allowAll, { permission: "edit", pattern: "secret.txt", action: "deny" }]
      const exit = yield* call("touch", "build", rules, { path: "secret.txt" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(hookInputs.map((input) => input.tool)).toEqual(["touch"])
      expect(builtinCalls).toEqual([])
    }),
  )
})
