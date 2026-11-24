export * as SessionSearchService from "./service.js"

import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionSearch } from "@opencode/schema/session-search"
import type { Project } from "@opencode/schema/project"
import { Database } from "../../database/database.js"
import type { AbsolutePath } from "../../schema.js"
import { SessionHistory } from "../history.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionSearchBuild } from "../search-build.js"
import { SessionSearchIndex } from "../search-index.js"
import { SessionMessageTable, SessionTable } from "../sql.js"
import { SessionSearchQuery } from "./query.js"

export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  "SessionSearchService.InvalidCursorError",
  {},
) {
  override get message() {
    return "Invalid cursor"
  }
}

export class InvalidQueryError extends Schema.TaggedError<InvalidQueryError>()(
  "SessionSearchService.InvalidQueryError",
  { message: Schema.String },
) {}

/** The index does not exist, as when this SQLite cannot create it. */
export class IndexUnavailableError extends Schema.TaggedError<IndexUnavailableError>()(
  "SessionSearchService.IndexUnavailableError",
  {},
) {
  override get message() {
    return "The session search index is unavailable"
  }
}

export type Input = {
  readonly query: string
  readonly archived?: boolean
  readonly project?: Project.ID
  readonly directory?: AbsolutePath
  /** A Session's children only, or with null only root Sessions. */
  readonly parentID?: SessionSchema.ID | null
  readonly limit?: number
  readonly cursor?: SessionSearch.Cursor
}

type Failure = InvalidCursorError | InvalidQueryError | IndexUnavailableError

/**
 * The HTTP routes' searches of user prompts and the visible text of assistant messages, read from the index
 * SessionSearchIndex keeps. Words match as that index's tokenizer reads them, ignoring case, diacritics and English
 * inflections.
 */
export interface Interface {
  /**
   * The messages matching `query`, best match first (BM25), newer first among equal ranks. Until the index has read
   * the history written before it existed, only messages indexed so far can match; `index` says how far it is.
   */
  readonly search: (input: Input) => Effect.Effect<SessionSearch.Response, Failure>
  /**
   * The sessions whose messages, taken together, match `query`, read by {@link SessionSearchQuery.parse}: each term
   * holds when one of the session's messages matches it. Best first: the sum of each term's best BM25 rank among the
   * session's messages, then the most recently updated. Each comes with its message best matching the terms it
   * holds. As for {@link Interface.search}, only the messages indexed so far can match until the index is complete.
   */
  readonly searchSessions: (input: Input) => Effect.Effect<SessionSearch.SessionsResponse, Failure>
  readonly index: Effect.Effect<SessionSearch.Index>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearchService") {}

// The index's columns holding message text; titles and compaction summaries are in the others.
const MESSAGES = "{user_text assistant_text}"
const messages = (expression: string) => `${MESSAGES} : (${expression})`

type Row = { messageID: string; sessionID: string; role: SessionSearch.Role; created: number; title: string | null }

type SessionRow = { id: string; title: string | null; updated: number }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const build = yield* SessionSearchBuild.Service

    // These routes read the index whatever the sqlite_fts flag says: create it now, so new messages are indexed from
    // here on, and let the server process index the history.
    yield* SessionSearchIndex.ensure(db).pipe(
      Effect.tap((ensured) =>
        ensured.status === "unsupported"
          ? Effect.logWarning("session search is not supported by this SQLite", { reason: ensured.reason })
          : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("session search index not created", { cause })),
    )
    yield* build.start

    const index: Interface["index"] = SessionSearchIndex.state(db).pipe(
      Effect.map((state): SessionSearch.Index => {
        if (!SessionSearchIndex.current(state)) return { complete: false }
        // Rows written after the index was created are indexed as they are written, so it is complete once the build
        // has visited every row that existed then.
        if (state.status === "done" || (state.status === "building" && state.processed >= state.total))
          return { complete: true }
        return { complete: false, processed: Math.min(state.processed, state.total), total: state.total }
      }),
    )

    const filters = (input: Input): SQL[] => {
      const conditions: SQL[] = []
      if (input.directory !== undefined) conditions.push(eq(SessionTable.directory, input.directory))
      if (input.project !== undefined) conditions.push(eq(SessionTable.project_id, input.project))
      if (input.parentID !== undefined)
        conditions.push(
          input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
        )
      if (input.archived !== undefined)
        conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
      return conditions
    }

