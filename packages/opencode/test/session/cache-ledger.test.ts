import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { CacheModel } from "../../src/session/cache/model"
import { CacheLedger } from "../../src/session/cache/ledger"
import { Wire } from "../../src/session/cache/wire"

// Request shapes mirror what @ai-sdk/anthropic and @ai-sdk/openai-compatible
// put on the wire for opencode sessions.

const ANTHROPIC = "https://api.anthropic.com/v1/messages"
const FIREWORKS = "https://api.fireworks.ai/inference/v1/chat/completions"
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

  test("expired entries are reported with the idle time", async () => {
    setSystemTime(new Date(Date.now() - 2 * 60 * 60_000))
    try {
      await wire(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
      CacheLedger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    } finally {
      setSystemTime()
    }
    const report = CacheLedger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("miss")
    expect(report.reasons.some((reason) => reason.startsWith("cached prefix expired"))).toBe(true)
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
