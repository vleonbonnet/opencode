import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { CacheModel } from "../../src/session/cache/model"
import { CacheLedger } from "../../src/session/cache/ledger"
import { Wire } from "../../src/session/cache/wire"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// Request shapes mirror what @ai-sdk/anthropic and @ai-sdk/openai-compatible
// put on the wire for opencode sessions.

const ANTHROPIC = "https://api.anthropic.com/v1/messages"
const FIREWORKS = "https://api.fireworks.ai/inference/v1/chat/completions"
const OPENAI = "https://api.openai.com/v1/responses"
const CODEX = "https://chatgpt.com/backend-api/codex/responses"
const CC = { type: "ephemeral", ttl: "1h" }

type Body = Record<string, any>

function request(url: string, body: Body, headers: Record<string, string> = {}, time = Date.now()): Wire.Captured {
  return {
    url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "key-a",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
    time,
  }
}

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: { q: { type: "string" } } },
})

function text(value: string, marker = false) {
  return { type: "text", text: value, ...(marker ? { cache_control: CC } : {}) }
}

// opencode's applyCaching: first two system blocks and the last two messages.
function anthropicBody(messages: Body[], extra: Body = {}): Body {
  const marked = messages.map((message, index) =>
    index >= messages.length - 2
      ? {
          ...message,
          content: message.content.map((block: Body, i: number) =>
            i === message.content.length - 1 ? { ...block, cache_control: CC } : block,
          ),
        }
      : message,
  )
  return {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    system: [text("You are opencode. ".repeat(200), true)],
    tools: [tool("read"), tool("edit")],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    stream: true,
    messages: marked,
    ...extra,
  }
}

const user = (...blocks: string[]) => ({ role: "user", content: blocks.map((value) => text(value)) })
const assistant = (...blocks: string[]) => ({ role: "assistant", content: blocks.map((value) => text(value)) })

function send(sessionID: string, captured: Wire.Captured, usage: { input: number; read: number; write: number }) {
  // Simulate what the wire hook and processor do for a real request.
  const listeners = Wire as any
  void listeners
  CacheLedger.observe(sessionID, usage)
}

// Record a request exactly the way the global fetch hook does.
async function wire(sessionID: string, captured: Wire.Captured) {
  const seen: Wire.Captured[] = []
  const off = Wire.onCapture((_tag, value) => seen.push(value))
  const original = globalThis.fetch
  try {
    // A fresh function: install() must patch it (the sentinel is per function).
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch
    Wire.install()
    await globalThis.fetch(captured.url, {
      method: "POST",
      headers: { ...captured.headers, ...Wire.header({ mode: "send", id: Wire.nextID(), sessionID }) },
      body: captured.body,
    })
  } finally {
    off()
    globalThis.fetch = original
  }
  return seen[0]
}

beforeEach(() => CacheLedger.reset())
afterEach(() => CacheLedger.reset())

