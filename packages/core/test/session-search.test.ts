import { describe, expect, test } from "bun:test"
import path from "path"
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
import { SessionSearchDDL } from "@opencode/core/session/search/ddl"
import { SessionSearchQuery } from "@opencode/core/session/search/query"
import { SessionSearchService } from "@opencode/core/session/search/service"
import { SessionSearchBackfillTable, SessionSearchTable } from "@opencode/core/session/search/sql"
import { SessionMessageTable, SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionStored } from "@opencode/core/session/stored"
import { SessionSearch } from "@opencode/schema/session-search"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
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
      time: { created: DateTime.makeUnsafe(created) },
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

  test("makes snippets one bounded line with located matches", () => {
    const { MARK_START: s, MARK_END: e } = SessionSearchDDL
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
  it.effect("indexes user prompts and assistant text, not tool calls, tool output or reasoning", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_a1", 1, "Please migrate the database"),
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
      expect((yield* ids("migrate")).toSorted()).toEqual(["msg_a1", "msg_a2"])
      expect(yield* ids("pondering")).toEqual([])
      expect(yield* ids("toolinput")).toEqual([])
      expect(yield* ids("tooloutput")).toEqual([])
      const row = yield* db
        .select({ text: SessionSearchTable.text, role: SessionSearchTable.role })
        .from(SessionSearchTable)
        .where(eq(SessionSearchTable.message_id, SessionMessage.ID.make("msg_a2")))
        .get()
      expect(row).toEqual({ text: "I will migrate it now.\n\nDone migrating.", role: "assistant" })
      const result = yield* search("migrating")
      expect(result.index).toEqual({ complete: true })
      expect(result.data).toEqual([
        {
          sessionID,
          title: "First",
          messageID: SessionMessage.ID.make("msg_a2"),
          role: "assistant",
          time: { created: DateTime.makeUnsafe(2) },
          snippet: { text: "I will migrate it now. Done migrating.", matches: [{ start: 28, end: 37 }] },
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
      expect(yield* ids("giraffe")).toEqual([])
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID,
        ordinal: 1,
        text: "The zebra is striped",
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

  it.effect("indexes text parts stored in session_part and drops a message once it has no text", () =>
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
      expect(yield* ids("beta")).toEqual(["msg_parts"])
      yield* db
        .update(SessionPartTable)
        .set({ data: { type: "text", text: "gamma part" } })
        .where(eq(SessionPartTable.ordinal, 1))
        .run()
      expect(yield* ids("beta")).toEqual([])
      expect(yield* ids("gamma")).toEqual(["msg_parts"])
      yield* db.delete(SessionPartTable).run()
      expect(yield* ids("part")).toEqual([])
      expect(yield* db.select().from(SessionSearchTable).all()).toEqual([])
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
      expect(yield* db.select({ id: SessionSearchTable.message_id }).from(SessionSearchTable).all()).toEqual([
        { id: SessionMessage.ID.make("msg_d2") },
      ])
      // Fails when the FTS index and its content table disagree.
      yield* db.run(sql`INSERT INTO session_search_fts (session_search_fts, rank) VALUES ('integrity-check', 1)`)
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
      expect(Exit.isFailure(invalid) && JSON.stringify(invalid.cause)).toContain("SessionSearch.InvalidCursorError")
      // Limits are clamped to what one page may return.
      expect((yield* search("kiwi", { limit: 10_000 })).data).toHaveLength(5)
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

  it.effect("matches phrases, prefixes and accents, and refuses too many terms", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db
        .insert(SessionMessageTable)
        .values([
          userRow(sessionID, "msg_q1", 1, "Run the service smoke test"),
          userRow(sessionID, "msg_q2", 2, "smoke the service"),
          userRow(sessionID, "msg_q3", 3, "Le café est prêt"),
          userRow(sessionID, "msg_q4", 4, "the session_search table"),
        ])
        .run()
      expect(yield* ids('"service smoke"')).toEqual(["msg_q1"])
      expect((yield* ids("service smoke")).toSorted()).toEqual(["msg_q1", "msg_q2"])
      expect(yield* ids("serv*")).toHaveLength(2)
      expect(yield* ids("cafe pret")).toEqual(["msg_q3"])
      expect(yield* ids("session_search")).toEqual(["msg_q4"])
      expect(yield* ids('NEAR(smoke "  OR * ^')).toEqual([])
      const result = yield* search("?!")
      expect(result.data).toEqual([])
      const tooMany = yield* Effect.exit(search(Array.from({ length: 33 }, (_, i) => `w${i}`).join(" ")))
      expect(Exit.isFailure(tooMany) && JSON.stringify(tooMany.cause)).toContain("SessionSearch.InvalidQueryError")
    }),
  )

  it.effect("backfills existing messages step by step and reports progress meanwhile", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const rows = Array.from({ length: SessionSearchService.BACKFILL_STEP + 10 }, (_, i) =>
        i % 2 === 0
          ? userRow(sessionID, `msg_b${String(i).padStart(4, "0")}`, i, `papaya number ${i}`)
          : assistantRow(sessionID, `msg_b${String(i).padStart(4, "0")}`, i, i % 3 === 0 ? [] : [text(`papaya ${i}`)]),
      )
      // As if written by a release without the index: rows the triggers never saw.
      yield* db.run(sql`DROP TRIGGER session_search_message_insert`)
      yield* db.insert(SessionMessageTable).values(rows).run()
      yield* SessionSearchDDL.install((statement) => db.run(statement))
      yield* db.run(SessionSearchDDL.seedBackfill(1))
      expect(yield* ids("papaya")).toEqual([])
      const pending = yield* search("papaya")
      expect(pending.index).toEqual({ complete: false, processed: 0, total: rows.length })

      const service = yield* SessionSearchService.Service
      // One step by hand, as the background loop does.
      for (const statement of SessionSearchDDL.backfillStep(SessionSearchService.BACKFILL_STEP))
        yield* db.run(statement)
      const partial = yield* search("papaya", { limit: 100 })
      expect(partial.index).toEqual({
        complete: false,
        processed: SessionSearchService.BACKFILL_STEP,
        total: rows.length,
      })
      expect(partial.data.length).toBeGreaterThan(0)

      yield* service.backfill
      expect(yield* service.index).toEqual({ complete: true })
      expect(yield* db.select().from(SessionSearchBackfillTable).all()).toEqual([])
      const indexed = rows.filter((_, i) => i % 2 === 0 || i % 3 !== 0).length
      expect(yield* db.get(sql`SELECT count(*) AS n FROM ${SessionSearchTable}`)).toEqual({ n: indexed })
      expect((yield* search("papaya", { limit: 100 })).data).toHaveLength(Math.min(indexed, 100))
      // A finished backfill does nothing more.
      yield* service.backfill
    }),
  )

  // Outside the shared test layer, whose already built services each layer below would otherwise reuse.
  test("puts back missing triggers at start and indexes everything again", () =>
    Effect.gen(function* () {
      const file = path.join((yield* tmpdirScoped("opencode-search-")).path, "search.sqlite")
      // A fresh layer each time: each one opens the database and starts the service as a server start does.
      const layer = () =>
        AppNodeBuilder.build(LayerNode.group([Database.node, SessionSearchService.node]), [
          Database.node.replace(Database.configured({ path: file })),
        ])
      yield* Effect.gen(function* () {
        const db = yield* seed
        // As a rebuild of session_message by a later migration would: its triggers are gone.
        yield* db.run(sql`DROP TRIGGER session_search_message_insert`)
        yield* db.run(sql`DROP TRIGGER session_search_message_delete`)
        yield* db
          .insert(SessionMessageTable)
          .values([userRow(sessionID, "msg_s1", 1, "unseen lychee")])
          .run()
        yield* db
          .insert(SessionMessageTable)
          .values([userRow(sessionID, "msg_s2", 2, "stale lychee")])
          .run()
        yield* db.run(SessionSearchDDL.upsert("message_id = 'msg_s2'"))
        yield* db
          .delete(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_s2")))
          .run()
        expect(yield* db.select({ id: SessionSearchTable.message_id }).from(SessionSearchTable).all()).toEqual([
          { id: SessionMessage.ID.make("msg_s2") },
        ])
      }).pipe(Effect.provide(layer()))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const service = yield* SessionSearchService.Service
        const triggers = yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_search_%' ORDER BY name`,
        )
        expect(triggers.map((row) => row.name)).toEqual([...SessionSearchDDL.objects.trigger].toSorted())
        yield* service.backfill
        expect(yield* ids("lychee")).toEqual(["msg_s1"])
      }).pipe(Effect.provide(layer()))
    }).pipe(Effect.scoped, Effect.runPromise))
})
