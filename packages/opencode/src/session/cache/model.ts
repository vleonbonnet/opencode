// Prompt-cache model: turns a captured wire request into the sequence of
// prefix hashes a provider's prompt cache keys on.
//
// Providers cache on the rendered prompt prefix. We cannot see the rendering,
// but it is a deterministic function of the request, so two requests can only
// share a cached prefix up to the first block where their normalized request
// content differs. Fields are split into:
//
// - namespace: where the cache lives (endpoint, credential, routing affinity).
//   Caches are not shared across namespaces (verified: anthropic direct, grove
//   and copilot keep separate caches for byte-identical requests).
// - keyed fields: anything that may change rendering. Unknown fields are keyed
//   so the model can only err towards predicting a miss.
// - non-keyed fields: verified not to affect the cache (max_tokens, effort,
//   thinking.display on Anthropic; max_tokens, temperature on Fireworks), plus
//   sampling/transport fields that act after the prompt is processed.
//
// Formats with explicit breakpoints (Anthropic Messages) only create cache
// entries at `cache_control` blocks and only find an earlier entry within a
// 20-block lookback of a breakpoint (verified: 20 blocks hit, 22 miss).
// Automatic-prefix formats (OpenAI-compatible chat, Responses) cache every
// prefix of a processed request.

import { createHash } from "crypto"
import type { Captured } from "./wire"

export type Format = "anthropic" | "openai-chat" | "openai-responses" | "unknown"
export type Region = "tools" | "system" | "messages"

export const ANTHROPIC_LOOKBACK = 20
export const ANTHROPIC_DEFAULT_TTL = 5 * 60_000
// OpenAI documents 5-10 minutes of inactivity (up to an hour off-peak) for
// automatic caching; other OpenAI-compatible hosts do not document theirs.
// Stay conservative unless the request asks for extended retention.
export const AUTOMATIC_DEFAULT_TTL = 5 * 60_000

export type Block = {
  /** Chained hash of the normalized request prefix ending with this block. */
  readonly prefix: string
  /** Hash of this block alone, for diffing against a previous request. */
  readonly own: string
  readonly bytes: number
  readonly region: Region
  readonly path: string
  readonly label: string
  readonly excerpt: string
  /** Set when the request asks the provider to create a cache entry here. */
  readonly breakpoint?: { readonly ttl: number }
}

export type Normalized = {
  readonly format: Format
  readonly namespace: string
  readonly namespaceParts: Readonly<Record<string, string>>
  readonly model: string | undefined
  /** Hashes of keyed top-level fields, for explaining a divergence. */
  readonly keyed: Readonly<Record<string, string>>
  readonly blocks: readonly Block[]
  /** Automatic formats cache every prefix; explicit formats only breakpoints. */
  readonly automatic: boolean
  /** TTL applied to automatic entries. */
  readonly automaticTTL: number
  readonly totalBytes: number
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32)

const stable = (value: unknown) => JSON.stringify(value ?? null)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Remove cache markers: they place breakpoints but are not prompt content. */
function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "cache_control" || key === "cacheControl") continue
    out[key] = stripMarkers(item)
  }
  return out
}

function ttlOf(marker: unknown) {
  if (!isRecord(marker)) return
  return marker.ttl === "1h" ? 60 * 60_000 : ANTHROPIC_DEFAULT_TTL
}

function excerptOf(value: unknown) {
  const text = (() => {
    if (typeof value === "string") return value
    if (!isRecord(value)) return stable(value)
    for (const key of ["text", "thinking", "content", "output", "name", "arguments"]) {
      const item = value[key]
      if (typeof item === "string" && item) return item
    }
    return stable(value)
  })()
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 120 ? flat.slice(0, 117) + "..." : flat
}

function labelOf(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback
  const type = typeof value.type === "string" ? value.type : undefined
  const role = typeof value.role === "string" ? value.role : undefined
  return [role, type].filter(Boolean).join(" ") || fallback
}

function credential(headers: Readonly<Record<string, string>>) {
  const value = headers["x-api-key"] ?? headers["api-key"] ?? headers["authorization"] ?? ""
  return value ? hash("credential:" + value).slice(0, 16) : "none"
}

function endpoint(raw: string) {
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return raw
  }
}

