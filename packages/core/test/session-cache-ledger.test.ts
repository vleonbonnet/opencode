import { describe, expect, test } from "bun:test"
import { LLM } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIResponses } from "@opencode/ai/protocols"
import { Auth } from "@opencode/ai/route"
import { CacheLedger } from "@opencode/core/session/cache/ledger"
import { CacheModel } from "@opencode/core/session/cache/model"
import { CacheWire } from "@opencode/core/session/cache/wire"
import { UNKNOWN_BINDING } from "@opencode/schema/session-cache"
import { Cause, Effect, Exit } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { staleSignature } from "./lib/session-cache"

// Request shapes mirror what the Anthropic Messages and OpenAI-compatible protocols put on the wire for Sessions.

const ANTHROPIC = "https://api.anthropic.com/v1/messages"
const FIREWORKS = "https://api.fireworks.ai/inference/v1/chat/completions"
const OPENAI = "https://api.openai.com/v1/responses"
const CODEX = "https://chatgpt.com/backend-api/codex/responses"
const COPILOT = "https://api.githubcopilot.com/responses"
const CC = { type: "ephemeral", ttl: "1h" }
const NOW = Date.UTC(2026, 9, 18, 12)
const MINUTE = 60_000
const REF = { id: "claude-opus-5-5", providerID: "anthropic" } as CacheLedger.ModelRef

type Body = Record<string, any>

