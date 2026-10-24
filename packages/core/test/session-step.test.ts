import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LanguageModel, LLM, LLMEvent } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
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
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { asc, eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

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

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
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
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

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
          request: LLM.request({ model: model.model, prompt: "Run one tool" }),
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

it.effect("records the cost and allowance the endpoint reports instead of the catalog price", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
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
        cost: [
          {
            input: Money.USDPerMillionTokens.make(1),
            output: Money.USDPerMillionTokens.make(2),
            cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
          },
        ],
      },
    )
    yield* llm.push(
      TestLLM.complete({
        reason: { normalized: "stop" },
        usage: { inputTokens: 10, outputTokens: 4, nonCachedInputTokens: 10, cost: 0, allowance: 0.25 },
      }),
    )
    yield* steps.attempt({
      isLocationClosed: () => false,
      sessionID,
      assistantMessageID,
      agent: Agent.defaultID,
      model,
      prepared: {
        retry: () => Effect.void,
        request: LLM.request({ model: model.model, prompt: "Hello" }),
        options: {},
        executeTool: () => Effect.die("no tools"),
      },
      retry: () => Effect.succeed({ retry: false }),
      recoverContinuation: true,
      recoverOverflow: Effect.succeed(false),
    })

    const message = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
    expect(message?.data).toMatchObject({ finish: "stop", cost: 0, allowance: 0.25 })
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
      cost: 0,
      allowance: 0.25,
    })
  }),
)