describe("CacheModel.normalize (anthropic)", () => {
  const history = [user("hello"), assistant("hi"), user("next")]
  const base = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history)))

  test("detects the format and breakpoints with their TTL", () => {
    expect(base.format).toBe("anthropic")
    expect(base.automatic).toBe(false)
    const points = base.blocks.filter((block) => block.breakpoint)
    expect(points.map((block) => block.path)).toEqual([
      "system[0]",
      "messages[1].content[0] (assistant text)",
      "messages[2].content[0] (user text)",
    ])
    expect(points.every((block) => block.breakpoint!.ttl === 60 * 60_000)).toBe(true)
  })

  test("verified non-keyed fields keep every prefix hash", () => {
    for (const extra of [
      { max_tokens: 100 },
      { output_config: { effort: "low" } },
      { thinking: { type: "adaptive", display: "summarized" } },
      { temperature: 0.2 },
    ]) {
      const other = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history, extra)))
      expect(other.blocks.map((block) => block.prefix)).toEqual(base.blocks.map((block) => block.prefix))
    }
  })

  test("moving cache markers does not change prefixes", () => {
    const longer = CacheModel.normalize(request(ANTHROPIC, anthropicBody([...history, assistant("ok"), user("more")])))
    expect(longer.blocks.slice(0, base.blocks.length).map((block) => block.prefix)).toEqual(
      base.blocks.map((block) => block.prefix),
    )
  })

  test("thinking config keys only the messages region", () => {
    const other = CacheModel.normalize(
      request(ANTHROPIC, anthropicBody(history, { thinking: { type: "enabled", budget_tokens: 2048 } })),
    )
    const split = base.blocks.findIndex((block) => block.region === "messages")
    expect(other.blocks.slice(0, split).map((block) => block.prefix)).toEqual(
      base.blocks.slice(0, split).map((b) => b.prefix),
    )
    expect(other.blocks[split].prefix).not.toBe(base.blocks[split].prefix)
  })

  test("tool order, model, beta header and unknown fields key everything", () => {
    const variants = [
      request(ANTHROPIC, anthropicBody(history, { tools: [tool("edit"), tool("read")] })),
      request(ANTHROPIC, anthropicBody(history, { model: "claude-opus-5" })),
      request(ANTHROPIC, anthropicBody(history), { "anthropic-beta": "context-1m-2025-08-07" }),
      request(ANTHROPIC, anthropicBody(history, { speed: "fast" })),
    ]
    for (const variant of variants) {
      const other = CacheModel.normalize(variant)
      expect(other.blocks[0].prefix).not.toBe(base.blocks[0].prefix)
    }
  })

  test("namespace follows endpoint and credential, not affinity", () => {
    const grove = CacheModel.normalize(
      request("https://grove.example/anthropic/v1/messages", anthropicBody(history), {
        "x-api-key": "",
        "api-key": "g",
      }),
    )
    const otherKey = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history), { "x-api-key": "key-b" }))
    const affinity = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history), { "x-session-affinity": "ses_2" }))
    expect(grove.namespace).not.toBe(base.namespace)
    expect(otherKey.namespace).not.toBe(base.namespace)
    expect(affinity.namespace).toBe(base.namespace)
  })
})

