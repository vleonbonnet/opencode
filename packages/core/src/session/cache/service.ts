export * as SessionCache from "./service.js"

// Prompt-cache ledger and thinking consent for Sessions.
//
// Every Session model request passes through a wire tap (model-request.ts) that sees its final bytes. Primary
// requests are kept as pending sends, keyed by their Step's assistant message, and confirmed when the Step ends with
// the provider's cache read/write counts. Preflights dry-run the next turn and compare it with what was confirmed.
//
// Claude 5.1+ binds each thinking signature to the prompt before it. A prompt chooses what happens to thinking that no
// longer matches (`metadata.thinkingLoss`). "ask": requests ask the provider to fail on a mismatch, and before a Step
// the runner dry-runs the request here to refuse known stale blocks itself. "accept": the blocks are marked dropped and
// replay as text from then on. Without it nobody is asked: the provider drops them, and the ledger records what it
// dropped.
//
// Records persist in KV: `session-cache:<sessionID>` per Session, `prompt-cache:<namespace>` per cache namespace. The
// service keeps decoded copies of the ones it uses, so a request never waits on decoding them; every change is
// written through. Another process sharing the database does not see this process's copies.

import { STALE_THINKING_ERROR, THINKING_LOSS } from "@opencode/schema/session-cache"
import type { DroppedThinking, PreflightReport, StaleThinking } from "@opencode/schema/session-cache"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { and, eq, inArray } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Database } from "../../database/database.js"
import { KeyedMutex } from "../../effect/keyed-mutex.js"
import { KV } from "../../kv.js"
import { SessionEvent } from "../event.js"
import { SessionHistory } from "../history.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionMessageTable } from "../sql.js"
import { CacheLedger } from "./ledger.js"
import { CacheModel } from "./model.js"
import type { CacheWire } from "./wire.js"

export type Report = PreflightReport
export type Dropped = DroppedThinking

const SESSION_PREFIX = "session-cache:"
const NAMESPACE_PREFIX = "prompt-cache:"
const sessionKey = (sessionID: SessionSchema.ID) => `${SESSION_PREFIX}${sessionID}`
const namespaceKey = (namespace: string) => `${NAMESPACE_PREFIX}${namespace}`

// In-memory bounds: pending sends per Session, and how long one waits for its Step to end (tools can run for hours)
// before it is dropped as abandoned; Sessions whose last request's excerpts explain a divergence; decoded records.
const PENDING_PER_SESSION = 8
const PENDING_TTL = 6 * 60 * 60_000
const EXCERPT_SESSIONS = 16
const RECORD_COPIES = 256
const NAMESPACE_COPIES = 64
// The sweep that prunes idle records starts after startup work settles, then runs hourly.
const SWEEP_DELAY = Duration.minutes(2)
const SWEEP_INTERVAL = Duration.hours(1)

/** The request a Session model call is about to make, for accounting. */
export interface Send {
  readonly sessionID: SessionSchema.ID
  readonly ref: CacheLedger.ModelRef
  /** Correlates the request with the usage that confirms it: the Step's assistant message ID, or a generation's. */
  readonly key: string
  /** False for requests that share the Session's prefix without being its next turn (keep-alive generations). */
  readonly snapshot: boolean
  /** How a Step's request treats stale thinking, where opencode chooses it. */
  readonly mode?: CacheLedger.Mode
}

export type Verdict =
  | { readonly type: "ok" }
  /** Stale thinking on a turn that asked first: fail the Step with this session error. */
  | { readonly type: "refused"; readonly error: { readonly type: string; readonly message: string } }
  /** Consent converted these blocks; rebuild the request with the Session's markers. */
  | { readonly type: "converted"; readonly dropped: readonly Dropped[] }

