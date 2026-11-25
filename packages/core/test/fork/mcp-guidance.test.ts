import { describe, expect, test } from "bun:test"
import { CodeMode, Tool as CodeModeToolDef } from "@opencode/codemode"
import { Effect, Layer, Schema } from "effect"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { ForkCodeModeCatalog } from "@opencode/core/codemode/fork-catalog"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { ForkMcpGuidance } from "@opencode/core/mcp/fork-guidance"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { PermissionPolicy } from "@opencode/core/permission/policy"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionSchema } from "@opencode/core/session/schema"
import { InstructionBlobTable, SessionTable } from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { it, testEffect } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"
import { toolNodeReplacements } from "../lib/tool"

const schema = { type: "object" as const }
const tool = (server: string, name: string, serverDescription?: string) =>
  ({
    server: Mcp.ServerName.make(server),
    name,
    inputSchema: schema,
    ...(serverDescription === undefined ? {} : { serverDescription }),
  }) satisfies Mcp.Tool
const instructions = (server: string, text: string) =>
  ({ server: Mcp.ServerName.make(server), instructions: text }) satisfies Mcp.ServerInstructions

const browserInstructions = "browser drives Firefox. Work in tabs you open.\nAct through the page."

const layer = AppNodeBuilder.build(LayerNode.group([McpInstructions.node, McpTool.node, Tool.node]), [
  ...toolNodeReplacements(),
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Mcp.node.replace(
    Layer.mock(Mcp.Service, {
      awaitStartup: () => Effect.void,
      instructions: () =>
        Effect.succeed([
          instructions("browser", browserInstructions),
          instructions("described", "Long guidance the configured line replaces."),
        ]),
      // MCP tags each tool with its server's line, as `Mcp.tools()` does.
      tools: () =>
        Effect.succeed([
          tool("browser", "open_tab", ForkMcpGuidance.describe(undefined, browserInstructions)),
          tool("described", "lookup", ForkMcpGuidance.describe("Look things up in the archive", "Long guidance.")),
          tool("plain", "run", ForkMcpGuidance.describe(undefined, undefined)),
        ]),
    }),
  ),
])

const snapshot = Effect.gen(function* () {
  yield* (yield* McpTool.Service).flush
  return yield* (yield* Tool.Service).snapshot(PermissionPolicy.fromRules([]))
})

describe("ForkMcpGuidance.summary", () => {
  test("keeps the first sentence of the first line", () => {
    expect(ForkMcpGuidance.summary("schwab reads accounts. Start with accounts.")).toBe("schwab reads accounts.")
    expect(ForkMcpGuidance.summary("Glean MCP Server Usage Guidelines\n\nGlean is a platform.")).toBe(
      "Glean MCP Server Usage Guidelines",
    )
    expect(ForkMcpGuidance.summary("  \n")).toBeUndefined()
    expect(ForkMcpGuidance.summary(undefined)).toBeUndefined()
  })

  test("prefers the configured description over the instructions", () => {
    expect(ForkMcpGuidance.describe("  Search the archive ", "Archive guidance. More.")).toBe("Search the archive")
    expect(ForkMcpGuidance.describe("", "Archive guidance. More.")).toBe("Archive guidance.")
    expect(ForkMcpGuidance.describe(undefined, undefined)).toBeUndefined()
  })

  test("cuts a long sentence at a word boundary", () => {
    const line = ForkMcpGuidance.summary(`${"word ".repeat(60)}end.`)
    expect(line?.endsWith("word…")).toBe(true)
    expect(line!.length).toBeLessThanOrEqual(200)
  })
})

describe("ForkMcpGuidance.namespaceOf", () => {
  test("reads the namespace of dotted and bracketed tool paths", () => {
    expect(ForkMcpGuidance.namespaceOf("tools.reynard.open_tab")).toBe("reynard")
    expect(ForkMcpGuidance.namespaceOf('tools["anvil-eval"]["emacs-eval"]')).toBe("anvil-eval")
    expect(ForkMcpGuidance.namespaceOf('tools.slack["send-message"]')).toBe("slack")
    expect(ForkMcpGuidance.namespaceOf("reynard.open_tab")).toBe("reynard")
    expect(ForkMcpGuidance.namespaceOf("tools")).toBeUndefined()
  })
})

