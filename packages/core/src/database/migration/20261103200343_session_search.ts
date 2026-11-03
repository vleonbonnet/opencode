import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261103200343_session_search",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_search_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`cursor\` text NOT NULL,
          \`processed\` integer NOT NULL,
          \`total\` integer NOT NULL,
          \`time_started\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_search\` (
          \`id\` integer PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`text\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_search_message_idx\` ON \`session_search\` (\`message_id\`);`)
    })
  },
}

export default migration
