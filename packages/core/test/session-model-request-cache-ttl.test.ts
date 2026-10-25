import { describe, expect } from "bun:test"
import { LanguageModel, LLMRequest, Message, SystemPart } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import {
  AmazonBedrock,
  AmazonBedrockMantle,
  AnthropicCompatible,
  CloudflareAIGateway,
  GoogleVertexMessages,
  MiniMax,
  VercelAIGateway,
} from "@opencode/ai/providers"
import { compileRequest } from "@opencode/ai/route/client"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_cache_ttl"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const oneHour = {
  Anthropic: AnthropicMessages.route.model({ id: "claude-opus-5-5" }),
  "GitHub Copilot Claude": AnthropicMessages.route.model({ id: "claude-opus-5.5", provider: "github-copilot" }),
  "an Anthropic-compatible gateway": AnthropicCompatible.configure({
    apiKey: "fixture",
    baseURL: "https://gateway.example/v1",
    provider: "gateway",
  }).model("claude-sonnet-5-1"),
  "Vertex Claude": GoogleVertexMessages.configure({
    accessToken: "fixture",
    project: "project",
    location: "us-east5",
  }).model("claude-opus-4-5@20251101"),
  "Bedrock Mantle Claude": AmazonBedrockMantle.configure({ apiKey: "fixture", region: "us-east-1" }).messages(
    "anthropic.claude-opus-5-5",
  ),
  "Cloudflare AI Gateway Claude": CloudflareAIGateway.messagesRoute.model({ id: "anthropic/claude-opus-5-5" }),
  "Vercel AI Gateway Claude": VercelAIGateway.configure({ apiKey: "fixture" }).messages("anthropic/claude-opus-5.5"),
} satisfies Record<string, LanguageModel>

const defaultTTL = {
  "a non-Claude model on Anthropic Messages": MiniMax.configure({ apiKey: "fixture" }).messages("MiniMax-M3"),
  "a non-Claude model through Vercel's Anthropic Messages route": VercelAIGateway.configure({
    apiKey: "fixture",
  }).messages("openai/gpt-5.5"),
  "Claude on Bedrock Converse": AmazonBedrock.configure({ apiKey: "fixture", region: "us-east-1" }).model(
    "anthropic.claude-opus-5-5",
  ),
  // Bedrock caches these releases for five minutes only.
  "a five-minute Claude release on Bedrock Mantle": AmazonBedrockMantle.configure({
    apiKey: "fixture",
    region: "us-east-1",
  }).messages("us.anthropic.claude-sonnet-4-20250514-v1:0"),
  "a Claude release Bedrock does not cache, on Bedrock Mantle": AmazonBedrockMantle.configure({
    apiKey: "fixture",
    region: "us-east-1",
  }).messages("anthropic.claude-3-haiku-20240307-v1:0"),
  "an OpenAI Chat model": OpenAIChat.route.model({ id: "gpt-5.5" }),
} satisfies Record<string, LanguageModel>

const prepare = (
  model: LanguageModel,
  kind: "primary" | "compaction" | "generate" | "title" = "primary",
  info: Session.Info = session,
) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests[kind]({
      session: info,
      agent: Agent.ID.make("build"),
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
      system: [SystemPart.make("Base agent instructions"), SystemPart.make("Project instructions")],
      messages: [Message.user("Read the file"), Message.assistant("Reading it now"), Message.user("Continue")],
      tools: {
        definitions: [
          {
            type: "tool",
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        execute: () => Effect.die("unused tool execution"),
      },
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

const cacheControls = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value.flatMap(cacheControls)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) =>
    key !== "cache_control" ? cacheControls(item) : item === undefined ? [] : [item],
  )
}

describe("SessionModelRequest prompt cache TTL", () => {
  for (const [name, model] of Object.entries(oneHour))
    it.effect(`requests a one-hour cache from ${name}`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare(model)
        expect(prepared.request.cache).toMatchObject({ ttlSeconds: 3600 })
        const compiled = yield* compileRequest(prepared.request)
        const markers = cacheControls(compiled.body)
        // Tools, both system parts and the conversation tail, as the default placement chooses.
        expect(markers).toEqual(Array.from({ length: 4 }, () => ({ type: "ephemeral", ttl: "1h" })))
        const auto = yield* compileRequest(LLMRequest.update(prepared.request, { cache: undefined }))
        expect(JSON.stringify(compiled.body).replaceAll(',"ttl":"1h"', "")).toBe(JSON.stringify(auto.body))
      }),
    )

  for (const [name, model] of Object.entries(defaultTTL))
    it.effect(`keeps the default cache for ${name}`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare(model)
        expect(prepared.request.cache).toBeUndefined()
        const compiled = yield* compileRequest(prepared.request)
        expect(JSON.stringify(compiled.body)).not.toContain('"ttl":"1h"')
      }),
    )

  // These run once or back to back, so a one-hour write would cost twice the base input for nothing.
  for (const kind of ["compaction", "generate", "title"] as const)
    it.effect(`keeps the default cache for ${kind} requests`, () =>
      Effect.gen(function* () {
        const prepared = yield* prepare(oneHour.Anthropic, kind)
        expect(prepared.request.cache).toBeUndefined()
        expect(JSON.stringify((yield* compileRequest(prepared.request)).body)).not.toContain('"ttl":"1h"')
      }),
    )

  it.effect("keeps the default cache for a child session", () =>
    Effect.gen(function* () {
      const child = Session.Info.make({ ...session, id: Session.ID.make("ses_cache_ttl_child"), parentID: session.id })
      const prepared = yield* prepare(oneHour.Anthropic, "primary", child)
      expect(prepared.request.cache).toBeUndefined()
      expect(JSON.stringify((yield* compileRequest(prepared.request)).body)).not.toContain('"ttl":"1h"')
    }),
  )
})
