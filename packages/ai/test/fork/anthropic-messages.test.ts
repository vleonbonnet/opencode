import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, CacheHint } from "../../src/effect.js"
import { Auth, LLMClient } from "../../src/route.js"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

// The model and request of the upstream Anthropic Messages route tests.
const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const request = ai.request({
  id: "req_1",
  model,
  system: { type: "text", text: "You are concise.", cache: new CacheHint({ type: "ephemeral" }) },
  prompt: "Say hello.",
  cache: "none",
  maxTokens: 20,
  temperature: 0,
})

describe("Anthropic Messages route", () => {
  it.effect("reports request transformations from message_start on the finish", () =>
    Effect.gen(function* () {
      const transformations = [{ type: "thinking_dropped", path: "messages.1.content.0" }]
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 }, input_transformations: transformations } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: "\n\nHuman:" },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const finishes = response.events.filter((event) => event.type === "step-finish" || event.type === "finish")
      expect(finishes.length).toBeGreaterThan(0)
      for (const finish of finishes)
        expect(finish).toMatchObject({
          providerMetadata: { anthropic: { stopSequence: "\n\nHuman:", inputTransformations: transformations } },
        })

      // An empty list is a report that nothing changed, unlike a response without one.
      const finishOf = (start: Record<string, unknown>) =>
        LLMClient.generate(request).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "message_start", message: { usage: { input_tokens: 5 }, ...start } },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
              ),
            ),
          ),
          Effect.map((response) => response.events.at(-1)),
        )
      const reported = yield* finishOf({ input_transformations: [] })
      expect(reported?.type).toBe("finish")
      expect(reported?.type === "finish" ? reported.providerMetadata : "missing").toEqual({
        anthropic: { inputTransformations: [] },
      })
      const silent = yield* finishOf({})
      expect(silent?.type).toBe("finish")
      expect(silent?.type === "finish" ? silent.providerMetadata : "missing").toBeUndefined()
    }),
  )
})
