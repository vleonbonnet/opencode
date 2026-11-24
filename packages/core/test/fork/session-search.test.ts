import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSearchBuild } from "@opencode/core/session/search-build"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
import { SessionSearchQuery } from "@opencode/core/session/search/query"
import { SessionSearchService } from "@opencode/core/session/search/service"
import { SessionMessageTable, SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionStored } from "@opencode/core/session/stored"
import { Money } from "@opencode/schema/money"
import { SessionSearch } from "@opencode/schema/session-search"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      SessionSearchBuild.node,
      SessionSearchService.node,
    ]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const sessionID = Session.ID.make("ses_search_test")
const otherID = Session.ID.make("ses_search_other")
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeAssistant = Schema.encodeSync(SessionMessage.Info)
const encodeUser = Schema.encodeSync(SessionStored.User)

const userRow = (session: Session.ID, id: string, seq: number, text: string, created = seq) => {
  const {
    id: _,
    type,
    ...data
  } = encodeUser(
    SessionStored.User.make({
      id: SessionMessage.ID.make(id),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(created) },
    }),
  )
  return { id: SessionMessage.ID.make(id), session_id: session, type, seq, time_created: created, data }
}

const assistantRow = (
  session: Session.ID,
  id: string,
  seq: number,
  content: SessionMessage.AssistantContent[],
  created = seq,
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeAssistant(
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(id),
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content,
      // The index holds an assistant message once it is finished.
      time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created) },
    }),
  )
  return { id: SessionMessage.ID.make(id), session_id: session, type, seq, time_created: created, data }
}

const text = (value: string): SessionMessage.AssistantContent => ({ type: "text", text: value })

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values([
      { id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] },
      { id: Project.ID.make("prj_other"), worktree: AbsolutePath.make("/other"), sandboxes: [] },
    ])
    .run()
  yield* db
    .insert(SessionTable)
    .values([
      { id: sessionID, project_id: Project.ID.global, slug: "a", directory: "/project", title: "First", version: "t" },
      {
        id: otherID,
        project_id: Project.ID.make("prj_other"),
        slug: "b",
        directory: "/other",
        title: "Second",
        version: "t",
      },
    ])
    .run()
  return db
})

const search = (query: string, input: Omit<SessionSearchService.Input, "query"> = {}) =>
  SessionSearchService.Service.use((service) => service.search({ query, ...input }))

const ids = (query: string, input?: Omit<SessionSearchService.Input, "query">) =>
  search(query, input).pipe(Effect.map((result) => result.data.map((match) => match.messageID as string)))