/** A captured request; CREDENTIAL is the identity the resolver names its credential by. */
function request(
  url: string,
  body: Body,
  headers: Record<string, string> = {},
  time = NOW,
  credential: string | undefined = "key:a",
): CacheWire.Captured {
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
    ...(credential === undefined ? {} : { credential }),
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

// The default cache policy: first system block and the last two messages carry breakpoints.
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

/** The ledger as the SessionCache service drives it, kept in memory. */
function memory() {
  const sessions = new Map<string, CacheLedger.SessionRecord>()
  const entries = new Map<string, CacheLedger.Entries>()
  const pendings = new Map<string, CacheLedger.Pending>()
  const excerpts = new Map<string, Map<string, string>>()
  const record = (sessionID: string) => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created = CacheLedger.emptyRecord()
    sessions.set(sessionID, created)
    return created
  }
  return {
    sessions,
    entries,
    /** What the wire tap records when a request leaves the process; SNAPSHOT false for keep-alive generations. */
    send(sessionID: string, captured: CacheWire.Captured, ref = REF, mode?: CacheLedger.Mode, snapshot = true) {
      const normalized = CacheModel.normalize(captured)
      pendings.set(
        sessionID,
        CacheLedger.pending({
          record: sessions.get(sessionID),
          entries: entries.get(normalized.namespace),
          request: captured,
          ref,
          mode,
          snapshot,
        }),
      )
      if (snapshot) excerpts.set(sessionID, new Map(normalized.blocks.map((block) => [block.own, block.excerpt])))
    },
    /**
     * What the Step's usage confirms. DROPPED are the content paths the provider reported removing (DROPS, with their
     * reasons, when given); null when it reports nothing. PRODUCED are the signatures of the reply's thinking.
     */
    observe(
      sessionID: string,
      usage: CacheLedger.Usage,
      dropped: string[] | null = [],
      produced: string[] = [],
      drops?: CacheLedger.Drop[],
    ) {
      const sent = pendings.get(sessionID)
      if (!sent) return []
      pendings.delete(sessionID)
      const map = entries.get(sent.normalized.namespace) ?? {}
      entries.set(sent.normalized.namespace, map)
      return CacheLedger.observe({
        sent,
        record: record(sessionID),
        entries: map,
        usage,
        dropped: drops ?? dropped?.map((path) => ({ path })) ?? undefined,
        produced,
      })
    },
    discard(sessionID: string) {
      pendings.delete(sessionID)
    },
    predict(sessionID: string, captured: CacheWire.Captured, now = NOW) {
      const normalized = CacheModel.normalize(captured)
      return CacheLedger.predict({
        record: sessions.get(sessionID),
        entries: entries.get(normalized.namespace),
        request: captured,
        ref: REF,
        now,
        excerpts: excerpts.get(sessionID),
      })
    },
    stale(sessionID: string, captured: CacheWire.Captured) {
      return CacheLedger.staleThinking(sessions.get(sessionID), captured, excerpts.get(sessionID))
    },
    consented(sessionID: string, captured: CacheWire.Captured) {
      return CacheLedger.consentedThinking(sessions.get(sessionID), captured)
    },
    forget(sessionID: string, signatures: string[]) {
      CacheLedger.forgetThinking(record(sessionID), signatures)
    },
    refuse(sessionID: string, message: string, now = NOW) {
      const sent = pendings.get(sessionID)
      if (!sent) return false
      return CacheLedger.refuseThinking(record(sessionID), sent, message, now)
    },
    unknown(sessionID: string, reason: string, now = NOW) {
      return CacheLedger.unknown({ record: sessions.get(sessionID), reason, now })
    },
  }
}

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
    expect(points.every((block) => block.breakpoint!.ttl === 60 * MINUTE)).toBe(true)
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

  test("the thinking block binding behavior does not key the cache", () => {
    for (const behavior of ["error", "drop_block"]) {
      const other = CacheModel.normalize(
        request(
          ANTHROPIC,
          anthropicBody(history, {
            thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: behavior } },
          }),
        ),
      )
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
    const otherKey = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history), {}, NOW, "key:b"))
    const affinity = CacheModel.normalize(request(ANTHROPIC, anthropicBody(history), { "x-session-affinity": "ses_2" }))
    expect(grove.namespace).not.toBe(base.namespace)
    expect(otherKey.namespace).not.toBe(base.namespace)
    expect(affinity.namespace).toBe(base.namespace)
  })

  test("Vertex rawPredict carries Anthropic Messages bodies with the model in the URL", () => {
    const { model: _model, ...body } = anthropicBody(history)
    const vertex = CacheModel.normalize(
      request(
        "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict",
        { ...body, anthropic_version: "vertex-2023-10-16" },
        { "x-api-key": "", authorization: "Bearer v" },
      ),
    )
    expect(vertex.format).toBe("anthropic")
    expect(vertex.model).toBe("claude-opus-5-5")
    expect(vertex.blocks.filter((block) => block.breakpoint)).toHaveLength(3)
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

  test("the credential identity keys the namespace, not a token that rotates", () => {
    const captured = (authorization: string, credential?: string) => {
      const { credential: _stored, ...base } = request(FIREWORKS, body(), {
        authorization,
        "x-session-affinity": "ses_1",
      })
      return CacheModel.normalize(credential === undefined ? base : { ...base, credential })
    }
    // An OAuth refresh or an Entra token per request: same account, same cache.
    expect(captured("Bearer token-1", "account:a").namespace).toBe(captured("Bearer token-2", "account:a").namespace)
    expect(captured("Bearer token-1", "account:a").namespaceParts.credential).toBe("account:a")
    expect(captured("Bearer token-1", "account:a").namespace).not.toBe(
      captured("Bearer token-1", "account:b").namespace,
    )
    // Without an identity the credential is left out; the header never keys the cache.
    expect(captured("Bearer token-1").namespaceParts.credential).toBeUndefined()
    expect(captured("Bearer token-1").namespace).toBe(captured("Bearer token-2").namespace)
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
    const ledger = memory()
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    expect(report.status).toBe("unknown")
    expect(report.model).toEqual({ id: REF.id, providerID: REF.providerID })
    expect(report.previous).toBeUndefined()
  })

  test("appending a turn reuses the whole previous prompt", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)), NOW + MINUTE)
    expect(report.status).toBe("hit")
    expect(report.reusableTokens).toBe(120_000)
    expect(report.reusableExact).toBe(true)
    expect(report.lostTokens).toBe(3)
    expect(report.previous).toEqual({
      time: NOW,
      promptTokens: 120_003,
      model: { id: REF.id, providerID: REF.providerID },
      ageMs: MINUTE,
    })
  })

  test("reminder churn on the previous user message is reported with its unit", () => {
    // The plan reminder lands on the newest user message in memory only, so the next request no longer carries it.
    // The previous turn ran many tool steps after its user message, so every cache entry after the churned block is
    // more than 20 blocks away or gone.
    const ledger = memory()
    const steps: Body[] = []
    for (let i = 0; i < 12; i++) steps.push(assistant(`call ${i} ` + "z".repeat(3000)), user(`result ${i}`))
    const previous = [
      ...turn2.slice(0, 2),
      user("second question", "<system-reminder>plan</system-reminder>"),
      ...steps,
    ]
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(previous)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 150_000 })
    const next = [...turn2, ...steps, assistant("answer"), user("third", "<system-reminder>plan</system-reminder>")]
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(next)))
    expect(report.status).toBe("partial")
    expect(report.lostTokens).toBeGreaterThan(100_000)
    expect(report.divergence?.previousUnit).toBe("messages[2].content[1] (user text)")
    expect(report.divergence?.previousExcerpt).toBe("<system-reminder>plan</system-reminder>")
    expect(report.reasons.some((reason) => reason.includes("diverges"))).toBe(true)
  })

  test("an edit far back only keeps the system prompt", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 150_000 })
    const edited = [user("hello " + "x".repeat(4000), "added"), ...turn2.slice(1), assistant("a"), user("b")]
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(edited)))
    expect(report.status).toBe("partial")
    expect(report.divergence?.previousUnit).toBe("messages[1].content[0] (assistant text)")
    expect(report.divergence?.unit).toBe("messages[0].content[1] (user text)")
    expect(report.divergence?.index).toBe(4)
    expect(report.lostTokens).toBeGreaterThan(100_000)
  })

  test("a changed tool list loses everything", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2, { tools: [tool("read")] })))
    expect(report.status).toBe("miss")
    expect(report.lostTokens).toBe(120_003)
    expect(report.divergence?.previousUnit).toBe("tools[1] (edit)")
  })

  test("switching gateway is a namespace change", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(
      sessionID,
      request(
        "https://api.githubcopilot.com/v1/messages",
        anthropicBody(turn2),
        { "x-api-key": "", authorization: "Bearer c" },
        NOW,
        "account:c",
      ),
    )
    expect(report.status).toBe("miss")
    expect(report.reasons[0]).toContain("cache namespace changed (credential, endpoint)")
  })

  test("age alone makes reuse uncertain and reports the idle time", () => {
    // The previous request is recent enough to be the session's `last`, while the entry it wrote has expired.
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1), {}, NOW - 70 * MINUTE))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("unknown")
    expect(report.reasons).toContain(
      "cache may have expired: idle ~70m, retention window 60m (requested cache_control TTL)",
    )
  })

  test("a miss without a known reason still explains itself", () => {
    const ledger = memory()
    // No previous request: the unknown reason is there anyway.
    expect(ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn1))).reasons).not.toHaveLength(0)
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const other = "ses_other2"
    ledger.send(other, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(other, { input: 3, read: 0, write: 120_000 })
    // A namespace that never saw this prefix (evicted server-side).
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2), {}, NOW, "key:c"))
    expect(report.status).toBe("miss")
    expect(report.reasons.some((reason) => reason.startsWith("cache namespace changed"))).toBe(true)
  })

  test("a namespace switch can hit a prefix another session cached there", () => {
    const ledger = memory()
    const copilot = (body: Body) =>
      request(
        "https://api.githubcopilot.com/v1/messages",
        body,
        { "x-api-key": "", authorization: "Bearer c" },
        NOW,
        "account:c",
      )
    // Another session already cached the same prefix on copilot.
    ledger.send("ses_other", copilot(anthropicBody(turn1)))
    ledger.observe("ses_other", { input: 3, read: 0, write: 120_000 })
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(sessionID, copilot(anthropicBody(turn2)))
    expect(report.status).toBe("hit")
    expect(report.reasons[0]).toContain("already holds a matching prefix")
  })

  test("expired entries are reported with the idle time", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1), {}, NOW - 120 * MINUTE))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(turn2)))
    expect(report.status).toBe("unknown")
    expect(report.reasons.some((reason) => reason.startsWith("cache may have expired"))).toBe(true)
  })

  test("entries beyond the 20-block lookback are not reachable", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    // 24 blocks between the old breakpoint and the new ones.
    const tail: Body[] = []
    for (let i = 0; i < 12; i++) tail.push(assistant(`call ${i}`), user(`result ${i}`))
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody([...turn1, ...tail])))
    expect(report.reasons.some((reason) => reason.includes("more than 20 blocks"))).toBe(true)
    expect(report.reusableTokens).toBeLessThan(120_000)
  })

  test("verification flags reads below the prediction and then refuses to predict", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    let history = turn1
    for (let i = 0; i < 2; i++) {
      history = [...history, assistant(`a${i}`), user(`u${i}`)]
      ledger.send(sessionID, request(ANTHROPIC, anthropicBody(history)))
      // Provider ignored the cache although the prefix matched.
      ledger.observe(sessionID, { input: 3, read: 0, write: 120_100 })
    }
    history = [...history, assistant("a"), user("u")]
    const report = ledger.predict(sessionID, request(ANTHROPIC, anthropicBody(history)))
    expect(ledger.sessions.get(sessionID)!.verifications.filter((item) => !item.ok)).toHaveLength(2)
    expect(report.status).toBe("unknown")
    expect(report.reasons.some((reason) => reason.includes("read less cache than predicted"))).toBe(true)
  })

  test("automatic caching predicts from every prefix", () => {
    const ledger = memory()
    const body = (messages: Body[]) => ({ model: "m", stream: true, messages })
    const fw = (value: Body) =>
      request(FIREWORKS, value, { authorization: "Bearer fw", "x-session-affinity": sessionID })
    const first = [
      { role: "system", content: "s".repeat(8000) },
      { role: "user", content: "hi" },
    ]
    ledger.send(sessionID, fw(body(first)))
    ledger.observe(sessionID, { input: 2_000, read: 0, write: 0 })
    const next = ledger.predict(
      sessionID,
      fw(body([...first, { role: "assistant", content: "ok" }, { role: "user", content: "more" }])),
    )
    expect(next.status).toBe("hit")
    expect(next.reusableTokens).toBe(2_000)
    const edited = ledger.predict(sessionID, fw(body([first[0], { role: "user", content: "changed" }])))
    // Only the tiny user message after the shared system prompt is lost.
    expect(edited.status).toBe("hit")
    expect(edited.reusableExact).toBe(false)
    expect(edited.reusableTokens).toBeGreaterThan(1_990)
    expect(edited.divergence?.previousUnit).toBe("messages[1] (user)")
  })

  test("the unknown report carries the previous prompt size", () => {
    const ledger = memory()
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody(turn1)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 })
    const report = ledger.unknown(sessionID, "compaction")
    expect(report.lostTokens).toBe(120_003)
    expect(report.reasons).toEqual(["compaction"])
  })

  test("a request format the model does not know is unknown", () => {
    const ledger = memory()
    const report = ledger.predict(
      sessionID,
      request("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse-stream", { messages: [] }),
    )
    expect(report.status).toBe("unknown")
    expect(report.format).toBe("unknown")
    expect(report.reasons[0]).toContain("is not modelled")
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
    { url: COPILOT, model: "gpt-6-astra" },
    { url: COPILOT, model: "gpt-5.6-sol" },
    { url: COPILOT, model: "gpt-5.5" },
    {
      url: "https://api.githubcopilot.com/chat/completions",
      model: "gpt-6-sol",
      extra: { messages: [{ role: "user", content: "hello " + "x".repeat(4000) }] },
    },
    { url: "https://api.business.githubcopilot.com/responses", model: "gpt-6.1-sol" },
    { url: "https://copilot-api.acme.ghe.com/responses", model: "gpt-6-luna" },
  ])("$url $model reuses a prefix after 29m and is uncertain after 30m", ({ url, model, extra }) => {
    const ledger = memory()
    const captured = request(url, body(model, extra))
    ledger.send(sessionID, captured)
    ledger.observe(sessionID, { input: 96, read: 117_248, write: 0 })
    const warm = ledger.predict(sessionID, captured, NOW + 29 * MINUTE)
    expect(warm.status).toBe("hit")
    expect(warm.reusableTokens).toBe(117_344)
    const aged = ledger.predict(sessionID, captured, NOW + 31 * MINUTE)
    expect(aged.status).toBe("unknown")
    expect(aged.lostTokens).toBe(117_344)
    expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~31m, retention window 30m")
    if (url === CODEX) expect(aged.reasons[0]).toContain("Codex model-family estimate")
    if (url.includes("copilot")) expect(aged.reasons[0]).toContain("(Copilot GPT-5.")
    // An uncertain prediction must not prevent real cache hits refreshing it.
    const again = { ...captured, time: NOW + 31 * MINUTE }
    ledger.send(sessionID, again)
    ledger.observe(sessionID, { input: 96, read: 117_248, write: 0 })
    const refreshed = ledger.predict(sessionID, again, NOW + 32 * MINUTE)
    expect(refreshed.status).toBe("hit")
    expect(ledger.sessions.get(sessionID)!.verifications.at(-1)?.actual).toBe(117_248)
  })

  test.each([
    { url: OPENAI, model: "gpt-5.4", extra: {} },
    { url: OPENAI, model: "gpt-5.4", extra: { prompt_cache_retention: "in_memory" } },
    { url: OPENAI, model: "unknown-model", extra: { prompt_cache_options: { ttl: "1h" } } },
    { url: CODEX, model: "gpt-5.4", extra: { prompt_cache_retention: "24h" } },
    { url: FIREWORKS, model: "gpt-6-astra", extra: { messages: [{ role: "user", content: "hello" }] } },
    { url: COPILOT, model: "gpt-5.4", extra: { prompt_cache_retention: "24h" } },
    { url: COPILOT, model: "gemini-3-pro", extra: {} },
    { url: "https://api.githubcopilot.com/v1/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://api.githubcopilot.com.example/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://evil.example/api.githubcopilot.com/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://api.githubcopilot.com:8443/responses", model: "gpt-6-astra", extra: {} },
    { url: "http://api.githubcopilot.com/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://api.openai.com.example/v1/responses", model: "gpt-6-astra", extra: {} },
    { url: "https://gateway.example/v1/responses", model: "gpt-6-astra", extra: { prompt_cache_retention: "24h" } },
    {
      url: "https://gateway.example/v1/responses",
      model: "gpt-6-astra",
      extra: { prompt_cache_options: { ttl: "30m" } },
    },
  ])("$url $model does not infer extended retention from an API-compatible shape", ({ url, model, extra }) => {
    const ledger = memory()
    const captured = request(url, body(model, extra))
    ledger.send(sessionID, captured)
    ledger.observe(sessionID, { input: 117_344, read: 0, write: 0 })
    const aged = ledger.predict(sessionID, captured, NOW + 6 * MINUTE)
    expect(aged.status).toBe("unknown")
    expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~6m, retention window 5m")
  })

  test("a model change is still a predicted miss after the old prefix ages", () => {
    const ledger = memory()
    ledger.send(sessionID, request(CODEX, body("gpt-6-astra")))
    ledger.observe(sessionID, { input: 117_344, read: 0, write: 0 })
    const report = ledger.predict(sessionID, request(CODEX, body("gpt-6-sol")), NOW + 31 * MINUTE)
    expect(report.status).toBe("miss")
    expect(report.reasons).toContain("model changed: gpt-6-astra -> gpt-6-sol")
    expect(report.reasons.some((reason) => reason.includes("may have expired"))).toBe(false)
  })

  test.each([
    { url: CODEX, model: "gpt-6-astra", ttl: 5 * MINUTE, extra: {} },
    { url: OPENAI, model: "gpt-5.4", ttl: 24 * 60 * MINUTE, extra: { prompt_cache_retention: "24h" } },
    { url: COPILOT, model: "gpt-6-astra", ttl: 5 * MINUTE, extra: {}, source: "undocumented provider fallback" },
  ])(
    "old $ttl ms ledger entries adopt the policy without refreshing their age",
    ({ url, model, ttl, extra, source }: { url: string; model: string; ttl: number; extra: Body; source?: string }) => {
      const ledger = memory()
      const captured = request(url, body(model, extra))
      const normalized = CacheModel.normalize(captured)
      // Legacy entries: a timestamp and TTL, but no policy source, or the source of a policy that has since changed.
      ledger.entries.set(normalized.namespace, {
        [normalized.blocks.at(-1)!.prefix]: {
          tokens: 117_344,
          exact: true,
          expires: NOW + ttl,
          ttl,
          ...(source ? { retentionSource: source } : {}),
        },
      })
      ledger.send(sessionID, captured)
      ledger.sessions.set(sessionID, {
        ...CacheLedger.emptyRecord(),
        last: {
          namespace: normalized.namespace,
          format: normalized.format,
          model,
          ref: REF,
          keyed: { ...normalized.keyed },
          namespaceParts: { ...normalized.namespaceParts },
          blocks: normalized.blocks.map((block) => ({ ...block })),
          totalBytes: normalized.totalBytes,
          time: NOW,
          prompt: 117_344,
          usage: { input: 96, read: 117_248, write: 0 },
        },
      })
      expect(ledger.predict(sessionID, captured, NOW + 29 * MINUTE).status).toBe("hit")
      const aged = ledger.predict(sessionID, captured, NOW + 31 * MINUTE)
      expect(aged.status).toBe("unknown")
      expect(aged.reasons[0]).toStartWith("cache may have expired: idle ~31m, retention window 30m")
    },
  )
})

