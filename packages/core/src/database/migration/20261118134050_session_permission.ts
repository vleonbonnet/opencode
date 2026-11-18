import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// Saved approvals become Session-scoped. A project-wide approval names no Session to keep it for, so none carries over.
const migration: DatabaseMigration.Migration = {
  id: "20261118134050_session_permission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`permission\`;`)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_session_action_resource_idx\` ON \`permission\` (\`session_id\`,\`action\`,\`resource\`);`,
      )
    })
  },
}

export default migration
