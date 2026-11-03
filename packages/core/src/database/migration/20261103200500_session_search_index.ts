import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"
import { SessionSearchDDL } from "../../session/search/ddl.js"

// Drizzle cannot declare the FTS table, its view or its triggers, so this also runs on a fresh database. Existing
// messages are indexed in the background after start (SessionSearch), from the backfill row seeded here.
const migration: DatabaseMigration.Migration = {
  id: "20261103200500_session_search_index",
  bootstrap: true,
  up(tx) {
    return Effect.gen(function* () {
      yield* SessionSearchDDL.install((statement) => tx.run(statement))
      yield* tx.run(SessionSearchDDL.seedBackfill(Date.now()))
    })
  },
}

export default migration