describe("CacheLedger thinking binding", () => {
  // Every case below mirrors a measurement against direct Anthropic and Copilot (claude-opus-5-5,
  // prefix_mismatch_behavior "error").
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
  /** The blocks reported stale, not those of unknown binding. */
  const ids = (stale: CacheLedger.StaleThinking | undefined) =>
    (stale && !stale.unknown ? stale.blocks : []).map((block) => block.signature).sort()
  const unknownIDs = (stale: CacheLedger.StaleThinking | undefined) =>
    (stale?.unknown ? stale.blocks : []).map((block) => block.signature).sort()
  const dropBlock = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }

  /** A confirmed Step: BODY was sent, the provider dropped DROPPED, and the reply produced PRODUCED. */
  const accepted = (ledger: ReturnType<typeof memory>, body: Body, dropped: string[] = [], produced: string[] = []) => {
    ledger.send(sessionID, send(body))
    return ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 }, dropped, produced)
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

  test("unchanged history, cache markers, tool order and the thinking config keep blocks valid", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history), [], ["sig-c"])
    expect(ledger.stale(sessionID, send(anthropicBody(next)))).toBeUndefined()
    const variants: Body[] = [
      { ...anthropicBody(history), tools: [tool("edit"), tool("read")] },
      { ...anthropicBody(history), thinking: undefined },
      { ...anthropicBody(history), thinking: { type: "adaptive", display: "summarized" } },
      { ...anthropicBody(history), system: [text("You are opencode. ".repeat(200))] },
    ]
    for (const body of variants) expect(ledger.stale(sessionID, send(body))).toBeUndefined()
  })

  test("a changed system prompt or tool list invalidates every block", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const system = ledger.stale(
      sessionID,
      send({ ...anthropicBody(history), system: [text("You are opencode. ".repeat(200) + "Today.")] }),
    )
    expect(ids(system)).toEqual(["sig-a", "sig-b"])
    expect(system?.reason).toBe("the system prompt changed")
    const tools = ledger.stale(sessionID, send({ ...anthropicBody(history), tools: [tool("read")] }))
    expect(ids(tools)).toEqual(["sig-a", "sig-b"])
    expect(tools?.reason).toBe("the tool list changed")
  })

  test("an edit invalidates only the blocks after it, and says where", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const edited = [u1, a1, user("second, edited"), a2, u3]
    const stale = ledger.stale(sessionID, send(anthropicBody(edited)))
    expect(ids(stale)).toEqual(["sig-b"])
    expect(stale?.reason).toBe("earlier messages changed")
    expect(stale?.path).toBe("messages[2].content[0] (user text)")
    // The block's own later content is not bound to it.
    const own = [u1, { ...a1, content: [think("sig-a"), text("answer a, edited")] }, u2, a2, u3]
    expect(ids(ledger.stale(sessionID, send(anthropicBody(own))))).toEqual(["sig-b"])
  })

  test("removing an earlier thinking block leaves later ones valid", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const without = [u1, { ...a1, content: [text("answer a")] }, u2, a2, u3]
    expect(ledger.stale(sessionID, send(anthropicBody(without)))).toBeUndefined()
  })

  test("blocks the ledger holds no binding for are reported as of unknown binding, never as stale", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody([u1]))
    const stale = ledger.stale(sessionID, send(anthropicBody(history)))
    expect(ids(stale)).toEqual([])
    expect(unknownIDs(stale)).toEqual(["sig-a", "sig-b"])
    expect(stale?.reason).toBe(UNKNOWN_BINDING)
    expect(stale?.path).toBeUndefined()
    // A Session from before the ledger has no record at all.
    expect(unknownIDs(CacheLedger.staleThinking(undefined, send(anthropicBody(history))))).toEqual(["sig-a", "sig-b"])
    // Known stale blocks take precedence: an unknown one before them stays signed.
    accepted(ledger, anthropicBody([u1, { ...a1, content: [text("answer a")] }, u2, a2, u3]))
    const changed = ledger.stale(sessionID, send({ ...anthropicBody(history), tools: [tool("read")] }))
    expect(ids(changed)).toEqual(["sig-b"])
    expect(changed?.converted.map((block) => block.signature)).toEqual(["sig-b"])
  })

  test("stale thinking is refused with a message; a consented request lets the provider drop it", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    const stale = ledger.stale(sessionID, send(changed))
    expect(CacheLedger.staleMessage(stale!)).toBe(
      "Stale thinking: 2 thinking blocks from earlier turns no longer match the conversation (the tool list changed). " +
        'Send the turn again with metadata.thinkingLoss "accept" to replay them as text, or undo the change.',
    )
    ledger.send(sessionID, send({ ...changed, thinking: dropBlock }), REF, "accept")
    // The consented request's stale blocks are lost even if the provider does not report them, and are no longer
    // tracked.
    const lost = ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 }, null)
    expect(lost.map((item) => item.signature).sort()).toEqual(["sig-a", "sig-b"])
    expect(lost[0].reason).toBe(CacheLedger.DROPPED_WITH_CONSENT)
    expect(ids(ledger.stale(sessionID, send(changed)))).toEqual([])
  })

  test("blocks the provider drops are lost, with whether anyone was asked, and no longer tracked", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const lost = accepted(ledger, anthropicBody(next), ["messages.3.content.0"])
    expect(lost).toEqual([{ signature: "sig-b", reason: CacheLedger.DROPPED_BY_PROVIDER }])
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    expect(ids(ledger.stale(sessionID, send(changed)))).toEqual(["sig-a"])
    // Nobody asked: the turn let the provider drop what no longer matched.
    ledger.send(sessionID, send({ ...anthropicBody(history), thinking: dropBlock }), REF, "unasked")
    expect(ledger.observe(sessionID, { input: 3, read: 0, write: 0 }, ["messages.1.content.0"])).toEqual([
      { signature: "sig-a", reason: CacheLedger.DROPPED_UNASKED },
    ])
    // A block another model wrote is dropped whatever the turn chose.
    const other = memory()
    other.send(sessionID, send(anthropicBody(history)), REF, "ask")
    expect(
      other.observe(
        sessionID,
        { input: 3, read: 0, write: 0 },
        null,
        [],
        [
          { path: "messages.1.content.0", reason: "model_binding_mismatch" },
          { path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
        ],
      ),
    ).toEqual([
      { signature: "sig-a", reason: CacheLedger.DROPPED_OTHER_MODEL },
      { signature: "sig-b", reason: CacheLedger.DROPPED_BY_PROVIDER },
    ])
  })

  test("a provider rejection the ledger missed is reported until a request succeeds", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody([u1]))
    ledger.send(sessionID, send(anthropicBody(history)))
    const message = staleSignature("messages.1.content.0")
    expect(CacheLedger.isThinkingRefusal(message)).toBe(true)
    expect(ledger.refuse(sessionID, message)).toBe(true)
    ledger.discard(sessionID)
    // sig-b follows the rejected block, so whatever changed precedes it too.
    const stale = ledger.stale(sessionID, send(anthropicBody(history)))
    expect(ids(stale)).toEqual(["sig-a", "sig-b"])
    expect(stale?.reason).toBe(
      "the provider rejected the block at messages.1.content.0: The `system` prompt differs from the one this block was created with.",
    )
    // A turn on another model does not carry the block: still refused.
    ledger.send(sessionID, request(FIREWORKS, { model: "glm", messages: [{ role: "user", content: "hi" }] }))
    ledger.observe(sessionID, { input: 3, read: 0, write: 0 })
    expect(ids(ledger.stale(sessionID, send(anthropicBody(history))))).toEqual(["sig-a", "sig-b"])
    // The consented turn lets the provider drop it, and every block after it.
    const lost = accepted(ledger, { ...anthropicBody(history), thinking: dropBlock }, [
      "messages.1.content.0",
      "messages.3.content.0",
    ])
    expect(lost.map((item) => item.signature)).toEqual(["sig-a", "sig-b"])
    expect(ledger.sessions.get(sessionID)?.refused).toBeUndefined()
    // Later requests leave both out.
    const after = [u1, { ...a1, content: [text("answer a")] }, u2, { ...a2, content: [text("answer b")] }, u3]
    expect(ledger.stale(sessionID, send(anthropicBody(after)))).toBeUndefined()
  })

  test("a refusal holds only under the prompt it was refused under: undoing the change clears it", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody([u1]))
    // An agent switch the ledger cannot vouch for the blocks under: the provider rejects the first.
    const switched = { ...anthropicBody(history), system: [text("You review changes. ".repeat(200), true)] }
    ledger.send(sessionID, send(switched))
    expect(ledger.refuse(sessionID, staleSignature("messages.1.content.0"))).toBe(true)
    ledger.discard(sessionID)
    expect(ids(ledger.stale(sessionID, send(switched)))).toEqual(["sig-a", "sig-b"])
    // Switching back restores the prompt the blocks were made under: nothing is known stale any more.
    const undone = ledger.stale(sessionID, send(anthropicBody(history)))
    expect(ids(undone)).toEqual([])
    expect(unknownIDs(undone)).toEqual(["sig-a", "sig-b"])
    // A refusal recorded before refusals named their prompt holds while the block is carried.
    const record = ledger.sessions.get(sessionID)!
    record.refused = { ...record.refused!, binding: undefined }
    expect(ids(ledger.stale(sessionID, send(anthropicBody(history))))).toEqual(["sig-a", "sig-b"])
  })

  test("the provider's words say what made the block invalid", () => {
    const sent = (message: string) => {
      const ledger = memory()
      ledger.send(sessionID, send(anthropicBody(history)))
      ledger.refuse(sessionID, message)
      return ledger.sessions.get(sessionID)?.refused?.detail
    }
    // As Bedrock relays it.
    expect(sent("The model returned the following errors: " + staleSignature("messages.1.content.0"))).toBe(
      "The `system` prompt differs from the one this block was created with.",
    )
    // Without the sentence that names the change, and without the beta header.
    const documented =
      "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. " +
      'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting ' +
      "requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header."
    expect(sent(documented)).toBe("it no longer matches the conversation")
    // A signature the provider cannot verify at all.
    expect(sent("messages.1.content.0: Invalid `signature` in `thinking` block.")).toBe(
      "the provider could not verify its signature",
    )
    expect(CacheLedger.refusalMessage(staleSignature("messages.1.content.0"))).toBe(
      "Stale thinking: the provider rejected a thinking block from an earlier turn " +
        "(The `system` prompt differs from the one this block was created with.). " +
        'Send the turn again with metadata.thinkingLoss "accept" to replay it and the thinking after it as text, ' +
        "or undo the change.",
    )
  })

  test("a refusal of a block the request does not carry is not recorded", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody([u1]))
    ledger.send(sessionID, send(anthropicBody(history)))
    expect(ledger.refuse(sessionID, staleSignature("messages.7.content.0"))).toBe(false)
    expect(ledger.refuse(sessionID, "Invalid `signature` in `thinking` block.")).toBe(false)
    expect(ledger.sessions.get(sessionID)?.refused).toBeUndefined()
  })

  test("a consented request keeps every block from the first stale one on as text", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history), [], ["sig-c"])
    expect(ledger.consented(sessionID, send(anthropicBody(next)))).toEqual([])
    // sig-c was produced after the edit's place: text in place of sig-b precedes it, and so does the edit.
    const edited = [u1, a1, user("second, edited"), a2, u3, { role: "assistant", content: [think("sig-c")] }, user("4")]
    expect(ids(ledger.stale(sessionID, send(anthropicBody(edited))))).toEqual(["sig-b", "sig-c"])
    expect(ledger.consented(sessionID, send(anthropicBody(edited)))).toEqual([
      { signature: "sig-b", reason: CacheLedger.DROPPED_WITH_CONSENT },
      { signature: "sig-c", reason: CacheLedger.DROPPED_WITH_CONSENT },
    ])
    // Consent replays what the report shows, blocks of unknown binding included.
    const fresh = memory()
    expect(fresh.consented(sessionID, send(anthropicBody(history))).map((item) => item.signature)).toEqual([
      "sig-a",
      "sig-b",
    ])
  })

  test("blocks kept as text are forgotten, with a refusal of one of them", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    ledger.forget(sessionID, ["sig-a"])
    const changed = { ...anthropicBody(history), tools: [tool("read")] }
    expect(ids(ledger.stale(sessionID, send(changed)))).toEqual(["sig-b"])
    ledger.send(sessionID, send(anthropicBody(history)))
    ledger.refuse(sessionID, staleSignature("messages.3.content.0"))
    ledger.discard(sessionID)
    expect(ids(ledger.stale(sessionID, send(anthropicBody(history))))).toEqual(["sig-b"])
    ledger.forget(sessionID, ["sig-b"])
    expect(ids(ledger.stale(sessionID, send(changed)))).toEqual([])
    expect(ledger.sessions.get(sessionID)?.refused).toBeUndefined()
  })

  test("every block after a refused one is stale too, earlier unknown ones are not", () => {
    const ledger = memory()
    const a0 = { role: "assistant", content: [think("sig-0"), text("answer 0")] }
    const longer = [u1, a0, user("between"), a1, u2, a2, u3]
    // sig-b is bound and matches; the provider's refusal of sig-a says what the ledger cannot see precedes both.
    accepted(ledger, anthropicBody([u1, a0, user("between"), { ...a1, content: [text("answer a")] }, u2, a2, u3]))
    ledger.send(sessionID, send(anthropicBody(longer)))
    ledger.refuse(sessionID, staleSignature("messages.3.content.0"))
    ledger.discard(sessionID)
    const stale = ledger.stale(sessionID, send(anthropicBody(longer)))
    expect(ids(stale)).toEqual(["sig-a", "sig-b"])
    expect(stale?.converted.map((block) => block.signature)).toEqual(["sig-a", "sig-b"])
  })

  test("a session's thinking bindings outlive its cache snapshot, and survive a JSON round trip", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history), [], ["sig-c"])
    const stored = JSON.parse(JSON.stringify(ledger.sessions.get(sessionID))) as CacheLedger.SessionRecord
    expect(CacheLedger.prune(stored, NOW + 3 * 24 * 60 * MINUTE)).toBe(false)
    expect(stored.last).toBeUndefined()
    expect(Object.keys(stored.thinking)).toHaveLength(2)
    expect(Object.keys(stored.produced ?? {})).toHaveLength(1)
    ledger.sessions.set(sessionID, stored)
    const changed = { ...anthropicBody(next), tools: [tool("read")] }
    expect(ids(ledger.stale(sessionID, send(changed)))).toEqual(["sig-a", "sig-b", "sig-c"])
    expect(ledger.predict(sessionID, send(anthropicBody(next))).status).toBe("unknown")
    // Past a month only the dropped-thinking markers would stay; with none, the record goes, and the blocks are of
    // unknown binding again.
    expect(CacheLedger.prune(stored, NOW + 31 * 24 * 60 * MINUTE)).toBe(true)
    expect(unknownIDs(CacheLedger.staleThinking(stored, send(changed)))).toEqual(["sig-a", "sig-b", "sig-c"])
  })

  test("dropped-thinking markers last the session's lifetime and merge without duplicates", () => {
    const record = CacheLedger.emptyRecord()
    const block = {
      messageID: "msg_1",
      ordinal: 0,
      reason: CacheLedger.DROPPED_WITH_CONSENT,
      asText: true,
      time: NOW,
    } as CacheLedger.Dropped
    expect(CacheLedger.markDropped(record, [block])).toHaveLength(1)
    expect(CacheLedger.markDropped(record, [block, { ...block, ordinal: 1 }])).toEqual([{ ...block, ordinal: 1 }])
    expect(CacheLedger.prune(record, NOW + 365 * 24 * 60 * MINUTE)).toBe(false)
    expect(record.dropped).toHaveLength(2)
  })

  test("other request formats are never checked", () => {
    const ledger = memory()
    accepted(ledger, anthropicBody(history))
    const chat = request(FIREWORKS, { model: "glm", messages: [{ role: "user", content: "hi" }] })
    expect(ledger.stale(sessionID, chat)).toBeUndefined()
    expect(CacheModel.signedThinking(chat)).toEqual([])
  })

  test("namespace entries expire a day after their window and are capped", () => {
    const entries: CacheLedger.Entries = {
      old: { tokens: 1, exact: true, expires: NOW - 25 * 60 * MINUTE, ttl: 5 * MINUTE },
      recent: { tokens: 1, exact: true, expires: NOW - 60 * MINUTE, ttl: 5 * MINUTE },
    }
    expect(CacheLedger.pruneEntries(entries, NOW)).toBe(false)
    expect(Object.keys(entries)).toEqual(["recent"])
    for (let i = 0; i < CacheLedger.ENTRY_LIMIT + 10; i++)
      entries[`e${i}`] = { tokens: 1, exact: true, expires: NOW + i, ttl: 5 * MINUTE }
    CacheLedger.pruneEntries(entries, NOW)
    expect(Object.keys(entries)).toHaveLength(CacheLedger.ENTRY_LIMIT)
    expect(entries.recent).toBeUndefined()
    expect(entries[`e${CacheLedger.ENTRY_LIMIT + 9}`]).toBeDefined()
  })
})

