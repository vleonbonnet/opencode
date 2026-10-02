// Cache ledger: what the provider has actually cached, as far as the wire and
// the provider's own usage reports can tell.
//
// Every tagged request that leaves the process is normalized and kept as the
// session's pending request. When the step finishes, the provider-reported
// usage (cache read / write / uncached input) confirms which prefix entries
// exist, and is compared with the prediction made when the request was sent.
// A preflight for the next turn dry-runs the real request pipeline and asks
// the ledger how much of the previous prompt that exact request can reuse.

import fs from "fs"
import path from "path"
import { CacheModel } from "./model"
import type { Captured, Tag } from "./wire"
import { Wire } from "./wire"

type Entry = {
  tokens: number
  exact: boolean
  expires: number
  ttl: number
}

type Snapshot = {
  namespace: string
  format: CacheModel.Format
  model: string | undefined
  keyed: Record<string, string>
  namespaceParts: Record<string, string>
  blocks: { prefix: string; own: string; bytes: number; path: string; label: string }[]
  totalBytes: number
  time: number
}

type Usage = { input: number; read: number; write: number }

type Verification = {
  time: number
  predicted: number
  actual: number
  written: number
  prompt: number
  ok: boolean
}

type SessionRecord = {
  last?: Snapshot & { usage: Usage; prompt: number }
  verifications: Verification[]
  /**
   * What each thinking block of the last successful request was bound to,
   * keyed by its identity (`SignedThinking.id`): [system, tools, prefix].
   * A block whose binding changes since is no longer replayable.
   */
  thinking: Record<string, Bound>
  /** The provider rejected a thinking block the ledger could not predict. */
  refused?: { id: string; path: string; detail: string; time: number }
  /** When a request of this session was last confirmed. */
  seen?: number
}

type Bound = [system: string, tools: string, prefix: string]

type Pending = {
  normalized: CacheModel.Normalized
  predicted: Match | undefined
  time: number
  body: Captured
  /** Stale blocks a consented request (drop_block) lets the provider drop. */
  consented: readonly CacheModel.SignedThinking[]
}

type Match = {
  index: number
  tokens: number
  exact: boolean
}

export type Divergence = {
  readonly index: number
  readonly path: string
  readonly label: string
  readonly excerpt: string
  readonly previousPath?: string
  readonly previousLabel?: string
  readonly previousExcerpt?: string
}

export type Report = {
  readonly status: "hit" | "partial" | "miss" | "unknown"
  readonly format: CacheModel.Format
  readonly model?: string
  readonly previous?: {
    readonly time: number
    readonly promptTokens: number
    readonly model?: string
    readonly ageMs: number
  }
  readonly reusableTokens: number
  readonly reusableExact: boolean
  readonly lostTokens: number
  readonly reasons: readonly string[]
  readonly divergence?: Divergence
  readonly verification?: readonly Verification[]
}

// Expired entries are kept this long so a miss can say why ("expired after
// N idle minutes") instead of looking like a prefix that never existed.
const RETAIN_EXPIRED = 24 * 60 * 60_000

// Thinking bindings kept per session, most recently accepted first to stay.
const THINKING_LIMIT = 500

// Sessions keep their cache snapshot this long, and their thinking bindings
// (or a provider refusal) this long.
const RETAIN_CACHE = 48 * 60 * 60_000
const RETAIN_THINKING = 30 * 24 * 60 * 60_000

// Allow for provider rounding (e.g. Fireworks reports cache in 16k pages) and,
// for estimated entries, for the byte-to-token spread.
const tolerance = (value: number, exact = true) => Math.max(4096, Math.round(value * (exact ? 0.1 : 0.25)))

let file: string | undefined
const entries = new Map<string, Map<string, Entry>>()
const sessions = new Map<string, SessionRecord>()
const pending = new Map<string, Pending>()
// Excerpts of the last request per session; kept in memory only.
const excerpts = new Map<string, Map<string, string>>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
let loaded = false

function session(id: string) {
  let record = sessions.get(id)
  if (!record) {
    record = { verifications: [], thinking: {} }
    sessions.set(id, record)
  }
  return record
}

function namespace(id: string) {
  let map = entries.get(id)
  if (!map) {
    map = new Map()
    entries.set(id, map)
  }
  return map
}

/** Persist the ledger to FILE and load any saved state. Call once at startup. */
export function configure(input: { file?: string }) {
  file = input.file
  loaded = false
  load()
}

