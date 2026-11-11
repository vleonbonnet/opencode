import { describe, expect } from "bun:test"
import { Effect, Redacted, Schema } from "effect"
import { ai } from "../../src/effect.js"
import { AnthropicMessages, OpenAIResponses } from "../../src/protocols.js"
import { Auth, LLMClient } from "../../src/route.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("compileHttpRequest", () => {
  it.effect("returns the URL, authenticated headers, and overlaid body the HTTP transport sends", () =>
    Effect.gen(function* () {
      const model = OpenAIResponses.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("secret") })
        .model({ id: "gpt-5.5" })
      const request = ai.request({
        model,
        prompt: "Say hello.",
        cache: "none",
        headers: { "x-extra": "1" },
        http: { body: { store: false } },
      })
      const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = []
      yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              sent.push({ url: input.request.url, headers: { ...input.request.headers }, body: input.text })
              return input.respond(
                sseEvents({
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    status: "completed",
                    output: [],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
        Effect.ignore,
      )
      const compiled = yield* LLMClient.compileHttpRequest(request)
      expect(sent).toHaveLength(1)
      expect(compiled.url).toBe(sent[0].url)
      expect(compiled.body).toBe(sent[0].body)
      expect(decodeJson(compiled.body)).toMatchObject({ model: "gpt-5.5", store: false })
      expect(compiled.headers.authorization).toBe("Bearer secret")
      expect(compiled.headers["x-extra"]).toBe("1")
    }),
  )

  it.effect("renders the request without authenticating it when asked", () =>
    Effect.gen(function* () {
      let loaded = 0
      const credential = Auth.effect(Effect.sync(() => (loaded++, Redacted.make("secret"))))
      const request = ai.request({
        model: AnthropicMessages.route
          .with({ endpoint: { baseURL: "https://api.anthropic.test/v1" }, auth: credential.header("x-api-key") })
          .model({ id: "claude-opus-5-5" }),
        prompt: "Say hello.",
        headers: { "x-extra": "1" },
        http: { body: { metadata: { user_id: "u" } } },
      })
      const rendered = yield* LLMClient.compileHttpRequest(request, { authenticate: false })
      expect(loaded).toBe(0)
      expect(rendered.headers["x-api-key"]).toBeUndefined()
      expect(rendered.headers["x-extra"]).toBe("1")
      const compiled = yield* LLMClient.compileHttpRequest(request)
      expect(loaded).toBe(1)
      expect(compiled.headers["x-api-key"]).toBe("secret")
      expect(rendered.url).toBe(compiled.url)
      expect(rendered.body).toBe(compiled.body)
      expect(decodeJson(rendered.body)).toMatchObject({ model: "claude-opus-5-5", metadata: { user_id: "u" } })
    }),
  )
})
