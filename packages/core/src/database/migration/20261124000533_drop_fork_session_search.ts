import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// The fork's own session search index gives way to SessionSearchIndex, whose objects take the same names. Its triggers
// write into `session_search`, so they go first. A database without the fork's index, such as one where
// SessionSearchIndex already built its own, keeps what it has.
const triggers = [
  "session_search_message_insert",
  "session_search_message_update",
  "session_search_message_delete",
  "session_search_part_insert",
  "session_search_part_update",
  "session_search_part_delete",
  "session_search_fts_insert",
  "session_search_fts_delete",
  "session_search_fts_update",
]

const migration: DatabaseMigration.Migration = {
  id: "20261124000533_drop_fork_session_search",
  up(tx) {
    return Effect.gen(function* () {
      const objects = yield* tx.all<{ name: string; sql: string | null }>(
        sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('session_search', 'session_search_fts', 'session_search_backfill')`,
      )
      // SessionSearchIndex's `session_search` is a virtual table; the fork's was a plain one.
      const fork = objects.some(
        (object) => object.name !== "session_search" || !/^\s*CREATE\s+VIRTUAL\b/i.test(object.sql ?? ""),
      )
      if (!fork) return
      for (const name of triggers) yield* tx.run(`DROP TRIGGER IF EXISTS \`${name}\`;`)
      yield* tx.run(`DROP VIEW IF EXISTS \`session_search_source\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_search_fts\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_search_message_idx\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_search_backfill\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_search\`;`)
    })
  },
}

export default migration
