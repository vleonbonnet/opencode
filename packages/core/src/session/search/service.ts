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
      }>(sql`SELECT type, name FROM sqlite_master WHERE name IN ${[...SessionSearchDDL.objects.view, ...SessionSearchDDL.objects.table, ...SessionSearchDDL.objects.trigger]}`)
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

    const search: Interface["search"] = Effect.fn("SessionSearch.search")(function* (input) {
      const terms = SessionSearchQuery.terms(input.query)
      if (terms.length > SessionSearch.MAX_TERMS)
        return yield* new InvalidQueryError({
          message: `A search query may hold at most ${SessionSearch.MAX_TERMS} terms`,
        })
      const offset =
        input.cursor === undefined
          ? 0
          : yield* SessionSearch.Cursor.parse(input.cursor).pipe(Effect.mapError(() => new InvalidCursorError()))
      const limit = Math.min(Math.max(1, input.limit ?? SessionSearch.DEFAULT_LIMIT), SessionSearch.MAX_LIMIT)
      const status = yield* index
      if (terms.length === 0) return { data: [], cursor: {}, index: status }

      const conditions: SQL[] = [sql`session_search_fts MATCH ${SessionSearchQuery.expression(terms)}`]
      if (input.directory !== undefined) conditions.push(eq(SessionTable.directory, input.directory))
      if (input.project !== undefined) conditions.push(eq(SessionTable.project_id, input.project))
      if (input.parentID !== undefined)
        conditions.push(
          input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
        )
      if (input.archived !== undefined)
        conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))

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

    yield* backfill.pipe(
      Effect.catchCause((cause) => Effect.logWarning("session search backfill stopped", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ search, index, backfill })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
