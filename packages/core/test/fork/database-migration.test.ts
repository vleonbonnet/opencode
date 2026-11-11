import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode/core/database/migration"
import { migrations } from "@opencode/core/database/migration.gen"
import sessionDelegatorsMigration from "@opencode/core/database/migration/20261019044242_session_delegators"
import sessionSearchMigration from "@opencode/core/database/migration/20261103200343_session_search"
import sessionSearchIndexMigration from "@opencode/core/database/migration/20261103200500_session_search_index"
import { SessionSearchDDL } from "@opencode/core/session/search/ddl"
import { Global } from "@opencode/util/global"

// The in-memory database runner of the upstream migration tests.
const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Global.Service>,
  global = Global.make({ data: path.join(process.cwd(), ".test-data") }),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Global.Service, global),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("adds no delegators to existing sessions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY, title text)`)
        yield* db.run(sql`INSERT INTO session_v2 (id, title) VALUES ('ses_existing', 'Existing')`)

        yield* DatabaseMigration.applyOnly(db, [sessionDelegatorsMigration])
        yield* DatabaseMigration.applyOnly(db, [sessionDelegatorsMigration])

        expect(yield* db.get(sql`SELECT id, title, delegators FROM session_v2`)).toEqual({
          id: "ses_existing",
          title: "Existing",
          delegators: null,
        })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: 1 })
      }),
    )
  })

  test("bootstraps the session search index that the generated schema cannot declare", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        const objects = yield* db.all<{ type: string; name: string }>(
          sql`SELECT type, name FROM sqlite_master WHERE name LIKE 'session_search%' AND type IN ('table', 'view', 'trigger')`,
        )
        for (const [type, names] of Object.entries(SessionSearchDDL.objects))
          for (const name of names) expect(objects).toContainEqual({ type, name })
        // An empty database has nothing to backfill.
        expect(yield* db.all(sql`SELECT * FROM session_search_backfill`)).toEqual([])
      }),
    )
  })

  test("adds the session search index to existing history and seeds its backfill", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        // Back to the schema before the index: without its tables, view, triggers and migration records.
        for (const name of SessionSearchDDL.objects.trigger) yield* db.run(sql.raw(`DROP TRIGGER ${name}`))
        yield* db.run(sql`DROP VIEW session_search_source`)
        yield* db.run(sql`DROP TABLE session_search_fts`)
        yield* db.run(sql`DROP TABLE session_search`)
        yield* db.run(sql`DROP TABLE session_search_backfill`)
        yield* db.run(
          sql`DELETE FROM migration WHERE id IN (${sessionSearchMigration.id}, ${sessionSearchIndexMigration.id})`,
        )
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/', '[]', 1, 1)`,
        )
        yield* db.run(sql`
          INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
          VALUES ('ses_old', 'global', 'old', '/', 'v', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
            ('msg_1', 'ses_old', 'user', 1, 1, 1, '{"text":"old quince prompt","time":{"created":1}}'),
            ('msg_2', 'ses_old', 'assistant', 2, 2, 2, '{"content":[{"type":"text","text":"old quince reply"}],"time":{"created":2}}'),
            ('msg_3', 'ses_old', 'system', 3, 3, 3, '{"text":"quince system note","time":{"created":3}}'),
            ('msg_4', 'ses_old', 'assistant', 4, 4, 4, 'not json')
        `)

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* db.all(sql`SELECT id, cursor, processed, total FROM session_search_backfill`)).toEqual([
          { id: 0, cursor: "", processed: 0, total: 3 },
        ])
        // History waits for the backfill; new messages are indexed as they are written.
        expect(yield* db.all(sql`SELECT message_id FROM session_search`)).toEqual([])
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_5', 'ses_old', 'user', 5, 5, 5, '{"text":"new quince","time":{"created":5}}')
        `)
        expect(
          yield* db.all(sql`SELECT rowid FROM session_search_fts WHERE session_search_fts MATCH 'quince'`),
        ).toHaveLength(1)
        for (let step = 0; step < 3; step++)
          for (const statement of SessionSearchDDL.backfillStep(2)) yield* db.run(sql.raw(statement))
        expect(yield* db.all(sql`SELECT * FROM session_search_backfill`)).toEqual([])
        expect(
          yield* db.all(
            sql`SELECT s.message_id AS id FROM session_search_fts f JOIN session_search s ON s.id = f.rowid WHERE session_search_fts MATCH 'quince' ORDER BY s.message_id`,
          ),
        ).toEqual([{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_5" }])
      }),
    )
  })
})
