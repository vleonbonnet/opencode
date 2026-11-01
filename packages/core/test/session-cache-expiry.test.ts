import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { CacheLedger } from "@opencode/core/session/cache/ledger"
import { CacheModel } from "@opencode/core/session/cache/model"
import { SessionCache } from "@opencode/core/session/cache/service"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionTable } from "@opencode/core/session/sql"
import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Expiry } from "@opencode/schema/session-cache"
import { testEffect } from "./lib/effect"
import {
  chatTurn,
  confirmed,
  createSession,
  eventually,
  makeProvider,
  MODEL_ID,
  models,
  stack,
  turn,
} from "./lib/session-cache"

const provider = makeProvider()
const it = testEffect(stack(provider))

const HOUR = 60 * 60_000

const run = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.prompt({ sessionID, text, resume: false })
    yield* session.resume(sessionID)
  })

const collectUpdates = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const seen: Array<SessionEvent.Cache.Updated["data"]> = []
  yield* bus.subscribe(SessionEvent.Cache.Updated).pipe(
    Stream.runForEach((event) => Effect.sync(() => void seen.push(event.data))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

const updatesOf = (seen: ReadonlyArray<SessionEvent.Cache.Updated["data"]>, sessionID: Session.ID, count: number) =>
  eventually(
    Effect.sync(() => {
      const mine = seen.filter((update) => update.sessionID === sessionID)
      return mine.length >= count ? mine : undefined
    }),
    `${count} cache update(s) of ${sessionID}`,
  )

/**
 * The list and the events agree: each Session's newest update is what LISTED holds for it (absent without an expiry),
 * and every listed Session was published. Valid until an entry expires in time, which publishes nothing.
 */
const expectAgreement = (
  seen: ReadonlyArray<SessionEvent.Cache.Updated["data"]>,
  listed: ReadonlyMap<Session.ID, Expiry>,
) => {
  const newest = new Map(seen.map((update) => [update.sessionID, update.expiry]))
  for (const [sessionID, expiry] of newest) expect([sessionID, listed.get(sessionID)]).toEqual([sessionID, expiry])
  for (const sessionID of listed.keys()) expect(newest.has(sessionID)).toBe(true)
}

/** A child Session of PARENT: its turns keep the default five-minute TTL. */
const createChild = Effect.fn("test.createChild")(function* (sessionID: Session.ID, parentID: Session.ID) {
  yield* createSession(parentID)
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      parent_id: parentID,
      slug: "cache-child",
      directory: "/project",
      title: "cache child",
      version: "test",
      agent: Agent.ID.make("build"),
      model: { id: MODEL_ID, providerID: String(models.primary.ref.providerID) },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("session cache expiry", () => {
  it.effect("is listed and published after a cached turn, with the 1h TTL of a root session", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_expiry_root")
      const idle = Session.ID.make("ses_expiry_idle")
      yield* createSession(sessionID)
      yield* createSession(idle)
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 120_000 } }))
      yield* run(sessionID, "Say hello. " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)
      expect(provider.requests.at(-1)!.body.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" })

      const expected = { expires: sent + HOUR, ttl: HOUR, tokens: 120_000, promptTokens: 120_003 }
      const [update] = yield* updatesOf(seen, sessionID, 1)
      expect(update).toEqual({ sessionID, expiry: expected })
      const listed = yield* session.cache
      expect(listed.get(sessionID)).toEqual(expected)
      // A Session without a confirmed request has none.
      expect(listed.has(idle)).toBe(false)

      // The next turn reads the entry and restarts its window.
      yield* TestClock.adjust(Duration.minutes(30))
      provider.reply(turn({ text: "Fine.", usage: { input: 20, output: 2, read: 120_000, write: 40 } }))
      yield* run(sessionID, "And now?")
      yield* confirmed(sessionID, 2)
      const [, refreshed] = yield* updatesOf(seen, sessionID, 2)
      expect(refreshed.expiry).toEqual({
        expires: sent + 30 * 60_000 + HOUR,
        ttl: HOUR,
        tokens: 120_040,
        promptTokens: 120_060,
      })
      expect((yield* session.cache).get(sessionID)).toEqual(refreshed.expiry!)

      // Expiring in time publishes nothing; the list leaves the Session out.
      yield* TestClock.adjust(Duration.hours(1))
      expect((yield* session.cache).has(sessionID)).toBe(false)
      expect(seen.filter((update) => update.sessionID === sessionID)).toHaveLength(2)
    }),
  )

  it.effect("a child session's entries live five minutes", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_expiry_child")
      yield* createChild(sessionID, Session.ID.make("ses_expiry_parent"))
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 60_000 } }))
      yield* run(sessionID, "Say hello. " + "x".repeat(100_000))
      yield* confirmed(sessionID, 1)

      const expected = { expires: sent + 5 * 60_000, ttl: 5 * 60_000, tokens: 60_000, promptTokens: 60_003 }
      const [update] = yield* updatesOf(seen, sessionID, 1)
      expect(update.expiry).toEqual(expected)
      expect((yield* session.cache).get(sessionID)).toEqual(expected)
      yield* TestClock.adjust(Duration.minutes(5))
      expect((yield* session.cache).has(sessionID)).toBe(false)
    }),
  )

  it.effect("the preflight reports when the previous request's entry expires", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_expiry_preflight")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 120_000 } }))
      yield* run(sessionID, "Say hello. " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)

      yield* TestClock.adjust(Duration.minutes(10))
      const report = yield* session.preflight({ sessionID, text: "And now?" })
      expect(report.status).toBe("hit")
      expect(report.previous).toMatchObject({ time: sent, ageMs: 10 * 60_000, expires: sent + HOUR, ttl: HOUR })

      yield* TestClock.adjust(Duration.hours(1))
      const expired = yield* session.preflight({ sessionID, text: "And now?" })
      expect(expired.previous).toMatchObject({ time: sent })
      expect(expired.previous?.expires).toBeUndefined()
      expect(expired.previous?.ttl).toBeUndefined()
    }),
  )

  it.effect("a keep-alive generation that reads the entry publishes its new expiry", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_expiry_keepalive")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 120_000 } }))
      yield* run(sessionID, "Say hello. " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)
      yield* updatesOf(seen, sessionID, 1)

      yield* TestClock.adjust(Duration.minutes(50))
      provider.reply(turn({ text: "OK", usage: { input: 3, output: 1, read: 120_000, write: 500 } }))
      expect(yield* session.generate({ sessionID, prompt: "Reply with exactly: OK" })).toBe("OK")
      const [, kept] = yield* updatesOf(seen, sessionID, 2)
      // The generation read the Session's tip; its own prompt is not the Session's.
      const expected = { expires: sent + 50 * 60_000 + HOUR, ttl: HOUR, tokens: 120_000, promptTokens: 120_003 }
      expect(kept.expiry).toEqual(expected)
      expect((yield* session.cache).get(sessionID)).toEqual(expected)
    }),
  )

  it.effect("reads the ledger an earlier process persisted", () =>
    Effect.gen(function* () {
      // What a previous server process left in the database: a confirmed request and its namespace's entries.
      const sessionID = Session.ID.make("ses_expiry_restart")
      const kv = yield* KV.Service
      const now = yield* Clock.currentTimeMillis
      const captured = {
        url: "https://api.anthropic.test/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: 1000,
          system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [
            { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
          ],
        }),
        time: now - 2 * 60_000,
        credential: "key:test-key",
      }
      const record = CacheLedger.emptyRecord()
      const entries: CacheLedger.Entries = {}
      CacheLedger.observe({
        sent: CacheLedger.pending({
          record: undefined,
          entries,
          request: captured,
          ref: { id: models.primary.ref.id, providerID: models.primary.ref.providerID },
          snapshot: true,
        }),
        record,
        entries,
        usage: { input: 3, read: 0, write: 50_000 },
      })
      yield* kv.set(
        `session-cache:${sessionID}`,
        Schema.encodeSync(Schema.toCodecJson(CacheLedger.SessionRecord))(record),
      )
      yield* kv.set(
        `prompt-cache:${CacheModel.normalize(captured).namespace}`,
        Schema.encodeSync(Schema.toCodecJson(CacheLedger.Entries))(entries),
      )

      const session = yield* Session.Service
      const seen = yield* collectUpdates
      expect((yield* session.cache).get(sessionID)).toEqual({
        expires: now + 3 * 60_000,
        ttl: 5 * 60_000,
        tokens: 50_000,
        promptTokens: 50_003,
      })

      // Another Session's request extending that one (a fork's, or a generation sharing the prefix) reads its tip: the
      // Session it belongs to, known only from the persisted record, is told its entry was refreshed.
      const cache = yield* SessionCache.Service
      const other = Session.ID.make("ses_expiry_reader")
      const body = JSON.parse(captured.body)
      yield* cache.sent({ sessionID: other, ref: models.primary.ref, key: "gen_reader", snapshot: false })({
        ...captured,
        body: JSON.stringify({
          ...body,
          messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
            { role: "user", content: [{ type: "text", text: "go on", cache_control: { type: "ephemeral" } }] },
          ],
        }),
        time: now,
      })
      yield* cache.confirm({ sessionID: other, key: "gen_reader", usage: { input: 3, read: 50_000, write: 20 } })
      const [refreshed] = yield* updatesOf(seen, sessionID, 1)
      const expected = { expires: now + 5 * 60_000, ttl: 5 * 60_000, tokens: 50_000, promptTokens: 50_003 }
      expect(refreshed.expiry).toEqual(expected)
      expect((yield* session.cache).get(sessionID)).toEqual(expected)
      expect(seen.some((update) => update.sessionID === other)).toBe(false)

      // Once the conversation's 5m entry expired the Session has no cache, though its 1h system prompt (which the
      // other request refreshed too) is still live.
      yield* TestClock.adjust(Duration.minutes(5))
      expect((yield* session.cache).has(sessionID)).toBe(false)
      const kept = (yield* kv.get(`prompt-cache:${CacheModel.normalize(captured).namespace}`)) as CacheLedger.Entries
      expect(Object.values(kept).some((entry) => entry.expires === now + HOUR)).toBe(true)
    }),
  )

  it.effect("a root session whose tip expired is not listed while a sibling keeps the shared system prompt warm", () =>
    Effect.gen(function* () {
      const first = Session.ID.make("ses_expiry_root_first")
      const second = Session.ID.make("ses_expiry_root_second")
      yield* createSession(first)
      yield* createSession(second)
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Done.", usage: { input: 3, output: 2, write: 120_000 } }))
      yield* run(first, "First task. " + "a".repeat(200_000))
      yield* confirmed(first, 1)
      yield* updatesOf(seen, first, 1)

      // 50 minutes later the second Session reads the tools and system prompt they share, restarting their hour.
      yield* TestClock.adjust(Duration.minutes(50))
      const shared = (yield* session.preflight({ sessionID: second, text: "Second task." })).reusableTokens
      expect(shared).toBeGreaterThan(0)
      expect(shared).toBeLessThan(120_000)
      provider.reply(turn({ text: "Done.", usage: { input: 3, output: 2, read: shared, write: 90_000 } }))
      yield* run(second, "Second task. " + "b".repeat(150_000))
      yield* confirmed(second, 1)
      yield* updatesOf(seen, second, 1)
      expectAgreement(seen, yield* session.cache)

      yield* TestClock.adjust(Duration.minutes(10))
      const listed = yield* session.cache
      expect(listed.has(first)).toBe(false)
      // A next turn of the first Session would still read the shared prefix: its preflight says so, with the new hour.
      const report = yield* session.preflight({ sessionID: first, text: "And now?" })
      expect(report.reusableTokens).toBe(shared)
      expect(report.previous).toMatchObject({ expires: sent + 50 * 60_000 + HOUR, ttl: HOUR })
      expect(listed.get(second)).toEqual({
        expires: sent + 50 * 60_000 + HOUR,
        ttl: HOUR,
        tokens: shared + 90_000,
        promptTokens: shared + 90_003,
      })
      // The second Session's turn did not touch the first one's entry: nothing was published for it.
      expect(seen.filter((update) => update.sessionID === first)).toHaveLength(1)
    }),
  )

  it.effect("finished subagents are not listed while a running sibling keeps their shared prefix warm", () =>
    Effect.gen(function* () {
      const parent = Session.ID.make("ses_expiry_subagents")
      const done = Session.ID.make("ses_expiry_subagent_done")
      const running = Session.ID.make("ses_expiry_subagent_running")
      yield* createChild(done, parent)
      yield* createChild(running, parent)
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Done.", usage: { input: 3, output: 2, write: 60_000 } }))
      yield* run(done, "Look into this. " + "a".repeat(100_000))
      yield* confirmed(done, 1)
      yield* updatesOf(seen, done, 1)

      yield* TestClock.adjust(Duration.minutes(4))
      const shared = (yield* session.preflight({ sessionID: running, text: "Look into that." })).reusableTokens
      expect(shared).toBeGreaterThan(0)
      provider.reply(turn({ text: "Working.", usage: { input: 3, output: 2, read: shared, write: 40_000 } }))
      yield* run(running, "Look into that. " + "b".repeat(70_000))
      yield* confirmed(running, 1)
      yield* updatesOf(seen, running, 1)
      expectAgreement(seen, yield* session.cache)

      yield* TestClock.adjust(Duration.minutes(1))
      const listed = yield* session.cache
      expect(listed.has(done)).toBe(false)
      expect(listed.get(running)).toMatchObject({ expires: sent + 9 * 60_000, ttl: 5 * 60_000 })
      expect(seen.filter((update) => update.sessionID === done)).toHaveLength(1)
    }),
  )

  it.effect("a fork counts its own tip; its read of the parent's tip refreshes the parent's, which is published", () =>
    Effect.gen(function* () {
      const parent = Session.ID.make("ses_expiry_fork_parent")
      yield* createSession(parent)
      const session = yield* Session.Service
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 120_000 } }))
      yield* run(parent, "Say hello. " + "x".repeat(200_000))
      yield* confirmed(parent, 1)
      yield* updatesOf(seen, parent, 1)

      yield* TestClock.adjust(Duration.minutes(10))
      const fork = yield* session.fork({ sessionID: parent })
      // The fork replays the parent's history: its next turn reads the parent's tip.
      expect((yield* session.preflight({ sessionID: fork.id, text: "And now?" })).reusableTokens).toBe(120_000)
      provider.reply(turn({ text: "Fine.", usage: { input: 20, output: 2, read: 120_000, write: 40 } }))
      yield* run(fork.id, "And now?")
      yield* confirmed(fork.id, 1)
      const [own] = yield* updatesOf(seen, fork.id, 1)
      const [, refreshed] = yield* updatesOf(seen, parent, 2)
      expect(own.expiry).toEqual({ expires: sent + 70 * 60_000, ttl: HOUR, tokens: 120_040, promptTokens: 120_060 })
      expect(refreshed.expiry).toEqual({
        expires: sent + 70 * 60_000,
        ttl: HOUR,
        tokens: 120_000,
        promptTokens: 120_003,
      })
      expectAgreement(seen, yield* session.cache)

      // The fork goes on from its own tip; the parent's is no longer read.
      yield* TestClock.adjust(Duration.minutes(55))
      provider.reply(turn({ text: "Done.", usage: { input: 10, output: 2, read: 120_040, write: 30 } }))
      yield* run(fork.id, "Go on.")
      yield* confirmed(fork.id, 2)
      yield* updatesOf(seen, fork.id, 2)
      expect(seen.filter((update) => update.sessionID === parent)).toHaveLength(2)
      expectAgreement(seen, yield* session.cache)

      yield* TestClock.adjust(Duration.minutes(6))
      const listed = yield* session.cache
      expect(listed.has(parent)).toBe(false)
      expect(listed.get(fork.id)).toEqual({
        expires: sent + 125 * 60_000,
        ttl: HOUR,
        tokens: 120_070,
        promptTokens: 120_080,
      })
    }),
  )

  it.effect("automatic caching counts a session's full prompt", () =>
    Effect.gen(function* () {
      const first = Session.ID.make("ses_expiry_chat_first")
      const second = Session.ID.make("ses_expiry_chat_second")
      yield* createSession(first)
      yield* createSession(second)
      const session = yield* Session.Service
      yield* session.switchModel({ sessionID: first, model: models.chat.ref })
      yield* session.switchModel({ sessionID: second, model: models.chat.ref })
      const seen = yield* collectUpdates
      const sent = yield* Clock.currentTimeMillis
      provider.reply(chatTurn({ text: "Done.", usage: { input: 3_000, output: 2 } }))
      yield* run(first, "First task. " + "a".repeat(4_000))
      yield* confirmed(first, 1)
      const [own] = yield* updatesOf(seen, first, 1)
      // The provider's undocumented retention: the ledger's five-minute fallback.
      expect(own.expiry).toEqual({ expires: sent + 5 * 60_000, ttl: 5 * 60_000, tokens: 3_000, promptTokens: 3_000 })

      // Another Session caches under its own affinity; its turn leaves the first one's entry alone.
      yield* TestClock.adjust(Duration.minutes(2))
      provider.reply(chatTurn({ text: "Done.", usage: { input: 3_000, output: 2 } }))
      yield* run(second, "Second task. " + "b".repeat(4_000))
      yield* confirmed(second, 1)
      yield* updatesOf(seen, second, 1)
      expect(seen.filter((update) => update.sessionID === first)).toHaveLength(1)

      // The next turn reads the whole previous prompt; the new full prompt is the Session's entry.
      yield* TestClock.adjust(Duration.minutes(2))
      provider.reply(chatTurn({ text: "Fine.", usage: { input: 40, output: 2, read: 3_000 } }))
      yield* run(first, "And now?")
      yield* confirmed(first, 2)
      const [, next] = yield* updatesOf(seen, first, 2)
      expect(next.expiry).toEqual({ expires: sent + 9 * 60_000, ttl: 5 * 60_000, tokens: 3_040, promptTokens: 3_040 })
      expectAgreement(seen, yield* session.cache)

      yield* TestClock.adjust(Duration.minutes(5))
      expect((yield* session.cache).size).toBe(0)
    }),
  )
})
