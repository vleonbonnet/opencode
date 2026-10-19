export * as CacheLedger from "./ledger.js"

// Cache ledger: what the provider has actually cached, as far as the wire and the provider's own usage reports can
// tell. Pure functions over plain records; the SessionCache service loads and stores them.
//
// Every Session request that leaves the process is normalized and kept as a pending send. When its Step ends, the
// provider-reported usage (cache read / write / uncached input) confirms which prefix entries exist, and is compared
// with the prediction made when the request was sent. A preflight for the next turn dry-runs the real request pipeline
// and asks the ledger how much of the previous prompt that exact request can reuse.
//
// Cache entries belong to a namespace (endpoint, credential, affinity), not to a Session: Anthropic-format caches are
// shared by every Session on the same gateway and credential. Session records keep the last confirmed request, the
// verifications, what each thinking block was bound to when the provider last accepted it (or, until a request replays
// it, when a Step produced it), a provider refusal, and the dropped-thinking markers.

import { SessionCache, THINKING_LOSS, UNKNOWN_BINDING } from "@opencode/schema/session-cache"
import type { Divergence as PublicDivergence, PreflightReport } from "@opencode/schema/session-cache"
import { Schema, type Types } from "effect"
import { CacheModel } from "./model.js"
import type { Captured } from "./wire.js"

// Records persist as JSON (KV); the schemas validate what is read back and encode what is written.

export type ModelRef = typeof SessionCache.ModelRef.Type

export const Entry = Schema.Struct({
  tokens: Schema.Number,
  exact: Schema.Boolean,
  expires: Schema.Number,
  ttl: Schema.Number,
  retentionSource: Schema.optional(Schema.String),
  /** Automatic formats: the full prompt of an earlier request, kept after its other prefixes are dropped. */
  tip: Schema.optional(Schema.Boolean),
})
export type Entry = Types.DeepMutable<typeof Entry.Type>

/** Cache entries of one namespace, keyed by block prefix hash. */
export const Entries = Schema.Record(Schema.String, Entry)
export type Entries = Record<string, Entry>

const Usage = Schema.Struct({ input: Schema.Number, read: Schema.Number, write: Schema.Number })
export type Usage = Types.DeepMutable<typeof Usage.Type>

export const Snapshot = Schema.Struct({
  namespace: Schema.String,
  format: Schema.Literals(["anthropic", "openai-chat", "openai-responses", "unknown"]),
  /** The model name on the wire. */
  model: Schema.optional(Schema.String),
  /** The model as opencode selected it. */
  ref: SessionCache.ModelRef,
  keyed: Schema.Record(Schema.String, Schema.String),
  namespaceParts: Schema.Record(Schema.String, Schema.String),
  blocks: Schema.Array(
    Schema.Struct({
      prefix: Schema.String,
      own: Schema.String,
      bytes: Schema.Number,
      path: Schema.String,
      label: Schema.String,
    }),
  ),
  totalBytes: Schema.Number,
  time: Schema.Number,
})
export type Snapshot = Types.DeepMutable<typeof Snapshot.Type>

const Verification = Schema.Struct({
  time: Schema.Number,
  predicted: Schema.Number,
  actual: Schema.Number,
  written: Schema.Number,
  prompt: Schema.Number,
  ok: Schema.Boolean,
})
export type Verification = Types.DeepMutable<typeof Verification.Type>

/** What a thinking block was bound to when the provider last accepted it: [system, tools, prefix]. */
const Bound = Schema.Tuple([Schema.String, Schema.String, Schema.String])
export type Bound = [system: string, tools: string, prefix: string]

export type Dropped = typeof SessionCache.DroppedThinking.Type

