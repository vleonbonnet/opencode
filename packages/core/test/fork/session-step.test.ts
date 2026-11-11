import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ai, LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import type { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { tempGlobalLayer } from "../fixture/global"
import { testEffect } from "../lib/effect"

// The step fixture of the upstream SessionStep tests, saving truncated tool text under a temporary data directory.
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
      // Truncated tool text is saved under the global data directory.
      Global.node.replace(tempGlobalLayer),
    ]),
    TestLLM.testLayer(),
  ),
)

/** Runs one step whose only tool call ends with `executeTool`, returning the error the call was failed with. */
const failedToolCall = (executeTool: SessionModelRequest.Prepared["executeTool"]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(Snapshot.ID.make("snapshot")),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 1_000 },
        cost: [],
      },
    )
    yield* llm.push(
      TestLLM.complete(
        { reason: { normalized: "tool-calls" } },
        LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
      ),
    )
    yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: ai.request({ model: model.model, prompt: "Run one tool" }),
          options: {},
          executeTool,
        },
        retry: () => Effect.succeed({ retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)
    const stored = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
    const tool = stored && "content" in stored.data ? stored.data.content[0] : undefined
    expect(tool).toMatchObject({ type: "tool", state: { status: "error" } })
    return tool?.type === "tool" && tool.state.status === "error" ? tool.state.error : undefined
  })

// MCP servers return isError text of any size; one such error once produced a multi-million-token prompt.
const oversized = Array.from({ length: ToolOutput.MAX_LINES + 500 }, (_, index) => `error line ${index}`).join("\n")

const expectBounded = (error: { readonly message: string } | undefined) =>
  Effect.gen(function* () {
    const lines = (error?.message ?? "").split("\n")
    expect(lines.slice(0, -1)).toEqual(oversized.split("\n").slice(0, ToolOutput.MAX_LINES))
    const saved = /^\[showing lines 1-2000 of 2500; full error saved to (.+)\]$/.exec(lines.at(-1) ?? "")?.[1]
    expect(saved).toBeDefined()
    expect(path.basename(path.dirname(saved!))).toBe(ToolOutput.DIRECTORY)
    expect(yield* Effect.promise(() => fs.readFile(saved!, "utf8"))).toBe(oversized)
  })

it.effect("bounds a failed tool call's error like output and saves the full text", () =>
  Effect.gen(function* () {
    const error = yield* failedToolCall(() => Effect.fail(new Tool.Error({ message: oversized })))
    expect(error).toMatchObject({ type: "tool.execution" })
    yield* expectBounded(error)
  }),
)

it.effect("bounds the error of a tool call that fails without a tool error", () =>
  Effect.gen(function* () {
    yield* expectBounded(yield* failedToolCall(() => Effect.die(new Error(oversized))))
  }),
)

it.effect("keeps the error of a tool that reports bounding it itself", () =>
  Effect.gen(function* () {
    const error = yield* failedToolCall(() =>
      Effect.fail(new Tool.Error({ message: oversized, metadata: { truncated: true, outputPath: "/saved" } })),
    )
    expect(error?.message).toBe(oversized)
  }),
)
