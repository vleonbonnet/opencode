import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { CacheReplay } from "@opencode/core/session/cache/replay"
import { SessionMessage } from "@opencode/core/session/message"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"

const created = DateTime.makeUnsafe(0)
const ref = (id: string) => Model.Ref.make({ id: Model.ID.make(id), providerID: Provider.ID.make("provider") })
const gpt = ref("gpt-5")
const claude = ref("claude-opus-5-5")
const reasoning = (text: string, signature: string) =>
  SessionMessage.AssistantReasoning.make({
    type: "reasoning",
    text,
    native: { signature },
    time: { created, completed: created },
  })
const text = (value: string) => SessionMessage.AssistantText.make({ type: "text", text: value })
const assistant = (model: Model.Ref, content: SessionMessage.Assistant["content"], finish?: "stop") =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_replay"),
    type: "assistant",
    agent: Agent.defaultID,
    model,
    content,
    ...(finish ? { finish } : {}),
    time: { created, completed: created },
  })
const dropped = (ordinal: number, reason?: string) => ({
  messageID: SessionMessage.ID.make("msg_replay"),
  ordinal,
  asText: false,
  ...(reason ? { reason } : {}),
})
const request = (model: Model.Ref, message: SessionMessage.Assistant, markers: CacheReplay.DroppedReasoning[]) =>
  toLLMMessages(CacheReplay.apply([message], model, markers), model).flatMap((item): unknown[] => [...item.content])

describe("CacheReplay", () => {
  test("replays a block dropped with consent as earlier reasoning where the model may read it", () => {
    const message = assistant(gpt, [reasoning("first", "sig_1"), reasoning("second", "sig_2"), text("answer")], "stop")
    expect(request(gpt, message, [dropped(1, "dropped with consent at step 3")])).toEqual([
      expect.objectContaining({ type: "reasoning", text: "first" }),
      { type: "text", text: CacheReplay.earlierReasoning("second") },
      expect.objectContaining({ type: "text", text: "answer" }),
    ])
  })

  test("leaves a dropped block out of Claude turns and out of turns nobody consented to", () => {
    const message = assistant(claude, [reasoning("stale", "sig_1"), text("answer")], "stop")
    expect(request(claude, message, [dropped(0, "dropped with consent at step 3")])).toEqual([
      expect.objectContaining({ type: "text", text: "answer" }),
    ])
    expect(request(gpt, assistant(gpt, [reasoning("stale", "sig_1"), text("answer")], "stop"), [dropped(0)])).toEqual([
      expect.objectContaining({ type: "text", text: "answer" }),
    ])
  })

  test("in a cut stream, leaves out reasoning that only a dropped block follows, as the request builder does", () => {
    // No finish: the stream was cut, so reasoning replays only once the model moved on to output.
    const message = assistant(gpt, [reasoning("kept", "sig_1"), reasoning("stale", "sig_2")])
    expect(request(gpt, message, [{ ...dropped(1), asText: true }])).toEqual([
      { type: "text", text: CacheReplay.earlierReasoning("stale") },
    ])
  })

  test("returns the history unchanged without dropped blocks", () => {
    const messages = [assistant(gpt, [reasoning("first", "sig_1")], "stop")]
    expect(CacheReplay.apply(messages, gpt, [])).toBe(messages)
    expect(CacheReplay.apply(messages, gpt, undefined)).toBe(messages)
  })
})
