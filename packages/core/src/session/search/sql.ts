import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SessionMessage } from "../message.js"
import type { SessionSchema } from "../schema.js"

/**
 * The searchable text of each user prompt and assistant message: the prompt, or the assistant's visible text parts
 * joined by blank lines, never tool calls, tool output or reasoning. Triggers on `session_message` and
 * `session_part` keep it current (see ./ddl.ts); `session_search_fts` indexes `text` with this table as its
 * external content. `id` is an INTEGER PRIMARY KEY so the FTS rowids survive VACUUM.
 */
export const SessionSearchTable = sqliteTable(
  "session_search",
  {
    id: integer().primaryKey(),
    message_id: text().$type<SessionMessage.ID>().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    role: text().$type<"user" | "assistant">().notNull(),
    time_created: integer().notNull(),
    text: text().notNull(),
  },
  (table) => [uniqueIndex("session_search_message_idx").on(table.message_id)],
)

/**
 * The indexing of messages written before the search index existed, while it runs: one row, removed once every
 * message up to the end of `session_message` has been indexed. `cursor` is the last message ID indexed, in ID order.
 */
export const SessionSearchBackfillTable = sqliteTable("session_search_backfill", {
  id: integer().primaryKey(),
  cursor: text().notNull(),
  processed: integer().notNull(),
  total: integer().notNull(),
  time_started: integer().notNull(),
})
