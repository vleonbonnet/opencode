import { describe, expect } from "bun:test"
import { LanguageModel, Message, mergeHttpOptions, mergeJsonRecords, SystemPart } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIChat } from "@opencode/ai/protocols"
import { AmazonBedrock, AmazonBedrockMantle, GoogleVertexMessages, MiniMax } from "@opencode/ai/providers"
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
  id: Session.ID.make("ses_thinking_display"),
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

/** The body a request sends: the protocol's lowering with the HTTP body overlaid, as the HTTP transport does. */
const sent = (model: LanguageModel, kind: "primary" | "compaction" | "generate" | "title" = "primary") =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests[kind]({
      session,
      agent: Agent.ID.make("build"),
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
      system: [SystemPart.make("Base agent instructions")],
      messages: [Message.user("Think it through")],
    })
    const compiled = yield* compileRequest(prepared.request)
    const http = mergeHttpOptions(model.route.defaults.http, model.defaults?.http, prepared.request.http)
    return mergeJsonRecords(compiled.body as Record<string, unknown>, http?.body) ?? {}
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

const thinkingOf = (body: Record<string, unknown>) => body.thinking
const converseThinking = (body: Record<string, unknown>) =>
  (body.additionalModelRequestFields as Record<string, unknown> | undefined)?.thinking

const adaptive = (model: LanguageModel) =>
  LanguageModel.update(model, { defaults: { providerOptions: { thinking: { type: "adaptive" } } } })

describe("SessionModelRequest thinking display", () => {
  const messages = {
    Anthropic: AnthropicMessages.route.model({ id: "claude-opus-5-5" }),
    "GitHub Copilot Claude": AnthropicMessages.route.model({ id: "claude-opus-5.5", provider: "github-copilot" }),
    "Vertex Claude": GoogleVertexMessages.configure({
      accessToken: "fixture",
      project: "project",
      location: "us-east5",
    }).model("claude-opus-4-7"),
    "Bedrock Mantle Claude": AmazonBedrockMantle.configure({ apiKey: "fixture", region: "us-east-1" }).messages(
      "anthropic.claude-sonnet-4-6",
    ),
  } satisfies Record<string, LanguageModel>

  for (const [name, model] of Object.entries(messages))
    it.effect(`asks ${name} for summarized adaptive thinking`, () =>
      Effect.gen(function* () {
        for (const kind of ["primary", "compaction", "generate", "title"] as const)
          expect(thinkingOf(yield* sent(adaptive(model), kind))).toMatchObject({
            type: "adaptive",
            display: "summarized",
          })
      }),
    )

  it.effect("asks a Claude 5 request that leaves thinking out for summarized adaptive thinking", () =>
    Effect.gen(function* () {
      // Claude 5.1 and later also bind thinking blocks; the display joins that binding.
      expect(thinkingOf(yield* sent(AnthropicMessages.route.model({ id: "claude-opus-5-5" })))).toEqual({
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      })
      expect(thinkingOf(yield* sent(AnthropicMessages.route.model({ id: "claude-sonnet-5" })))).toEqual({
        type: "adaptive",
        display: "summarized",
      })
      // Claude 4.8 does not think unless asked to, so nothing is added.
      expect(thinkingOf(yield* sent(AnthropicMessages.route.model({ id: "claude-opus-4-8" })))).toBeUndefined()
    }),
  )

  it.effect("keeps an explicit display, other thinking modes and non-Claude models as they are", () =>
    Effect.gen(function* () {
      const claude = AnthropicMessages.route.model({ id: "claude-opus-4-7" })
      const thinking = (value: Record<string, unknown>) =>
        LanguageModel.update(claude, { defaults: { providerOptions: { thinking: value } } })

      expect(thinkingOf(yield* sent(thinking({ type: "adaptive", display: "omitted" })))).toEqual({
        type: "adaptive",
        display: "omitted",
      })
      expect(thinkingOf(yield* sent(thinking({ type: "disabled" })))).toEqual({ type: "disabled" })
      expect(thinkingOf(yield* sent(thinking({ type: "enabled", budgetTokens: 4_000 })))).toEqual({
        type: "enabled",
        budget_tokens: 4_000,
      })
      expect(
        thinkingOf(yield* sent(adaptive(MiniMax.configure({ apiKey: "fixture" }).messages("MiniMax-M3")))),
      ).toEqual({ type: "adaptive" })
      expect(thinkingOf(yield* sent(OpenAIChat.route.model({ id: "gpt-5.5" })))).toBeUndefined()
    }),
  )

  it.effect("adds the display where a body overlay chooses adaptive thinking", () =>
    Effect.gen(function* () {
      const claude = AnthropicMessages.route.model({ id: "claude-opus-4-7" })
      const overlaid = LanguageModel.update(claude, {
        defaults: {
          providerOptions: { thinking: { type: "enabled", budgetTokens: 4_000 } },
          http: { body: { thinking: { type: "adaptive" } } },
        },
      })

      expect(thinkingOf(yield* sent(overlaid))).toEqual({
        type: "adaptive",
        budget_tokens: 4_000,
        display: "summarized",
      })
    }),
  )

  it.effect("asks Claude on Bedrock Converse for summarized adaptive thinking", () =>
    Effect.gen(function* () {
      const bedrock = AmazonBedrock.configure({ apiKey: "fixture", region: "us-east-1" })
      // Variants send Converse's adaptive thinking through the body.
      const body = (id: string, thinking: Record<string, unknown>) =>
        LanguageModel.update(bedrock.model(id), {
          defaults: { http: { body: { additionalModelRequestFields: { thinking, output_config: { effort: "high" } } } } },
        })

      expect(converseThinking(yield* sent(body("anthropic.claude-sonnet-4-6", { type: "adaptive" })))).toEqual({
        type: "adaptive",
        display: "summarized",
      })
      expect(converseThinking(yield* sent(bedrock.model("anthropic.claude-opus-5-5")))).toEqual({
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      })
      expect(converseThinking(yield* sent(bedrock.model("us.anthropic.claude-sonnet-5")))).toEqual({
        type: "adaptive",
        display: "summarized",
      })
      expect(
        converseThinking(yield* sent(body("anthropic.claude-opus-4-7", { type: "adaptive", display: "omitted" }))),
      ).toEqual({ type: "adaptive", display: "omitted" })
      const manual = LanguageModel.update(bedrock.model("anthropic.claude-sonnet-4-5"), {
        defaults: { providerOptions: { thinking: { type: "enabled", budgetTokens: 4_000 } } },
      })
      expect(converseThinking(yield* sent(manual))).toEqual({ type: "enabled", budget_tokens: 4_000 })
      expect(converseThinking(yield* sent(bedrock.model("anthropic.claude-opus-4-8")))).toBeUndefined()
      expect(converseThinking(yield* sent(bedrock.model("amazon.nova-2-lite-v1:0")))).toBeUndefined()
    }),
  )
})