describe("CacheModel.normalize (openai chat)", () => {
  const body = (extra: Body = {}) => ({
    model: "accounts/fireworks/models/glm-5p3-flash",
    stream: true,
    max_tokens: 1000,
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    messages: [
      { role: "system", content: "You are opencode." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", reasoning_content: "thinking" },
      { role: "user", content: "next" },
    ],
    ...extra,
  })
  const fw = (value: Body, affinity = "ses_1") =>
    CacheModel.normalize(request(FIREWORKS, value, { authorization: "Bearer fw", "x-session-affinity": affinity }))

  test("affinity is part of the namespace", () => {
    expect(fw(body()).namespace).not.toBe(fw(body(), "ses_2").namespace)
    expect(fw(body()).automatic).toBe(true)
  })

  test("reasoning_effort keys the cache, sampling and limits do not", () => {
    const base = fw(body()).blocks.map((block) => block.prefix)
    expect(fw(body({ temperature: 0.3, max_tokens: 5 })).blocks.map((block) => block.prefix)).toEqual(base)
    expect(fw(body({ reasoning_effort: "low" })).blocks[0].prefix).not.toBe(base[0])
  })
})

describe("CacheLedger", () => {
  const sessionID = "ses_test"
  const turn1 = [user("hello " + "x".repeat(4000))]
  const turn2 = [...turn1, assistant("hi " + "y".repeat(4000)), user("second question")]

  test("a new session without observed requests is unknown", () => {
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    expect(report.status).toBe("unknown")
  })

  test("appending a turn reuses the whole previous prompt", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("hit")
    expect(report.reusableTokens).toBe(120_000)
    expect(report.reusableExact).toBe(true)
    expect(report.lostTokens).toBe(3)
  })

  test("reminder churn on the previous user message is reported with its path", async () => {
    // opencode appends the plan reminder to the newest user message in memory
    // only, so the next request no longer carries it on that message.
    // The previous turn ran many tool steps after its user message, so every
    // cache entry after the churned block is more than 20 blocks away or gone.
    const steps: Body[] = []
    for (let i = 0; i < 12; i++) steps.push(assistant(`call ${i} ` + "z".repeat(3000)), user(`result ${i}`))
    const previous = [
      ...turn2.slice(0, 2),
      user("second question", "<system-reminder>plan</system-reminder>"),
      ...steps,
    ]
    await wire(sessionID, request(ANTHROPIC, anthropicBody(previous)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 150_000 })
    const next = [...turn2, ...steps, assistant("answer"), user("third", "<system-reminder>plan</system-reminder>")]
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(next)))
    expect(report.status).toBe("partial")
    expect(report.lostTokens).toBeGreaterThan(100_000)
    expect(report.divergence?.previousPath).toBe("messages[2].content[1] (user text)")
    expect(report.divergence?.previousExcerpt).toBe("<system-reminder>plan</system-reminder>")
    expect(report.lostTokens).toBeGreaterThan(0)
    expect(report.reasons.some((reason) => reason.includes("diverges"))).toBe(true)
  })

  test("an edit far back only keeps the system prompt", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 150_000 })
    const edited = [user("hello " + "x".repeat(4000), "added"), ...turn2.slice(1), assistant("a"), user("b")]
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(edited)))
    expect(report.status).toBe("partial")
    expect(report.divergence?.previousPath).toBe("messages[1].content[0] (assistant text)")
    expect(report.divergence?.path).toBe("messages[0].content[1] (user text)")
    expect(report.lostTokens).toBeGreaterThan(100_000)
  })

  test("a changed tool list loses everything", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2, { tools: [tool("read")] })))
    expect(report.status).toBe("miss")
    expect(report.lostTokens).toBe(120_003)
    expect(report.divergence?.previousPath).toBe("tools[1] (edit)")
  })

  test("switching gateway is a namespace change", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = CacheLedger.predict(
      sessionID,
      request("https://api.githubcopilot.com/v1/messages", anthropicBody(turn2), {
        "x-api-key": "",
        authorization: "Bearer c",
      }),
    )
    expect(report.status).toBe("miss")
    expect(report.reasons[0]).toContain("cache namespace changed (credential, endpoint)")
  })

  test("age alone makes reuse uncertain and reports the idle time", async () => {
    // The previous request must be recent enough to be the session's `last`
    // (older sessions cannot have a live cache), while the entry it wrote
    // must be old enough to have expired.
    setSystemTime(new Date(Date.now() - 70 * 60_000))
    try {
      await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
      CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    } finally {
      setSystemTime()
    }
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("unknown")
    expect(report.reasons).toContain(
      "cache may have expired: idle ~70m, retention window 60m (requested cache_control TTL)",
    )
  })

  test("a miss without a known reason still explains itself", async () => {
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    // No previous request: the unknown reason is there anyway.
    expect(report.reasons).not.toHaveLength(0)
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    // A namespace that never saw this prefix (evicted server-side).
    const other = "ses_other2"
    await wire(other, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(other, { input: 3, read: 0, write: 120_000 })
    const probe = request(ANTHROPIC, anthropicBody(turn2), { "x-api-key": "key-c" })
    const report2 = CacheLedger.predict(sessionID, probe)
    expect(report2.status).toBe("miss")
    expect(report2.reasons.some((reason) => reason.startsWith("cache namespace changed"))).toBe(true)
  })

  test("a namespace switch can hit a prefix another session cached there", async () => {
    const copilot = (body: Body) =>
      request("https://api.githubcopilot.com/v1/messages", body, { "x-api-key": "", authorization: "Bearer c" })
    // Another session already cached the same prefix on copilot.
    await wire("ses_other", copilot(anthropicBody(turn1)))
    CacheLedger.observe("ses_other", { input: 3, read: 0, write: 120_000 })
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = CacheLedger.predict(sessionID, copilot(anthropicBody(turn2)))
    expect(report.status).toBe("hit")
    expect(report.reasons[0]).toContain("already holds a matching prefix")
  })

  test("expired entries are reported with the idle time", async () => {
    setSystemTime(new Date(Date.now() - 2 * 60 * 60_000))
    try {
      await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
      CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    } finally {
      setSystemTime()
    }
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("unknown")
    expect(report.reasons.some((reason) => reason.startsWith("cache may have expired"))).toBe(true)
  })

  test("entries beyond the 20-block lookback are not reachable", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    // 24 blocks between the old breakpoint and the new ones.
    const tail: Body[] = []
    for (let i = 0; i < 12; i++) tail.push(assistant(`call ${i}`), user(`result ${i}`))
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody([...turn1, ...tail])))
    expect(report.reasons.some((reason) => reason.includes("more than 20 blocks"))).toBe(true)
    expect(report.reusableTokens).toBeLessThan(120_000)
  })

  test("verification flags reads below the prediction and then refuses to predict", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    let history = turn1
    for (let i = 0; i < 2; i++) {
      history = [...history, assistant(`a${i}`), user(`u${i}`)]
      await wire(sessionID, request(ANTHROPIC, anthropicBody(history)))
      // Provider ignored the cache although the prefix matched.
      CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_100 })
    }
    history = [...history, assistant("a"), user("u")]
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(history)))
    expect(report.verification?.filter((item) => !item.ok).length).toBe(2)
    expect(report.status).toBe("unknown")
  })

  test("automatic caching predicts from every prefix", async () => {
    const body = (messages: Body[]) => ({ model: "m", stream: true, messages })
    const fw = (value: Body) =>
      request(FIREWORKS, value, { authorization: "Bearer fw", "x-session-affinity": sessionID })
    const first = [
      { role: "system", content: "s".repeat(8000) },
      { role: "user", content: "hi" },
    ]
    await wire(sessionID, fw(body(first)))
    CacheLedger.observe(sessionID, { input: 2_000, read: 0, write: 0 })
    const next = CacheLedger.predict(
      sessionID,
      fw(body([...first, { role: "assistant", content: "ok" }, { role: "user", content: "more" }])),
    )
    expect(next.status).toBe("hit")
    expect(next.reusableTokens).toBe(2_000)
    const edited = CacheLedger.predict(sessionID, fw(body([first[0], { role: "user", content: "changed" }])))
    // Only the tiny user message after the shared system prompt is lost.
    expect(edited.status).toBe("hit")
    expect(edited.reusableExact).toBe(false)
    expect(edited.reusableTokens).toBeGreaterThan(1_990)
    expect(edited.divergence?.previousPath).toBe("messages[1] (user)")
  })

  test("the unknown report carries the previous prompt size", async () => {
    await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = CacheLedger.unknown(sessionID, "compaction")
    expect(report.lostTokens).toBe(120_003)
    expect(report.reasons).toEqual(["compaction"])
  })
})