export const SessionRecord = Schema.Struct({
  last: Schema.optional(Schema.Struct({ ...Snapshot.fields, usage: Usage, prompt: Schema.Number })),
  verifications: Schema.Array(Verification),
  /**
   * What each thinking block of the accepted requests was bound to, keyed by its identity (`SignedThinking.id`). A
   * block whose binding changes since is no longer replayable.
   */
  thinking: Schema.Record(Schema.String, Bound),
  /**
   * What each thinking block a Step produced, and no request has replayed yet, was bound to: [system, tools, the
   * messages before its assistant message]. The first replay checks it, then binds it exactly in `thinking`.
   */
  produced: Schema.optional(Schema.Record(Schema.String, Bound)),
  /**
   * The provider rejected a thinking block the ledger could not predict, under the prompt `binding` names: it stays
   * rejected while that prompt does.
   */
  refused: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      detail: Schema.String,
      time: Schema.Number,
      binding: Schema.optional(Bound),
    }),
  ),
  /** Reasoning left out of every later request, for the Session's lifetime. */
  dropped: Schema.Array(SessionCache.DroppedThinking),
  /** When a request of this Session was last confirmed, or refused. */
  seen: Schema.optional(Schema.Number),
})
export type SessionRecord = Types.DeepMutable<typeof SessionRecord.Type>

type Match = { index: number; tokens: number; exact: boolean }

/**
 * What a Step's request does with replayed thinking that no longer matches the conversation, from the newest user
 * message's `thinkingLoss`.
 */
export type Mode =
  /** "ask": the provider fails instead ("error"); the user decides, so opencode refuses known stale blocks first. */
  | "ask"
  /** "accept": the user consented; stale blocks replay as text, the provider drops what the check missed. */
  | "accept"
  /** No `thinkingLoss`: nobody was asked; the provider drops stale blocks ("drop_block") and the turn proceeds. */
  | "unasked"

/** A request on its way to the provider, as the ledger keeps it until its usage confirms it. */
export type Pending = {
  /** The request's cache units, without their excerpts. */
  readonly normalized: CacheModel.Normalized
  readonly predicted: Match | undefined
  readonly time: number
  readonly ref: ModelRef
  /** How the request treats stale thinking; undefined where opencode does not choose (no binding check). */
  readonly mode: Mode | undefined
  /** The signed thinking the request carries. */
  readonly signed: readonly CacheModel.SignedThinking[]
  /** What the thinking its reply produces is bound to; undefined for formats without thinking bindings. */
  readonly produced: CacheModel.Produced | undefined
  /**
   * The blocks a request letting the provider drop stale thinking ("drop_block") is predicted to lose: the first stale
   * block and every signed block after it, as the provider drops them. Used when the provider does not say.
   */
  readonly stale: readonly CacheModel.SignedThinking[]
  /** False for requests that share the prefix but are not the Session's next turn (keep-alive generations). */
  readonly snapshot: boolean
}

/** A thinking block the provider reported removing from a request (`input_transformations`). */
export type Drop = { readonly path: string; readonly reason?: string }

export type Report = PreflightReport

// Expired entries are kept this long so a miss can say why ("expired after N idle minutes") instead of looking like a
// prefix that never existed.
export const RETAIN_EXPIRED = 24 * 60 * 60_000
// Sessions keep their cache snapshot this long, and their thinking bindings (or a provider refusal) this long.
export const RETAIN_CACHE = 48 * 60 * 60_000
export const RETAIN_THINKING = 30 * 24 * 60 * 60_000
// Thinking bindings kept per Session besides those of the blocks the last request carried, most recently accepted
// first to stay; and bindings of produced thinking no request has replayed yet.
export const THINKING_LIMIT = 500
export const PRODUCED_LIMIT = 64
// Automatic-format namespaces keep every prefix of their newest request, and the full prompts of this many others.
export const AUTOMATIC_TIPS = 64
// Entries kept per namespace, most recently refreshed first to stay.
export const ENTRY_LIMIT = 4_000

// Why a block is left out of later requests. Clients tell them apart by prefix.
export const DROPPED_WITH_CONSENT = "dropped with consent: no longer matches the conversation"
export const DROPPED_BY_PROVIDER = "dropped by the provider: no longer matches the conversation"
export const DROPPED_UNASKED = "dropped by the provider without asking: no longer matches the conversation"
export const DROPPED_OTHER_MODEL = "dropped by the provider: written by a model this one cannot read"

// Allow for provider rounding (e.g. Fireworks reports cache in 16k pages) and, for estimated entries, for the
// byte-to-token spread.
const tolerance = (value: number, exact = true) => Math.max(4096, Math.round(value * (exact ? 0.1 : 0.25)))

export const emptyRecord = (): SessionRecord => ({ verifications: [], thinking: {}, dropped: [] })

