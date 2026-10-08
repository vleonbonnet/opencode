import { text, sqliteTable } from "drizzle-orm/sqlite-core"
import type { MessageID } from "../v1/session"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Timestamps } from "./schema.sql"

/**
 * The system prompt sections a v1 session froze at its start (or at its latest
 * compaction). Later changes reach the model as stored update parts instead,
 * so the system prompt, the prompt cache and thinking signatures stay valid.
 */
export const SessionSystemBaselineTable = sqliteTable("session_system_baseline", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  /** Identity of this baseline: update parts name the generation they extend. */
  generation: text().notNull(),
  /** The frozen sections, decoded by the session layer. */
  sections: text({ mode: "json" }).notNull().$type<unknown>(),
  /** The completed compaction the baseline was built after, if any. */
  compaction_id: text().$type<MessageID>(),
  ...Timestamps,
})