describe("CacheLedger produced thinking", () => {
  const sessionID = "ses_produced"
  const think = (signature: string) => ({ type: "thinking", thinking: "hmm " + signature, signature })
  const u1 = user("hello " + "x".repeat(4000))
  const a1 = { role: "assistant", content: [think("sig-a"), text("answer a")] }
  const send = (body: Body) => request(ANTHROPIC, body)
  const ids = (stale: CacheLedger.StaleThinking | undefined) =>
    (stale && !stale.unknown ? stale.blocks : []).map((block) => block.signature)

  // A single-Step turn: its thinking is in no request before the next turn replays it.
  const turn = (ledger: ReturnType<typeof memory>, body: Body, produced: string[]) => {
    ledger.send(sessionID, send(body))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 }, [], produced)
  }

  test("the thinking a Step produced is bound to the prompt it answered", () => {
    const ledger = memory()
    turn(ledger, anthropicBody([u1]), ["sig-a"])
    const next = [u1, a1, user("next")]
    expect(ledger.stale(sessionID, send(anthropicBody(next)))).toBeUndefined()
    const system = ledger.stale(sessionID, send({ ...anthropicBody(next), system: [text("You review changes.")] }))
    expect(ids(system)).toEqual(["sig-a"])
    expect(system?.reason).toBe("the system prompt changed")
    expect(ids(ledger.stale(sessionID, send({ ...anthropicBody(next), tools: [tool("read")] })))).toEqual(["sig-a"])
    const edited = ledger.stale(sessionID, send(anthropicBody([user("hello, edited"), a1, user("next")])))
    expect(ids(edited)).toEqual(["sig-a"])
    expect(edited?.reason).toBe("earlier messages changed")
    // Content of its own message before it is not known until a request replays it.
    expect(
      ledger.stale(sessionID, send(anthropicBody([u1, { ...a1, content: [text("preamble"), ...a1.content] }]))),
    ).toBeUndefined()
  })

  test("the first replay the provider accepts binds the block exactly", () => {
    const ledger = memory()
    turn(ledger, anthropicBody([u1]), ["sig-a"])
    const next = [u1, a1, user("next")]
    turn(ledger, anthropicBody(next), [])
    const record = ledger.sessions.get(sessionID)!
    expect(record.produced).toBeUndefined()
    expect(Object.keys(record.thinking)).toEqual([CacheModel.thinkingID("sig-a")])
    // Now its own message's earlier content is bound too.
    expect(
      ids(ledger.stale(sessionID, send(anthropicBody([u1, { ...a1, content: [text("preamble"), ...a1.content] }])))),
    ).toEqual(["sig-a"])
  })

  test("a reply continuing a prefilled assistant message replays where that message starts", () => {
    const ledger = memory()
    turn(ledger, anthropicBody([u1, assistant("Final answer:")]), ["sig-a"])
    expect(ledger.stale(sessionID, send(anthropicBody([u1, a1, user("next")])))).toBeUndefined()
  })

  test("produced bindings are kept for a bounded number of blocks", () => {
    const ledger = memory()
    const signatures = Array.from({ length: CacheLedger.PRODUCED_LIMIT + 5 }, (_, index) => `sig-${index}`)
    turn(ledger, anthropicBody([u1]), signatures)
    const record = ledger.sessions.get(sessionID)!
    expect(Object.keys(record.produced ?? {})).toHaveLength(CacheLedger.PRODUCED_LIMIT)
    expect(record.produced?.[CacheModel.thinkingID(signatures.at(-1)!)]).toBeDefined()
    expect(record.produced?.[CacheModel.thinkingID(signatures[0])]).toBeUndefined()
  })
})