describe("ForkMcpGuidance catalog lines", () => {
  it.effect("describes each server in one line: configured, else its first sentence, else nothing", () =>
    Effect.gen(function* () {
      const tools = yield* snapshot
      const text = (yield* readInitial(
        CodeModeInstructions.make(
          ForkCodeModeCatalog.adapt(tools.codeModeCatalog),
          ForkCodeModeCatalog.signatureBudget,
        ),
      )).text
      expect(text).toContain("- browser (1 tool, none shown) // browser drives Firefox.")
      expect(text).toContain("- described (1 tool, none shown) // Look things up in the archive")
      expect(text.endsWith("\n- plain (1 tool, none shown)")).toBe(true)
      expect(text).not.toContain("Act through the page")
    }).pipe(Effect.provide(layer)),
  )
})

describe("ForkMcpGuidance instructions", () => {
  it.effect("lists a Code Mode server's instructions only once the session loads it", () =>
    Effect.gen(function* () {
      const tools = yield* snapshot
      const service = yield* McpInstructions.Service
      const none = yield* service.load(tools, new Set()).pipe(Effect.flatMap(readInitial))
      expect(none.text).toBe("")

      const browser = yield* service.load(tools, new Set(["browser"])).pipe(Effect.flatMap(readInitial))
      expect(browser.text).toContain('<server name="browser">')
      expect(browser.text).not.toContain('<server name="described">')

      // Loading another server adds it; a change to a server the session never loaded says nothing.
      const both = yield* service
        .load(tools, new Set(["browser", "described"]))
        .pipe(Effect.flatMap((list) => readUpdate(list, browser)))
      expect(both.text).toContain("New MCP server instructions are available")
      expect(both.text).toContain('<server name="described">')
      expect(both.text).not.toContain('<server name="browser">')

      // Without a loaded set (no Session), every reachable server is listed as upstream does.
      const all = yield* service.load(tools).pipe(Effect.flatMap(readInitial))
      expect(all.text).toContain('<server name="browser">')
      expect(all.text).toContain('<server name="described">')
    }).pipe(Effect.provide(layer)),
  )
})

const database = testEffect(AppNodeBuilder.build(Database.node))

const session = (id: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    const sessionID = SessionSchema.ID.make(id)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: id, directory: "/project", version: "t" })
      .run()
    return { db, sessionID }
  })

const commitGuidance = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  value: ReadonlyArray<{ server: string; instructions: string; codemode?: false }>,
) =>
  Effect.gen(function* () {
    const json = value as unknown as Schema.Json
    const hash = Instructions.hash(json)
    yield* db.insert(InstructionBlobTable).values({ hash, value: json }).onConflictDoNothing().run()
    yield* InstructionState.initialize(db, sessionID, 1, { "core/mcp-guidance": hash })
  })

describe("ForkMcpGuidance loaded set", () => {
  database.effect("joins the committed guidance with what the session's runs searched or called", () =>
    Effect.gen(function* () {
      const { db, sessionID } = yield* session("ses_guidance_loaded")
      expect([...(yield* ForkMcpGuidance.loaded(db, sessionID))]).toEqual([])

      yield* commitGuidance(db, sessionID, [
        { server: "schwab", instructions: "Read accounts." },
        { server: "direct", instructions: "Direct only.", codemode: false },
      ])

      const lookup = CodeModeToolDef.make({
        description: "Run",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
      const runtime = CodeMode.make({
        tools: { reynard: { open_tab: lookup }, "anvil-eval": { "emacs-eval": lookup }, slack: { read: lookup } },
        hooks: ForkMcpGuidance.observe({}, sessionID),
      })
      const result = yield* runtime.execute(
        'await search({ namespace: "anvil-eval" }); return await tools.reynard.open_tab({})',
      )
      expect(result.ok).toBe(true)

      const loaded = yield* ForkMcpGuidance.loaded(db, sessionID)
      expect([...loaded].toSorted()).toEqual(["anvil-eval", "reynard", "schwab"])
      // Other sessions see none of it.
      const other = yield* session("ses_guidance_other")
      expect([...(yield* ForkMcpGuidance.loaded(other.db, other.sessionID))]).toEqual([])
    }),
  )
})
