import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { CacheLedger } from "@opencode/core/session/cache/ledger"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { UNKNOWN_BINDING } from "@opencode/schema/session-cache"
import { and, asc, eq } from "drizzle-orm"
import { Duration, Effect, Exit, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import {
  chatTurn,
  confirmed,
  createSession,
  eventually,
  makeProvider,
  models,
  refusal,
  staleSignature,
  stack,
  turn,
  type Reply,
  type Sent,
} from "./lib/session-cache"

const provider = makeProvider()
const it = testEffect(stack(provider))

const earlier = (text: string) => `<earlier-reasoning>\n${text}\n</earlier-reasoning>`

/** The content blocks of a request, flattened, with cache markers removed. */
const blocks = (sent: Sent): Array<Record<string, unknown>> =>
  (sent.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).flatMap((message) =>
    message.content.map(({ cache_control: _marker, ...block }) => ({ role: message.role, ...block })),
  )
const signatures = (sent: Sent) =>
  blocks(sent).flatMap((block) => (block.type === "thinking" ? [String(block.signature)] : []))
const texts = (sent: Sent) => blocks(sent).flatMap((block) => (block.type === "text" ? [String(block.text)] : []))
const behavior = (sent: Sent) => sent.body.thinking?.block_binding?.prefix_mismatch_behavior

// What a client that asks before losing thinking sends, and what it sends once the user agreed.
const ask = { thinkingLoss: "ask" } as const
const accept = { thinkingLoss: "accept" } as const

const run = (sessionID: Session.ID, text: string, metadata?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.prompt({ sessionID, text, resume: false, ...(metadata ? { metadata } : {}) })
    return yield* session.resume(sessionID).pipe(Effect.exit)
  })

/** The session error a turn's execution settles with, as `session.execution.failed` reports it. */
const failureOf = (exit: Exit.Exit<void, unknown>) => {
  const outcome = SessionExecution.terminal(exit as Parameters<typeof SessionExecution.terminal>[0])
  return outcome.type === "failed" ? outcome.error : undefined
}

const assistantIDs = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)).map((row) => row.id)
  })

const collectDropped = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const seen: Array<SessionEvent.Thinking.Dropped["data"]> = []
  yield* bus.subscribe(SessionEvent.Thinking.Dropped).pipe(
    Stream.runForEach((event) => Effect.sync(() => void seen.push(event.data))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

/** Change the session's system prompt from the next request on, as an instruction or agent change would. */
const systemChange = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const state = { changed: false }
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        if (!state.changed || event.sessionID !== sessionID || !event.system[0]) return
        event.system[0] = { ...event.system[0], text: event.system[0].text + "\nThe system prompt changed." }
      }),
    )
    return state
  })

/** How many times the session's context hook ran, and whether each was a dry run. */
const contextRuns = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const seen: Array<boolean | undefined> = []
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        if (event.sessionID === sessionID) seen.push(event.dryRun)
      }),
    )
    return seen
  })

/** A reviewer agent: another system prompt than the build agent's. */
const reviewAgent = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("review"), (agent) => {
      agent.mode = "all"
      agent.system = "You review the change you are given."
      agent.permissions.push({ action: "execute", resource: "*", effect: "deny" })
    }),
  )
  return Agent.ID.make("review")
})

/** Past the month the ledger keeps thinking bindings: the hourly sweep forgets them. */
const forgetBindings = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    yield* TestClock.adjust(Duration.days(31))
    yield* eventually(
      kv
        .get(`session-cache:${sessionID}`)
        .pipe(
          Effect.map((record) =>
            record === undefined || Object.keys((record as { thinking: object }).thinking).length === 0
              ? true
              : undefined,
          ),
        ),
      "the swept bindings",
    )
  })