type Draft = { value: unknown; region: Region; path: string; marker?: unknown; seed: string }

function chain(drafts: Draft[]) {
  const blocks: Block[] = []
  let previous = ""
  let total = 0
  for (const draft of drafts) {
    const text = stable(stripMarkers(draft.value))
    const own = hash(draft.region + "\u0000" + text)
    previous = hash(previous + "\u0000" + draft.seed + "\u0000" + own)
    total += text.length
    const ttl = ttlOf(draft.marker)
    blocks.push({
      prefix: previous,
      own,
      bytes: text.length,
      region: draft.region,
      path: draft.path,
      label: labelOf(draft.value, draft.region),
      excerpt: excerptOf(draft.value),
      ...(ttl !== undefined ? { breakpoint: { ttl } } : {}),
    })
  }
  return { blocks, total }
}

function keyedFields(body: Record<string, unknown>, skip: ReadonlySet<string>) {
  const keyed: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (skip.has(key)) continue
    keyed[key] = hash(stable(value))
  }
  return keyed
}

// Anthropic Messages -------------------------------------------------------

const ANTHROPIC_CONTENT = new Set(["system", "messages", "tools"])
// Verified on anthropic, grove and copilot: changing these keeps the cache.
const ANTHROPIC_NON_KEYED = new Set([
  "max_tokens",
  "stream",
  "metadata",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
])
// Documented to invalidate only the messages region (system/tools stay cached).
const ANTHROPIC_MESSAGES_KEYED = new Set(["thinking", "tool_choice"])
// Keyed request headers: they select features that change rendering.
const ANTHROPIC_KEYED_HEADERS = ["anthropic-beta", "anthropic-version"]

function anthropicSeeds(body: Record<string, unknown>, headers: Readonly<Record<string, string>>) {
  const global: Record<string, unknown> = {}
  const messages: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (ANTHROPIC_CONTENT.has(key) || ANTHROPIC_NON_KEYED.has(key)) continue
    if (key === "output_config" && isRecord(value)) {
      const { effort: _effort, ...rest } = value
      if (Object.keys(rest).length) global[key] = rest
      continue
    }
    if (ANTHROPIC_MESSAGES_KEYED.has(key)) {
      if (key === "thinking" && isRecord(value)) {
        const { display: _display, ...rest } = value
        messages[key] = rest
        continue
      }
      messages[key] = value
      continue
    }
    global[key] = value
  }
  for (const name of ANTHROPIC_KEYED_HEADERS) {
    const value = headers[name]
    if (value !== undefined)
      global["header:" + name] = value
        .split(",")
        .map((item) => item.trim())
        .sort()
  }
  return { global: hash(stable(global)), messages: hash(stable(messages)), fields: { ...global, ...messages } }
}

function anthropic(body: Record<string, unknown>, request: Captured): Omit<Normalized, "namespace" | "namespaceParts"> {
  const seeds = anthropicSeeds(body, request.headers)
  const drafts: Draft[] = []
  const tools = Array.isArray(body.tools) ? body.tools : []
  tools.forEach((tool, index) =>
    drafts.push({
      value: tool,
      region: "tools",
      path: `tools[${index}]${isRecord(tool) && typeof tool.name === "string" ? ` (${tool.name})` : ""}`,
      marker: isRecord(tool) ? tool.cache_control : undefined,
      seed: seeds.global,
    }),
  )
  const system =
    typeof body.system === "string"
      ? [{ type: "text", text: body.system }]
      : Array.isArray(body.system)
        ? body.system
        : []
  system.forEach((block, index) =>
    drafts.push({
      value: block,
      region: "system",
      path: `system[${index}]`,
      marker: isRecord(block) ? block.cache_control : undefined,
      seed: seeds.global,
    }),
  )
  const messages = Array.isArray(body.messages) ? body.messages : []
  messages.forEach((message, index) => {
    if (!isRecord(message)) return
    const role = typeof message.role === "string" ? message.role : "message"
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []
    content.forEach((block, part) =>
      drafts.push({
        value: { role, ...(isRecord(block) ? block : { value: block }) },
        region: "messages",
        path: `messages[${index}].content[${part}] (${role}${isRecord(block) && typeof block.type === "string" ? " " + block.type : ""})`,
        marker: isRecord(block) ? block.cache_control : undefined,
        seed: seeds.global + seeds.messages,
      }),
    )
  })
  const { blocks, total } = chain(drafts)
  return {
    format: "anthropic",
    model: typeof body.model === "string" ? body.model : undefined,
    keyed: Object.fromEntries(Object.entries(seeds.fields).map(([key, value]) => [key, hash(stable(value))])),
    blocks,
    automatic: false,
    automaticTTL: 0,
    totalBytes: total,
  }
}