describe("SessionSearchQuery", () => {
  test("quotes every term so nothing in the query is FTS syntax", () => {
    expect(
      SessionSearchQuery.expression(SessionSearchQuery.terms('foo AND bar OR NOT "x" NEAR(a b) col:y ^z -w')),
    ).toBe('"foo" "AND" "bar" "OR" "NOT" "x" "NEAR(a" "b)" "col:y" "^z" "-w"')
    expect(SessionSearchQuery.expression(SessionSearchQuery.terms('say "hi"" there'))).toBe('"say" "hi" "there"')
    // Folded as the index folds its text.
    expect(SessionSearchQuery.anyOf(SessionSearchQuery.terms("Straße đơn*"))).toBe('"Strasse" OR "dơn"*')
  })

  test("reads phrases, prefixes and drops terms without letters or digits", () => {
    expect(SessionSearchQuery.terms('  "service smoke"  drov* a* ** ?! "unterminated phrase')).toEqual([
      { text: "service smoke", prefix: false },
      { text: "drov", prefix: true },
      { text: "a", prefix: false },
      { text: "unterminated phrase", prefix: false },
    ])
    expect(SessionSearchQuery.terms(" ... ")).toEqual([])
  })

  test("reads queries over whole sessions: AND, OR, exclusion and groups", () => {
    const word = (text: string, prefix = false): SessionSearchQuery.Expression => ({
      type: "term",
      term: { text, prefix },
    })
    const expr = (value: SessionSearchQuery.Expression) => value
    expect(SessionSearchQuery.parse('aiur "home lab" -nomad (consul OR vault*)')).toEqual(
      expr({
        type: "and",
        items: [
          word("aiur"),
          word("home lab"),
          { type: "not", item: word("nomad") },
          { type: "or", items: [word("consul"), word("vault", true)] },
        ],
      }),
    )
    // OR binds looser than terms side by side; lower-case "or" is a word.
    expect(SessionSearchQuery.parse("a b OR c or")).toEqual(
      expr({
        type: "or",
        items: [
          { type: "and", items: [word("a"), word("b")] },
          { type: "and", items: [word("c"), word("or")] },
        ],
      }),
    )
    expect(SessionSearchQuery.parse('-(a OR "b c") --d e-f')).toEqual(
      expr({
        type: "and",
        items: [{ type: "not", item: { type: "or", items: [word("a"), word("b c")] } }, word("d"), word("e-f")],
      }),
    )
    // As typed: unclosed groups and quotes run to the end, dangling operators and stray parentheses are dropped.
    expect(SessionSearchQuery.parse('OR (a "b c')).toEqual(expr({ type: "and", items: [word("a"), word("b c")] }))
    expect(SessionSearchQuery.parse("a ) OR - ( )")).toEqual(word("a"))
    expect(SessionSearchQuery.parse(" - ?! () ")).toBeUndefined()
    const query = SessionSearchQuery.parse('a -b (a OR -(c -d)) "A"')!
    expect(SessionSearchQuery.termsOf(query).map((term) => term.text)).toEqual(["a", "b", "c", "d"])
    expect(SessionSearchQuery.positives(query).map((term) => term.text)).toEqual(["a", "d"])
    expect(SessionSearchQuery.evaluate(query, (term) => term.text !== "b")).toBe(true)
    expect(SessionSearchQuery.evaluate(query, () => true)).toBe(false)
  })

  test("makes snippets one bounded line with located matches", () => {
    const { MARK_START: s, MARK_END: e } = SessionSearchQuery
    expect(SessionSearchQuery.snippet(`…the  ${s}quick${e}\n\n brown ${s}fox${e} jumps…`)).toEqual({
      text: "…the quick brown fox jumps…",
      matches: [
        { start: 5, end: 10 },
        { start: 17, end: 20 },
      ],
    })
    const long = `${"word ".repeat(100)}${s}needle${e} ${"tail ".repeat(100)}`
    const result = SessionSearchQuery.snippet(long)
    expect([...result.text].length).toBe(SessionSearch.MAX_SNIPPET_LENGTH)
    expect(result.text.startsWith("…")).toBe(true)
    expect(result.text.endsWith("…")).toBe(true)
    expect(result.matches).toHaveLength(1)
    const [match] = result.matches
    expect([...result.text].slice(match!.start, match!.end).join("")).toBe("needle")
    // Offsets count code points, as Emacs and most clients index strings.
    expect(SessionSearchQuery.snippet(`🙂 ${s}café${e}`)).toEqual({ text: "🙂 café", matches: [{ start: 2, end: 6 }] })
  })
})