describe("CacheLedger keep-alive generations", () => {
  const sessionID = "ses_keepalive"
  const think = (signature: string) => ({ type: "thinking", thinking: "hmm " + signature, signature })
  const u1 = user("hello " + "x".repeat(4000))
  const a1 = { role: "assistant", content: [think("sig-a"), text("answer a")] }
  const history = [u1, a1, user("second")]
  const send = (body: Body) => request(ANTHROPIC, body)

  test("a generation that drops stale thinking changes nothing the Session knows about it", () => {
    const ledger = memory()
    ledger.send(sessionID, send(anthropicBody(history)))
    ledger.observe(sessionID, { input: 3, read: 0, write: 120_000 }, [])
    const record = ledger.sessions.get(sessionID)!
    record.refused = {
      id: "elsewhere",
      path: "messages.9.content.0",
      detail: "x",
      time: NOW,
    }
    const before = JSON.stringify(record)
    // The system prompt changed; the keep-alive lets the provider drop the stale block, and it does.
    const changed = {
      ...anthropicBody([...history, user("keep-alive")]),
      system: [text("Changed.", true)],
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    }
    ledger.send(sessionID, send(changed), REF, undefined, false)
    const lost = ledger.observe(sessionID, { input: 3, read: 0, write: 2_000 }, ["messages.1.content.0"], ["sig-k"])
    expect(lost).toEqual([])
    expect(JSON.stringify(ledger.sessions.get(sessionID))).toBe(before)
    // Its prefix is cached all the same.
    expect(ledger.predict(sessionID, send(changed)).reusableTokens).toBeGreaterThan(0)
  })
})

