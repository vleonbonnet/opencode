// A Session stack whose model is a scripted Anthropic Messages (or OpenAI Chat) provider behind a fake HTTP client:
// every request is recorded, nothing leaves the process, and replies (streams or errors) are queued by the test.

import { LanguageModel } from "@opencode/ai"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import { Auth, LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCache } from "@opencode/core/session/cache/service"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionContext } from "@opencode/core/session/context"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { promptLocationNode } from "../fixture/prompt-location"
import { permissionLayer } from "./permission"

export const BASE_URL = "https://api.anthropic.test/v1"
export const MODEL_ID = "claude-fable-5-1"

type Usage = { readonly input: number; readonly output: number; readonly read?: number; readonly write?: number }

/** One reply of the scripted provider; a deferred one holds the request open until the test settles it. */
export type Reply =
  | { readonly type: "stream"; readonly body: string }
  | { readonly type: "error"; readonly status: number; readonly body: string }
  | { readonly type: "deferred"; readonly reply: Promise<Reply> }

const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

/**
 * An Anthropic Messages stream: optional signed thinking, then text, with the usage and request transformations. Like
 * Anthropic under the thinking-binding beta it lists the transformations, none by default; `false` leaves the list out,
 * as a gateway that does not relay it would.
 */
export const turn = (input: {
  readonly thinking?: { readonly text: string; readonly signature: string }
  readonly text: string
  readonly usage?: Usage
  readonly transformations?: ReadonlyArray<unknown> | false
}): Reply => {
  const usage = input.usage ?? { input: 10, output: 5 }
  const blocks: unknown[] = []
  let index = 0
  if (input.thinking) {
    blocks.push(
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: input.thinking.text } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: input.thinking.signature } },
      { type: "content_block_stop", index },
    )
    index++
  }
  blocks.push(
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text: input.text } },
    { type: "content_block_stop", index },
  )
  return {
    type: "stream",
    body: sse([
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input,
            output_tokens: 0,
            cache_read_input_tokens: usage.read ?? 0,
            cache_creation_input_tokens: usage.write ?? 0,
          },
          ...(input.transformations === false ? {} : { input_transformations: input.transformations ?? [] }),
        },
      },
      ...blocks,
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.output },
      },
      { type: "message_stop" },
    ]),
  }
}

/** The provider rejecting a request, as Anthropic does with prefix_mismatch_behavior "error". */
export const refusal = (message: string): Reply => ({
  type: "error",
  status: 400,
  body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
})

/**
 * The Claude API's refusal of the thinking block at PATH under `prefix_mismatch_behavior: "error"`, as documented
 * (preserved thinking, "Breaking change 3") with the closing sentence that names what changed, as recorded from
 * Bedrock in packages/ai/test/fixtures/recordings/bedrock-converse-thinking-binding/
 * keeps-a-session-working-after-the-system-prompt-changes.json.
 */
export const staleSignature = (path: string) =>
  `${path}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. ` +
  'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". ' +
  "The `system` prompt differs from the one this block was created with."

/** An OpenAI Chat stream: text, then the usage (`read` cached prompt tokens). */
export const chatTurn = (input: { readonly text: string; readonly usage?: Usage }): Reply => {
  const usage = input.usage ?? { input: 10, output: 5 }
  const chunk = (body: object) => `data: ${JSON.stringify({ id: "chatcmpl_test", ...body })}\n\n`
  return {
    type: "stream",
    body:
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: input.text }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      chunk({
        choices: [],
        usage: {
          prompt_tokens: usage.input + (usage.read ?? 0),
          completion_tokens: usage.output,
          prompt_tokens_details: { cached_tokens: usage.read ?? 0 },
        },
      }) +
      "data: [DONE]\n\n",
  }
}

export interface Sent {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: any
}

/** The scripted provider: queue replies with `reply`, inspect `requests`. Running out of replies is a test error. */
export const makeProvider = () => {
  const requests: Sent[] = []
  const replies: Reply[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const text = yield* Effect.promise(() => web.text())
        requests.push({ url: web.url, headers: Object.fromEntries(web.headers.entries()), body: JSON.parse(text) })
        const queued = replies.shift()
        if (!queued) return yield* Effect.die(new Error(`unscripted provider request ${requests.length}`))
        const next = queued.type === "deferred" ? yield* Effect.promise(() => queued.reply) : queued
        if (next.type === "deferred") return yield* Effect.die(new Error("a deferred reply must settle to a reply"))
        return HttpClientResponse.fromWeb(
          request,
          next.type === "stream"
            ? new Response(next.body, { status: 200, headers: { "content-type": "text/event-stream" } })
            : new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } }),
        )
      }),
    ),
  )
  return { requests, reply: (...items: Reply[]) => void replies.push(...items), pending: () => replies.length, layer }
}