    const page = Effect.fnUntraced(function* (input: Input) {
      const offset =
        input.cursor === undefined
          ? 0
          : yield* SessionSearch.Cursor.parse(input.cursor).pipe(Effect.mapError(() => new InvalidCursorError()))
      const limit = Math.min(Math.max(1, input.limit ?? SessionSearch.DEFAULT_LIMIT), SessionSearch.MAX_LIMIT)
      return { offset, limit }
    })

    const tooManyTerms = () =>
      new InvalidQueryError({ message: `A search query may hold at most ${SessionSearch.MAX_TERMS} terms` })

    // Every query quotes its terms, so only a missing index fails one.
    const read = <A>(query: Effect.Effect<A, unknown>) =>
      query.pipe(
        Effect.catch((error) =>
          SessionSearchIndex.isQueryError(error) ? Effect.fail(new IndexUnavailableError()) : Effect.die(error),
        ),
      )

    const search: Interface["search"] = Effect.fn("SessionSearchService.search")(function* (input) {
      const terms = SessionSearchQuery.terms(input.query)
      if (terms.length > SessionSearch.MAX_TERMS) return yield* tooManyTerms()
      const { offset, limit } = yield* page(input)
      const status = yield* index
      if (terms.length === 0) return { data: [], cursor: {}, index: status }

      const conditions = [
        sql`session_search MATCH ${messages(SessionSearchQuery.expression(terms))}`,
        ...filters(input),
      ]
      const rows = yield* read(
        db.all<Row>(
          sql`
            SELECT
              d.source_id AS messageID,
              d.session_id AS sessionID,
              ${SessionMessageTable.type} AS role,
              ${SessionMessageTable.time_created} AS created,
              ${SessionTable.title} AS title
            FROM session_search
            JOIN session_search_document AS d ON d.id = session_search.rowid
            JOIN ${SessionMessageTable} ON ${SessionMessageTable.id} = d.source_id
            JOIN ${SessionTable} ON ${SessionTable.id} = d.session_id
            WHERE ${and(...conditions)}
            ORDER BY bm25(session_search), ${SessionMessageTable.time_created} DESC, ${SessionMessageTable.id} DESC
            LIMIT ${limit + 1} OFFSET ${offset}
          `,
        ),
      )
      const shown = rows.slice(0, limit)
      const snippets = yield* highlight(
        shown.map((row) => row.messageID),
        SessionSearchQuery.anyOf(terms),
      )

      return {
        data: shown.map((row) => ({
          sessionID: SessionSchema.ID.make(row.sessionID),
          ...(row.title ? { title: row.title } : {}),
          messageID: SessionMessage.ID.make(row.messageID),
          role: row.role,
          time: { created: DateTime.makeUnsafe(row.created) },
          snippet: SessionSearchQuery.snippet(snippets.get(row.messageID) ?? ""),
        })),
        cursor: rows.length > limit ? { next: SessionSearch.Cursor.make(offset + limit) } : {},
        index: status,
      }
    })

