import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// Installed the fork's own session search index, which SessionSearchIndex replaced: a database that ran it has it
// dropped by 20261124000533_drop_fork_session_search, and one that did not never needs it.
const migration: DatabaseMigration.Migration = {
  id: "20261103200500_session_search_index",
  up() {
    return Effect.void
  },
}

export default migration
