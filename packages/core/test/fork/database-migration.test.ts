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
import dropForkSessionSearchMigration from "@opencode/core/database/migration/20261124000533_drop_fork_session_search"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
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

  test("creates no session search objects on a fresh database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        expect(yield* searchObjects(db)).toEqual([])
      }),
    )
  })

  test("drops the fork's own session search index, so SessionSearchIndex can build its own", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${dropForkSessionSearchMigration.id}`)
        yield* installForkIndex(db)
        yield* seedHistory(db)
        expect((yield* searchObjects(db)).length).toBeGreaterThan(0)

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* searchObjects(db)).toEqual([])
        // Its triggers wrote into its table: without them, writes go through.
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_new', 'ses_old', 'user', 3, 3, 3, '{"text":"new quince","time":{"created":3}}')
        `)
        expect((yield* SessionSearchIndex.ensure(db)).status).toBe("ready")
        while (!(yield* SessionSearchIndex.buildChunk(db)).done) {}
        expect(
          yield* db.all(sql`
            SELECT d.source_id AS id FROM session_search JOIN session_search_document AS d ON d.id = session_search.rowid
            WHERE session_search MATCH 'quince' ORDER BY d.source_id
          `),
        ).toEqual([{ id: "msg_1" }, { id: "msg_new" }])
      }),
    )
  })

  test("keeps an index SessionSearchIndex built", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${dropForkSessionSearchMigration.id}`)
        yield* seedHistory(db)
        expect((yield* SessionSearchIndex.ensure(db)).status).toBe("ready")
        const before = yield* searchObjects(db)

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* searchObjects(db)).toEqual(before)
      }),
    )
  })
})

type Db = Effect.Success<typeof makeDb>

const searchObjects = (db: Db) =>
  db.all<{ type: string; name: string }>(
    sql`SELECT type, name FROM sqlite_master WHERE name GLOB 'session_search*' ORDER BY type, name`,
  )

const seedHistory = (db: Db) =>
  Effect.gen(function* () {
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
        ('msg_2', 'ses_old', 'system', 2, 2, 2, '{"text":"quince system note","time":{"created":2}}')
    `)
  })

// The objects the fork's index (20261103200343_session_search and 20261103200500_session_search_index) installed,
// with the trigger names it shared with SessionSearchIndex.
const installForkIndex = (db: Db) =>
  Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TABLE session_search (
        id integer PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, role text NOT NULL,
        time_created integer NOT NULL, text text NOT NULL
      )
    `)
    yield* db.run(sql`CREATE UNIQUE INDEX session_search_message_idx ON session_search (message_id)`)
    yield* db.run(sql`
      CREATE TABLE session_search_backfill (
        id integer PRIMARY KEY, cursor text NOT NULL, processed integer NOT NULL, total integer NOT NULL,
        time_started integer NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE VIEW session_search_source AS
      SELECT id AS message_id, session_id, type AS role, time_created, json_extract(data, '$.text') AS text
      FROM session_message WHERE type IN ('user', 'assistant')
    `)
    yield* db.run(
      sql`CREATE VIRTUAL TABLE session_search_fts USING fts5(text, content = 'session_search', content_rowid = 'id')`,
    )
    yield* db.run(sql`
      CREATE TRIGGER session_search_message_insert AFTER INSERT ON session_message WHEN new.type IN ('user', 'assistant')
      BEGIN
        INSERT INTO session_search (message_id, session_id, role, time_created, text)
        SELECT message_id, session_id, role, time_created, text FROM session_search_source WHERE message_id = new.id;
      END
    `)
    yield* db.run(sql`
      CREATE TRIGGER session_search_fts_insert AFTER INSERT ON session_search
      BEGIN
        INSERT INTO session_search_fts (rowid, text) VALUES (new.id, new.text);
      END
    `)
  })