describe("CacheLedger thinking limits", () => {
  const sessionID = "ses_limits"
  const think = (signature: string) => ({ type: "thinking", thinking: "hmm " + signature, signature })

  test("a long Session keeps the binding of every block its last request carried", () => {
    const ledger = memory()
    const messages: Body[] = [user("start")]
    for (let index = 0; index < CacheLedger.THINKING_LIMIT + 50; index++)
      messages.push({ role: "assistant", content: [think(`sig-${index}`), text(`step ${index}`)] }, user(`go ${index}`))
    const body = anthropicBody(messages)
    ledger.send(sessionID, request(ANTHROPIC, body))
    ledger.observe(sessionID, { input: 3, read: 0, write: 0 }, [])
    expect(Object.keys(ledger.sessions.get(sessionID)!.thinking)).toHaveLength(CacheLedger.THINKING_LIMIT + 50)
    // A change before the oldest block finds it stale, rather than of unknown binding.
    const stale = ledger.stale(sessionID, request(ANTHROPIC, { ...body, tools: [tool("read")] }))
    expect(stale?.unknown).toBe(false)
    expect(stale?.blocks).toHaveLength(CacheLedger.THINKING_LIMIT + 50)
    // Blocks no request carries any more (compacted away) make room first.
    ledger.send(sessionID, request(ANTHROPIC, anthropicBody([user("summary"), assistant("ok"), user("next")])))
    ledger.observe(sessionID, { input: 3, read: 0, write: 0 }, [])
    expect(Object.keys(ledger.sessions.get(sessionID)!.thinking)).toHaveLength(CacheLedger.THINKING_LIMIT + 50)
    ledger.send(
      sessionID,
      request(
        ANTHROPIC,
        anthropicBody([user("summary"), { role: "assistant", content: [think("sig-new"), text("ok")] }, user("next")]),
      ),
    )
    ledger.observe(sessionID, { input: 3, read: 0, write: 0 }, [])
    const kept = ledger.sessions.get(sessionID)!.thinking
    expect(Object.keys(kept)).toHaveLength(CacheLedger.THINKING_LIMIT + 1)
    expect(kept[CacheModel.thinkingID("sig-new")]).toBeDefined()
    expect(kept[CacheModel.thinkingID("sig-0")]).toBeUndefined()
  })
})

