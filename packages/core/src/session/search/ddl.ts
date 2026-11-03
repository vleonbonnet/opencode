export * as SessionSearchDDL from "./ddl.js"

import { Effect } from "effect"

/** Marks the start and end of each match in snippets: private-use characters, removed from the indexed text. */
export const MARK_START = "\uE000"
export const MARK_END = "\uE001"

const SEPARATOR = "char(10, 10)"

/**
 * The searchable text of every user and assistant message, as `session_search` stores it: a user prompt, or an
 * assistant message's text parts, inline in `data.content` or (written by a newer release) in `session_part`, joined
 * by blank lines. Tool calls, tool output and reasoning are left out. A row whose data is not JSON has no text, so a
 * malformed legacy row never fails the write that touches it.
 */
const source = `
CREATE VIEW session_search_source AS
SELECT
  m.id AS message_id,
  m.session_id AS session_id,
  m.type AS role,
  m.time_created AS time_created,
  replace(replace(trim(
    CASE
      WHEN NOT json_valid(m.data) THEN ''
      WHEN m.type = 'user' THEN coalesce(json_extract(m.data, '$.text'), '')
      ELSE coalesce((
        SELECT group_concat(json_extract(c.value, '$.text'), ${SEPARATOR})
        FROM json_each(m.data, '$.content') c
        WHERE json_extract(c.value, '$.type') = 'text' AND json_extract(c.value, '$.text') <> ''
      ), '') || coalesce(${SEPARATOR} || (
        SELECT group_concat(json_extract(p.data, '$.text'), ${SEPARATOR})
        FROM (
          SELECT data FROM session_part
          WHERE message_id = m.id AND type = 'text' AND json_valid(data)
          ORDER BY ordinal
        ) p
        WHERE json_extract(p.data, '$.text') <> ''
      ), '')
    END,
    char(32, 9, 10, 13)), char(${MARK_START.codePointAt(0)}), ''), char(${MARK_END.codePointAt(0)}), '') AS text
FROM session_message m
WHERE m.type IN ('user', 'assistant')`

const fts = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
  text,
  content = 'session_search',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
)`

/**
 * Indexes the messages `condition` selects, inserting or updating their rows. The LIMIT keeps SQLite from flattening
 * the view into the INSERT, which would extract each message's text twice: once for the filter, once for the value.
 */
export const upsert = (condition: string) => `
  INSERT INTO session_search (message_id, session_id, role, time_created, text)
  SELECT message_id, session_id, role, time_created, text
  FROM (SELECT * FROM session_search_source WHERE ${condition} LIMIT -1)
  WHERE text <> ''
  ON CONFLICT (message_id) DO UPDATE SET
    session_id = excluded.session_id,
    role = excluded.role,
    time_created = excluded.time_created,
    text = excluded.text
  WHERE session_search.text IS NOT excluded.text
    OR session_search.session_id IS NOT excluded.session_id
    OR session_search.role IS NOT excluded.role
    OR session_search.time_created IS NOT excluded.time_created`

/** Brings the `session_search` row of message `id` in line with its message: written, updated or removed. */
const reindex = (id: string) => `${upsert(`message_id = ${id}`)};
  DELETE FROM session_search
  WHERE message_id = ${id}
    AND coalesce((SELECT text FROM session_search_source WHERE message_id = ${id}), '') = '';`

const triggers: Record<string, string> = {
  session_search_message_insert: `
AFTER INSERT ON session_message WHEN new.type IN ('user', 'assistant')
BEGIN${reindex("new.id")}
END`,
  session_search_message_update: `
AFTER UPDATE OF type, session_id, time_created, data ON session_message
WHEN new.type IN ('user', 'assistant') OR old.type IN ('user', 'assistant')
BEGIN${reindex("new.id")}
END`,
  session_search_message_delete: `
AFTER DELETE ON session_message WHEN old.type IN ('user', 'assistant')
BEGIN
  DELETE FROM session_search WHERE message_id = old.id;
END`,
  session_search_part_insert: `
AFTER INSERT ON session_part WHEN new.type = 'text'
BEGIN${reindex("new.message_id")}
END`,
  session_search_part_update: `
AFTER UPDATE ON session_part WHEN new.type = 'text' OR old.type = 'text'
BEGIN${reindex("new.message_id")}
END`,
  session_search_part_delete: `
AFTER DELETE ON session_part WHEN old.type = 'text'
BEGIN${reindex("old.message_id")}
END`,
  session_search_fts_insert: `
AFTER INSERT ON session_search
BEGIN
  INSERT INTO session_search_fts (rowid, text) VALUES (new.id, new.text);
END`,
  session_search_fts_delete: `
AFTER DELETE ON session_search
BEGIN
  INSERT INTO session_search_fts (session_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END`,
  session_search_fts_update: `
AFTER UPDATE OF text ON session_search WHEN old.text IS NOT new.text
BEGIN
  INSERT INTO session_search_fts (session_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO session_search_fts (rowid, text) VALUES (new.id, new.text);
END`,
}

/** Every schema object the index needs besides the Drizzle-declared tables, by type. */
export const objects = {
  view: ["session_search_source"],
  table: ["session_search_fts"],
  trigger: Object.keys(triggers),
} as const

/**
 * Creates the view, the FTS table and the triggers, replacing the view and triggers when they exist. An earlier
 * index's FTS table is kept: rebuilding it is the backfill's job.
 */
export const install = <E, R>(run: (statement: string) => Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    yield* run(`DROP VIEW IF EXISTS session_search_source`)
    yield* run(source)
    yield* run(fts)
    for (const [name, body] of Object.entries(triggers)) {
      yield* run(`DROP TRIGGER IF EXISTS ${name}`)
      yield* run(`CREATE TRIGGER ${name} ${body}`)
    }
  })

/**
 * Starts (or restarts) indexing every existing user and assistant message from the beginning, when there is any.
 * Messages already indexed are left as they are unless their text changed.
 */
export const seedBackfill = (now: number) => `
INSERT OR REPLACE INTO session_search_backfill (id, cursor, processed, total, time_started)
SELECT 0, '', 0, count(*), ${Math.trunc(now)} FROM session_message WHERE type IN ('user', 'assistant')
HAVING count(*) > 0`

/**
 * One backfill step, run in a single transaction: indexes the next `size` user and assistant messages after the
 * cursor, advances it, and removes the backfill row once no message is left after it. Every statement reads the
 * cursor from the row, so nothing crosses into JavaScript, and a step after the last one changes nothing.
 */
export const backfillStep = (size: number) => {
  const window = `
    SELECT id FROM session_message
    WHERE id > (SELECT cursor FROM session_search_backfill WHERE id = 0) AND type IN ('user', 'assistant')
    ORDER BY id LIMIT ${Math.max(1, Math.trunc(size))}`
  return [
    upsert(`message_id IN (${window})`),
    `UPDATE session_search_backfill SET cursor = w.last, processed = processed + w.n
     FROM (SELECT max(id) AS last, count(*) AS n FROM (${window})) AS w
     WHERE session_search_backfill.id = 0 AND w.n > 0`,
    `DELETE FROM session_search_backfill
     WHERE id = 0 AND NOT EXISTS (
       SELECT 1 FROM session_message
       WHERE id > session_search_backfill.cursor AND type IN ('user', 'assistant')
     )`,
  ]
}
