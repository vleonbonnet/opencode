import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008221404_session_system_baseline",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_system_baseline\` (
          \`session_id\` text PRIMARY KEY,
          \`generation\` text NOT NULL,
          \`sections\` text NOT NULL,
          \`compaction_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_system_baseline_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
