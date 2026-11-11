import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai } from "../../src/effect.js"
import { compileRequest } from "../../src/route/client.js"
import { AmazonBedrock } from "../../src/providers.js"
import { it } from "../lib/effect.js"

const binding = { prefix_mismatch_behavior: "drop_block" }
const beta = ["thinking-binding-controls-2026-08-01"]

const bedrock = (id: string) =>
  AmazonBedrock.model(id, { baseURL: "https://bedrock-runtime.test", apiKey: "test-bearer" })

describe("Bedrock Converse thinking block binding", () => {
  it.effect("follows the request-level prefix mismatch behavior", () =>
    Effect.gen(function* () {
      const fieldsWith = (thinkingPrefixMismatch: "error" | "drop_block") =>
        compileRequest(
          ai.request({
            model: bedrock("global.anthropic.claude-fable-5-1"),
            prompt: "Say hello.",
            cache: "none",
            thinkingPrefixMismatch,
          }),
        ).pipe(Effect.map((prepared) => prepared.body.additionalModelRequestFields))
      expect(yield* fieldsWith("error")).toEqual({
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
        anthropic_beta: beta,
      })
      expect(yield* fieldsWith("drop_block")).toEqual({
        thinking: { type: "adaptive", block_binding: binding },
        anthropic_beta: beta,
      })
    }),
  )
})