export type Provider = ReturnType<typeof makeProvider>

const route = AnthropicMessages.route.with({
  endpoint: { baseURL: BASE_URL },
  auth: Auth.header("x-api-key", "test-key"),
})
const chatRoute = OpenAIChat.route.with({ endpoint: { baseURL: BASE_URL }, auth: Auth.bearer("chat-key") })
const resolvedModel = (model: LanguageModel, variant?: string, credential = "key:test-key") =>
  SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
    // As the resolver names the stored key the route authenticates with.
    credential,
  })
/** Models the test stack resolves: the session's default, another model on the same gateway, a variant of the
 * default whose thinking config differs (it keys only the messages region of the cache), and an OpenAI Chat model. */
export const models = {
  primary: resolvedModel(route.model({ id: MODEL_ID })),
  chat: resolvedModel(chatRoute.model({ id: "gpt-chat" }), undefined, "key:chat-key"),
  other: resolvedModel(route.model({ id: "claude-mythos-5-1" })),
  deep: resolvedModel(
    route.model({ id: MODEL_ID, defaults: { providerOptions: { thinking: { type: "enabled", budgetTokens: 4096 } } } }),
    "deep",
  ),
}
const modelService = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.succeed(
      session.model?.id === "claude-mythos-5-1"
        ? models.other
        : session.model?.id === "gpt-chat"
          ? models.chat
          : session.model?.variant === "deep"
            ? models.deep
            : models.primary,
    ),
})

const empty = {
  builtins: Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) }),
  discovery: Layer.mock(InstructionDiscovery.Service, {
    project: true,
    global: true,
    load: () => Effect.succeed(Instructions.empty),
  }),
  skills: Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
  references: Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
  mcp: Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
}
const catalog = Layer.mock(Model.Service, {
  get: () => Effect.undefined,
  all: () => Effect.succeed([]),
  available: () => Effect.succeed([]),
  default: () => Effect.undefined,
  small: () => Effect.undefined,
})

/** The Session stack over PROVIDER's HTTP client. */
export const stack = (provider: Provider) => {
  const executor = RequestExecutor.layer.pipe(Layer.provide(provider.layer))
  const client = LLMClient.layer.pipe(Layer.provide(executor))
  const permission = permissionLayer()
  const config = Config.testLayer()
  const replacements = [
    Snapshot.node.replace(Snapshot.noopLayer),
    LayerNodePlatform.llmClient.replace(client),
    SessionRunnerModel.node.replace(modelService),
    InstructionBuiltIns.node.replace(empty.builtins),
    InstructionDiscovery.node.replace(empty.discovery),
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    SkillInstructions.node.replace(empty.skills),
    ReferenceInstructions.node.replace(empty.references),
    McpInstructions.node.replace(empty.mcp),
    Config.node.replace(config),
    Permission.node.replace(permission),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  ]
  const runner = AppNodeBuilder.build(SessionRunnerLLM.node, replacements)
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.drain({ sessionID, force }).pipe(Effect.asVoid),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: (sessionID) => coordinator.interrupt(sessionID),
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  ).pipe(Layer.provide(runner), Layer.orDie)
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      KV.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      Model.node,
      PluginHooks.node,
      Tool.node,
      Command.node,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionContext.node,
      SessionCompaction.node,
      SessionCache.node,
      SessionRunnerLLM.node,
      Session.node,
    ]),
    [
      ...replacements,
      Bus.node.replace(Bus.configured({ persist: true })),
      LocationServiceMap.node.replace(promptLocationNode),
      Model.node.replace(catalog),
      SessionExecution.node.replace(execution),
    ],
  )
}

/** A Session in /project on the primary model with the build agent. */
export const createSession = Effect.fn("test.createSession")(function* (sessionID: Session.ID) {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.permissions.push({ action: "execute", resource: "*", effect: "deny" })
    }),
  )
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "cache",
      directory: "/project",
      title: "cache",
      version: "test",
      agent: Agent.ID.make("build"),
      model: { id: MODEL_ID, providerID: String(models.primary.ref.providerID) },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** Wait for the ledger's Bus subscriber: polls in real time, since the test clock never advances by itself. */
export const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>, what: string, attempts = 2_000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.promise(() => Bun.sleep(1))
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

/** The Session's ledger record once COUNT requests of it were confirmed. */
export const confirmed = (sessionID: Session.ID, count: number) =>
  eventually(
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const record = (yield* kv.get(`session-cache:${sessionID}`)) as
        | { verifications?: unknown[]; last?: unknown }
        | undefined
      return record?.last && (record.verifications?.length ?? 0) >= count ? record : undefined
    }),
    `${count} confirmed request(s)`,
  )