/** Forget all state (tests). */
export function reset() {
  entries.clear()
  sessions.clear()
  pending.clear()
  excerpts.clear()
  loaded = true
}

function load() {
  if (loaded) return
  loaded = true
  if (!file) return
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      entries?: Record<string, Record<string, Entry>>
      sessions?: Record<string, SessionRecord>
    }
    const now = Date.now()
    for (const [ns, map] of Object.entries(data.entries ?? {})) {
      for (const [key, entry] of Object.entries(map))
        if (entry.expires > now - RETAIN_EXPIRED) namespace(ns).set(key, entry)
    }
    for (const [id, record] of Object.entries(data.sessions ?? {}))
      sessions.set(id, { ...record, thinking: Array.isArray(record.thinking) ? {} : (record.thinking ?? {}) })
  } catch {
    // Missing or corrupt ledger: predictions start from nothing (fail-safe).
  }
}

function flush() {
  if (!file || flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    if (!file) return
    const now = Date.now()
    const out: { entries: Record<string, Record<string, Entry>>; sessions: Record<string, SessionRecord> } = {
      entries: {},
      sessions: {},
    }
    for (const [ns, map] of entries) {
      for (const [key, entry] of map) {
        if (entry.expires <= now - RETAIN_EXPIRED) {
          map.delete(key)
          continue
        }
        ;(out.entries[ns] ??= {})[key] = entry
      }
    }
    // Keep the most recently used sessions. Past two days their cache is gone,
    // so only what tells stale thinking apart stays, for a month: a session
    // resumed later is still asked about instead of failing at the provider.
    const time = (record: SessionRecord) => record.seen ?? record.last?.time ?? 0
    const recent = [...sessions.entries()]
      .filter(([, record]) => now - time(record) < RETAIN_THINKING)
      .sort((a, b) => time(b[1]) - time(a[1]))
      .slice(0, 200)
    for (const [id, record] of recent) {
      if (now - time(record) < RETAIN_CACHE) out.sessions[id] = record
      else if (Object.keys(record.thinking).length > 0 || record.refused)
        out.sessions[id] = {
          verifications: [],
          thinking: record.thinking,
          seen: time(record),
          ...(record.refused ? { refused: record.refused } : {}),
        }
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(out))
      fs.renameSync(temp, file)
    } catch {
      // Persistence is best-effort; in-memory state stays authoritative.
    }
  }, 1000)
  flushTimer.unref?.()
}

function snapshot(normalized: CacheModel.Normalized, time: number): Snapshot {
  return {
    namespace: normalized.namespace,
    format: normalized.format,
    model: normalized.model,
    keyed: { ...normalized.keyed },
    namespaceParts: { ...normalized.namespaceParts },
    blocks: normalized.blocks.map((block) => ({
      prefix: block.prefix,
      own: block.own,
      bytes: block.bytes,
      path: block.path,
      label: block.label,
    })),
    totalBytes: normalized.totalBytes,
    time,
  }
}

type Candidate = { index: number; entry: Entry; live: boolean }

/** Deepest cached entry the provider can use for NORMALIZED at time NOW. */
function lookup(normalized: CacheModel.Normalized, now: number) {
  const map = entries.get(normalized.namespace)
  let best: Candidate | undefined
  let expired: Candidate | undefined
  let unreachable: Candidate | undefined
  if (!map || normalized.format === "unknown") return { best, expired, unreachable }
  const consider = (index: number) => {
    const entry = map.get(normalized.blocks[index].prefix)
    if (!entry) return
    const live = entry.expires > now
    const candidate = { index, entry, live }
    if (live) {
      if (!best || index > best.index) best = candidate
      return
    }
    if (!expired || index > expired.index) expired = candidate
  }
  if (normalized.automatic) {
    for (let index = normalized.blocks.length - 1; index >= 0; index--) {
      consider(index)
      if (best) break
    }
    return { best, expired, unreachable }
  }
  const reachable = new Set<number>()
  normalized.blocks.forEach((block, index) => {
    if (!block.breakpoint) return
    for (let j = index; j >= Math.max(0, index - CacheModel.ANTHROPIC_LOOKBACK); j--) reachable.add(j)
  })
  for (const index of reachable) consider(index)
  // Entries that exist but sit beyond every breakpoint's lookback window.
  for (let index = normalized.blocks.length - 1; index >= 0; index--) {
    if (reachable.has(index)) continue
    const entry = map.get(normalized.blocks[index].prefix)
    if (entry && entry.expires > now && (!best || index > best.index)) {
      unreachable = { index, entry, live: true }
      break
    }
  }
  return { best, expired, unreachable }
}