describe("CacheLedger automatic entries", () => {
  const sessionID = "ses_automatic"
  const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions"
  const chat = (messages: Body[], effort: string, time: number) =>
    request(
      OPENAI_CHAT,
      { model: "gpt-6-astra", stream: true, reasoning_effort: effort, messages },
      { authorization: "Bearer key", "x-session-affinity": sessionID },
      time,
    )

  test("a namespace keeps the newest request's every prefix and only the full prompts of earlier ones", () => {
    const ledger = memory()
    const messages: Body[] = [{ role: "system", content: "s".repeat(8000) }]
    const sent: CacheWire.Captured[] = []
    // The effort changes every ten turns, and with it every prefix (reasoning_effort keys the cache).
    for (let turn = 0; turn < 60; turn++) {
      messages.push({ role: "user", content: `question ${turn} ` + "q".repeat(400) })
      const captured = chat(messages, Math.floor(turn / 10) % 2 === 0 ? "high" : "low", NOW + turn * MINUTE)
      sent.push(captured)
      ledger.send(sessionID, captured)
      ledger.observe(sessionID, { input: 400, read: 2_000 + turn * 100, write: 0 })
      messages.push({ role: "assistant", content: `answer ${turn} ` + "a".repeat(400) })
    }
    const newest = CacheModel.normalize(sent.at(-1)!)
    const entries = ledger.entries.get(newest.namespace)!
    // Every prefix of the newest request, and the full prompt of the last request under the other effort: the earlier
    // ones under it are its prefixes.
    expect(Object.keys(entries)).toHaveLength(newest.blocks.length + 1)
    expect(Object.values(entries).filter((entry) => entry.tip)).toHaveLength(2)
    const now = NOW + 60 * MINUTE
    // The next turn hits; an edit early on still finds the prefix before it; an earlier request's full prompt is
    // still exact.
    expect(ledger.predict(sessionID, chat(messages, "low", now), now).status).toBe("hit")
    const edited = ledger.predict(
      sessionID,
      chat([...messages.slice(0, 5), { role: "user", content: "x" }], "low", now),
      now,
    )
    expect(edited.reusableTokens).toBeGreaterThan(0)
    const earlier = ledger.predict(sessionID, { ...sent[49], time: now }, now)
    expect(earlier.reusableExact).toBe(true)
    expect(earlier.reusableTokens).toBe(400 + 2_000 + 49 * 100)
  })
})