// OpenAI-compatible chat ---------------------------------------------------

// Verified on Fireworks: max_tokens and temperature keep the cache; the rest
// only drive decoding or transport. reasoning_effort is rendered by chat
// templates and did break the cache, so it stays keyed.
const CHAT_NON_KEYED = new Set([
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "seed",
  "n",
  "stop",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "logprobs",
  "top_logprobs",
  "metadata",
])

function openaiChat(body: Record<string, unknown>): Omit<Normalized, "namespace" | "namespaceParts"> {
  const skip = new Set([...CHAT_NON_KEYED, "messages", "tools"])
  const keyed = keyedFields(body, skip)
  const seed = hash(stable(keyed))
  const drafts: Draft[] = []
  const tools = Array.isArray(body.tools) ? body.tools : []
  tools.forEach((tool, index) =>
    drafts.push({
      value: tool,
      region: "tools",
      path: `tools[${index}]${isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? ` (${tool.function.name})` : ""}`,
      seed,
    }),
  )
  const messages = Array.isArray(body.messages) ? body.messages : []
  messages.forEach((message, index) => {
    const role = isRecord(message) && typeof message.role === "string" ? message.role : "message"
    drafts.push({
      value: message,
      region: role === "system" || role === "developer" ? "system" : "messages",
      path: `messages[${index}] (${role})`,
      seed,
    })
  })
  const { blocks, total } = chain(drafts)
  return {
    format: "openai-chat",
    model: typeof body.model === "string" ? body.model : undefined,
    keyed,
    blocks,
    automatic: true,
    automaticTTL: body.prompt_cache_retention === "24h" ? 24 * 60 * 60_000 : AUTOMATIC_DEFAULT_TTL,
    totalBytes: total,
  }
}

// OpenAI Responses ---------------------------------------------------------

const RESPONSES_NON_KEYED = new Set([
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_logprobs",
  "metadata",
  "include",
  "store",
  "background",
])

function openaiResponses(body: Record<string, unknown>): Omit<Normalized, "namespace" | "namespaceParts"> {
  const skip = new Set([...RESPONSES_NON_KEYED, "input", "tools", "instructions"])
  const keyed = keyedFields(body, skip)
  const seed = hash(stable(keyed))
  const drafts: Draft[] = []
  const tools = Array.isArray(body.tools) ? body.tools : []
  tools.forEach((tool, index) =>
    drafts.push({
      value: tool,
      region: "tools",
      path: `tools[${index}]${isRecord(tool) && typeof tool.name === "string" ? ` (${tool.name})` : ""}`,
      seed,
    }),
  )
  if (typeof body.instructions === "string")
    drafts.push({ value: body.instructions, region: "system", path: "instructions", seed })
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : []
  input.forEach((item, index) => {
    const role =
      isRecord(item) && typeof item.role === "string"
        ? item.role
        : isRecord(item) && typeof item.type === "string"
          ? item.type
          : "item"
    drafts.push({
      value: item,
      region: role === "system" || role === "developer" ? "system" : "messages",
      path: `input[${index}] (${role})`,
      seed,
    })
  })
  const { blocks, total } = chain(drafts)
  return {
    format: "openai-responses",
    model: typeof body.model === "string" ? body.model : undefined,
    keyed,
    blocks,
    automatic: true,
    automaticTTL: body.prompt_cache_retention === "24h" ? 24 * 60 * 60_000 : AUTOMATIC_DEFAULT_TTL,
    totalBytes: total,
  }
}

