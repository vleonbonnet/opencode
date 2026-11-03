export * as SessionSearch from "./session-search.js"

import { Effect, Result, Schema, SchemaParser } from "effect"
import { Base64Url } from "effect/encoding"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

/** The most matches one page returns. */
export const MAX_LIMIT = 100
/** The matches a page returns when the request names no limit. */
export const DEFAULT_LIMIT = 20
/** The longest query accepted, in characters. */
export const MAX_QUERY_LENGTH = 512
/** The most terms (words, phrases or prefixes) one query may hold. */
export const MAX_TERMS = 32
/** The longest snippet returned, in characters. */
export const MAX_SNIPPET_LENGTH = 320

/** A match's place in a snippet: `start` inclusive, `end` exclusive, both counted in characters (code points). */
export interface Range extends Schema.Schema.Type<typeof Range> {}
export const Range = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
}).annotate({ identifier: "SessionSearch.Range" })

/** An excerpt of the matching message around its best match, on one line, with the matched words located. */
export interface Snippet extends Schema.Schema.Type<typeof Snippet> {}
export const Snippet = Schema.Struct({
  text: Schema.String,
  matches: Schema.Array(Range),
}).annotate({ identifier: "SessionSearch.Snippet" })

export const Role = Schema.Literals(["user", "assistant"]).annotate({ identifier: "SessionSearch.Role" })
export type Role = typeof Role.Type

/** One message matching a search: a user prompt or an assistant message's visible text. */
export interface Match extends Schema.Schema.Type<typeof Match> {}
export const Match = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String.pipe(optional),
  messageID: SessionMessage.ID,
  role: Role,
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
  snippet: Snippet,
}).annotate({ identifier: "SessionSearch.Match" })

/**
 * How much of the history the index covers. Messages written before the index existed are indexed in the background
 * after the server starts; until `complete`, results come only from what is indexed so far, and `processed` of
 * `total` existing messages have been looked at. New messages are indexed as they are written either way.
 */
export interface Index extends Schema.Schema.Type<typeof Index> {}
export const Index = Schema.Struct({
  complete: Schema.Boolean,
  processed: NonNegativeInt.pipe(optional),
  total: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionSearch.Index" })

const CursorJson = Schema.fromJsonString(Schema.Struct({ offset: NonNegativeInt }))
const encodeCursor = Schema.encodeSync(CursorJson)
const decodeCursor = Schema.decodeUnknownEffect(CursorJson)

export const Cursor = Schema.String.pipe(
  Schema.brand("SessionSearchCursor"),
  Schema.annotate({
    identifier: "SessionSearchCursor",
    description: "Opaque pagination cursor returned as cursor.next in the previous response for the same query.",
  }),
  statics((schema) => {
    const make = SchemaParser.make(schema)
    return {
      make: (offset: number) => make(Base64Url.encode(encodeCursor({ offset }))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Base64Url.decodeString(input)
          return Result.isFailure(result)
            ? Effect.fail("Invalid cursor" as const)
            : decodeCursor(result.success).pipe(
                Effect.map((cursor) => cursor.offset),
                Effect.mapError(() => "Invalid cursor" as const),
              )
        }),
    }
  }),
)
export type Cursor = typeof Cursor.Type

export interface Response extends Schema.Schema.Type<typeof Response> {}
export const Response = Schema.Struct({
  data: Schema.Array(Match),
  cursor: Schema.Struct({ next: Cursor.pipe(optional) }),
  index: Index,
}).annotate({ identifier: "SessionSearchResponse" })