describe("CacheLedger automatic retention", () => {
  const sessionID = "ses_retention"
  const body = (model: string, extra: Body = {}) => ({
    model,
    input: [{ role: "user", content: "hello " + "x".repeat(4000) }],
    ...extra,
  })

  test.each([
    { url: OPENAI, model: "gpt-6-astra" },
    { url: CODEX, model: "gpt-6-astra" },
    { url: OPENAI, model: "gpt-5.6" },
    { url: CODEX, model: "gpt-5.6-luna" },
    { url: OPENAI, model: "gpt-5.5-2026-04-23" },
    { url: CODEX, model: "gpt-5.5" },
    { url: OPENAI, model: "gpt-5.4", extra: { prompt_cache_retention: "24h" } },
    { url: OPENAI, model: "future-model", extra: { prompt_cache_options: { ttl: "30m" } } },
  ])("$url $model reuses a prefix after 29m and is uncertain after 30m", async ({ url, model, extra }) => {
    const start = Date.now()
    const captured = request(url, body(model, extra))
    try {
      setSystemTime(start)
      await wire(sessionID, captured)
      CacheLedger.observe(sessionID, { input: 96, read: 117_248, write: 0 })
      setSystemTime(start + 29 * 60_000)
      const warm = CacheLedger.predict(sessionID, captured)
      expect(warm.status).toBe("hit")
      expect(warm.reusableTokens).toBe(117_344)
      setSystemTime(start + 31 * 60_000)
      const aged = CacheLedger.predict(sessionID, captured)
      expect(aged.status).toBe("unknown")
      expect(aged.lostTokens).toBe(117_344)
      expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~31m, retention window 30m")
      if (url === CODEX) expect(aged.reasons[0]).toContain("Codex model-family estimate")
      // An uncertain prediction must not prevent real cache hits refreshing it.
      await wire(sessionID, captured)
      CacheLedger.observe(sessionID, { input: 96, read: 117_248, write: 0 })
      const refreshed = CacheLedger.predict(sessionID, captured)
      expect(refreshed.status).toBe("hit")
      expect(refreshed.verification?.at(-1)?.actual).toBe(117_248)
    } finally {
      setSystemTime()
    }
  })

  test.each([
    { url: OPENAI, model: "gpt-5.4", extra: {} },
    { url: OPENAI, model: "gpt-5.4", extra: { prompt_cache_retention: "in_memory" } },
    { url: OPENAI, model: "unknown-model", extra: { prompt_cache_options: { ttl: "1h" } } },
    { url: CODEX, model: "gpt-5.4", extra: { prompt_cache_retention: "24h" } },
    { url: FIREWORKS, model: "gpt-6-astra", extra: { messages: [{ role: "user", content: "hello" }] } },
    { url: "https://api.githubcopilot.com/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://api.openai.com.example/v1/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://gateway.example/v1/responses", model: "gpt-6-astra", extra: { prompt_cache_retention: "24h" } },
    {
      url: "https://gateway.example/v1/responses",
      model: "gpt-6-astra",
      extra: { prompt_cache_options: { ttl: "30m" } },
    },
  ])("$url $model does not infer extended retention from an API-compatible shape", async ({ url, model, extra }) => {
    const start = Date.now()
    const captured = request(url, body(model, extra))
    try {
      setSystemTime(start)
      await wire(sessionID, captured)
      CacheLedger.observe(sessionID, { input: 117_344, read: 0, write: 0 })
      setSystemTime(start + 6 * 60_000)
      const aged = CacheLedger.predict(sessionID, captured)
      expect(aged.status).toBe("unknown")
      expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~6m, retention window 5m")
    } finally {
      setSystemTime()
    }
  })

  test("a model change is still a predicted miss after the old prefix ages", async () => {
    const start = Date.now()
    try {
      setSystemTime(start)
      await wire(sessionID, request(CODEX, body("gpt-6-astra")))
      CacheLedger.observe(sessionID, { input: 117_344, read: 0, write: 0 })
      setSystemTime(start + 31 * 60_000)
      const report = CacheLedger.predict(sessionID, request(CODEX, body("gpt-6-sol")))
      expect(report.status).toBe("miss")
      expect(report.reasons).toContain("model changed: gpt-6-astra -> gpt-6-sol")
      expect(report.reasons.some((reason) => reason.includes("may have expired"))).toBe(false)
    } finally {
      setSystemTime()
    }
  })

  test.each([
    { url: CODEX, model: "gpt-6-astra", ttl: 5 * 60_000, extra: {} },
    { url: OPENAI, model: "gpt-5.4", ttl: 24 * 60 * 60_000, extra: { prompt_cache_retention: "24h" } },
  ])("old $ttl ms ledger entries adopt the policy without refreshing their age", async ({ url, model, ttl, extra }) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "cache-ledger.json")
    const start = Date.now()
    const captured = request(url, body(model, extra))
    const normalized = CacheModel.normalize(captured)
    // Legacy ledger fixture: entries have a timestamp and TTL, but no policy source.
    await fs.writeFile(
      file,
      JSON.stringify({
        entries: {
          [normalized.namespace]: {
            [normalized.blocks.at(-1)!.prefix]: { tokens: 117_344, exact: true, expires: start + ttl, ttl },
          },
        },
        sessions: {
          [sessionID]: {
            last: { ...normalized, time: start, prompt: 117_344, usage: { input: 96, read: 117_248, write: 0 } },
            verifications: [],
            thinking: {},
          },
        },
      }),
    )
    try {
      setSystemTime(start + 29 * 60_000)
      CacheLedger.configure({ file })
      expect(CacheLedger.predict(sessionID, captured).status).toBe("hit")
      setSystemTime(start + 31 * 60_000)
      const aged = CacheLedger.predict(sessionID, captured)
      expect(aged.status).toBe("unknown")
      expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~31m, retention window 30m")
    } finally {
      CacheLedger.configure({})
      setSystemTime()
    }
  })
})