function divergence(normalized: CacheModel.Normalized, previous: Snapshot, sessionID: string): Divergence | undefined {
  const count = Math.min(normalized.blocks.length, previous.blocks.length)
  let index = 0
  while (index < count && normalized.blocks[index].prefix === previous.blocks[index].prefix) index++
  if (index === previous.blocks.length) return
  const current = normalized.blocks[index]
  const before = previous.blocks[index]
  const known = excerpts.get(sessionID)
  return {
    index,
    path: current?.path ?? "(end of request)",
    label: current?.label ?? "",
    excerpt: current?.excerpt ?? "",
    ...(before
      ? {
          previousPath: before.path,
          previousLabel: before.label,
          ...(known?.get(before.own) ? { previousExcerpt: known.get(before.own) } : {}),
        }
      : {}),
  }
}

function describeKeyed(normalized: CacheModel.Normalized, previous: Snapshot) {
  const names = new Set([...Object.keys(normalized.keyed), ...Object.keys(previous.keyed)])
  return [...names].filter((name) => normalized.keyed[name] !== previous.keyed[name]).sort()
}

function describeNamespace(normalized: CacheModel.Normalized, previous: Snapshot) {
  const names = new Set([...Object.keys(normalized.namespaceParts), ...Object.keys(previous.namespaceParts)])
  return [...names].filter((name) => normalized.namespaceParts[name] !== previous.namespaceParts[name]).sort()
}

function tokensAt(index: number, normalized: CacheModel.Normalized, anchorIndex: number, anchorTokens: number) {
  // Tokens are only reported for whole requests; spread them over the prefix
  // by serialized size. Exact values replace estimates as usage confirms them.
  let upTo = 0
  let anchor = 0
  normalized.blocks.forEach((block, i) => {
    if (i <= index) upTo += block.bytes
    if (i <= anchorIndex) anchor += block.bytes
  })
  if (anchor === 0) return 0
  return Math.round((anchorTokens * upTo) / anchor)
}

/** Predict cache reuse for a request that SESSIONID is about to send. */
export function predict(sessionID: string, request: Captured): Report {
  load()
  const normalized = CacheModel.normalize(request)
  const now = Date.now()
  const record = sessions.get(sessionID)
  const previous = record?.last
  const verification = record?.verifications.slice(-5)
  const reasons: string[] = []
  const base = {
    format: normalized.format,
    model: normalized.model,
    ...(previous
      ? {
          previous: {
            time: previous.time,
            promptTokens: previous.prompt,
            model: previous.model,
            ageMs: now - previous.time,
          },
        }
      : {}),
    ...(verification?.length ? { verification } : {}),
  }
  if (normalized.format === "unknown") {
    return {
      ...base,
      status: "unknown",
      reusableTokens: 0,
      reusableExact: false,
      lostTokens: previous?.prompt ?? 0,
      reasons: [
        `request format for ${normalized.namespaceParts.endpoint} is not modelled; cache reuse cannot be predicted`,
      ],
    }
  }
  const { best, expired, unreachable } = lookup(normalized, now)
  const reusable = best?.entry.tokens ?? 0
  const lost = previous ? Math.max(0, previous.prompt - reusable) : 0

  if (!previous) {
    reasons.push(
      "no request from this session has been observed on the wire yet (new session, or sent before the cache ledger existed)",
    )
  } else {
    const moved = describeNamespace(normalized, previous)
    if (moved.length)
      reasons.push(
        best
          ? `cache namespace changed (${moved.join(", ")}), but it already holds a matching prefix from an earlier request`
          : `cache namespace changed (${moved.join(", ")}): caches are not shared across gateways, credentials or affinity`,
      )
    if (previous.model !== normalized.model)
      reasons.push(`model changed: ${previous.model ?? "?"} -> ${normalized.model ?? "?"}`)
    const keyed = describeKeyed(normalized, previous).filter((name) => name !== "model")
    if (keyed.length) reasons.push(`request parameters that key the cache changed: ${keyed.join(", ")}`)
  }
  const diff = previous ? divergence(normalized, previous, sessionID) : undefined
  if (diff && previous && !describeNamespace(normalized, previous).length) {
    reasons.push(
      `prompt diverges from the previous request at ${diff.previousPath ?? diff.path}` +
        (diff.previousPath && diff.previousPath !== diff.path ? ` (now ${diff.path})` : ""),
    )
  }
  if (expired && (!best || expired.index > best.index)) {
    const idle = Math.round((now - (expired.entry.expires - expired.entry.ttl)) / 60_000)
    reasons.push(`cached prefix expired: idle ~${idle}m, provider TTL ${Math.round(expired.entry.ttl / 60_000)}m`)
  }
  if (unreachable) {
    reasons.push(
      `a cached prefix exists at ${normalized.blocks[unreachable.index].path} but is more than ${CacheModel.ANTHROPIC_LOOKBACK} blocks before the request's cache breakpoints`,
    )
  }
  if (previous && reusable === 0 && !reasons.length && !diff)
    reasons.push("no cached prefix of this request is known: the provider never confirmed one, or evicted it")
  else if (previous && !reasons.length && lost > tolerance(previous.prompt))
    reasons.push("the previous request's full prompt is not cached: only an earlier prefix is known")
  const recent = record?.verifications.slice(-3) ?? []
  const unreliable = recent.filter((item) => !item.ok).length
  if (unreliable) {
    reasons.push(
      `${unreliable} of the last ${recent.length} requests read less cache than predicted; the provider may not be honouring this model`,
    )
  }
  const status: Report["status"] = !previous
    ? "unknown"
    : unreliable >= 2 && recent.length >= 2
      ? "unknown"
      : lost <= tolerance(previous.prompt)
        ? "hit"
        : reusable > 0
          ? "partial"
          : "miss"
  return {
    ...base,
    status,
    reusableTokens: reusable,
    reusableExact: best?.entry.exact ?? true,
    lostTokens: lost,
    reasons,
    ...(diff ? { divergence: diff } : {}),
  }
}