function snapshot(normalized: CacheModel.Normalized, ref: ModelRef, time: number): Snapshot {
  return {
    namespace: normalized.namespace,
    format: normalized.format,
    ...(normalized.model === undefined ? {} : { model: normalized.model }),
    ref: { id: ref.id, providerID: ref.providerID },
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
function lookup(normalized: CacheModel.Normalized, entries: Entries | undefined, now: number) {
  let best: Candidate | undefined
  let expired: Candidate | undefined
  let unreachable: Candidate | undefined
  if (!entries || normalized.format === "unknown") return { best, expired, unreachable }
  const consider = (index: number) => {
    const saved = entries[normalized.blocks[index].prefix]
    if (!saved) return
    // A window's policy can change since it was recorded. Reinterpret it under the current policy without resetting
    // when the prefix was used.
    const retention = normalized.automaticRetention
    const entry =
      retention && saved.retentionSource !== retention.source
        ? {
            ...saved,
            ttl: retention.ttl,
            expires: saved.expires - saved.ttl + retention.ttl,
            retentionSource: retention.source,
          }
        : saved
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
    const entry = entries[normalized.blocks[index].prefix]
    if (entry && entry.expires > now && (!best || index > best.index)) {
      unreachable = { index, entry, live: true }
      break
    }
  }
  return { best, expired, unreachable }
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

/** Excerpts of the blocks a Session last sent, by block hash. Kept in memory only. */
export type Excerpts = ReadonlyMap<string, string>

function divergence(
  normalized: CacheModel.Normalized,
  previous: Snapshot,
  excerpts: Excerpts | undefined,
): Divergence | undefined {
  const count = Math.min(normalized.blocks.length, previous.blocks.length)
  let index = 0
  while (index < count && normalized.blocks[index].prefix === previous.blocks[index].prefix) index++
  if (index === previous.blocks.length) return
  const current = normalized.blocks[index]
  const before = previous.blocks[index]
  return {
    index,
    path: current?.path ?? "(end of request)",
    label: current?.label ?? "",
    excerpt: current?.excerpt ?? "",
    ...(before
      ? {
          previousPath: before.path,
          previousLabel: before.label,
          ...(excerpts?.get(before.own) ? { previousExcerpt: excerpts.get(before.own) } : {}),
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
  // Tokens are only reported for whole requests; spread them over the prefix by serialized size. Exact values
  // replace estimates as usage confirms them.
  let upTo = 0
  let anchor = 0
  normalized.blocks.forEach((block, i) => {
    if (i <= index) upTo += block.bytes
    if (i <= anchorIndex) anchor += block.bytes
  })
  if (anchor === 0) return 0
  return Math.round((anchorTokens * upTo) / anchor)
}

const previousOf = (record: SessionRecord | undefined, now: number) =>
  record?.last
    ? {
        previous: {
          time: Math.max(0, Math.round(record.last.time)),
          promptTokens: Math.max(0, Math.round(record.last.prompt)),
          model: { id: record.last.ref.id, providerID: record.last.ref.providerID },
          ageMs: Math.max(0, Math.round(now - record.last.time)),
        },
      }
    : {}

/** The public form of a divergence: where the next request stops sharing the previous prompt. */
export const divergenceUnit = (diff: Divergence): PublicDivergence => ({
  unit: diff.path,
  index: diff.index,
  ...(diff.previousPath === undefined ? {} : { previousUnit: diff.previousPath }),
  ...(diff.excerpt ? { excerpt: diff.excerpt } : {}),
  ...(diff.previousExcerpt === undefined ? {} : { previousExcerpt: diff.previousExcerpt }),
})

/** Predict cache reuse for REQUEST, which a Session with RECORD is about to send to the model REF. */
export function predict(input: {
  readonly record: SessionRecord | undefined
  /** Entries of the request's namespace. */
  readonly entries: Entries | undefined
  readonly request: Captured
  readonly ref: ModelRef
  readonly now: number
  readonly excerpts?: Excerpts
}): Report {
  const normalized = CacheModel.normalize(input.request)
  const now = input.now
  const record = input.record
  const previous = record?.last
  const reasons: string[] = []
  const base = {
    format: normalized.format,
    model: { id: input.ref.id, providerID: input.ref.providerID },
    ...previousOf(record, now),
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
  const { best, expired, unreachable } = lookup(normalized, input.entries, now)
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
  const diff = previous ? divergence(normalized, previous, input.excerpts) : undefined
  if (diff && previous && !describeNamespace(normalized, previous).length) {
    reasons.push(
      `prompt diverges from the previous request at ${diff.previousPath ?? diff.path}` +
        (diff.previousPath && diff.previousPath !== diff.path ? ` (now ${diff.path})` : ""),
    )
  }
  const aged = expired && (!best || expired.index > best.index)
  if (aged) {
    const idle = Math.round((now - (expired.entry.expires - expired.entry.ttl)) / 60_000)
    reasons.push(
      `cache may have expired: idle ~${idle}m, retention window ${Math.round(expired.entry.ttl / 60_000)}m` +
        ` (${expired.entry.retentionSource ?? "requested cache_control TTL"})`,
    )
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
        : aged
          ? "unknown"
          : reusable > 0
            ? "partial"
            : "miss"
  return {
    ...base,
    status,
    reusableTokens: Math.max(0, Math.round(reusable)),
    reusableExact: best?.entry.exact ?? true,
    lostTokens: Math.max(0, Math.round(lost)),
    reasons,
    ...(diff ? { divergence: divergenceUnit(diff) } : {}),
  }
}

/** A report for when no request could be built; everything cached may be lost. */
export function unknown(input: {
  readonly record: SessionRecord | undefined
  readonly reason: string
  readonly now: number
  readonly ref?: ModelRef
  /** What the turn loses; by default the whole previous prompt. */
  readonly lostTokens?: number
}): Report {
  const previous = input.record?.last
  return {
    status: "unknown",
    ...(previous ? { format: previous.format } : {}),
    ...(input.ref ? { model: { id: input.ref.id, providerID: input.ref.providerID } } : {}),
    ...previousOf(input.record, input.now),
    reusableTokens: 0,
    reusableExact: false,
    lostTokens: Math.max(0, Math.round(input.lostTokens ?? previous?.prompt ?? 0)),
    reasons: [input.reason],
  }
}

/** Record that REQUEST is about to be sent, with the prediction to verify once its usage is known. */
export function pending(input: {
  readonly record: SessionRecord | undefined
  readonly entries: Entries | undefined
  readonly request: Captured
  /** REQUEST as `CacheModel.analyze` reads it, when the caller already did. */
  readonly analyzed?: CacheModel.Analyzed
  readonly ref: ModelRef
  readonly mode?: Mode
  readonly snapshot: boolean
}): Pending {
  const { normalized, thinking } = input.analyzed ?? CacheModel.analyze(input.request)
  const { best } = lookup(normalized, input.entries, input.request.time)
  const stale = input.record ? staleOf(input.record, thinking.signed) : undefined
  return {
    // Excerpts and the request itself stay out: a pending send can wait for hours, and its headers carry credentials.
    normalized: { ...normalized, blocks: normalized.blocks.map((block) => ({ ...block, excerpt: "" })) },
    predicted: best ? { index: best.index, tokens: best.entry.tokens, exact: best.entry.exact } : undefined,
    time: input.request.time,
    ref: input.ref,
    mode: input.mode,
    signed: thinking.signed,
    produced: thinking.produced,
    stale: stale && !stale.unknown && CacheModel.bindingBehavior(input.request) === "drop_block" ? stale.converted : [],
    snapshot: input.snapshot,
  }
}

/** A thinking block a request lost, and why. */
export type LostThinking = { readonly signature: string; readonly reason: string }

// Why the provider dropped a block, for the marker that keeps it out of later requests.
const droppedReason = (mode: Mode | undefined, reported: string | undefined) =>
  reported === "model_binding_mismatch"
    ? DROPPED_OTHER_MODEL
    : mode === "accept"
      ? DROPPED_WITH_CONSENT
      : mode === "unasked"
        ? DROPPED_UNASKED
        : DROPPED_BY_PROVIDER

const bound = (binding: { readonly system: string; readonly tools: string }, prefix: string): Bound => [
  binding.system,
  binding.tools,
  prefix,
]

/** Keep the LIMIT most recently written keys of RECORD, never those in KEEP. */
function evict(record: Record<string, unknown>, limit: number, keep: ReadonlySet<string> = new Set()) {
  const others = Object.keys(record).filter((key) => !keep.has(key))
  for (const key of others.slice(0, Math.max(0, others.length - limit))) delete record[key]
}

/**
 * Confirm SENT with the provider-reported USAGE (`input` excludes cached tokens; `read` and `write` are cache tokens),
 * updating RECORD and the ENTRIES of the request's namespace in place. DROPPED lists the thinking blocks the provider
 * reported removing (`input_transformations`); undefined when it reports nothing, and then the blocks the ledger
 * predicted a "drop_block" request to lose count as dropped. PRODUCED are the signatures of the thinking the reply
 * produced, in order. Returns every thinking block this request lost.
 *
 * A request that is not the Session's next turn (`snapshot` false: a keep-alive generation) only refreshes the cache
 * entries: it never changes what the Session knows about its thinking.
 */
export function observe(input: {
  readonly sent: Pending
  readonly record: SessionRecord
  readonly entries: Entries
  readonly usage: Usage
  readonly dropped?: readonly Drop[]
  readonly produced?: readonly string[]
}): LostThinking[] {
  const { sent, record, entries, usage } = input
  const normalized = sent.normalized
  const prompt = usage.input + usage.read + usage.write
  observeEntries(normalized, entries, usage, prompt, sent)
  if (!sent.snapshot) return []

  const predicted = sent.predicted?.tokens ?? 0
  record.verifications.push({
    time: sent.time,
    predicted,
    actual: usage.read,
    written: usage.write,
    prompt,
    // Under-prediction is safe; only reading less than predicted is a miss we failed to foresee.
    ok: usage.read >= predicted - tolerance(predicted, sent.predicted?.exact ?? true),
  })
  record.verifications = record.verifications.slice(-20)
  record.last = { ...snapshot(normalized, sent.ref, sent.time), usage, prompt }
  record.seen = Math.max(record.seen ?? 0, sent.time)

  // The provider accepted every thinking block it did not drop, so each was valid under this request's binding; later
  // requests are checked against it. What it dropped is what it reported, or, when it reports nothing, what the
  // ledger predicted.
  const removed = new Map(
    input.dropped !== undefined
      ? input.dropped.map((drop) => [drop.path, drop.reason] as const)
      : sent.stale.map((block) => [block.path, undefined] as const),
  )
  const lost: LostThinking[] = []
  const carried = new Set<string>()
  // Merge rather than replace: a request to another gateway or model carries none of these blocks, and they stay
  // replayable when the Session returns.
  for (const block of sent.signed) {
    delete record.thinking[block.id]
    delete record.produced?.[block.id]
    if (removed.has(block.path)) {
      lost.push({ signature: block.signature, reason: droppedReason(sent.mode, removed.get(block.path)) })
      continue
    }
    carried.add(block.id)
    record.thinking[block.id] = bound(block.binding, block.binding.prefix)
  }
  // Older bindings make room, never those of the blocks this request carried: in a long Session they are all still
  // replayed, and an evicted one could only be reported as of unknown binding. A request that carried none (another
  // model's turn) added none, and leaves them for when the Session returns.
  if (carried.size > 0) evict(record.thinking, THINKING_LIMIT, carried)
  // The reply's own thinking is bound to this prompt until a request replays it and the provider accepts it there.
  const produced = sent.produced
  if (produced && input.produced?.length) {
    record.produced ??= {}
    for (const signature of input.produced) {
      const id = CacheModel.thinkingID(signature)
      if (record.thinking[id]) continue
      delete record.produced[id]
      record.produced[id] = bound(produced, produced.start)
    }
  }
  if (record.produced) {
    evict(record.produced, PRODUCED_LIMIT)
    if (Object.keys(record.produced).length === 0) record.produced = undefined
  }
  // The refused block was carried again: accepted (the change was undone) or dropped.
  if (record.refused && sent.signed.some((block) => block.id === record.refused?.id)) record.refused = undefined
  return lost
}

/**
 * Confirm only the cache ENTRIES SENT refreshed, with its USAGE: for requests that share the Session's prefix without
 * being its next turn (keep-alive generations), which never change the Session's record.
 */
export function confirmEntries(input: { readonly sent: Pending; readonly entries: Entries; readonly usage: Usage }) {
  const { usage } = input
  observeEntries(input.sent.normalized, input.entries, usage, usage.input + usage.read + usage.write, input.sent)
}

function observeEntries(
  normalized: CacheModel.Normalized,
  entries: Entries,
  usage: Usage,
  prompt: number,
  sent: Pending,
) {
  if (normalized.format === "unknown" || normalized.blocks.length === 0) return
  const last = normalized.blocks.length - 1
  const retention = normalized.automaticRetention
  if (retention) {
    // Automatic caching stores the processed prompt, so every prefix of this request is an entry; providers that do
    // not cache at all are caught by verification on the next request. Of earlier requests only their full prompts
    // (tips) stay: the newest request already holds every prefix the conversation shares with them, and keeping each
    // request's every prefix would grow the namespace by a conversation's length per turn.
    const chain = new Set(normalized.blocks.map((block) => block.prefix))
    for (const [key, entry] of Object.entries(entries)) if (!entry.tip && !chain.has(key)) delete entries[key]
    normalized.blocks.forEach((block, index) => {
      entries[block.prefix] = {
        tokens: index === last ? prompt : tokensAt(index, normalized, last, prompt),
        exact: index === last,
        expires: sent.time + retention.ttl,
        ttl: retention.ttl,
        retentionSource: retention.source,
        ...(index === last ? { tip: true } : {}),
      }
    })
    const tips = Object.keys(entries).filter((key) => entries[key].tip && !chain.has(key))
    for (const key of tips.sort((a, b) => entries[a].expires - entries[b].expires).slice(0, -AUTOMATIC_TIPS))
      delete entries[key]
    return
  }
  if (usage.read + usage.write === 0) return
  // Explicit breakpoints: read + write is exactly the prefix up to the request's last breakpoint. Earlier breakpoints
  // are estimated unless they are the entry the provider just read.
  const breakpoints = normalized.blocks.flatMap((block, index) => (block.breakpoint ? [index] : []))
  const lastBreakpoint = breakpoints.at(-1)
  if (lastBreakpoint === undefined) return
  const anchor = usage.read + usage.write
  const readIndex =
    sent.predicted &&
    Math.abs(usage.read - sent.predicted.tokens) <= tolerance(sent.predicted.tokens, sent.predicted.exact)
      ? sent.predicted.index
      : undefined
  const touch = (index: number, tokens: number, exact: boolean, ttl: number) => {
    const key = normalized.blocks[index].prefix
    const existing = entries[key]
    entries[key] = {
      tokens: exact || !existing?.exact ? tokens : existing.tokens,
      exact: exact || (existing?.exact ?? false),
      expires: sent.time + ttl,
      ttl,
      retentionSource: "requested cache_control TTL",
    }
  }
  for (const index of breakpoints) {
    const ttl = normalized.blocks[index].breakpoint!.ttl
    if (index === lastBreakpoint) touch(index, anchor, true, ttl)
    else touch(index, tokensAt(index, normalized, lastBreakpoint, anchor), false, ttl)
  }
  if (readIndex !== undefined) {
    const existing = entries[normalized.blocks[readIndex].prefix]
    touch(readIndex, usage.read, true, existing?.ttl ?? CacheModel.ANTHROPIC_DEFAULT_TTL)
  }
}

export type StaleThinking = {
  /** The blocks of the request that can no longer be replayed, or whose binding is not known. */
  readonly blocks: readonly CacheModel.SignedThinking[]
  /** Why, for the user: what changed since the blocks were last accepted, or {@link UNKNOWN_BINDING}. */
  readonly reason: string
  /** First cache unit where the prompt diverges from the previous one. */
  readonly path?: string
  /**
   * No binding of these blocks is on record (a Session from before the ledger, or idle for over a month): they may
   * well still match, so they are sent, and only a provider refusal fails the turn.
   */
  readonly unknown: boolean
  /** What consent replays as text: every signed block of the request from the first reported one on. */
  readonly converted: readonly CacheModel.SignedThinking[]
}

const sameBinding = (bound: Bound, binding: CacheModel.Binding) =>
  bound[0] === binding.system && bound[1] === binding.tools && bound[2] === binding.prefix

const bindingChange = (bound: Bound, binding: CacheModel.Binding, prefix: string) =>
  bound[0] !== binding.system
    ? "the system prompt changed"
    : bound[1] !== binding.tools
      ? "the tool list changed"
      : bound[2] !== prefix
        ? "earlier messages changed"
        : undefined

function staleOf(
  record: SessionRecord | undefined,
  signed: readonly CacheModel.SignedThinking[],
): Omit<StaleThinking, "path"> | undefined {
  const stale: CacheModel.SignedThinking[] = []
  const unknown: CacheModel.SignedThinking[] = []
  const reasons = new Set<string>()
  // A refusal holds only while the prompt before the block is the one it was refused under: undoing the change
  // replays the block as it was accepted.
  const refused = record?.refused
  const rejected = refused && `the provider rejected the block at ${refused.path}: ${refused.detail}`
  let afterRefused = false
  for (const block of signed) {
    if (refused?.id === block.id && (!refused.binding || sameBinding(refused.binding, block.binding))) {
      afterRefused = true
      stale.push(block)
      reasons.add(rejected!)
      continue
    }
    // Whatever made the refused block stale, which the ledger could not see, precedes every later block too.
    if (afterRefused) {
      stale.push(block)
      continue
    }
    const accepted = record?.thinking[block.id]
    const produced = accepted ? undefined : record?.produced?.[block.id]
    if (!accepted && !produced) {
      unknown.push(block)
      continue
    }
    // A block no request replayed yet is known only up to its own message.
    const reason = accepted
      ? bindingChange(accepted, block.binding, block.binding.prefix)
      : bindingChange(produced!, block.binding, block.binding.start)
    if (!reason) continue
    stale.push(block)
    reasons.add(reason)
  }
  const reported = stale.length > 0 ? stale : unknown
  if (reported.length === 0) return
  const first = signed.findIndex((block) => block.id === reported[0].id)
  return {
    blocks: reported,
    reason: stale.length > 0 ? [...reasons].join("; ") : UNKNOWN_BINDING,
    unknown: stale.length === 0,
    converted: signed.slice(first),
  }
}

/**
 * The thinking blocks of REQUEST (about to be sent) that are no longer bound to what they were last accepted under,
 * or, for blocks no request replayed yet, produced under; plus a block the provider rejected under the same prompt.
 * The provider names the first invalid block, and whatever changed before it also precedes every later block, so every
 * later block is stale too. When nothing is stale, the blocks the ledger has no binding for are reported as of
 * {@link UNKNOWN_BINDING}.
 */
export function staleThinking(
  record: SessionRecord | undefined,
  request: Captured,
  excerpts?: Excerpts,
): StaleThinking | undefined {
  const { normalized, thinking } = CacheModel.analyze(request)
  const stale = staleOf(record, thinking.signed)
  if (!stale) return
  const diff = !stale.unknown && record?.last ? divergence(normalized, record.last, excerpts) : undefined
  const path = diff?.previousPath ?? diff?.path
  return { ...stale, ...(path ? { path } : {}) }
}

/**
 * The thinking blocks a request the user consented to lose stale thinking on replays as text instead (REQUEST is its
 * dry run): every signed block from the first reported one on. Text takes the place of the first, so it precedes every
 * later block and changes what each is bound to; those were already behind whatever made the first one stale.
 */
export function consentedThinking(record: SessionRecord | undefined, request: Captured): LostThinking[] {
  return (staleThinking(record, request)?.converted ?? []).map((block) => ({
    signature: block.signature,
    reason: DROPPED_WITH_CONSENT,
  }))
}

/** Forget the thinking blocks that will never be replayed again (SIGNATURES): their bindings and a refusal of one. */
export function forgetThinking(record: SessionRecord, signatures: readonly string[]) {
  const ids = new Set(signatures.map((signature) => CacheModel.thinkingID(signature)))
  for (const id of ids) {
    delete record.thinking[id]
    delete record.produced?.[id]
  }
  if (record.produced && Object.keys(record.produced).length === 0) record.produced = undefined
  if (record.refused && ids.has(record.refused.id)) record.refused = undefined
}

/**
 * True when MESSAGE is the provider rejecting a thinking block: its binding to the conversation ("The block is bound to
 * a different conversation"), or a signature it cannot verify. Recorded at
 * packages/ai/test/fixtures/recordings/bedrock-converse-thinking-binding/ and documented for the Claude API:
 * "messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.
 * Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block"." optionally followed by
 * the sentence that names what changed.
 */
export function isThinkingRefusal(message: string | undefined) {
  return !!message && /Invalid `signature` in `(?:redacted_)?thinking` block/.test(message)
}

/** What the provider said made the block invalid, for the user. */
function refusalDetail(message: string) {
  const named = /bound to a different conversation\.(?:.*?drop_block"?\.)?(?:\s*That setting requires[^.]*\.)?\s*(.*)$/s
    .exec(message)?.[1]
    ?.trim()
  if (named) return named
  return /bound to a different conversation/.test(message)
    ? "it no longer matches the conversation"
    : "the provider could not verify its signature"
}

/**
 * Record that the provider rejected SENT because a thinking block no longer matches (MESSAGE is the provider's
 * error), with the prompt it was rejected under, so the next preflight reports it and the user can accept dropping it
 * or undo the change. False when the block is not known.
 */
export function refuseThinking(record: SessionRecord, sent: Pending, message: string, now: number) {
  const path = /(messages\.\d+\.content\.\d+):/.exec(message)?.[1]
  if (!path) return false
  const block = sent.signed.find((item) => item.path === path)
  if (!block) return false
  record.refused = {
    id: block.id,
    path,
    detail: refusalDetail(message),
    time: now,
    binding: bound(block.binding, block.binding.prefix),
  }
  record.seen = Math.max(record.seen ?? 0, now)
  return true
}

export const STALE_THINKING = "Stale thinking"

const RETRY_WITH_CONSENT = `Send the turn again with metadata.${THINKING_LOSS} "accept"`

/** Why a turn that asked first was refused: the session error message, starting with "Stale thinking:". */
export function staleMessage(stale: StaleThinking) {
  const count = stale.blocks.length
  return (
    `${STALE_THINKING}: ${count} thinking block${count === 1 ? "" : "s"} from earlier turns no longer ` +
    `match${count === 1 ? "es" : ""} the conversation (${stale.reason}). ` +
    `${RETRY_WITH_CONSENT} to replay ${stale.converted.length === 1 ? "it" : "them"} as text, or undo the change.`
  )
}

/**
 * Why a turn that asked first failed when the provider rejected a thinking block the ledger could not vouch for
 * (MESSAGE is the provider's error): the session error message, starting with "Stale thinking:".
 */
export function refusalMessage(message: string) {
  return (
    `${STALE_THINKING}: the provider rejected a thinking block from an earlier turn (${refusalDetail(message)}). ` +
    `${RETRY_WITH_CONSENT} to replay it and the thinking after it as text, or undo the change.`
  )
}

/** Merge newly dropped blocks into RECORD; returns the ones that were not marked yet. */
export function markDropped(record: SessionRecord, blocks: readonly Dropped[]) {
  const key = (block: { messageID: string; ordinal: number }) => `${block.messageID}#${block.ordinal}`
  const known = new Set(record.dropped.map(key))
  const added = blocks.filter((block) => {
    if (known.has(key(block))) return false
    known.add(key(block))
    return true
  })
  record.dropped.push(...added)
  return added
}

/**
 * Drop what RECORD no longer needs at NOW: the cache snapshot and verifications past two days, thinking bindings and a
 * refusal past a month. Dropped-thinking markers stay for the Session's lifetime. True when nothing is left.
 */
export function prune(record: SessionRecord, now: number) {
  const seen = record.seen ?? record.last?.time ?? 0
  if (record.last && now - record.last.time >= RETAIN_CACHE) {
    record.last = undefined
    record.verifications = []
  }
  if (now - seen >= RETAIN_THINKING) {
    record.thinking = {}
    record.produced = undefined
    record.refused = undefined
  }
  return (
    !record.last &&
    record.verifications.length === 0 &&
    Object.keys(record.thinking).length === 0 &&
    record.produced === undefined &&
    !record.refused &&
    record.dropped.length === 0
  )
}

/** Drop entries expired for more than a day, then the least recently refreshed beyond the cap. */
export function pruneEntries(entries: Entries, now: number) {
  for (const [key, entry] of Object.entries(entries)) if (entry.expires <= now - RETAIN_EXPIRED) delete entries[key]
  const keys = Object.keys(entries)
  if (keys.length > ENTRY_LIMIT)
    for (const key of keys.sort((a, b) => entries[a].expires - entries[b].expires).slice(0, keys.length - ENTRY_LIMIT))
      delete entries[key]
  return Object.keys(entries).length === 0
}