    const searchSessions: Interface["searchSessions"] = Effect.fn("SessionSearchService.searchSessions")(
      function* (input) {
        const expression = SessionSearchQuery.parse(input.query)
        const terms = expression ? SessionSearchQuery.termsOf(expression) : []
        if (terms.length > SessionSearch.MAX_TERMS) return yield* tooManyTerms()
        const { offset, limit } = yield* page(input)
        const status = yield* index
        if (!expression) return { data: [], cursor: {}, index: status }

        const scope = filters(input)
        const where = scope.length > 0 ? and(...scope)! : sql`1`
        // Every session the filters leave, as a term held by none, or excluded, leaves them all.
        const sessions = yield* db
          .all<SessionRow>(
            sql`SELECT ${SessionTable.id} AS id, ${SessionTable.title} AS title, ${SessionTable.time_updated} AS updated
                FROM ${SessionTable} WHERE ${where}`,
          )
          .pipe(Effect.orDie)
        // Each term's best rank in each session holding it. The LIMITs keep SQLite from flattening the full-text query
        // into the aggregate or window around it, where bm25() cannot run.
        const ranks = new Map<string, Map<string, number>>()
        for (const term of terms) {
          const rows = yield* read(
            db.all<{ id: string; rank: number }>(
              sql`
                SELECT sessionID AS id, MIN(rank) AS rank FROM (
                  SELECT d.session_id AS sessionID, bm25(session_search) AS rank
                  FROM session_search
                  JOIN session_search_document AS d ON d.id = session_search.rowid
                  JOIN ${SessionTable} ON ${SessionTable.id} = d.session_id
                  WHERE session_search MATCH ${messages(SessionSearchQuery.expression([term]))} AND ${where}
                  LIMIT -1
                ) GROUP BY sessionID
              `,
            ),
          )
          ranks.set(SessionSearchQuery.key(term), new Map(rows.map((row) => [row.id, row.rank])))
        }
        const holds = (session: string) => (term: SessionSearchQuery.Term) =>
          ranks.get(SessionSearchQuery.key(term))?.has(session) ?? false
        const positives = SessionSearchQuery.positives(expression)
        const matched = sessions
          .filter((session) => SessionSearchQuery.evaluate(expression, holds(session.id)))
          .map((session) => {
            const held = positives.flatMap((term) => {
              const rank = ranks.get(SessionSearchQuery.key(term))?.get(session.id)
              return rank === undefined ? [] : [rank]
            })
            return { ...session, held: held.length > 0, score: held.reduce((sum, rank) => sum + rank, 0) }
          })
          .toSorted(
            (a, b) =>
              Number(b.held) - Number(a.held) ||
              a.score - b.score ||
              b.updated - a.updated ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
        const shown = matched.slice(offset, offset + limit)
        const best = yield* bestMessages(
          positives,
          shown.filter((session) => session.held).map((session) => session.id),
        )

        return {
          data: shown.map((session) => {
            const message = best.get(session.id)
            return {
              sessionID: SessionSchema.ID.make(session.id),
              ...(session.title ? { title: session.title } : {}),
              ...(message
                ? {
                    message: {
                      messageID: SessionMessage.ID.make(message.messageID),
                      role: message.role,
                      time: { created: DateTime.makeUnsafe(message.created) },
                      snippet: SessionSearchQuery.snippet(message.snippet),
                    },
                  }
                : {}),
            }
          }),
          cursor: matched.length > offset + limit ? { next: SessionSearch.Cursor.make(offset + limit) } : {},
          index: status,
        }
      },
    )

    /** The message of each of `sessions` best matching any of `terms`, by BM25 then the newest, with its marked text. */
    const bestMessages = Effect.fnUntraced(function* (
      terms: ReadonlyArray<SessionSearchQuery.Term>,
      sessions: ReadonlyArray<string>,
    ) {
      const found = new Map<string, Omit<Row, "title"> & { snippet: string }>()
      if (terms.length === 0 || sessions.length === 0) return found
      const match = SessionSearchQuery.anyOf(terms)
      const rows = yield* read(
        db.all<Omit<Row, "title">>(
          sql`
            SELECT messageID, sessionID, role, created FROM (
              SELECT messageID, sessionID, role, created,
                ROW_NUMBER() OVER (PARTITION BY sessionID ORDER BY rank, created DESC, messageID DESC) AS n
              FROM (
                SELECT d.source_id AS messageID, d.session_id AS sessionID, ${SessionMessageTable.type} AS role,
                  ${SessionMessageTable.time_created} AS created, bm25(session_search) AS rank
                FROM session_search
                JOIN session_search_document AS d ON d.id = session_search.rowid
                JOIN ${SessionMessageTable} ON ${SessionMessageTable.id} = d.source_id
                WHERE session_search MATCH ${messages(match)} AND d.session_id IN ${sessions}
                LIMIT -1
              )
            ) WHERE n = 1
          `,
        ),
      )
      const snippets = yield* highlight(
        rows.map((row) => row.messageID),
        match,
      )
      for (const row of rows) found.set(row.sessionID, { ...row, snippet: snippets.get(row.messageID) ?? "" })
      return found
    })

    /**
     * The searchable text of each message, its matches of `match` marked with {@link SessionSearchQuery.MARK_START}
     * and {@link SessionSearchQuery.MARK_END}. A contentless index has no text to mark, so the text is read again
     * into a temporary full-text table with the index's own tokenizer, which finds the words exactly as it does.
     */
    const highlight = Effect.fnUntraced(function* (ids: ReadonlyArray<string>, match: string) {
      const marked = new Map<string, string>()
      if (ids.length === 0) return marked
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          inArray(
            SessionMessageTable.id,
            [...ids].map((id) => SessionMessage.ID.make(id)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const texts = new Map<string, string>()
      for (const row of yield* SessionHistory.withParts(db, rows)) {
        const message = yield* SessionHistory.decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
        const text = message ? searchable(message) : ""
        if (text) texts.set(row.id, text)
      }
      if (texts.size === 0) return marked
      const index = yield* db
        .get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_search'`)
        .pipe(Effect.orDie)
      const tokenizer = index && /tokenize\s*=\s*('(?:[^']|'')*')/.exec(index.sql)?.[1]
      const entries = [...texts.entries()].map(([id, text], position) => ({ id, text, rowid: position + 1 }))
      const folds = new Map(entries.map((entry) => [entry.rowid, fold(entry.text)]))
      const found = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql.raw("DROP TABLE IF EXISTS temp.search_highlight"))
            yield* tx.run(
              sql.raw(
                `CREATE VIRTUAL TABLE temp.search_highlight USING fts5(text${tokenizer ? `, tokenize=${tokenizer}` : ""})`,
              ),
            )
            for (const entry of entries)
              yield* tx.run(
                sql`INSERT INTO temp.search_highlight (rowid, text) VALUES (${entry.rowid}, ${folds.get(entry.rowid)!.text})`,
              )
            const result = yield* tx.all<{ rowid: number; text: string }>(
              sql`SELECT rowid, highlight(search_highlight, 0, ${SessionSearchQuery.MARK_START}, ${SessionSearchQuery.MARK_END}) AS text
                  FROM temp.search_highlight WHERE search_highlight MATCH ${match}`,
            )
            yield* tx.run(sql.raw("DROP TABLE temp.search_highlight"))
            return result
          }),
        )
        .pipe(Effect.orDie)
      const highlighted = new Map(found.map((row) => [row.rowid, row.text]))
      for (const entry of entries) {
        const text = highlighted.get(entry.rowid)
        marked.set(entry.id, text === undefined ? entry.text : unfold(entry.text, folds.get(entry.rowid)!, text))
      }
      return marked
    })

    return Service.of({ search, searchSessions, index })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SessionSearchBuild.node] })