describe("stale thinking consent", () => {
  it.effect("a turn that asks is refused on stale thinking, and the consented turn drops it as text", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_stale")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const change = yield* systemChange(sessionID)
      const dropped = yield* collectDropped
      const start = provider.requests.length

      provider.reply(turn({ thinking: { text: "reasoning one", signature: "sig-1" }, text: "answer one" }))
      yield* run(sessionID, "first", ask)
      yield* confirmed(sessionID, 1)
      provider.reply(turn({ thinking: { text: "reasoning two", signature: "sig-2" }, text: "answer two" }))
      yield* run(sessionID, "second", ask)
      yield* confirmed(sessionID, 2)
      const second = provider.requests[start + 1]
      expect(signatures(second)).toEqual(["sig-1"])
      expect(behavior(second)).toBe("error")

      // The system prompt changes: sig-1 no longer matches, nor does sig-2, which no request replayed yet.
      change.changed = true
      const report = yield* session.preflight({ sessionID, text: "third" })
      expect(report.staleThinking).toMatchObject({ count: 2, reason: "the system prompt changed", unit: "system[0]" })
      expect(report.staleThinking?.consent).toBeDefined()

      // A turn that asks first is refused before anything is sent, and the error says what to send.
      const refused = yield* run(sessionID, "third", ask)
      expect(provider.requests.length).toBe(start + 2)
      const failure = failureOf(refused)
      expect(failure?.type).toBe("thinking.stale")
      expect(failure?.message).toBe(
        "Stale thinking: 2 thinking blocks from earlier turns no longer match the conversation (the system prompt changed). " +
          'Send the turn again with metadata.thinkingLoss "accept" to replay them as text, or undo the change.',
      )

      // With consent the turn asks the provider to drop what the check could not foresee, and already carries the
      // stale blocks as text.
      provider.reply(turn({ thinking: { text: "reasoning three", signature: "sig-3" }, text: "answer three" }))
      yield* run(sessionID, "fourth", accept)
      expect(provider.requests.length).toBe(start + 3)
      const consented = provider.requests[start + 2]
      expect(behavior(consented)).toBe("drop_block")
      expect(signatures(consented)).toEqual([])
      expect(texts(consented)).toContain(earlier("reasoning one"))
      expect(texts(consented)).toContain(earlier("reasoning two"))

      const [first, secondAssistant] = yield* assistantIDs(sessionID)
      const markers = yield* session.thinking(sessionID)
      expect(markers.map(({ time: _time, ...marker }) => marker)).toEqual([
        { messageID: first, ordinal: 0, reason: CacheLedger.DROPPED_WITH_CONSENT, asText: true },
        { messageID: secondAssistant, ordinal: 0, reason: CacheLedger.DROPPED_WITH_CONSENT, asText: true },
      ])
      yield* eventually(
        Effect.sync(() => (dropped.length > 0 ? dropped : undefined)),
        "the dropped event",
      )
      expect(dropped).toEqual([
        {
          sessionID,
          blocks: [
            { messageID: first, ordinal: 0, reason: CacheLedger.DROPPED_WITH_CONSENT, asText: true },
            { messageID: secondAssistant, ordinal: 0, reason: CacheLedger.DROPPED_WITH_CONSENT, asText: true },
          ],
        },
      ])
      yield* confirmed(sessionID, 3)

      // Later turns fail loudly again, replay the converted text byte for byte, and keep the new thinking signed.
      provider.reply(turn({ text: "answer five" }))
      yield* run(sessionID, "fifth", ask)
      const next = provider.requests[start + 3]
      expect(behavior(next)).toBe("error")
      expect(signatures(next)).toEqual(["sig-3"])
      expect(blocks(next).slice(0, blocks(consented).length)).toEqual(blocks(consented))
      expect(dropped).toHaveLength(1)

      // A fork keeps the history under new message IDs: the markers follow it, and so do the thinking bindings.
      const kv = yield* KV.Service
      const fork = yield* session.fork({ sessionID })
      const forkedMarkers = yield* eventually(
        session.thinking(fork.id).pipe(Effect.map((items) => (items.length === 2 ? items : undefined))),
        "the fork's markers",
      )
      const forkAssistants = yield* assistantIDs(fork.id)
      expect(forkedMarkers.map((marker) => marker.messageID)).toEqual(forkAssistants.slice(0, 2))
      expect(forkedMarkers.every((marker) => marker.asText && marker.ordinal === 0)).toBe(true)
      const parentRecord = (yield* kv.get(`session-cache:${sessionID}`)) as { thinking: Record<string, unknown> }
      const forkRecord = (yield* kv.get(`session-cache:${fork.id}`)) as { thinking: Record<string, unknown> }
      expect(Object.keys(forkRecord.thinking).sort()).toEqual(Object.keys(parentRecord.thinking).sort())

      // Deleting a session drops its ledger record.
      yield* session.remove(fork.id)
      yield* eventually(
        kv.get(`session-cache:${fork.id}`).pipe(Effect.map((record) => (record === undefined ? true : undefined))),
        "the deleted session's record to go",
      )
    }),
  )

  it.effect("a single-Step turn's thinking is checked on its first replay", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_single_step")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const review = yield* reviewAgent
      const start = provider.requests.length

      // One Step answers the turn: its thinking is in no request yet.
      provider.reply(turn({ thinking: { text: "reasoning s", signature: "sig-s" }, text: "answer s" }))
      yield* run(sessionID, "first", ask)
      yield* confirmed(sessionID, 1)
      yield* session.switchAgent({ sessionID, agent: review })

      const report = yield* session.preflight({ sessionID, text: "second" })
      expect(report.staleThinking).toMatchObject({ count: 1, reason: "the system prompt changed" })
      const refused = yield* run(sessionID, "second", ask)
      expect(failureOf(refused)?.type).toBe("thinking.stale")
      expect(provider.requests.length).toBe(start + 1)

      provider.reply(turn({ text: "reviewed" }))
      const consented = yield* run(sessionID, "second", accept)
      expect(Exit.isSuccess(consented)).toBe(true)
      expect(signatures(provider.requests[start + 1])).toEqual([])
      expect(texts(provider.requests[start + 1])).toContain(earlier("reasoning s"))
    }),
  )

  it.effect("a provider refusal makes the refused block and later ones stale until consent", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_refused")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const kv = yield* KV.Service
      const start = provider.requests.length

      // The conversation, not the system prompt, holds most of the cached prompt.
      provider.reply(turn({ thinking: { text: "reasoning a", signature: "sig-a" }, text: "answer a" }))
      yield* run(sessionID, "first " + "x".repeat(200_000), ask)
      yield* confirmed(sessionID, 1)
      provider.reply(
        turn({
          thinking: { text: "reasoning b", signature: "sig-b" },
          text: "answer b",
          usage: { input: 3, output: 5, write: 120_000 },
        }),
      )
      yield* run(sessionID, "second", ask)
      yield* confirmed(sessionID, 2)

      // Nothing the ledger can see changed, but the provider rejects the first block.
      provider.reply(refusal(staleSignature("messages.1.content.0")))
      const rejected = yield* run(sessionID, "third", ask)
      // The turn fails as one refused for stale thinking, with the same way out; it is not retried.
      const failure = failureOf(rejected)
      expect(failure?.type).toBe("thinking.stale")
      expect(failure?.message).toStartWith(
        "Stale thinking: the provider rejected a thinking block from an earlier turn " +
          "(The `system` prompt differs from the one this block was created with.).",
      )
      expect(failure?.message).toContain('metadata.thinkingLoss "accept"')
      expect(provider.requests.length).toBe(start + 3)
      expect(signatures(provider.requests[start + 2])).toEqual(["sig-a", "sig-b"])
      yield* eventually(
        kv.get(`session-cache:${sessionID}`).pipe(Effect.map((record) => (record as { refused?: unknown })?.refused)),
        "the recorded refusal",
      )

      // The preflight says so, and what the consented turn reuses: it replays both blocks as text, so the cache is
      // lost from the first of them on.
      const report = yield* session.preflight({ sessionID, text: "fourth" })
      expect(report.staleThinking?.count).toBe(2)
      expect(report.staleThinking?.reason).toBe(
        "the provider rejected the block at messages.1.content.0: The `system` prompt differs from the one this block was created with.",
      )
      expect(report.status).toBe("hit")
      expect(report.lostTokens).toBeLessThan(10)
      expect(report.staleThinking?.consent?.lostTokens).toBeGreaterThan(100_000)

      const refused = yield* run(sessionID, "fourth", ask)
      expect(provider.requests.length).toBe(start + 3)
      expect(failureOf(refused)?.type).toBe("thinking.stale")
      expect(failureOf(refused)?.message).toStartWith("Stale thinking: 2 thinking blocks")

      provider.reply(turn({ text: "recovered" }))
      yield* run(sessionID, "fifth", accept)
      const consented = provider.requests[start + 3]
      expect(behavior(consented)).toBe("drop_block")
      expect(signatures(consented)).toEqual([])
      expect(texts(consented)).toEqual(expect.arrayContaining([earlier("reasoning a"), earlier("reasoning b")]))
      expect((yield* session.thinking(sessionID)).map((marker) => marker.asText)).toEqual([true, true])
      yield* confirmed(sessionID, 3)
      expect((yield* session.preflight({ sessionID, text: "sixth" })).staleThinking).toBeUndefined()
    }),
  )

  it.effect(
    "blocks of unknown binding are sent, and a refusal of them holds only under its prompt",
    () =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_consent_unknown")
        yield* createSession(sessionID)
        const session = yield* Session.Service
        const review = yield* reviewAgent
        const start = provider.requests.length

        provider.reply(turn({ thinking: { text: "reasoning u", signature: "sig-u" }, text: "answer u" }))
        yield* run(sessionID, "first", ask)
        yield* confirmed(sessionID, 1)
        // A month idle: the ledger no longer knows what sig-u was bound to, as for a session from before it.
        yield* forgetBindings(sessionID)
        const unknown = yield* session.preflight({ sessionID, text: "second" })
        expect(unknown.staleThinking).toMatchObject({ count: 1, reason: UNKNOWN_BINDING })

        // Switched to the reviewer, the turn sends the block, and the provider rejects it.
        yield* session.switchAgent({ sessionID, agent: review })
        provider.reply(refusal(staleSignature("messages.1.content.0")))
        const rejected = yield* run(sessionID, "second", ask)
        expect(provider.requests.length).toBe(start + 2)
        expect(behavior(provider.requests[start + 1])).toBe("error")
        expect(failureOf(rejected)?.type).toBe("thinking.stale")
        const reported = yield* eventually(
          session
            .preflight({ sessionID, text: "second" })
            .pipe(Effect.map((report) => (report.staleThinking?.reason !== UNKNOWN_BINDING ? report : undefined))),
          "the refusal in the preflight",
        )
        expect(reported.staleThinking?.reason).toStartWith("the provider rejected the block at messages.1.content.0")

        // Switching back undoes the change: the block is of unknown binding again, sent, and accepted.
        yield* session.switchAgent({ sessionID, agent: Agent.ID.make("build") })
        const undone = yield* session.preflight({ sessionID, text: "third" })
        expect(undone.staleThinking?.reason).toBe(UNKNOWN_BINDING)
        provider.reply(turn({ text: "answer three" }))
        const accepted = yield* run(sessionID, "third", ask)
        expect(Exit.isSuccess(accepted)).toBe(true)
        expect(signatures(provider.requests[start + 2])).toEqual(["sig-u"])
        yield* confirmed(sessionID, 1)
        expect((yield* session.preflight({ sessionID, text: "fourth" })).staleThinking).toBeUndefined()
      }),
    // A month of hourly sweeps on the test clock.
    30_000,
  )

  it.effect("a turn nobody asked about lets the provider drop stale thinking and goes on, unchecked", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_unasked")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const change = yield* systemChange(sessionID)
      const runs = yield* contextRuns(sessionID)
      const dropped = yield* collectDropped
      const start = provider.requests.length

      // The TUI, `opencode run` and plugins send no thinkingLoss.
      provider.reply(turn({ thinking: { text: "reasoning x", signature: "sig-x" }, text: "answer x" }))
      yield* run(sessionID, "first")
      yield* confirmed(sessionID, 1)
      provider.reply(turn({ thinking: { text: "reasoning y", signature: "sig-y" }, text: "answer y" }))
      yield* run(sessionID, "second")
      yield* confirmed(sessionID, 2)
      expect(provider.requests.slice(start).map(behavior)).toEqual(["drop_block", "drop_block"])
      // Nothing is dry-run first.
      expect(runs).toEqual([undefined, undefined])

      // The system prompt changes. Nothing refuses the turn: the provider drops the first stale block and every one
      // after it, and says so.
      change.changed = true
      provider.reply(
        turn({
          text: "answer z",
          transformations: [
            { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
            { type: "thinking_dropped", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
          ],
        }),
      )
      const third = yield* run(sessionID, "third")
      expect(Exit.isSuccess(third)).toBe(true)
      expect(behavior(provider.requests[start + 2])).toBe("drop_block")
      expect(signatures(provider.requests[start + 2])).toEqual(["sig-x", "sig-y"])
      const markers = yield* eventually(
        session.thinking(sessionID).pipe(Effect.map((items) => (items.length === 2 ? items : undefined))),
        "the provider-dropped markers",
      )
      const [first, second] = yield* assistantIDs(sessionID)
      const expected = [
        { messageID: first, ordinal: 0, reason: CacheLedger.DROPPED_UNASKED, asText: false },
        { messageID: second, ordinal: 0, reason: CacheLedger.DROPPED_UNASKED, asText: false },
      ]
      expect(markers.map(({ time: _time, ...marker }) => marker)).toEqual(expected)
      yield* eventually(
        Effect.sync(() => (dropped.length > 0 ? dropped : undefined)),
        "the dropped event",
      )
      expect(dropped).toEqual([{ sessionID, blocks: expected }])

      // Later requests leave them out: the thinking produced since is bound to a prompt without them.
      provider.reply(turn({ text: "answer w" }))
      yield* run(sessionID, "fourth")
      const next = provider.requests[start + 3]
      expect(signatures(next)).toEqual([])
      expect(texts(next).some((value) => value.includes("reasoning x"))).toBe(false)
      expect(texts(next)).toContain("answer x")

      // A fork before the second answer keeps only the first answer's marker.
      const fork = yield* session.fork({ sessionID, before: second })
      const forked = yield* eventually(
        session.thinking(fork.id).pipe(Effect.map((items) => (items.length > 0 ? items : undefined))),
        "the fork's marker",
      )
      const [forkFirst, ...rest] = yield* assistantIDs(fork.id)
      expect(rest).toEqual([])
      expect(forked.map(({ time: _time, ...marker }) => marker)).toEqual([{ ...expected[0], messageID: forkFirst }])
    }),
  )

  it.effect("when the provider does not say what it dropped, the ledger's prediction is recorded", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_unreported")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const change = yield* systemChange(sessionID)

      provider.reply(turn({ thinking: { text: "reasoning p", signature: "sig-p" }, text: "answer p" }))
      yield* run(sessionID, "first")
      yield* confirmed(sessionID, 1)
      provider.reply(turn({ thinking: { text: "reasoning q", signature: "sig-q" }, text: "answer q" }))
      yield* run(sessionID, "second")
      yield* confirmed(sessionID, 2)
      change.changed = true
      // A gateway that does not relay input_transformations.
      provider.reply(turn({ text: "answer r", transformations: false }))
      yield* run(sessionID, "third")
      const markers = yield* eventually(
        session.thinking(sessionID).pipe(Effect.map((items) => (items.length === 2 ? items : undefined))),
        "the predicted markers",
      )
      expect(markers.every((marker) => marker.reason === CacheLedger.DROPPED_UNASKED && !marker.asText)).toBe(true)
    }),
  )

  it.effect("a subagent continued with another agent goes on without anyone to ask", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_subagent")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const review = yield* reviewAgent
      const start = provider.requests.length

      provider.reply(turn({ thinking: { text: "reasoning s", signature: "sig-s" }, text: "answer s" }))
      yield* run(sessionID, "You are a subagent spawned by another session.\nLook into it.")
      yield* confirmed(sessionID, 1)
      // As the subagent tool continues a child with a different agent: switch, then prompt without metadata.
      yield* session.switchAgent({ sessionID, agent: review })
      provider.reply(
        turn({
          text: "reviewed",
          transformations: [
            { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
          ],
        }),
      )
      const continued = yield* run(sessionID, "Now review it.")
      expect(Exit.isSuccess(continued)).toBe(true)
      expect(provider.requests.length).toBe(start + 2)
      expect(behavior(provider.requests[start + 1])).toBe("drop_block")
      const markers = yield* eventually(
        session.thinking(sessionID).pipe(Effect.map((items) => (items.length > 0 ? items : undefined))),
        "the dropped marker",
      )
      expect(markers.map((marker) => marker.reason)).toEqual([CacheLedger.DROPPED_UNASKED])
    }),
  )

  it.effect("keep-alive generations never change the Session's thinking state", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_keepalive")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const kv = yield* KV.Service
      const change = yield* systemChange(sessionID)
      const start = provider.requests.length

      provider.reply(turn({ thinking: { text: "reasoning k", signature: "sig-k" }, text: "answer k" }))
      yield* run(sessionID, "first", ask)
      yield* confirmed(sessionID, 1)
      provider.reply(turn({ thinking: { text: "reasoning l", signature: "sig-l" }, text: "answer l" }))
      yield* run(sessionID, "second", ask)
      yield* confirmed(sessionID, 2)
      const before = yield* kv.get(`session-cache:${sessionID}`)

      // The system prompt changes, then the warming plugin keeps the cache alive: the provider drops the stale blocks
      // of that request.
      change.changed = true
      provider.reply(
        turn({
          text: "OK",
          usage: { input: 3, output: 1, read: 0, write: 500 },
          transformations: [
            { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
            { type: "thinking_dropped", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
          ],
        }),
      )
      expect(yield* session.generate({ sessionID, prompt: "Reply with exactly: OK" })).toBe("OK")
      expect(behavior(provider.requests[start + 2])).toBe("drop_block")
      // The Session's thinking state is what its turns left.
      expect(yield* kv.get(`session-cache:${sessionID}`)).toEqual(before)
      expect(yield* session.thinking(sessionID)).toEqual([])
      expect((yield* session.preflight({ sessionID, text: "third" })).staleThinking?.count).toBe(2)
      const refused = yield* run(sessionID, "third", ask)
      expect(failureOf(refused)?.type).toBe("thinking.stale")
    }),
  )

  it.effect("a model whose requests do not bind thinking is never checked, bindings or not", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_other_protocol")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const change = yield* systemChange(sessionID)
      const runs = yield* contextRuns(sessionID)
      const start = provider.requests.length

      provider.reply(turn({ thinking: { text: "reasoning o", signature: "sig-o" }, text: "answer o" }))
      yield* run(sessionID, "first", ask)
      yield* confirmed(sessionID, 1)
      // With bindings on record a turn that asks is dry-run first.
      provider.reply(turn({ text: "answer two" }))
      yield* run(sessionID, "second", ask)
      expect(runs).toEqual([undefined, true, undefined])

      // On an OpenAI Chat model nothing is dry-run, refused or asked about.
      change.changed = true
      yield* session.switchModel({ sessionID, model: models.chat.ref })
      provider.reply(chatTurn({ text: "chat answer" }))
      const chat = yield* run(sessionID, "third", ask)
      expect(Exit.isSuccess(chat)).toBe(true)
      expect(runs).toEqual([undefined, true, undefined, undefined])
      expect(provider.requests[start + 2].url).toEndWith("/chat/completions")
      expect((yield* session.preflight({ sessionID, text: "fourth" })).staleThinking).toBeUndefined()
    }),
  )

  it.effect("request hooks are told when a request is only a dry run", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_hook_dry_run")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      const seen: Array<[string, boolean | undefined]> = []
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          if (event.sessionID === sessionID) seen.push(["model.request", event.dryRun])
        }),
      )
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          if (event.sessionID === sessionID) seen.push(["http.request", event.dryRun])
        }),
      )
      provider.reply(turn({ text: "hello" }))
      yield* run(sessionID, "first")
      expect(seen).toEqual([
        ["model.request", undefined],
        ["http.request", undefined],
      ])
      yield* session.preflight({ sessionID, text: "second" })
      expect(seen.slice(2)).toEqual([
        ["model.request", true],
        ["http.request", true],
      ])
    }),
  )

  it.effect("a preflight while a turn runs predicts nothing", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_consent_running")
      yield* createSession(sessionID)
      const session = yield* Session.Service
      const start = provider.requests.length
      let release: (reply: Reply) => void = () => {}
      provider.reply({ type: "deferred", reply: new Promise<Reply>((resolve) => (release = resolve)) })
      const running = yield* run(sessionID, "first").pipe(Effect.forkScoped)
      // The provider holds the turn's request open.
      yield* eventually(
        Effect.sync(() => (provider.requests.length > start ? true : undefined)),
        "the running turn's request",
      )
      const report = yield* session.preflight({ sessionID, text: "second" })
      expect(report.status).toBe("unknown")
      expect(report.running).toBe(true)
      expect(report.reasons).toEqual(["a turn is running"])
      release(turn({ text: "done" }))
      expect(Exit.isSuccess(yield* Fiber.join(running))).toBe(true)
    }),
  )
})
