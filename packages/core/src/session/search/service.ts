export * as SessionSearchService from "./service.js"

import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionSearch } from "@opencode/schema/session-search"
import type { Project } from "@opencode/schema/project"
import { Database } from "../../database/database.js"
import type { AbsolutePath } from "../../schema.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionTable } from "../sql.js"
import { SessionSearchDDL } from "./ddl.js"
import { SessionSearchQuery } from "./query.js"
import { SessionSearchBackfillTable, SessionSearchTable } from "./sql.js"

export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  "SessionSearch.InvalidCursorError",
  {},
) {
  override get message() {
    return "Invalid cursor"
  }
}

export class InvalidQueryError extends Schema.TaggedError<InvalidQueryError>()("SessionSearch.InvalidQueryError", {
  message: Schema.String,
}) {}

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

export interface Interface {
  /**
   * The messages matching `query`, best match first (BM25), newer first among equal ranks. Until the backfill is
   * complete, only the messages indexed so far can match; `index` says how far it is.
   */
  readonly search: (input: Input) => Effect.Effect<SessionSearch.Response, InvalidCursorError | InvalidQueryError>
  /**
   * The sessions whose messages, taken together, match `query`, read by {@link SessionSearchQuery.parse}: each term
   * holds when one of the session's messages matches it. Best first: the sum of each term's best BM25 rank among the
   * session's messages, then the most recently updated. Each comes with its message best matching the terms it
   * holds. As for {@link Interface.search}, only the messages indexed so far can match until the backfill is complete.
   */
  readonly searchSessions: (
    input: Input,
  ) => Effect.Effect<SessionSearch.SessionsResponse, InvalidCursorError | InvalidQueryError>
  readonly index: Effect.Effect<SessionSearch.Index>
  /** Indexes the messages written before the index existed, step by step, until none is left. */
  readonly backfill: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearch") {}

/** Messages one backfill step indexes: a step holds the database for tens of milliseconds on a cold cache. */
export const BACKFILL_STEP = 250
const SNIPPET_TOKENS = 24

type Row = {
  messageID: string
  sessionID: string
  role: SessionSearch.Role
  created: number
  title: string | null
  snippet: string | null
}

type SessionRow = { id: string; title: string | null; updated: number }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    // A table rebuild drops its triggers, so an upstream migration rebuilding session_message would silently stop
    // indexing: put back whatever is missing, drop rows of messages deleted meanwhile, and index everything again.
    const present = yield* db
      .all<{
        type: string
        name: string
      }>(
        sql`SELECT type, name FROM sqlite_master WHERE name IN ${[...SessionSearchDDL.objects.view, ...SessionSearchDDL.objects.table, ...SessionSearchDDL.objects.trigger]}`,
      )
      .pipe(Effect.orDie)
    const missing = Object.entries(SessionSearchDDL.objects).flatMap(([type, names]) =>
      names.filter((name) => !present.some((object) => object.type === type && object.name === name)),
    )
    if (missing.length > 0) {
      yield* Effect.logWarning("session search index repaired", { missing })
      const now = yield* Clock.currentTimeMillis
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* SessionSearchDDL.install((statement) => tx.run(statement))
            yield* tx.run(
              sql`DELETE FROM ${SessionSearchTable} WHERE ${SessionSearchTable.message_id} NOT IN (SELECT id FROM session_message)`,
            )
            yield* tx.run(SessionSearchDDL.seedBackfill(now))
          }),
        )
        .pipe(Effect.orDie)
    }

    const steps = SessionSearchDDL.backfillStep(BACKFILL_STEP)
    const step = db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            for (const statement of steps) yield* tx.run(statement)
            return (yield* tx.get<{ id: number }>(sql`SELECT id FROM ${SessionSearchBackfillTable}`)) !== undefined
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)

    const index: Interface["index"] = db
      .select({ processed: SessionSearchBackfillTable.processed, total: SessionSearchBackfillTable.total })
      .from(SessionSearchBackfillTable)
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) =>
          row
            ? { complete: false, processed: Math.min(row.processed, row.total), total: row.total }
            : { complete: true },
        ),
      )

    const backfill: Interface["backfill"] = Effect.gen(function* () {
      const pending = yield* index
      if (pending.complete) return
      const started = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("session search backfill started", { processed: pending.processed, total: pending.total })
      let more = true
      while (more) {
        more = yield* step
        // Each step takes the database's only connection; let waiting queries through between steps.
        yield* Effect.yieldNow
      }
      yield* Effect.logInfo("session search backfill completed", {
        total: pending.total,
        durationMs: (yield* Clock.currentTimeMillis) - started,
      })
    })

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

    const search: Interface["search"] = Effect.fn("SessionSearch.search")(function* (input) {
      const terms = SessionSearchQuery.terms(input.query)
      if (terms.length > SessionSearch.MAX_TERMS) return yield* tooManyTerms()
      const { offset, limit } = yield* page(input)
      const status = yield* index
      if (terms.length === 0) return { data: [], cursor: {}, index: status }

      const conditions = [sql`session_search_fts MATCH ${SessionSearchQuery.expression(terms)}`, ...filters(input)]

      const rows = yield* db
        .all<Row>(
          sql`
            SELECT
              ${SessionSearchTable.message_id} AS messageID,
              ${SessionSearchTable.session_id} AS sessionID,
              ${SessionSearchTable.role} AS role,
              ${SessionSearchTable.time_created} AS created,
              ${SessionTable.title} AS title,
              snippet(session_search_fts, 0, ${SessionSearchDDL.MARK_START}, ${SessionSearchDDL.MARK_END}, '…', ${SNIPPET_TOKENS}) AS snippet
            FROM session_search_fts
            JOIN ${SessionSearchTable} ON ${SessionSearchTable.id} = session_search_fts.rowid
            JOIN ${SessionTable} ON ${SessionTable.id} = ${SessionSearchTable.session_id}
            WHERE ${and(...conditions)}
            ORDER BY bm25(session_search_fts), ${SessionSearchTable.time_created} DESC, ${SessionSearchTable.id} DESC
            LIMIT ${limit + 1} OFFSET ${offset}
          `,
        )
        .pipe(Effect.orDie)

      return {
        data: rows.slice(0, limit).map((row) => ({
          sessionID: SessionSchema.ID.make(row.sessionID),
          ...(row.title ? { title: row.title } : {}),
          messageID: SessionMessage.ID.make(row.messageID),
          role: row.role,
          time: { created: DateTime.makeUnsafe(row.created) },
          snippet: SessionSearchQuery.snippet(row.snippet ?? ""),
        })),
        cursor: rows.length > limit ? { next: SessionSearch.Cursor.make(offset + limit) } : {},
        index: status,
      }
    })

    const searchSessions: Interface["searchSessions"] = Effect.fn("SessionSearch.searchSessions")(function* (input) {
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
        const rows = yield* db
          .all<{ id: string; rank: number }>(
            sql`
              SELECT sessionID AS id, MIN(rank) AS rank FROM (
                SELECT ${SessionSearchTable.session_id} AS sessionID, bm25(session_search_fts) AS rank
                FROM session_search_fts
                JOIN ${SessionSearchTable} ON ${SessionSearchTable.id} = session_search_fts.rowid
                JOIN ${SessionTable} ON ${SessionTable.id} = ${SessionSearchTable.session_id}
                WHERE session_search_fts MATCH ${SessionSearchQuery.expression([term])} AND ${where}
                LIMIT -1
              ) GROUP BY sessionID
            `,
          )
          .pipe(Effect.orDie)
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
      const messages = yield* bestMessages(
        positives,
        shown.filter((session) => session.held).map((session) => session.id),
      )

      return {
        data: shown.map((session) => {
          const message = messages.get(session.id)
          return {
            sessionID: SessionSchema.ID.make(session.id),
            ...(session.title ? { title: session.title } : {}),
            ...(message
              ? {
                  message: {
                    messageID: SessionMessage.ID.make(message.messageID),
                    role: message.role,
                    time: { created: DateTime.makeUnsafe(message.created) },
                    snippet: SessionSearchQuery.snippet(message.snippet ?? ""),
                  },
                }
              : {}),
          }
        }),
        cursor: matched.length > offset + limit ? { next: SessionSearch.Cursor.make(offset + limit) } : {},
        index: status,
      }
    })

    /** The message of each of `sessions` best matching any of `terms`, by BM25 then the newest, with its snippet. */
    const bestMessages = Effect.fnUntraced(function* (
      terms: ReadonlyArray<SessionSearchQuery.Term>,
      sessions: ReadonlyArray<string>,
    ) {
      if (terms.length === 0 || sessions.length === 0) return new Map<string, Omit<Row, "title">>()
      const match = SessionSearchQuery.anyOf(terms)
      const best = yield* db
        .all<{ id: number }>(
          sql`
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY sessionID ORDER BY rank, created DESC, id DESC) AS n FROM (
                SELECT ${SessionSearchTable.id} AS id, ${SessionSearchTable.session_id} AS sessionID,
                  ${SessionSearchTable.time_created} AS created, bm25(session_search_fts) AS rank
                FROM session_search_fts
                JOIN ${SessionSearchTable} ON ${SessionSearchTable.id} = session_search_fts.rowid
                WHERE session_search_fts MATCH ${match} AND ${SessionSearchTable.session_id} IN ${sessions}
                LIMIT -1
              )
            ) WHERE n = 1
          `,
        )
        .pipe(Effect.orDie)
      if (best.length === 0) return new Map<string, Omit<Row, "title">>()
      const rows = yield* db
        .all<Omit<Row, "title">>(
          sql`
            SELECT
              ${SessionSearchTable.message_id} AS messageID,
              ${SessionSearchTable.session_id} AS sessionID,
              ${SessionSearchTable.role} AS role,
              ${SessionSearchTable.time_created} AS created,
              snippet(session_search_fts, 0, ${SessionSearchDDL.MARK_START}, ${SessionSearchDDL.MARK_END}, '…', ${SNIPPET_TOKENS}) AS snippet
            FROM session_search_fts
            JOIN ${SessionSearchTable} ON ${SessionSearchTable.id} = session_search_fts.rowid
            WHERE session_search_fts MATCH ${match} AND session_search_fts.rowid IN ${best.map((row) => row.id)}
          `,
        )
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [row.sessionID, row]))
    })

    yield* backfill.pipe(
      Effect.catchCause((cause) => Effect.logWarning("session search backfill stopped", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ search, searchSessions, index, backfill })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