/**
 * The text the index holds for a message, before its folds: a user prompt, or an assistant message's text parts
 * joined by blank lines, each cut to the length the index keeps. Without the marks, which locate matches.
 */
function searchable(message: SessionMessage.Info) {
  const text =
    message.type === "user"
      ? message.text.slice(0, SessionSearchIndex.MaxText)
      : message.type === "assistant"
        ? message.content
            .flatMap((part) =>
              part.type === "text" && part.text.trim() ? [part.text.slice(0, SessionSearchIndex.MaxText)] : [],
            )
            .join("\n\n")
            .slice(0, SessionSearchIndex.MaxText)
        : ""
  return text.replaceAll(SessionSearchQuery.MARK_START, "").replaceAll(SessionSearchQuery.MARK_END, "")
}

type Folded = {
  readonly text: string
  /** For each UTF-16 unit of `text`, and one past its end, the offset in the original text it comes from. */
  readonly origin: ReadonlyArray<number>
}

/** The text as the index folds it, and where each of its characters came from. */
function fold(text: string): Folded {
  let folded = ""
  const origin: number[] = []
  let offset = 0
  for (const character of text) {
    const piece = SessionSearchIndex.foldText(character)
    for (let unit = 0; unit < piece.length; unit++) origin.push(offset)
    folded += piece
    offset += character.length
  }
  origin.push(offset)
  return { text: folded, origin }
}

/** The original text with the marks `highlighted` puts in its folded form. */
function unfold(original: string, folded: Folded, highlighted: string) {
  const marks: Array<{ at: number; mark: string }> = []
  let position = 0
  for (const unit of highlighted) {
    if (unit === SessionSearchQuery.MARK_START || unit === SessionSearchQuery.MARK_END) {
      marks.push({ at: folded.origin[position] ?? original.length, mark: unit })
      continue
    }
    position += unit.length
  }
  let result = ""
  let from = 0
  for (const mark of marks) {
    result += original.slice(from, mark.at) + mark.mark
    from = mark.at
  }
  return result + original.slice(from)
}