export interface Interface {
  /** The send-mode tap callback for one request: keeps it pending until its usage confirms it. */
  readonly sent: (send: Send) => NonNullable<Extract<CacheWire.Mode, { type: "send" }>["sent"]>
  /** Confirm a request recorded under KEY with its usage; Steps are confirmed from `session.step.ended`. */
  readonly confirm: (input: {
    readonly sessionID: SessionSchema.ID
    readonly key: string
    readonly usage: CacheLedger.Usage
  }) => Effect.Effect<void>
  /** Forget a request recorded under KEY that no usage will confirm: a failed generation, a Step given up. */
  readonly discard: (input: { readonly sessionID: SessionSchema.ID; readonly key: string }) => Effect.Effect<void>
  /** Predict how much of the provider's cache REQUEST (a dry run of the next turn) reuses. */
  readonly predict: (input: {
    readonly sessionID: SessionSchema.ID
    readonly request: CacheWire.Captured
    readonly ref: CacheLedger.ModelRef
    /**
     * Whether the model's requests bind thinking (`CacheModel.checksThinking`): only then is stale thinking reported,
     * as only then does the turn choose what happens to it.
     */
    readonly checksThinking: boolean
  }) => Effect.Effect<Report>
  /** A report for a next turn that could not be built. */
  readonly unknown: (input: {
    readonly sessionID: SessionSchema.ID
    readonly reason: string
    readonly ref?: CacheLedger.ModelRef
    /** What the turn loses; by default the whole previous prompt. */
    readonly lostTokens?: number
  }) => Effect.Effect<Report>
  /** What a Step needs before it is built: whether its request must be checked, and the dropped-thinking markers. */
  readonly step: (input: {
    readonly sessionID: SessionSchema.ID
    readonly accept: boolean
  }) => Effect.Effect<{ readonly check: boolean; readonly dropped: readonly Dropped[] }>
  /**
   * Check a Step's dry-run REQUEST for stale thinking. A turn that asked first is refused when a block is stale; with
   * consent every signed block from the first reported one on is marked dropped (as text), found in MESSAGES (the
   * Step's history).
   */
  readonly consent: (input: {
    readonly sessionID: SessionSchema.ID
    readonly request: CacheWire.Captured
    readonly accept: boolean
    readonly messages: ReadonlyArray<SessionMessage.Info>
  }) => Effect.Effect<Verdict>
  /**
   * The markers a turn sent with consent would be built with, without recording any: the Session's, and the blocks of
   * REQUEST (a dry run) consent would convert, found in MESSAGES. Undefined when consent converts nothing.
   */
  readonly consented: (input: {
    readonly sessionID: SessionSchema.ID
    readonly request: CacheWire.Captured
    readonly messages: ReadonlyArray<SessionMessage.Info>
  }) => Effect.Effect<readonly Dropped[] | undefined>
  /** The reasoning blocks later requests leave out, oldest first. */
  readonly dropped: (sessionID: SessionSchema.ID) => Effect.Effect<readonly Dropped[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCache") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// KV holds JSON. A record that does not decode reads as absent: the ledger then predicts from nothing (fail-safe)
// rather than failing a Step.
const RecordJson = Schema.toCodecJson(CacheLedger.SessionRecord)
const EntriesJson = Schema.toCodecJson(CacheLedger.Entries)
const decodeRecordOption = Schema.decodeUnknownOption(RecordJson)
const decodeEntriesOption = Schema.decodeUnknownOption(EntriesJson)
const encodeRecord = Schema.encodeSync(RecordJson)
const encodeEntries = Schema.encodeSync(EntriesJson)
// The ledger updates records in place; decoding builds fresh objects, so they are safe to mutate.
const decodeRecord = (value: unknown): CacheLedger.SessionRecord | undefined =>
  value === undefined
    ? undefined
    : (Option.getOrUndefined(decodeRecordOption(value)) as CacheLedger.SessionRecord | undefined)
const decodeEntries = (value: unknown): CacheLedger.Entries =>
  value === undefined
    ? {}
    : ((Option.getOrUndefined(decodeEntriesOption(value)) as CacheLedger.Entries | undefined) ?? {})

/** Set KEY to VALUE as the most recently used entry of MAP, keeping at most LIMIT. */
const remember = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
}

/**
 * The thinking blocks the provider reported dropping, from a Step's native data; undefined when it reported nothing
 * (an empty list is a report that nothing was dropped).
 */
export const droppedPaths = (native: Record<string, unknown> | undefined): CacheLedger.Drop[] | undefined => {
  const transformations = native?.inputTransformations
  if (!Array.isArray(transformations)) return undefined
  return transformations.flatMap((item) =>
    isRecord(item) && item.type === "thinking_dropped" && typeof item.path === "string"
      ? [{ path: item.path, ...(typeof item.reason === "string" ? { reason: item.reason } : {}) }]
      : [],
  )
}

/** The signature (or redacted data) identifying a reasoning item's signed block, if it has one. */
export const reasoningSignature = (item: SessionMessage.AssistantReasoning) => {
  const signature = item.native?.signature ?? item.native?.redactedData
  return typeof signature === "string" && signature.length > 0 ? signature : undefined
}

/** Where each signed reasoning block of MESSAGES lives: signature → (assistant message ID, reasoning ordinal). */
export const locate = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const located = new Map<string, { readonly messageID: SessionMessage.ID; readonly ordinal: number }>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    let ordinal = 0
    for (const item of message.content) {
      if (item.type !== "reasoning") continue
      const signature = reasoningSignature(item)
      if (signature) located.set(signature, { messageID: message.id, ordinal })
      ordinal++
    }
  }
  return located
}