describe("SessionSearch", () => {
  it.effect("indexes user prompts and finished assistant text, not tool calls, tool output or reasoning", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_a1", 1, "Please move the database"),
          assistantRow(sessionID, "msg_a2", 2, [
            { type: "reasoning", text: "pondering quietly" },
            text("I will migrate it now."),
            {
              type: "tool",
              id: "call_1",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "sqlite3 toolinput" },
                content: [{ type: "text", text: "tooloutput rows" }],
              },
              time: { created: DateTime.makeUnsafe(2) },
            },
            text("Done migrating."),
          ]),
        ])
        .run()
      expect((yield* ids("database")).toSorted()).toEqual(["msg_a1"])
      expect(yield* ids("pondering")).toEqual([])
      expect(yield* ids("toolinput")).toEqual([])
      expect(yield* ids("tooloutput")).toEqual([])
      const result = yield* search("migrating")
      expect(result.index).toEqual({ complete: true })
      // English inflections match as the index's tokenizer reads them: "migrating" finds "migrate".
      expect(result.data).toEqual([
        {
          sessionID,
          title: "First",
          messageID: SessionMessage.ID.make("msg_a2"),
          role: "assistant",
          time: { created: DateTime.makeUnsafe(2) },
          snippet: {
            text: "I will migrate it now. Done migrating.",
            matches: [
              { start: 7, end: 14 },
              { start: 28, end: 37 },
            ],
          },
        },
      ])
    }),
  )

  it.effect("follows messages as the projector writes, updates and reverts them", () =>
    Effect.gen(function* () {
      yield* seed
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.make("msg_prompt"),
        item: { type: "user", payload: { text: "find the zebra" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: SessionMessage.ID.make("msg_prompt") })
      expect(yield* ids("zebra")).toEqual(["msg_prompt"])

      const assistantMessageID = SessionMessage.ID.make("msg_reply")
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        started: 0,
      })
      yield* bus.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* bus.publish(SessionEvent.Reasoning.Ended, { sessionID, assistantMessageID, ordinal: 0, text: "giraffe" })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 1,
        text: "The zebra is striped",
      })
      // A streaming reply is indexed once its Step ends.
      expect(yield* ids("striped")).toEqual([])
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect(yield* ids("striped")).toEqual(["msg_reply"])
      expect(yield* ids("giraffe")).toEqual([])

      yield* bus.publish(SessionEvent.MessageContentUpdated, {
        sessionID,
        messageID: assistantMessageID,
        content: [{ type: "text", text: "The okapi is shy" }],
      })
      expect(yield* ids("striped")).toEqual([])
      expect(yield* ids("okapi")).toEqual(["msg_reply"])

      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: assistantMessageID })
      expect(yield* ids("okapi")).toEqual([])
      expect(yield* ids("zebra")).toEqual(["msg_prompt"])
    }),
  )

  it.effect("reads text parts stored in session_part and drops a message once it has no text", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values(assistantRow(sessionID, "msg_parts", 1, []))
        .run()
      const part = (ordinal: number, value: string) => ({
        message_id: SessionMessage.ID.make("msg_parts"),
        session_id: sessionID,
        ordinal,
        type: "text" as const,
        call_id: null,
        time_created: 1,
        time_updated: 1,
        data: { type: "text" as const, text: value },
      })
      yield* db
        .insert(SessionPartTable)
        .values([part(0, "alpha part"), part(1, "beta part")])
        .run()
      expect(yield* ids("alpha")).toEqual(["msg_parts"])
      const beta = yield* search("beta")
      expect(beta.data.map((match) => match.snippet)).toEqual([
        { text: "alpha part beta part", matches: [{ start: 11, end: 15 }] },
      ])
      yield* db
        .update(SessionPartTable)
        .set({ data: { type: "text", text: "gamma part" } })
        .where(eq(SessionPartTable.ordinal, 1))
        .run()
      expect(yield* ids("beta")).toEqual([])
      expect(yield* ids("gamma")).toEqual(["msg_parts"])
      yield* db.delete(SessionPartTable).run()
      expect(yield* ids("part")).toEqual([])
    }),
  )

  it.effect("forgets a deleted session's messages", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([userRow(sessionID, "msg_d1", 1, "ephemeral words"), userRow(otherID, "msg_d2", 1, "ephemeral too")])
        .run()
      expect(yield* ids("ephemeral")).toHaveLength(2)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* ids("ephemeral")).toEqual(["msg_d2"])
    }),
  )

  it.effect("ranks by relevance, newer first among equals, and pages with a cursor", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_r1", 1, "kiwi " + "filler ".repeat(40), 10),
          userRow(sessionID, "msg_r2", 2, "kiwi kiwi kiwi", 20),
          userRow(sessionID, "msg_r3", 3, "kiwi " + "filler ".repeat(40), 30),
          userRow(otherID, "msg_r4", 1, "kiwi " + "filler ".repeat(40), 40),
          userRow(otherID, "msg_r5", 2, "kiwi " + "filler ".repeat(40), 50),
        ])
        .run()
      const all = yield* ids("kiwi")
      expect(all).toEqual(["msg_r2", "msg_r5", "msg_r4", "msg_r3", "msg_r1"])

      const first = yield* search("kiwi", { limit: 2 })
      expect(first.data.map((match) => match.messageID as string)).toEqual(["msg_r2", "msg_r5"])
      expect(first.cursor.next).toBeDefined()
      const second = yield* search("kiwi", { limit: 2, cursor: first.cursor.next })
      expect(second.data.map((match) => match.messageID as string)).toEqual(["msg_r4", "msg_r3"])
      const third = yield* search("kiwi", { limit: 2, cursor: second.cursor.next })
      expect(third.data.map((match) => match.messageID as string)).toEqual(["msg_r1"])
      expect(third.cursor.next).toBeUndefined()

      const invalid = yield* Effect.exit(search("kiwi", { cursor: "not-a-cursor" as SessionSearch.Cursor }))
      expect(Exit.isFailure(invalid) && JSON.stringify(invalid.cause)).toContain(
        "SessionSearchService.InvalidCursorError",
      )
      // Limits are clamped to what one page may return.
      expect((yield* search("kiwi", { limit: 10_000 })).data).toHaveLength(5)
    }),
  )

  it.effect("searches messages only, not titles or compaction summaries", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.update(SessionTable).set({ title: "Pelican plans" }).where(eq(SessionTable.id, sessionID)).run()
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_c1"),
          session_id: sessionID,
          type: "compaction",
          seq: 1,
          time_created: 1,
          data: { status: "completed", summary: "pelican summary", reason: "manual", time: { created: 1 } },
        } as typeof SessionMessageTable.$inferInsert)
        .run()
      expect(yield* ids("pelican")).toEqual([])
      expect(
        (yield* SessionSearchService.Service.use((service) => service.searchSessions({ query: "pelican" }))).data,
      ).toEqual([])
    }),
  )

  it.effect("filters by archive state, project, directory and parent", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const child = Session.ID.make("ses_search_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: child,
          project_id: Project.ID.global,
          parent_id: sessionID,
          slug: "c",
          directory: "/project",
          title: "Child",
          version: "t",
        })
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_f1", 1, "mango"),
          userRow(otherID, "msg_f2", 1, "mango"),
          userRow(child, "msg_f3", 1, "mango"),
        ])
        .run()
      yield* db.update(SessionTable).set({ time_archived: 5 }).where(eq(SessionTable.id, otherID)).run()
      const sorted = (query: string, input?: Omit<SessionSearchService.Input, "query">) =>
        ids(query, input).pipe(Effect.map((list) => list.toSorted()))
      expect(yield* sorted("mango")).toEqual(["msg_f1", "msg_f2", "msg_f3"])
      expect(yield* sorted("mango", { archived: false })).toEqual(["msg_f1", "msg_f3"])
      expect(yield* sorted("mango", { archived: true })).toEqual(["msg_f2"])
      expect(yield* sorted("mango", { project: Project.ID.make("prj_other") })).toEqual(["msg_f2"])
      expect(yield* sorted("mango", { directory: AbsolutePath.make("/project") })).toEqual(["msg_f1", "msg_f3"])
      expect(yield* sorted("mango", { parentID: null })).toEqual(["msg_f1", "msg_f2"])
      expect(yield* sorted("mango", { parentID: sessionID })).toEqual(["msg_f3"])
    }),
  )

  it.effect("matches phrases, prefixes, accents and folded letters, and refuses too many terms", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_q1", 1, "Run the service smoke test"),
          userRow(sessionID, "msg_q2", 2, "smoke the service"),
          userRow(sessionID, "msg_q3", 3, "Le café est prêt"),
          userRow(sessionID, "msg_q4", 4, "the session_search table"),
          userRow(sessionID, "msg_q5", 5, "Die Straße in Łódź"),
        ])
        .run()
      expect(yield* ids('"service smoke"')).toEqual(["msg_q1"])
      expect((yield* ids("service smoke")).toSorted()).toEqual(["msg_q1", "msg_q2"])
      expect(yield* ids("serv*")).toHaveLength(2)
      expect(yield* ids("cafe pret")).toEqual(["msg_q3"])
      expect(yield* ids("session_search")).toEqual(["msg_q4"])
      expect(yield* ids('NEAR(smoke "  OR * ^')).toEqual([])
      // Letters the index folds match their ASCII spellings, and the snippet marks them as written.
      const folded = yield* search("strasse lodz")
      expect(folded.data.map((match) => match.snippet)).toEqual([
        {
          text: "Die Straße in Łódź",
          matches: [
            { start: 4, end: 10 },
            { start: 14, end: 18 },
          ],
        },
      ])
      expect((yield* search("Straße")).data.map((match) => match.messageID as string)).toEqual(["msg_q5"])
      const result = yield* search("?!")
      expect(result.data).toEqual([])
      const tooMany = yield* Effect.exit(search(Array.from({ length: 33 }, (_, i) => `w${i}`).join(" ")))
      expect(Exit.isFailure(tooMany) && JSON.stringify(tooMany.cause)).toContain(
        "SessionSearchService.InvalidQueryError",
      )
    }),
  )

  const searchSessions = (query: string, input: Omit<SessionSearchService.Input, "query"> = {}) =>
    SessionSearchService.Service.use((service) => service.searchSessions({ query, ...input }))

  const sessionIDs = (query: string, input?: Omit<SessionSearchService.Input, "query">) =>
    searchSessions(query, input).pipe(Effect.map((result) => result.data.map((match) => match.sessionID as string)))

  it.effect("matches whole sessions: terms in different messages, OR, exclusion and groups", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const third = Session.ID.make("ses_search_third")
      yield* db
        .insert(SessionTable)
        .values({ id: third, project_id: Project.ID.global, slug: "t", directory: "/project", version: "t" })
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_w1", 1, "Set up the aiur cluster"),
          assistantRow(sessionID, "msg_w2", 2, [text("The homelab runs nomad.")]),
          userRow(otherID, "msg_w3", 1, "aiur homelab with consul"),
          userRow(third, "msg_w4", 1, "the homelab vault"),
        ])
        .run()
      const sorted = (query: string, input?: Omit<SessionSearchService.Input, "query">) =>
        sessionIDs(query, input).pipe(Effect.map((list) => list.toSorted()))
      // Words in different messages of one session.
      expect(yield* sorted("aiur homelab")).toEqual([otherID, sessionID].toSorted())
      expect(yield* sorted('"aiur homelab"')).toEqual([otherID])
      expect(yield* sorted('"aiur cluster" homelab')).toEqual([sessionID])
      expect(yield* sorted("homelab -nomad")).toEqual([otherID, third].toSorted())
      expect(yield* sorted("homelab (consul OR vault)")).toEqual([otherID, third].toSorted())
      expect(yield* sorted("homelab -(consul OR vault)")).toEqual([sessionID])
      expect(yield* sorted("nom* OR vau*")).toEqual([sessionID, third].toSorted())
      // Excluded terms alone: every session lacking them, without a message.
      const lacking = yield* searchSessions("-aiur")
      expect(lacking.data).toEqual([{ sessionID: third }])
      expect(yield* sorted("aiur", { project: Project.ID.make("prj_other") })).toEqual([otherID])
      expect(yield* sorted("-aiur", { archived: true })).toEqual([])
      expect((yield* searchSessions(" ?! ")).data).toEqual([])
      const tooMany = yield* Effect.exit(searchSessions(Array.from({ length: 33 }, (_, i) => `-w${i}`).join(" ")))
      expect(Exit.isFailure(tooMany) && JSON.stringify(tooMany.cause)).toContain(
        "SessionSearchService.InvalidQueryError",
      )
    }),
  )

  it.effect("gives each session once with its best message, ranked by its terms, and pages", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_v1", 1, "kiwi " + "filler ".repeat(40), 10),
          userRow(sessionID, "msg_v2", 2, "kiwi kiwi kiwi and plum", 20),
          userRow(sessionID, "msg_v3", 3, "plum " + "filler ".repeat(40), 30),
          userRow(otherID, "msg_v4", 1, "kiwi " + "filler ".repeat(40), 40),
        ])
        .run()
      const result = yield* searchSessions("kiwi plum*")
      expect(result.data).toEqual([
        {
          sessionID,
          title: "First",
          message: {
            messageID: SessionMessage.ID.make("msg_v2"),
            role: "user",
            time: { created: DateTime.makeUnsafe(20) },
            snippet: {
              text: "kiwi kiwi kiwi and plum",
              matches: [
                { start: 0, end: 4 },
                { start: 5, end: 9 },
                { start: 10, end: 14 },
                { start: 19, end: 23 },
              ],
            },
          },
        },
      ])
      // Sessions holding more of the terms, and better, first.
      expect(yield* sessionIDs("kiwi OR plum")).toEqual([sessionID, otherID])
      const first = yield* searchSessions("kiwi OR plum", { limit: 1 })
      expect(first.data.map((match) => match.sessionID as string)).toEqual([sessionID])
      expect(first.cursor.next).toBeDefined()
      const second = yield* searchSessions("kiwi OR plum", { limit: 1, cursor: first.cursor.next })
      expect(second.data.map((match) => match.sessionID as string)).toEqual([otherID])
      expect(second.data[0]!.message?.messageID).toBe(SessionMessage.ID.make("msg_v4"))
      expect(second.cursor.next).toBeUndefined()
      const invalid = yield* Effect.exit(searchSessions("kiwi", { cursor: "bogus" as SessionSearch.Cursor }))
      expect(Exit.isFailure(invalid) && JSON.stringify(invalid.cause)).toContain(
        "SessionSearchService.InvalidCursorError",
      )
    }),
  )

  it.effect("fails as unavailable without an index", () =>
    Effect.gen(function* () {
      yield* seed
      const db = (yield* Database.Service).db
      yield* dropIndex(db)
      expect((yield* Effect.flip(search("kiwi")))._tag).toBe("SessionSearchService.IndexUnavailableError")
      expect((yield* Effect.flip(searchSessions("kiwi")))._tag).toBe("SessionSearchService.IndexUnavailableError")
    }),
  )

  // Live: the build pauses between chunks.
  it.live("finds history once the build has indexed it, and reports progress meanwhile", () =>
    Effect.gen(function* () {
      const db = yield* seed
      // As if written before the index existed: rows its triggers never saw.
      yield* dropIndex(db)
      const rows = Array.from({ length: SessionSearchIndex.ChunkLimit + 10 }, (_, i) =>
        userRow(sessionID, `msg_b${String(i).padStart(4, "0")}`, i, `papaya number ${i}`),
      )
      yield* db.insert(SessionMessageTable).values(rows).run()
      const ensured = yield* SessionSearchIndex.ensure(db)
      expect(ensured.status).toBe("ready")
      const pending = yield* search("papaya")
      expect(pending.data).toEqual([])
      // The two sessions and every message existed when the index was created.
      expect(pending.index).toEqual({ complete: false, processed: 0, total: rows.length + 2 })
      yield* SessionSearchIndex.buildChunk(db)
      expect((yield* search("papaya")).index).toMatchObject({ complete: false })

      // The service started the build, which the server process runs.
      const build = yield* SessionSearchBuild.Service
      yield* build.run
      const done = yield* search("papaya", { limit: 100 })
      expect(done.index).toEqual({ complete: true })
      expect(done.data).toHaveLength(rows.length)
    }),
  )
})

/** Drops the index, its view and triggers, and its state, as a database that never had it. */
const dropIndex = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const triggers = yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'session_search*'`,
    )
    for (const row of triggers) yield* db.run(sql.raw(`DROP TRIGGER ${row.name}`))
    yield* db.run(sql`DROP VIEW IF EXISTS session_search_source`)
    yield* db.run(sql`DROP TABLE IF EXISTS session_search`)
    yield* db.run(sql`DROP TABLE IF EXISTS session_search_document`)
    yield* db.run(sql`DELETE FROM kv WHERE key = 'session.search'`)
  })