function detect(request: Captured, body: unknown): Format {
  if (!isRecord(body)) return "unknown"
  const pathname = (() => {
    try {
      return new URL(request.url).pathname
    } catch {
      return request.url
    }
  })()
  if (pathname.endsWith("/messages") && Array.isArray(body.messages) && "max_tokens" in body) return "anthropic"
  if (pathname.endsWith("/chat/completions") && Array.isArray(body.messages)) return "openai-chat"
  if (pathname.endsWith("/responses") && ("input" in body || "instructions" in body)) return "openai-responses"
  return "unknown"
}

export function normalize(request: Captured): Normalized {
  let body: unknown
  try {
    body = request.body === undefined ? undefined : JSON.parse(request.body)
  } catch {
    body = undefined
  }
  const format = detect(request, body)
  const parts: Record<string, string> = {
    endpoint: endpoint(request.url),
    credential: credential(request.headers),
  }
  // Automatic-prefix hosts route cache hits by affinity (verified on Fireworks:
  // a different or missing x-session-affinity misses). Explicit-breakpoint
  // caches are organisation-wide.
  if (format !== "anthropic") {
    const affinity = request.headers["x-session-affinity"]
    if (affinity) parts.affinity = affinity
  }
  const namespace = hash(stable(parts))
  if (format === "unknown" || !isRecord(body)) {
    return {
      format: "unknown",
      namespace,
      namespaceParts: parts,
      model: isRecord(body) && typeof body.model === "string" ? body.model : undefined,
      keyed: {},
      blocks: [],
      automatic: false,
      automaticTTL: 0,
      totalBytes: request.body?.length ?? 0,
    }
  }
  const shape =
    format === "anthropic"
      ? anthropic(body, request)
      : format === "openai-chat"
        ? openaiChat(body)
        : openaiResponses(body)
  return { ...shape, namespace, namespaceParts: parts }
}

// Thinking-signature binding ------------------------------------------------
//
// What an Anthropic thinking signature is bound to, measured on direct
// Anthropic and Copilot (claude-opus-5-5, thinking-binding-controls): the
// system prompt, the tool set (order does not matter) and every content block
// before the thinking block, its own message included. Not bound: cache
// markers, max_tokens, output_config.effort, the thinking config (even its
// absence), tool_choice, content after the block, and other thinking blocks
// (removing an earlier thinking block leaves later ones valid).

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])

export type SignedThinking = {
  /** Hash of the signature (or redacted data): the block's identity. */
  readonly id: string
  /** The signature or redacted data itself, as replayed. */
  readonly signature: string
  readonly path: string
  /** Hashes of what the block is bound to. */
  readonly binding: Binding
}

export type Binding = {
  readonly system: string
  readonly tools: string
  /** Every non-thinking content block before this one, roles included. */
  readonly prefix: string
}

function parseAnthropic(request: Captured): Record<string, unknown> | undefined {
  let body: unknown
  try {
    body = request.body === undefined ? undefined : JSON.parse(request.body)
  } catch {
    return
  }
  if (!isRecord(body) || detect(request, body) !== "anthropic") return
  return body
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

/** The signed thinking blocks of an Anthropic REQUEST, with their binding. Empty for other formats. */
export function signedThinking(request: Captured): SignedThinking[] {
  const body = parseAnthropic(request)
  if (!body || !Array.isArray(body.messages)) return []
  const system = hash("system:" + stable(stripMarkers(contentBlocks(body.system))))
  const tools = hash(
    "tools:" + stable((Array.isArray(body.tools) ? body.tools : []).map((tool) => stable(stripMarkers(tool))).sort()),
  )
  const out: SignedThinking[] = []
  let prefix = hash("messages:")
  body.messages.forEach((message: unknown, index: number) => {
    if (!isRecord(message)) return
    prefix = hash(prefix + "\u0000role:" + String(message.role))
    contentBlocks(message.content).forEach((block, position) => {
      if (isRecord(block) && THINKING_TYPES.has(String(block.type))) {
        const signature = block.type === "thinking" ? block.signature : block.data
        if (typeof signature === "string" && signature)
          out.push({
            id: hash("thinking:" + signature),
            signature,
            path: `messages.${index}.content.${position}`,
            binding: { system, tools, prefix },
          })
        return
      }
      prefix = hash(prefix + "\u0001" + stable(stripMarkers(block)))
    })
  })
  return out
}

export * as CacheModel from "./model"