/** A report for when no request could be built; everything cached may be lost. */
export function unknown(sessionID: string, reason: string): Report {
  load()
  const record = sessions.get(sessionID)
  const previous = record?.last
  const now = Date.now()
  return {
    status: "unknown",
    format: previous?.format ?? "unknown",
    ...(previous?.model ? { model: previous.model } : {}),
    ...(previous
      ? {
          previous: {
            time: previous.time,
            promptTokens: previous.prompt,
            model: previous.model,
            ageMs: now - previous.time,
          },
        }
      : {}),
    reusableTokens: 0,
    reusableExact: false,
    lostTokens: previous?.prompt ?? 0,
    reasons: [reason],
    ...(record?.verifications.length ? { verification: record.verifications.slice(-5) } : {}),
  }
}

function recordSend(tag: Tag, request: Captured) {
  load()
  const normalized = CacheModel.normalize(request)
  const { best } = lookup(normalized, request.time)
  pending.set(tag.sessionID, {
    normalized,
    predicted: best ? { index: best.index, tokens: best.entry.tokens, exact: best.entry.exact } : undefined,
    time: request.time,
    body: request,
    consented: bindingBehavior(request) === "drop_block" ? (staleThinking(tag.sessionID, request)?.blocks ?? []) : [],
  })
  const map = new Map<string, string>()
  for (const block of normalized.blocks) map.set(block.own, block.excerpt)
  excerpts.delete(tag.sessionID)
  excerpts.set(tag.sessionID, map)
  while (excerpts.size > 16) excerpts.delete(excerpts.keys().next().value!)
}

/** A thinking block left out of a request, and why. */
export type DroppedThinking = { readonly signature: string; readonly reason: string }

/**
 * Confirm the pending request of SESSIONID with the provider-reported usage.
 * `input` excludes cached tokens; `read` and `write` are cache tokens.
 * DROPPED lists the content paths of thinking blocks the provider removed
 * (`input_transformations`). Returns every thinking block this request lost:
 * those, and the stale blocks a consented request let the provider drop.
 */
