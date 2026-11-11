import { expect } from "bun:test"
import { Effect } from "effect"
import { ai } from "../../src/effect.js"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

for (const [id, enabled] of [
  ["claude-fable-5-1", true],
  ["claude-mythos-5-1", true],
  ["claude-fable-5.1", true],
  ["anthropic/claude-fable-5.1", true],
  ["claude-fable-5-1@default", true],
  ["claude-fable-5-1@20260901", true],
  ["claude-sonnet-6", true],
  ["claude-opus-5-20260901", false],
  ["claude-opus-4-8", false],
  ["anthropic/claude-opus-4.8", false],
  ["claude-fable-5@default", false],
  ["kimi-k2.5", false],
] as const) {
  it.effect(`bindsThinking agrees with the thinking-binding default for ${id}`, () =>
    Effect.gen(function* () {
      const request = ai.request({ model: AnthropicMessages.route.model({ id }), prompt: "Hello" })
      const compiled = yield* compileRequest(request)
      expect(AnthropicMessages.bindsThinking(request.model)).toBe(enabled)
      expect(compiled.body.thinking !== undefined).toBe(enabled)
    }),
  )
}

it.effect("follows the request-level prefix mismatch behavior unless provider options spell one out", () =>
  Effect.gen(function* () {
    const compile = (thinkingPrefixMismatch?: "error" | "drop_block", thinking?: unknown) =>
      compileRequest(
        ai.request({
          model: AnthropicMessages.route.model({ id: "claude-fable-5-1" }),
          prompt: "Hello",
          thinkingPrefixMismatch,
          ...(thinking === undefined ? {} : { providerOptions: { thinking } }),
        }),
      ).pipe(Effect.map((compiled) => compiled.body.thinking))
    expect(yield* compile("error")).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } })
    expect(yield* compile("drop_block")).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    })
    expect(yield* compile("error", { type: "adaptive", display: "summarized" })).toEqual({
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "error" },
    })
    expect(
      yield* compile("error", { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }),
    ).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } })
    // Models without thinking binding never carry it.
    const unbound = yield* compileRequest(
      ai.request({
        model: AnthropicMessages.route.model({ id: "claude-opus-4-8" }),
        prompt: "Hello",
        thinkingPrefixMismatch: "error",
      }),
    )
    expect(unbound.body.thinking).toBeUndefined()
  }),
)
