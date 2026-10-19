import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PromptMetadata, THINKING_LOSS } from "../src/session-cache.js"

describe("SessionCache.PromptMetadata", () => {
  const decode = Schema.decodeUnknownSync(PromptMetadata)

  test("types thinkingLoss and keeps every other client key", () => {
    expect(decode({ [THINKING_LOSS]: "ask", client: { id: 1 } })).toEqual({ thinkingLoss: "ask", client: { id: 1 } })
    expect(decode({ thinkingLoss: "accept" })).toEqual({ thinkingLoss: "accept" })
    expect(decode({ tag: "x" })).toEqual({ tag: "x" })
  })

  test("rejects a thinkingLoss outside ask and accept", () => {
    expect(() => decode({ thinkingLoss: true })).toThrow()
    expect(() => decode({ thinkingLoss: "drop" })).toThrow()
  })
})
