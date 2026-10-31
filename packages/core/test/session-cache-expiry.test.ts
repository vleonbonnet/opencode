import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { CacheLedger } from "@opencode/core/session/cache/ledger"
import { CacheModel } from "@opencode/core/session/cache/model"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionTable } from "@opencode/core/session/sql"
import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { confirmed, createSession, eventually, makeProvider, MODEL_ID, models, stack, turn } from "./lib/session-cache"

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

      const expected = { expires: sent + HOUR, ttl: HOUR, tokens: 120_000 }
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
      expect(refreshed.expiry).toEqual({ expires: sent + 30 * 60_000 + HOUR, ttl: HOUR, tokens: 120_040 })
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

      const expected = { expires: sent + 5 * 60_000, ttl: 5 * 60_000, tokens: 60_000 }
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
      const expected = { expires: sent + 50 * 60_000 + HOUR, ttl: HOUR, tokens: 120_000 }
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
      expect((yield* session.cache).get(sessionID)).toEqual({
        expires: now + 3 * 60_000,
        ttl: 5 * 60_000,
        tokens: 50_000,
      })
      // Once the conversation's 5m entry expired, the system prompt's hour remains.
      yield* TestClock.adjust(Duration.minutes(3))
      expect((yield* session.cache).get(sessionID)).toMatchObject({ expires: now - 2 * 60_000 + HOUR, ttl: HOUR })
    }),
  )
})