/**
 * How a Step treats thinking that no longer matches, from the newest user message's `thinkingLoss` (any other value
 * counts as absent). Consent covers only the first Step answering that message: it was given for what a preflight
 * showed, so a later Step that finds new stale thinking asks again.
 */
export const thinkingMode = (messages: ReadonlyArray<SessionMessage.Info>, step: number): CacheLedger.Mode => {
  let answered = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === "assistant") answered = true
    if (message.type !== "user") continue
    const value = message.metadata?.[THINKING_LOSS]
    if (value === "accept") return step === 1 && !answered ? "accept" : "ask"
    return value === "ask" ? "ask" : "unasked"
  }
  return "unasked"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const locks = KeyedMutex.makeUnsafe<string>()
    const pendings = new Map<SessionSchema.ID, Map<string, CacheLedger.Pending>>()
    const excerpts = new Map<SessionSchema.ID, Map<string, string>>()
    // Decoded copies of what KV holds; `null` records a Session known to have none.
    const records = new Map<SessionSchema.ID, CacheLedger.SessionRecord | null>()
    const namespaces = new Map<string, CacheLedger.Entries>()

    // A read outside a key's lock keeps its copy only if no write stored a newer one meanwhile.
    const readRecord = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() => {
        const cached = records.get(sessionID)
        if (cached !== undefined) {
          remember(records, sessionID, cached, RECORD_COPIES)
          return Effect.succeed(cached ?? undefined)
        }
        return kv.get(sessionKey(sessionID)).pipe(
          Effect.map(decodeRecord),
          Effect.tap((record) =>
            Effect.sync(() => {
              if (!records.has(sessionID)) remember(records, sessionID, record ?? null, RECORD_COPIES)
            }),
          ),
          Effect.map((record) => (records.has(sessionID) ? (records.get(sessionID) ?? undefined) : record)),
        )
      })
    const readEntries = (namespace: string) =>
      Effect.suspend(() => {
        const cached = namespaces.get(namespace)
        if (cached) {
          remember(namespaces, namespace, cached, NAMESPACE_COPIES)
          return Effect.succeed(cached)
        }
        return kv.get(namespaceKey(namespace)).pipe(
          Effect.map(decodeEntries),
          Effect.tap((entries) =>
            Effect.sync(() => {
              if (!namespaces.has(namespace)) remember(namespaces, namespace, entries, NAMESPACE_COPIES)
            }),
          ),
          Effect.map((entries) => namespaces.get(namespace) ?? entries),
        )
      })

    const storeRecord = (sessionID: SessionSchema.ID, record: CacheLedger.SessionRecord, now: number) =>
      Effect.suspend(() => {
        const empty = CacheLedger.prune(record, now)
        remember(records, sessionID, empty ? null : record, RECORD_COPIES)
        return empty ? kv.remove(sessionKey(sessionID)) : kv.set(sessionKey(sessionID), encodeRecord(record))
      })
    const storeEntries = (namespace: string, entries: CacheLedger.Entries, now: number) =>
      Effect.suspend(() => {
        const empty = CacheLedger.pruneEntries(entries, now)
        remember(namespaces, namespace, entries, NAMESPACE_COPIES)
        return empty ? kv.remove(namespaceKey(namespace)) : kv.set(namespaceKey(namespace), encodeEntries(entries))
      })

    /** Read-modify-write a Session record under its lock. */
    const updateRecord = <A>(
      sessionID: SessionSchema.ID,
      update: (record: CacheLedger.SessionRecord, now: number) => Effect.Effect<A>,
    ) =>
      locks.withLock(sessionKey(sessionID))(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const record = (yield* readRecord(sessionID)) ?? CacheLedger.emptyRecord()
          const result = yield* update(record, now)
          yield* storeRecord(sessionID, record, now)
          return result
        }),
      )

    const updateEntries = (namespace: string, update: (entries: CacheLedger.Entries) => void) =>
      locks.withLock(namespaceKey(namespace))(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const entries = yield* readEntries(namespace)
          update(entries)
          yield* storeEntries(namespace, entries, now)
        }),
      )

    const publishDropped = (sessionID: SessionSchema.ID, added: readonly Dropped[]) =>
      added.length === 0
        ? Effect.void
        : bus.publish(SessionEvent.Thinking.Dropped, {
            sessionID,
            blocks: added.map((block) => ({
              messageID: block.messageID,
              ordinal: block.ordinal,
              reason: block.reason,
              asText: block.asText,
            })),
          })

    const historyOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(rows, (row) =>
        SessionHistory.decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined)),
      ).pipe(Effect.map((messages) => messages.filter((message) => message !== undefined)))
    })

    /** The signatures of the thinking a Step's reply produced, in order, from its assistant message. */
    const producedBy = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return []
      const message = yield* SessionHistory.decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
      if (message?.type !== "assistant") return []
      return message.content.flatMap((item) => {
        const signature = item.type === "reasoning" ? reasoningSignature(item) : undefined
        return signature ? [signature] : []
      })
    })

    const takePending = (sessionID: SessionSchema.ID, key: string) => {
      const map = pendings.get(sessionID)
      const sent = map?.get(key)
      if (!sent) return undefined
      map!.delete(key)
      if (map!.size === 0) pendings.delete(sessionID)
      return sent
    }

    // Sends no usage confirmed within the TTL were given up: an interrupted Step, an abandoned retry.
    const expirePending = (sessionID: SessionSchema.ID, now: number) => {
      const map = pendings.get(sessionID)
      if (!map) return
      for (const [key, sent] of map) if (now - sent.time >= PENDING_TTL) map.delete(key)
      if (map.size === 0) pendings.delete(sessionID)
    }

    /** Confirm SENT with its usage; mark the thinking it lost. A Step's send names its assistant message. */
    const settle = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      messageID: SessionMessage.ID | undefined,
      sent: CacheLedger.Pending,
      usage: CacheLedger.Usage,
      dropped: readonly CacheLedger.Drop[] | undefined,
    ) {
      // Keep-alive generations share the prefix but are not the Session's turn: they refresh the cache entries and
      // never change what the Session knows about its thinking.
      if (!sent.snapshot)
        return yield* updateEntries(sent.normalized.namespace, (entries) =>
          CacheLedger.confirmEntries({ sent, entries, usage }),
        )
      const produced = sent.produced && messageID ? yield* producedBy(sessionID, messageID) : []
      const lost: CacheLedger.LostThinking[] = []
      yield* updateRecord(sessionID, (record) =>
        updateEntries(sent.normalized.namespace, (entries) => {
          lost.push(...CacheLedger.observe({ sent, record, entries, usage, dropped, produced }))
        }),
      )
      if (lost.length === 0) return
      // Blocks the provider removed stay out of later requests: the thinking that request produced is bound to a
      // prompt without them.
      const located = locate(yield* historyOf(sessionID))
      const time = yield* Clock.currentTimeMillis
      const blocks = lost.flatMap((item) => {
        const where = located.get(item.signature)
        return where ? [{ ...where, reason: item.reason, asText: false, time }] : []
      })
      if (blocks.length === 0) return
      const added = yield* updateRecord(sessionID, (record) => Effect.succeed(CacheLedger.markDropped(record, blocks)))
      yield* publishDropped(sessionID, added)
    })

    const quietly = <A>(name: string, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`prompt-cache ${name} failed`, cause),
        ),
      )

    const onEnded = (event: SessionEvent.Step.Ended) =>
      Effect.suspend(() => {
        const sent = takePending(event.data.sessionID, event.data.assistantMessageID)
        if (!sent) return Effect.void
        return settle(
          event.data.sessionID,
          event.data.assistantMessageID,
          sent,
          { input: event.data.tokens.input, read: event.data.tokens.cache.read, write: event.data.tokens.cache.write },
          droppedPaths(event.data.native),
        )
      })

    const onFailed = (event: SessionEvent.Step.Failed) =>
      Effect.suspend(() => {
        const sent = takePending(event.data.sessionID, event.data.assistantMessageID)
        if (!sent || !CacheLedger.isThinkingRefusal(event.data.error.message)) return Effect.void
        // A thinking block the ledger could not predict was rejected: remember it, so the next preflight reports it and
        // the user can accept the loss instead of resending into the same error.
        return updateRecord(event.data.sessionID, (record, now) =>
          Effect.succeed(CacheLedger.refuseThinking(record, sent, event.data.error.message, now)),
        )
      })

    const onDeleted = (event: SessionEvent.Deleted) =>
      Effect.gen(function* () {
        pendings.delete(event.data.sessionID)
        excerpts.delete(event.data.sessionID)
        yield* locks.withLock(sessionKey(event.data.sessionID))(
          Effect.suspend(() => {
            records.delete(event.data.sessionID)
            return kv.remove(sessionKey(event.data.sessionID))
          }),
        )
      })

    // A fork copies the parent's settled history under new message IDs (`<fork event message ID>_<seq>`). Its thinking
    // blocks are the parent's, so their bindings, a refusal and the dropped markers carry over for the kept part.
    const onForked = (event: SessionEvent.Forked) =>
      Effect.gen(function* () {
        const parent = yield* readRecord(event.data.parentID)
        if (!parent) return
        const parentRows = parent.dropped.length
          ? yield* db
              .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, event.data.parentID),
                  inArray(
                    SessionMessageTable.id,
                    parent.dropped.map((block) => block.messageID),
                  ),
                ),
              )
              .all()
              .pipe(Effect.orDie)
          : []
        const prefix = SessionMessage.ID.fromEvent(event.id)
        const candidates = new Map(parentRows.map((row) => [row.id, SessionMessage.ID.make(`${prefix}_${row.seq}`)]))
        const kept =
          candidates.size === 0
            ? new Set<string>()
            : new Set(
                (yield* db
                  .select({ id: SessionMessageTable.id })
                  .from(SessionMessageTable)
                  .where(
                    and(
                      eq(SessionMessageTable.session_id, event.data.sessionID),
                      inArray(SessionMessageTable.id, [...candidates.values()]),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)).map((row) => row.id),
              )
        const dropped = parent.dropped.flatMap((block) => {
          const id = candidates.get(block.messageID)
          return id && kept.has(id) ? [{ ...block, messageID: id }] : []
        })
        yield* updateRecord(event.data.sessionID, (record) =>
          Effect.sync(() => {
            record.thinking = { ...parent.thinking, ...record.thinking }
            if (parent.produced) record.produced = { ...parent.produced, ...record.produced }
            if (parent.refused && !record.refused) record.refused = parent.refused
            record.seen = Math.max(record.seen ?? 0, parent.seen ?? parent.last?.time ?? 0)
            CacheLedger.markDropped(record, dropped)
          }),
        )
      })

    yield* bus
      .subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.Deleted, SessionEvent.Forked])
      .pipe(
        Stream.runForEach((event) => {
          switch (event.type) {
            case "session.step.ended":
              return quietly("confirmation", onEnded(event))
            case "session.step.failed":
              return quietly("refusal", onFailed(event))
            case "session.deleted":
              return quietly("cleanup", onDeleted(event))
            case "session.forked":
              return quietly("fork", onForked(event))
          }
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

    // Records of idle Sessions are only pruned when written; sweep the rest, and the sends nobody confirmed.
    const sweep = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      for (const sessionID of [...pendings.keys()]) expirePending(sessionID, started)
      for (const prefix of [SESSION_PREFIX, NAMESPACE_PREFIX]) {
        let after: string | undefined
        do {
          const page = yield* kv.scan({ prefix, after, limit: 200 })
          for (const entry of page.entries)
            yield* locks.withLock(entry.key)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                // This process's copy where it has one; otherwise what KV holds now, which another process may have
                // written since this process last looked.
                if (prefix === SESSION_PREFIX) {
                  const sessionID = entry.key.slice(SESSION_PREFIX.length) as SessionSchema.ID
                  const record = records.get(sessionID) ?? decodeRecord(yield* kv.get(entry.key))
                  if (!record) {
                    records.delete(sessionID)
                    return yield* kv.remove(entry.key)
                  }
                  return yield* storeRecord(sessionID, record, now)
                }
                const namespace = entry.key.slice(NAMESPACE_PREFIX.length)
                const entries = namespaces.get(namespace) ?? decodeEntries(yield* kv.get(entry.key))
                return yield* storeEntries(namespace, entries, now)
              }),
            )
          after = page.next
        } while (after !== undefined)
      }
    })
    yield* Effect.sleep(SWEEP_DELAY).pipe(
      Effect.andThen(quietly("sweep", sweep).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))),
      Effect.forkScoped({ startImmediately: true }),
    )

    const sent: Interface["sent"] = (send) => (request) =>
      Effect.gen(function* () {
        const record = yield* readRecord(send.sessionID)
        const analyzed = CacheModel.analyze(request)
        const normalized = analyzed.normalized
        const entries = normalized.format === "unknown" ? undefined : yield* readEntries(normalized.namespace)
        const next = CacheLedger.pending({
          record,
          entries,
          request,
          analyzed,
          ref: send.ref,
          mode: send.mode,
          snapshot: send.snapshot,
        })
        expirePending(send.sessionID, request.time)
        const map = pendings.get(send.sessionID) ?? new Map<string, CacheLedger.Pending>()
        map.delete(send.key)
        map.set(send.key, next)
        while (map.size > PENDING_PER_SESSION) map.delete(map.keys().next().value!)
        pendings.set(send.sessionID, map)
        if (!send.snapshot) return
        remember(
          excerpts,
          send.sessionID,
          new Map(normalized.blocks.map((block) => [block.own, block.excerpt])),
          EXCERPT_SESSIONS,
        )
      })

    const confirm: Interface["confirm"] = (input) =>
      Effect.suspend(() => {
        const sent = takePending(input.sessionID, input.key)
        return sent
          ? quietly("confirmation", settle(input.sessionID, undefined, sent, input.usage, undefined))
          : Effect.void
      })

    const discard: Interface["discard"] = (input) => Effect.sync(() => void takePending(input.sessionID, input.key))

    const staleReport = (
      record: CacheLedger.SessionRecord | undefined,
      request: CacheWire.Captured,
      sessionID: SessionSchema.ID,
    ) => {
      const stale = CacheLedger.staleThinking(record, request, excerpts.get(sessionID))
      if (!stale) return undefined
      return {
        // What consent converts: the reported blocks and every signed block after the first.
        count: stale.converted.length,
        reason: stale.reason,
        ...(stale.path ? { unit: stale.path } : {}),
      } satisfies StaleThinking
    }

    const predict: Interface["predict"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const record = yield* readRecord(input.sessionID)
        const normalized = CacheModel.normalize(input.request)
        const entries = normalized.format === "unknown" ? undefined : yield* readEntries(normalized.namespace)
        const report = CacheLedger.predict({
          record,
          entries,
          request: input.request,
          ref: input.ref,
          now,
          excerpts: excerpts.get(input.sessionID),
        })
        const stale = input.checksThinking ? staleReport(record, input.request, input.sessionID) : undefined
        return stale ? { ...report, staleThinking: stale } : report
      })

    const unknown: Interface["unknown"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return CacheLedger.unknown({
          record: yield* readRecord(input.sessionID),
          reason: input.reason,
          now,
          ref: input.ref,
          lostTokens: input.lostTokens,
        })
      })

    const step: Interface["step"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecord(input.sessionID)
        return {
          check:
            input.accept ||
            (record !== undefined &&
              (Object.keys(record.thinking).length > 0 || record.produced !== undefined || !!record.refused)),
          dropped: [...(record?.dropped ?? [])],
        }
      })

    /** The markers consent adds for the blocks of REQUEST it converts, found in MESSAGES; not recorded. */
    const conversion = (
      record: CacheLedger.SessionRecord | undefined,
      request: CacheWire.Captured,
      messages: ReadonlyArray<SessionMessage.Info>,
      time: number,
    ) => {
      const located = locate(messages)
      return CacheLedger.consentedThinking(record, request).flatMap((item) => {
        const where = located.get(item.signature)
        return where
          ? [{ signature: item.signature, block: { ...where, reason: item.reason, asText: true, time } }]
          : []
      })
    }

    const consent: Interface["consent"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecord(input.sessionID)
        const stale = CacheLedger.staleThinking(record, input.request, excerpts.get(input.sessionID))
        if (!stale) return { type: "ok" } as const
        // Blocks of unknown binding may well still match: a turn that asked first sends them, and only the provider
        // can refuse them.
        if (!input.accept)
          return stale.unknown
            ? ({ type: "ok" } as const)
            : ({
                type: "refused",
                error: { type: STALE_THINKING_ERROR, message: CacheLedger.staleMessage(stale) },
              } as const)
        // The consented request already replays the blocks as text, like every later one: the provider caches one
        // prompt, and the thinking it produces is bound to it. drop_block covers blocks this could not place.
        const converted = conversion(record, input.request, input.messages, yield* Clock.currentTimeMillis)
        const result = yield* updateRecord(input.sessionID, (current) =>
          Effect.sync(() => {
            CacheLedger.forgetThinking(
              current,
              converted.map((item) => item.signature),
            )
            return {
              added: CacheLedger.markDropped(
                current,
                converted.map((item) => item.block),
              ),
              all: [...current.dropped],
            }
          }),
        )
        yield* publishDropped(input.sessionID, result.added)
        yield* Effect.logWarning("stale thinking kept as text", {
          sessionID: input.sessionID,
          stale: stale.blocks.length,
          converted: converted.length,
        })
        return { type: "converted", dropped: result.all } as const
      })

    const consented: Interface["consented"] = (input) =>
      Effect.gen(function* () {
        const record = yield* readRecord(input.sessionID)
        const converted = conversion(record, input.request, input.messages, yield* Clock.currentTimeMillis)
        if (converted.length === 0) return undefined
        const markers = [...(record?.dropped ?? [])]
        CacheLedger.markDropped(
          { ...CacheLedger.emptyRecord(), dropped: markers },
          converted.map((item) => item.block),
        )
        return markers
      })

    const dropped: Interface["dropped"] = (sessionID) =>
      readRecord(sessionID).pipe(Effect.map((record) => [...(record?.dropped ?? [])]))

    return Service.of({ sent, confirm, discard, predict, unknown, step, consent, consented, dropped })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node, Database.node] })
