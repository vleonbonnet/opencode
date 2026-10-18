import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { EventTable } from "@opencode/core/event/sql"
import { KV } from "@opencode/core/kv"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { CacheLedger } from "@opencode/core/session/cache/ledger"
import { SessionPreflight } from "@opencode/core/session/cache/preflight"
import { SessionInboxTable, SessionMessageTable } from "@opencode/core/session/sql"
import { eq } from "drizzle-orm"
import { Clock, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
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

/** Everything a preflight must leave untouched: durable events, the inbox and history. */
const durable = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const count = (rows: unknown[]) => rows.length
    return {
      events: count(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
      ),
      inbox: count(
        yield* db
          .select()
          .from(SessionInboxTable)
          .where(eq(SessionInboxTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ),
      messages: count(
        yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ),
    }
  })

const promptAndRun = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.prompt({ sessionID, text, resume: false })
    yield* session.resume(sessionID)
  })

describe("session preflight", () => {
  it.effect("is unknown before any request and leaves the session untouched", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_new")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const before = yield* durable(sessionID)
      const sent = provider.requests.length
      const report = yield* session.preflight({ sessionID, text: "hello" })
      expect(report.status).toBe("unknown")
      expect(report.running).toBeUndefined()
      expect(report.format).toBe("anthropic")
      expect(report.model).toEqual({ id: models.primary.ref.id, providerID: models.primary.ref.providerID })
      expect(report.previous).toBeUndefined()
      expect(report.reusableTokens).toBe(0)
      expect(report.reasons[0]).toContain("no request from this session has been observed")
      // Built and captured, never sent; nothing admitted, persisted or delivered.
      expect(provider.requests.length).toBe(sent)
      expect(yield* durable(sessionID)).toEqual(before)
    }),
  )

  it.effect("predicts a hit after a turn, a partial on a thinking change, and a miss on a model change", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_turns")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      // The conversation, not the system prompt, holds most of the prompt.
      provider.reply(turn({ text: "Hello there.", usage: { input: 3, output: 5, write: 120_000 } }))
      yield* promptAndRun(sessionID, "Say hello. " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)
      const first = provider.requests.at(-1)!
      // A turn that sets no thinkingLoss lets the provider drop stale thinking, as upstream does.
      expect(first.body.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: "drop_block" } })

      const before = yield* durable(sessionID)
      const sent = provider.requests.length
      const hit = yield* session.preflight({ sessionID, text: "And now?" })
      expect(hit.status).toBe("hit")
      expect(hit.reusableTokens).toBe(120_000)
      expect(hit.reusableExact).toBe(true)
      expect(hit.lostTokens).toBe(3)
      expect(hit.previous).toMatchObject({
        promptTokens: 120_003,
        model: { id: MODEL_ID, providerID: models.primary.ref.providerID },
      })
      expect(hit.divergence).toBeUndefined()
      expect(hit.staleThinking).toBeUndefined()

      // A variant with another thinking config re-keys only the messages region: tools and system stay cached.
      const partial = yield* session.preflight({
        sessionID,
        text: "And now?",
        model: { ...models.deep.ref },
      })
      expect(partial.status).toBe("partial")
      expect(partial.reusableTokens).toBeGreaterThan(0)
      expect(partial.reusableTokens).toBeLessThan(60_000)
      expect(
        partial.reasons.some((reason) => reason.includes("request parameters that key the cache changed: thinking")),
      ).toBe(true)

      const miss = yield* session.preflight({ sessionID, text: "And now?", model: { ...models.other.ref } })
      expect(miss.status).toBe("miss")
      expect(miss.model).toEqual({ id: models.other.ref.id, providerID: models.other.ref.providerID })
      expect(miss.lostTokens).toBe(120_003)
      expect(miss.reasons).toContain(`model changed: ${MODEL_ID} -> claude-mythos-5-1`)
      expect(miss.divergence).toMatchObject({ index: 0 })

      // None of the three preflights sent, admitted or persisted anything.
      expect(provider.requests.length).toBe(sent)
      expect(yield* durable(sessionID)).toEqual(before)

      // The prediction holds: the next turn reads what the preflight promised.
      provider.reply(turn({ text: "Fine.", usage: { input: 20, output: 2, read: 120_000, write: 40 } }))
      yield* promptAndRun(sessionID, "And now?")
      const verified = (yield* confirmed(sessionID, 2)) as { verifications: Array<{ ok: boolean; predicted: number }> }
      expect(verified.verifications.at(-1)).toMatchObject({ ok: true, predicted: 120_000 })
    }),
  )

  it.effect("hooks see the dry run, and the prediction includes their request changes", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_hooks")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      const seen: Array<boolean | undefined> = []
      let suffix = ""
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          if (event.sessionID !== sessionID) return
          seen.push(event.dryRun)
          if (suffix && event.system[0]) event.system[0] = { ...event.system[0], text: event.system[0].text + suffix }
        }),
      )
      provider.reply(turn({ text: "Hi.", usage: { input: 3, output: 2, write: 120_000 } }))
      yield* promptAndRun(sessionID, "Hi? " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)
      expect(seen).toEqual([undefined])

      expect((yield* session.preflight({ sessionID, text: "next" })).status).toBe("hit")
      suffix = "\nA plugin changed the system prompt."
      const changed = yield* session.preflight({ sessionID, text: "next" })
      expect(seen).toEqual([undefined, true, true])
      // Everything from the changed system block on is lost; tool definitions before it, if any, stay cached.
      expect(["partial", "miss"]).toContain(changed.status)
      expect(changed.divergence?.unit).toBe("system[0]")
      expect(changed.lostTokens).toBeGreaterThan(100_000)
    }),
  )

  it.effect("a credential whose token rotates keeps its cache namespace", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_rotating")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      // Like Entra ID or an OAuth refresh: every request carries a fresh bearer token for the same account.
      let issued = 0
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          if (event.sessionID !== sessionID) return
          event.request.headers.delete("x-api-key")
          event.request.headers.set("authorization", `Bearer token-${++issued}`)
        }),
      )
      provider.reply(turn({ text: "Hi.", usage: { input: 3, output: 2, write: 120_000 } }))
      yield* promptAndRun(sessionID, "Hi? " + "x".repeat(200_000))
      yield* confirmed(sessionID, 1)
      expect(provider.requests.at(-1)?.headers.authorization).toBe("Bearer token-1")

      const report = yield* session.preflight({ sessionID, text: "next" })
      expect(issued).toBe(2)
      expect(report.status).toBe("hit")
      expect(report.reusableTokens).toBe(120_000)
      expect(report.reasons.filter((reason) => reason.includes("namespace"))).toEqual([])
    }),
  )

  it.effect("rejects an unknown command or agent without building a request", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_errors")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const sent = provider.requests.length
      const command = yield* session.preflight({ sessionID, command: { name: "nope" } }).pipe(Effect.flip)
      expect(command).toBeInstanceOf(SessionPreflight.InvalidInputError)
      expect(command).toMatchObject({ field: "command", message: "Command not found: nope" })
      const agent = yield* session.preflight({ sessionID, text: "x", agent: Agent.ID.make("nope") }).pipe(Effect.flip)
      expect(agent).toMatchObject({ field: "agent", message: 'Agent not found: "nope"' })
      expect(provider.requests.length).toBe(sent)
    }),
  )

  it.effect("a hook that breaks makes the turn unpredictable, said in one line", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_defect")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        event.sessionID === sessionID && event.dryRun
          ? Effect.die(new Error("hook exploded\nat stack frame"))
          : Effect.void,
      )
      const report = yield* session.preflight({ sessionID, text: "hello" })
      expect(report.status).toBe("unknown")
      expect(report.reasons).toEqual(["the next turn could not be built: hook exploded"])
    }),
  )

  it.effect("predicts an OpenAI Chat session, whose namespace stays the size of its conversation", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_preflight_chat")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const kv = yield* KV.Service
      yield* session.switchModel({ sessionID, model: models.chat.ref })
      for (let index = 0; index < 6; index++) {
        provider.reply(chatTurn({ text: `answer ${index}`, usage: { input: 50, output: 5, read: 2_000 + index * 60 } }))
        yield* promptAndRun(sessionID, `question ${index} ` + "q".repeat(2_000))
        yield* confirmed(sessionID, index + 1)
      }
      const report = yield* session.preflight({ sessionID, text: "next" })
      expect(report.format).toBe("openai-chat")
      expect(report.status).toBe("hit")
      expect(report.reusableTokens).toBe(50 + 2_000 + 5 * 60)
      const namespaces = (yield* kv.scan({ prefix: "prompt-cache:" })).entries.filter(
        (entry) => Object.keys(entry.value as object).length > 0,
      )
      const chat = namespaces.find((entry) =>
        Object.values(entry.value as CacheLedger.Entries).some((item) => item.retentionSource?.includes("fallback")),
      )!
      const entries = chat.value as CacheLedger.Entries
      // One entry per tool and message of the newest request, and nothing per earlier turn.
      const newest = provider.requests.at(-1)!.body as { tools?: unknown[]; messages: unknown[] }
      expect(Object.keys(entries)).toHaveLength((newest.tools?.length ?? 0) + newest.messages.length)
      expect(Object.values(entries).filter((entry) => entry.tip)).toHaveLength(1)
    }),
  )

  it.effect("the hourly sweep drops records idle past their retention", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const now = yield* Clock.currentTimeMillis
      const idle = (seen: number) => ({
        verifications: [],
        thinking: { block: ["system", "tools", "prefix"] },
        dropped: [],
        seen,
      })
      yield* kv.set("session-cache:ses_swept_first", idle(now - 31 * 24 * 60 * 60_000))
      yield* kv.set("session-cache:ses_kept", idle(now))
      yield* kv.set("prompt-cache:swept", { gone: { tokens: 1, exact: true, expires: now - 25 * 60 * 60_000, ttl: 1 } })
      yield* TestClock.adjust(Duration.minutes(2))
      yield* eventually(
        kv.get("session-cache:ses_swept_first").pipe(Effect.map((value) => (value === undefined ? true : undefined))),
        "the first sweep",
      )
      expect(yield* kv.get("prompt-cache:swept")).toBeUndefined()
      expect(yield* kv.get("session-cache:ses_kept")).toBeDefined()
      // Then every hour.
      yield* kv.set("session-cache:ses_swept_later", idle(now - 31 * 24 * 60 * 60_000))
      yield* TestClock.adjust(Duration.hours(1))
      yield* eventually(
        kv.get("session-cache:ses_swept_later").pipe(Effect.map((value) => (value === undefined ? true : undefined))),
        "the hourly sweep",
      )
      expect(yield* kv.get("session-cache:ses_kept")).toBeDefined()
    }),
  )
})
