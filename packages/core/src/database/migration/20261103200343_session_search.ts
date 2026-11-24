import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// Created the fork's own session search tables, which SessionSearchIndex replaced: a database that ran it has them
// dropped by 20261124000533_drop_fork_session_search, and one that did not never needs them.
const migration: DatabaseMigration.Migration = {
  id: "20261103200343_session_search",
  up() {
    return Effect.void
  },
}

export default migration