describe("CacheLedger pending sends", () => {
  test("keep what confirming them needs, never the request or its credential", () => {
    const captured = request(ANTHROPIC, anthropicBody([user("hello " + "x".repeat(4000))]), {
      "x-api-key": "secret-key",
      authorization: "Bearer secret-token",
    })
    const sent = CacheLedger.pending({
      record: undefined,
      entries: undefined,
      request: captured,
      ref: REF,
      snapshot: true,
    })
    const kept = JSON.stringify(sent)
    expect(kept).not.toContain("secret")
    expect(kept).not.toContain("x".repeat(200))
    expect(sent.normalized.blocks.every((block) => block.excerpt === "")).toBe(true)
  })
})

describe("CacheModel.checksThinking", () => {
  const anthropic = (id: string) => AnthropicMessages.route.model({ id })
  test("only Anthropic Messages models that bind thinking are checked", () => {
    expect(CacheModel.checksThinking(anthropic("claude-fable-5-1"))).toBe(true)
    expect(CacheModel.checksThinking(anthropic("claude-opus-4-8"))).toBe(false)
    expect(CacheModel.checksThinking(OpenAIResponses.route.model({ id: "gpt-5.5" }))).toBe(false)
    // An AI SDK route posts Anthropic bodies but builds them itself: nothing chooses its binding.
    const aisdk = anthropic("claude-fable-5-1")
    expect(CacheModel.checksThinking({ ...aisdk, route: { ...aisdk.route, protocol: "ai-sdk" } } as typeof aisdk)).toBe(
      false,
    )
  })
})

describe("CacheWire", () => {
  const llmRequest = LLM.request({
    model: AnthropicMessages.route
      .with({ endpoint: { baseURL: "https://api.anthropic.test/v1" }, auth: Auth.header("x-api-key", "key-a") })
      .model({ id: "claude-opus-5-5" }),
    prompt: "hello",
    cache: "none",
  })
  const post = (body = '{"x":1}', headers: Record<string, string> = {}) =>
    HttpClientRequest.post(ANTHROPIC).pipe(
      HttpClientRequest.setHeaders({ a: "1", ...headers }),
      HttpClientRequest.bodyText(body, "application/json"),
    )
  const respond = (seen: HttpClientRequest.HttpClientRequest[]) => (sent: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      seen.push(sent)
      return HttpClientResponse.fromWeb(sent, new Response("{}", { status: 200 }))
    })

  test("a dry run captures the request after plugin hooks and never calls the handler", async () => {
    const wire = CacheWire.make({ request: llmRequest, mode: { type: "dryrun" } })
    const seen: HttpClientRequest.HttpClientRequest[] = []
    // A plugin middleware that rewrites the body before handing it on.
    const plugin = (request: HttpClientRequest.HttpClientRequest, handler: (r: typeof request) => any) =>
      handler(request.pipe(HttpClientRequest.bodyText('{"x":2}', "application/json")))
    const http = wire.options({ http: plugin as never }).http!
    const exit = await Effect.runPromise(http(post(), respond(seen)).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(seen).toHaveLength(0)
    expect(wire.captured()?.body).toBe('{"x":2}')
    expect(wire.captured()?.headers.a).toBe("1")
    if (Exit.isFailure(exit)) expect(CacheWire.isDryRunFailure(Cause.squash(exit.cause))).toBe(true)
  })

  test("a send records the final request before handing it to the transport", async () => {
    const recorded: CacheWire.Captured[] = []
    const wire = CacheWire.make({
      request: llmRequest,
      mode: { type: "send", sent: (request) => Effect.sync(() => void recorded.push(request)) },
    })
    const seen: HttpClientRequest.HttpClientRequest[] = []
    await Effect.runPromise(wire.options({}).http!(post('{"y":1}'), respond(seen)))
    expect(seen).toHaveLength(1)
    expect(recorded.map((request) => request.body)).toEqual(['{"y":1}'])
    expect(wire.captured()).toBeUndefined()
  })

  test("a failing accounting callback never breaks the request", async () => {
    const wire = CacheWire.make({
      request: llmRequest,
      mode: { type: "send", sent: () => Effect.die(new Error("boom")) },
    })
    const seen: HttpClientRequest.HttpClientRequest[] = []
    await Effect.runPromise(wire.options({}).http!(post(), respond(seen)))
    expect(seen).toHaveLength(1)
  })

  test("gzip bodies are captured as their JSON text", async () => {
    const zlib = await import("node:zlib")
    const wire = CacheWire.make({ request: llmRequest, mode: { type: "dryrun" } })
    const compressed = HttpClientRequest.post(ANTHROPIC).pipe(
      HttpClientRequest.setHeaders({ "content-encoding": "gzip" }),
      HttpClientRequest.bodyUint8Array(new Uint8Array(zlib.gzipSync('{"z":3}')), "application/json"),
    )
    await Effect.runPromise(wire.options({}).http!(compressed, respond([])).pipe(Effect.exit))
    expect(wire.captured()?.body).toBe('{"z":3}')
  })

  test("a WebSocket dry run captures the HTTP-equivalent request and never opens the socket", async () => {
    const responses = LLM.request({
      model: OpenAIResponses.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("secret") })
        .model({ id: "gpt-5.5" }),
      prompt: "hello",
      cache: "none",
    })
    let executed = 0
    const executor = { execute: () => Effect.sync(() => void executed++).pipe(Effect.andThen(Effect.die("opened"))) }
    const dry = CacheWire.make({ request: responses, mode: { type: "dryrun" } })
    const exit = await Effect.runPromise(
      Effect.scoped(
        dry.options({ webSocket: executor as never }).webSocket!.execute({ connect: { url: "wss://x" } } as never),
      ).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(executed).toBe(0)
    expect(dry.captured()?.url).toBe("https://api.openai.test/v1/responses")
    expect(JSON.parse(dry.captured()!.body!)).toMatchObject({ model: "gpt-5.5", stream: true })
    // Captured for accounting, so never authenticated: the credential is named by its identity instead.
    expect(dry.captured()?.headers.authorization).toBeUndefined()

    const recorded: CacheWire.Captured[] = []
    const send = CacheWire.make({
      request: responses,
      mode: { type: "send", sent: (request) => Effect.sync(() => void recorded.push(request)) },
    })
    const passthrough = {
      execute: () => Effect.sync(() => void executed++).pipe(Effect.as({ frames: undefined, complete: Effect.void })),
    }
    await Effect.runPromise(
      Effect.scoped(send.options({ webSocket: passthrough as never }).webSocket!.execute({} as never)),
    )
    expect(executed).toBe(1)
    expect(recorded.map((request) => request.url)).toEqual(["https://api.openai.test/v1/responses"])
  })
})