describe("CacheLedger thinking binding", () => {
  // Every case below mirrors a measurement against direct Anthropic and
  // Copilot (claude-opus-5-5, prefix_mismatch_behavior "error").
  const sessionID = "ses_think"
  const think = (signature: string) => ({ type: "thinking", thinking: "hmm " + signature, signature })
  const u1 = user("hello " + "x".repeat(4000))
  const a1 = { role: "assistant", content: [think("sig-a"), text("answer a")] }
  const u2 = user("second")
  const a2 = { role: "assistant", content: [think("sig-b"), text("answer b")] }
  const u3 = user("third")
  const history = [u1, a1, u2, a2, u3]
  const next = [...history, { role: "assistant", content: [think("sig-c"), text("answer c")] }, user("fourth")]
  const send = (body: Body) => request(ANTHROPIC, body)
  const ids = (stale: CacheLedger.StaleThinking | undefined) =>
    (stale?.blocks ?? []).map((block) => block.signature).sort()

  async function accepted(body: Body, dropped: string[] = []) {
    await wire(sessionID, send(body))
    return CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 }, dropped)
  }

  async function guarded(body: Body) {
    const captured = send(body)
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch
      Wire.install()
      await globalThis.fetch(captured.url, {
        method: "POST",
        headers: { ...captured.headers, ...Wire.header({ mode: "send", id: Wire.nextID(), sessionID }) },
        body: captured.body,
      })
    } finally {
      globalThis.fetch = original
    }
  }

  test("blocks are bound by content before them, never by what follows", () => {
    const blocks = CacheModel.signedThinking(send(anthropicBody(history)))
    expect(blocks.map((block) => [block.signature, block.path])).toEqual([
      ["sig-a", "messages.1.content.0"],
      ["sig-b", "messages.3.content.0"],
    ])
    const later = CacheModel.signedThinking(send(anthropicBody(next)))
    expect(later[0].binding).toEqual(blocks[0].binding)
  })

  test("unchanged history, cache markers, tool order and the thinking config keep blocks valid", async () => {
    await accepted(anthropicBody(history))
    expect(CacheLedger.staleThinking(sessionID, send(anthropicBody(next)))).toBeUndefined()
    const variants: Body[] = [
      { ...anthropicBody(history), tools: [tool("edit"), tool("read")] },
      { ...anthropicBody(history), thinking: undefined },
      { ...anthropicBody(history), thinking: { type: "adaptive", display: "summarized" } },
      { ...anthropicBody(history), system: [text("You are opencode. ".repeat(200))] },
    ]
    for (const body of variants) expect(CacheLedger.staleThinking(sessionID, send(body))).toBeUndefined()
  })

  test("a changed system prompt or tool list invalidates every block", async () => {
    await accepted(anthropicBody(history))
    const system = CacheLedger.staleThinking(
      sessionID,
      send({ ...anthropicBody(history), system: [text("You are opencode. ".repeat(200) + "Today.")] }),
    )
    expect(ids(system)).toEqual(["sig-a", "sig-b"])
    expect(system?.reason).toBe("the system prompt changed")
    const tools = CacheLedger.staleThinking(sessionID, send({ ...anthropicBody(history), tools: [tool("read")] }))
    expect(ids(tools)).toEqual(["sig-a", "sig-b"])
    expect(tools?.reason).toBe("the tool list changed")
  })

  test("an edit invalidates only the blocks after it, and says where", async () => {
    await accepted(anthropicBody(history))
    const edited = [u1, a1, user("second, edited"), a2, u3]
    const stale = CacheLedger.staleThinking(sessionID, send(anthropicBody(edited)))
    expect(ids(stale)).toEqual(["sig-b"])
    expect(stale?.reason).toBe("earlier messages changed")
    expect(stale?.path).toBe("messages[2].content[0] (user text)")
    // The block's own later content is not bound to it.
    const own = [u1, { ...a1, content: [think("sig-a"), text("answer a, edited")] }, u2, a2, u3]
    expect(ids(CacheLedger.staleThinking(sessionID, send(anthropicBody(own))))).toEqual(["sig-b"])
  })

  test("removing an earlier thinking block leaves later ones valid", async () => {
    await accepted(anthropicBody(history))
    const without = [u1, { ...a1, content: [text("answer a")] }, u2, a2, u3]
    expect(CacheLedger.staleThinking(sessionID, send(anthropicBody(without)))).toBeUndefined()
  })

  test("blocks never seen accepted are assumed valid", async () => {
    await accepted(anthropicBody([u1]))
    expect(CacheLedger.staleThinking(sessionID, send(anthropicBody(history)))).toBeUndefined()
  })

  test("the guard refuses stale thinking unless the request asks the provider to drop it", async () => {
    await accepted(anthropicBody(history))
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    await expect(guarded(changed)).rejects.toThrow(
      "Stale thinking: 2 thinking blocks from earlier turns no longer match the conversation (the tool list changed)",
    )
    const consented = {
      ...changed,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    }
    await guarded(consented)
    // The consented request's stale blocks are lost even if the provider does
    // not report them, and are no longer tracked.
    const lost = CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    expect(lost.map((item) => item.signature).sort()).toEqual(["sig-a", "sig-b"])
    expect(lost[0].reason).toBe("dropped with consent: no longer matches the conversation")
    expect(CacheLedger.staleThinking(sessionID, send(changed))).toBeUndefined()
  })

  test("blocks the provider drops are lost and no longer tracked", async () => {
    await accepted(anthropicBody(history))
    const lost = await accepted(anthropicBody(next), ["messages.3.content.0"])
    expect(lost).toEqual([
      { signature: "sig-b", reason: "dropped by the provider: no longer matches the conversation" },
    ])
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    expect(ids(CacheLedger.staleThinking(sessionID, send(changed)))).toEqual(["sig-a"])
  })

  test("a provider rejection the ledger missed is reported until a request succeeds", async () => {
    await accepted(anthropicBody([u1]))
    await wire(sessionID, send(anthropicBody(history)))
    const message =
      "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. " +
      'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". ' +
      "The `system` prompt differs from when this block was created."
    expect(CacheLedger.isThinkingRefusal(message)).toBe(true)
    CacheLedger.refuseThinking(sessionID, message)
    CacheLedger.discard(sessionID)
    // sig-b follows the rejected block, so whatever changed precedes it too.
    const stale = CacheLedger.staleThinking(sessionID, send(anthropicBody(history)))
    expect(ids(stale)).toEqual(["sig-a", "sig-b"])
    expect(stale?.reason).toBe(
      "the provider rejected the block at messages.1.content.0: The `system` prompt differs from when this block was created.",
    )
    await expect(guarded(anthropicBody(history))).rejects.toThrow("Stale thinking: 2 thinking blocks")
    CacheLedger.discard(sessionID)
    // A turn on another model does not carry the block: still refused.
    await wire(sessionID, request(FIREWORKS, { model: "glm", messages: [{ role: "user", content: "hi" }] }))
    CacheLedger.observe(sessionID, { input: 3, read: 0, write: 0 })
    expect(ids(CacheLedger.staleThinking(sessionID, send(anthropicBody(history))))).toEqual(["sig-a", "sig-b"])
    // The consented turn lets the provider drop it.
    const lost = await accepted(
      {
        ...anthropicBody(history),
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      },
      ["messages.1.content.0"],
    )
    expect(lost.map((item) => item.signature)).toEqual(["sig-a", "sig-b"])
    expect(CacheLedger.staleThinking(sessionID, send(anthropicBody(history)))).toBeUndefined()
  })

  test("a consented request keeps every block from the first stale one on as text", async () => {
    await accepted(anthropicBody(history))
    expect(CacheLedger.consentedThinking(sessionID, send(anthropicBody(next)))).toEqual([])
    // sig-c was never seen accepted, but text in place of sig-b precedes it.
    const edited = [u1, a1, user("second, edited"), a2, u3, { role: "assistant", content: [think("sig-c")] }, user("4")]
    expect(ids(CacheLedger.staleThinking(sessionID, send(anthropicBody(edited))))).toEqual(["sig-b"])
    expect(CacheLedger.consentedThinking(sessionID, send(anthropicBody(edited)))).toEqual([
      { signature: "sig-b", reason: CacheLedger.DROPPED_WITH_CONSENT },
      { signature: "sig-c", reason: CacheLedger.DROPPED_WITH_CONSENT },
    ])
  })

  test("blocks kept as text are forgotten, with a refusal of one of them", async () => {
    await accepted(anthropicBody(history))
    CacheLedger.forgetThinking(sessionID, ["sig-a"])
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    expect(ids(CacheLedger.staleThinking(sessionID, send(changed)))).toEqual(["sig-b"])
    await wire(sessionID, send(anthropicBody(history)))
    CacheLedger.refuseThinking(
      sessionID,
      "messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
    )
    CacheLedger.discard(sessionID)
    expect(ids(CacheLedger.staleThinking(sessionID, send(anthropicBody(history))))).toEqual(["sig-b"])
    CacheLedger.forgetThinking(sessionID, ["sig-b"])
    expect(CacheLedger.staleThinking(sessionID, send(changed))).toBeUndefined()
  })

  test("blocks after a refused one are stale too, earlier unknown ones are not", async () => {
    const a0 = { role: "assistant", content: [think("sig-0"), text("answer 0")] }
    const longer = [u1, a0, user("between"), a1, u2, a2, u3]
    await accepted(anthropicBody([u1]))
    await wire(sessionID, send(anthropicBody(longer)))
    CacheLedger.refuseThinking(
      sessionID,
      "messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. " +
        'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". ' +
        "Content before this block differs from when it was created.",
    )
    CacheLedger.discard(sessionID)
    expect(ids(CacheLedger.staleThinking(sessionID, send(anthropicBody(longer))))).toEqual(["sig-a", "sig-b"])
  })

  test("a session's thinking bindings outlive its cache snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-"))
    const file = path.join(dir, "cache-ledger.json")
    try {
      CacheLedger.configure({ file })
      setSystemTime(new Date(Date.now() - 3 * 24 * 60 * 60_000))
      try {
        await accepted(anthropicBody(history))
      } finally {
        setSystemTime()
      }
      await Bun.sleep(1200)
      const saved = JSON.parse(await fs.readFile(file, "utf8")).sessions[sessionID]
      expect(saved.last).toBeUndefined()
      expect(Object.keys(saved.thinking)).toHaveLength(2)
      CacheLedger.reset()
      CacheLedger.configure({ file })
      const changed = { ...anthropicBody(history), tools: [tool("read")] }
      expect(ids(CacheLedger.staleThinking(sessionID, send(changed)))).toEqual(["sig-a", "sig-b"])
      expect(CacheLedger.predict(sessionID, send(anthropicBody(next))).status).toBe("unknown")
    } finally {
      CacheLedger.configure({})
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("other request formats are never checked", async () => {
    await accepted(anthropicBody(history))
    const chat = request(FIREWORKS, { model: "glm", messages: [{ role: "user", content: "hi" }] })
    expect(CacheLedger.staleThinking(sessionID, chat)).toBeUndefined()
    expect(CacheModel.signedThinking(chat)).toEqual([])
  })

  test("bindings and expired entries survive a restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-"))
    const file = path.join(dir, "cache-ledger.json")
    try {
      CacheLedger.configure({ file })
      await accepted(anthropicBody(history))
      await Bun.sleep(1200)
      CacheLedger.reset()
      CacheLedger.configure({ file })
      const changed = { ...anthropicBody(history), tools: [tool("read")] }
      expect(ids(CacheLedger.staleThinking(sessionID, send(changed)))).toEqual(["sig-a", "sig-b"])
      expect(CacheLedger.predict(sessionID, send(anthropicBody(next))).status).toBe("hit")
    } finally {
      CacheLedger.configure({})
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("Wire", () => {
  test("strips the tag header and aborts dry runs before the network", async () => {
    const seen: Headers[] = []
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return new Response("{}")
      }) as unknown as typeof fetch
      Wire.install()
      const id = Wire.nextID()
      await expect(
        globalThis.fetch(ANTHROPIC, {
          method: "POST",
          headers: { a: "1", ...Wire.header({ mode: "dryrun", id, sessionID: "ses_x" }) },
          body: '{"x":1}',
        }),
      ).rejects.toBeInstanceOf(Wire.DryRunCaptured)
      expect(seen).toHaveLength(0)
      const captured = Wire.take(id)
      expect(captured?.body).toBe('{"x":1}')
      expect(captured?.headers[Wire.HEADER]).toBeUndefined()

      await globalThis.fetch(ANTHROPIC, {
        method: "POST",
        headers: { a: "1", ...Wire.header({ mode: "send", id: Wire.nextID(), sessionID: "ses_x" }) },
        body: "{}",
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].get(Wire.HEADER)).toBeNull()
      expect(seen[0].get("a")).toBe("1")
    } finally {
      globalThis.fetch = original
    }
  })
})