export function observe(sessionID: string, usage: Usage, dropped: readonly string[] = []): DroppedThinking[] {
  load()
  const sent = pending.get(sessionID)
  if (!sent) return []
  pending.delete(sessionID)
  const normalized = sent.normalized
  const prompt = usage.input + usage.read + usage.write
  const record = session(sessionID)
  const predicted = sent.predicted?.tokens ?? 0
  record.verifications.push({
    time: sent.time,
    predicted,
    actual: usage.read,
    written: usage.write,
    prompt,
    // Under-prediction is safe; only reading less than predicted is a miss we
    // failed to foresee.
    ok: usage.read >= predicted - tolerance(predicted, sent.predicted?.exact ?? true),
  })
  record.verifications = record.verifications.slice(-20)
  record.last = { ...snapshot(normalized, sent.time), usage, prompt }
  record.seen = sent.time
  // The provider accepted every thinking block it did not drop, so each was
  // valid under this request's binding; later requests are checked against it.
  const signed = CacheModel.signedThinking(sent.body)
  const removed = new Set(dropped)
  const lost: DroppedThinking[] = []
  const seen = new Set<string>()
  for (const block of sent.consented) {
    seen.add(block.id)
    lost.push({ signature: block.signature, reason: "dropped with consent: no longer matches the conversation" })
  }
  // Merge rather than replace: a request to another gateway or model carries
  // none of these blocks, and they stay replayable when the session returns.
  for (const id of seen) delete record.thinking[id]
  for (const block of signed) {
    delete record.thinking[block.id]
    if (removed.has(block.path)) {
      if (!seen.has(block.id))
        lost.push({ signature: block.signature, reason: "dropped by the provider: no longer matches the conversation" })
      continue
    }
    if (seen.has(block.id)) continue
    record.thinking[block.id] = [block.binding.system, block.binding.tools, block.binding.prefix]
  }
  const ids = Object.keys(record.thinking)
  for (const id of ids.slice(0, Math.max(0, ids.length - THINKING_LIMIT))) delete record.thinking[id]
  // The refused block was carried again: accepted (the change was undone) or dropped.
  if (record.refused && signed.some((block) => block.id === record.refused?.id)) record.refused = undefined

  if (normalized.format !== "unknown" && normalized.blocks.length > 0) {
    const map = namespace(normalized.namespace)
    const last = normalized.blocks.length - 1
    if (normalized.automatic) {
      // Automatic caching stores the processed prompt. Providers that do not
      // cache at all are caught by verification on the next request.
      const cachedTokens = prompt
      normalized.blocks.forEach((block, index) => {
        const tokens = index === last ? cachedTokens : tokensAt(index, normalized, last, cachedTokens)
        map.set(block.prefix, {
          tokens,
          exact: index === last,
          expires: sent.time + normalized.automaticTTL,
          ttl: normalized.automaticTTL,
        })
      })
    } else if (usage.read + usage.write > 0) {
      // Explicit breakpoints: read + write is exactly the prefix up to the
      // request's last breakpoint. Earlier breakpoints are estimated unless
      // they are the entry the provider just read.
      const breakpoints = normalized.blocks.flatMap((block, index) => (block.breakpoint ? [index] : []))
      const lastBreakpoint = breakpoints.at(-1)
      if (lastBreakpoint !== undefined) {
        const anchor = usage.read + usage.write
        const readIndex =
          sent.predicted &&
          Math.abs(usage.read - sent.predicted.tokens) <= tolerance(sent.predicted.tokens, sent.predicted.exact)
            ? sent.predicted.index
            : undefined
        const touch = (index: number, tokens: number, exact: boolean, ttl: number) => {
          const key = normalized.blocks[index].prefix
          const existing = map.get(key)
          map.set(key, {
            tokens: exact || !existing?.exact ? tokens : existing.tokens,
            exact: exact || (existing?.exact ?? false),
            expires: sent.time + ttl,
            ttl,
          })
        }
        for (const index of breakpoints) {
          const ttl = normalized.blocks[index].breakpoint!.ttl
          if (index === lastBreakpoint) touch(index, anchor, true, ttl)
          else touch(index, tokensAt(index, normalized, lastBreakpoint, anchor), false, ttl)
        }
        if (readIndex !== undefined) {
          const existing = map.get(normalized.blocks[readIndex].prefix)
          touch(readIndex, usage.read, true, existing?.ttl ?? CacheModel.ANTHROPIC_DEFAULT_TTL)
        }
      }
    }
  }
  flush()
  return lost
}

export type StaleThinking = {
  /** The blocks of the request that can no longer be replayed. */
  readonly blocks: readonly CacheModel.SignedThinking[]
  /** Why, for the user: what changed since the blocks were last accepted. */
  readonly reason: string
  /** First request path where the prompt diverges from the previous one. */
  readonly path?: string
}

/** The block binding behaviour REQUEST asks for, if any. */
function bindingBehavior(request: Captured): string | undefined {
  try {
    const body = request.body === undefined ? undefined : JSON.parse(request.body)
    const value = body?.thinking?.block_binding?.prefix_mismatch_behavior
    return typeof value === "string" ? value : undefined
  } catch {
    return
  }
}

/**
 * The thinking blocks of REQUEST (about to be sent) that are no longer bound
 * to what they were last accepted under, plus a block the provider already
 * rejected. The provider names the first invalid block, and whatever changed
 * before it also precedes every later block, so later blocks the ledger has
 * no binding for are stale too. Other unknown blocks are assumed valid.
 */
export function staleThinking(sessionID: string, request: Captured): StaleThinking | undefined {
  load()
  const record = sessions.get(sessionID)
  if (!record) return
  const signed = CacheModel.signedThinking(request)
  const stale: CacheModel.SignedThinking[] = []
  const reasons = new Set<string>()
  const refused = record.refused
  const rejected = refused && `the provider rejected the block at ${refused.path}: ${refused.detail}`
  let afterRefused = false
  for (const block of signed) {
    if (refused?.id === block.id) {
      afterRefused = true
      stale.push(block)
      reasons.add(rejected!)
      continue
    }
    const bound = record.thinking[block.id]
    if (!bound) {
      if (afterRefused) stale.push(block)
      continue
    }
    const reason =
      bound[0] !== block.binding.system
        ? "the system prompt changed"
        : bound[1] !== block.binding.tools
          ? "the tool list changed"
          : bound[2] !== block.binding.prefix
            ? "earlier messages changed"
            : undefined
    if (!reason) continue
    stale.push(block)
    reasons.add(reason)
  }
  if (stale.length === 0) return
  const diff = record.last ? divergence(CacheModel.normalize(request), record.last, sessionID) : undefined
  const path = diff?.previousPath ?? diff?.path
  return { blocks: stale, reason: [...reasons].join("; "), ...(path ? { path } : {}) }
}

/**
 * Record that the provider rejected SESSIONID's pending request because a
 * thinking block no longer matches (MESSAGE is the provider's error), so the
 * next preflight reports it and the user can accept dropping it.
 */
export function refuseThinking(sessionID: string, message: string) {
  load()
  const sent = pending.get(sessionID)
  const path = /(messages\.\d+\.content\.\d+):/.exec(message)?.[1]
  if (!sent || !path) return
  const block = CacheModel.signedThinking(sent.body).find((item) => item.path === path)
  if (!block) return
  const detail = /bound to a different conversation\.(?:.*?drop_block"?\.)?\s*(.*)$/s.exec(message)?.[1]?.trim()
  const record = session(sessionID)
  record.refused = {
    id: block.id,
    path,
    detail: detail || "it no longer matches the conversation",
    time: Date.now(),
  }
  record.seen = Date.now()
  flush()
}

/** True when MESSAGE is the provider rejecting a thinking block's binding. */
export function isThinkingRefusal(message: string | undefined) {
  return !!message && /Invalid `signature` in `(?:redacted_)?thinking` block/.test(message)
}

/** Drop the pending request of SESSIONID (the request failed before usage). */
export function discard(sessionID: string) {
  pending.delete(sessionID)
}

export const STALE_THINKING = "Stale thinking"

/** Refusal to send thinking blocks that no longer match, without the user's consent. */
export class StaleThinkingError extends Error {
  constructor(readonly stale: StaleThinking) {
    const count = stale.blocks.length
    super(
      `${STALE_THINKING}: ${count} thinking block${count === 1 ? "" : "s"} from earlier turns no longer ` +
        `match${count === 1 ? "es" : ""} the conversation (${stale.reason}). ` +
        "Send again and accept dropping them, or undo the change.",
    )
    this.name = "StaleThinkingError"
  }
}

Wire.onSend(recordSend)

// A request whose thinking no longer matches would be rejected (block binding
// "error") on every gateway, or silently stripped where "error" is not
// honoured. Refuse it here, on the exact body, unless it asks the provider to
// drop stale blocks: only a turn the user consented to does.
Wire.guard((tag, request) => {
  if (bindingBehavior(request) === "drop_block") return
  const stale = staleThinking(tag.sessionID, request)
  if (stale) throw new StaleThinkingError(stale)
})

export * as CacheLedger from "./ledger"
