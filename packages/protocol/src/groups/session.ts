import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Session } from "@opencode/schema/session"
import { SessionStats } from "@opencode/schema/session-stats"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Money } from "@opencode/schema/money"
import { InstructionEntry } from "@opencode/schema/instruction-entry"
import { Project } from "@opencode/schema/project"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt } from "@opencode/schema/schema"
import { Event } from "@opencode/schema/event"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import { Context, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/http-api"
import {
  ConflictError,
  LocationNotFoundError,
  CommandExecutionError,
  CommandNotFoundError,
  FormAlreadySettledError,
  FormInvalidAnswerError,
  FormNotFoundError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
  SkillNotFoundError,
  UnknownError,
} from "../errors.js"
import { Agent } from "@opencode/schema/agent"
import { Skill } from "@opencode/schema/skill"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { Location } from "@opencode/schema/location"
import { SessionEvent } from "@opencode/schema/session-event"
import { EventLog } from "@opencode/schema/event-log"
import { FileDiff } from "@opencode/schema/file-diff"
import { Form } from "@opencode/schema/form"
import { PublicSessionMessage } from "./message.js"

import { SessionCache } from "@opencode/schema/session-cache"
import { SessionSearch } from "@opencode/schema/session-search"

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const PublicSessionInfo = Schema.Struct({
  ...Struct.omit(Session.Info.fields, ["location"]),
  location: Location.PublicRef,
}).annotate({ identifier: "Session.Info" })

const PublicSessionTransfer = Schema.Struct({
  info: PublicSessionInfo,
  messages: Schema.Array(PublicSessionMessage),
}).annotate({ identifier: "SessionTransfer.Data" })

const PublicMovePayload = Schema.Struct({
  ...Struct.omit(SessionInbox.MovePayload.fields, ["location"]),
  location: Location.PublicRef,
}).annotate({ identifier: "Session.Inbox.MovePayload" })

const PublicMove = Schema.Struct({
  ...Struct.omit(SessionInbox.Move.fields, ["payload"]),
  payload: PublicMovePayload,
}).annotate({ identifier: "Session.Inbox.Move" })

const PublicInboxInfo = Schema.Union([
  SessionInbox.User,
  SessionInbox.Synthetic,
  SessionInbox.Compaction,
  PublicMove,
]).annotate({ identifier: "Session.Inbox.Info" })

/** Experimental: the `session.inbox.list` response for clients that opt into `experimental-media-uri`. */
export const SessionMediaInboxResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Union([SessionInbox.MediaUser, SessionInbox.Synthetic, SessionInbox.Compaction, PublicMove]).annotate({
      identifier: "Session.Inbox.MediaInfo",
    }),
  ),
})

// Transcripts exported before v2.1 carry older names for native data. The wire stays plain JSON so any export file
// is accepted; decoding upgrades those names and then validates the current message shape.
const ImportedMessages = Schema.Array(Schema.Json).pipe(
  Schema.decodeTo(Schema.Array(Schema.Unknown), {
    decode: SchemaGetter.transform(SessionLegacy.messages),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
  Schema.decodeTo(Schema.Array(PublicSessionMessage), {
    decode: SchemaGetter.passthrough({ strict: false }),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const FormCreatePayload = Schema.Struct({
  id: Form.ID.pipe(Schema.optional),
  title: Form.Info.fields.title,
  metadata: Form.Info.fields.metadata,
  fields: Form.Info.fields.fields,
}).annotate({ identifier: "Form.CreatePayload" })

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

// Kept so existing imports of SessionsCursor from Protocol keep working.
export const SessionsCursor = Session.ListCursor
export type SessionsCursor = Session.ListCursor

export const SessionsQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  ...Session.ListFilter.fields,
  search: Session.ListFilter.fields.search.annotateKey({
    description: "Only sessions whose title contains this text, ignoring case. % and _ act as wildcards.",
  }),
  archived: Session.ListFilter.fields.archived.annotateKey({
    description:
      "Filter by archive state. Use true to return only archived sessions or false to exclude them. Omit to include both.",
  }),
  directory: Session.ListFilter.fields.directory.annotateKey({
    description: "Only sessions whose directory is exactly this absolute path.",
  }),
  subpath: Session.ListFilter.fields.subpath.annotateKey({
    description: "With project, only sessions at this path relative to the project directory.",
  }),
  cursor: Session.ListCursor.pipe(Schema.optional).annotateKey({
    description:
      "Opaque cursor from a previous page's cursor.next or cursor.previous. It carries that page's filters and order, so other filters are ignored.",
  }),
}).annotate({ identifier: "SessionsQuery" })

export const SessionSearchQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SessionSearch.MAX_QUERY_LENGTH)).annotate({
    description:
      "The words to find. Whitespace separates words, double quotes group a phrase, and a word ending in * matches as a prefix (at least two characters before it). Every term must match; nothing else is query syntax. Words match ignoring case, diacritics and English inflections.",
  }),
  limit: Schema.NumberFromString.pipe(
    Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(SessionSearch.MAX_LIMIT))),
    Schema.optional,
  ).annotate({
    description: `Maximum number of matches to return, at most ${SessionSearch.MAX_LIMIT}. Defaults to ${SessionSearch.DEFAULT_LIMIT}.`,
  }),
  archived: Session.ListFilter.fields.archived,
  parentID: Session.ListFilter.fields.parentID,
  directory: Session.ListFilter.fields.directory,
  project: Session.ListFilter.fields.project,
  cursor: SessionSearch.Cursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionSearchQuery" })

export const SessionSearchSessionsQuery = Schema.Struct({
  ...SessionSearchQuery.fields,
  q: SessionSearchQuery.fields.q.annotate({
    description:
      "What the sessions must hold. Terms are read as session.search reads them: words, double-quoted phrases and prefixes ending in *. Terms side by side must all match, OR (in capitals) between them matches either, a leading - excludes the term or parenthesized group after it, and parentheses group. A term holds when any one message of the session matches it.",
  }),
  limit: SessionSearchQuery.fields.limit.annotate({
    description: `Maximum number of sessions to return, at most ${SessionSearch.MAX_LIMIT}. Defaults to ${SessionSearch.DEFAULT_LIMIT}.`,
  }),
}).annotate({ identifier: "SessionSearchSessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S, FormI extends HttpApiMiddleware.AnyId, FormS>(
  sessionLocationMiddleware: Context.Key<I, S>,
  formLocationMiddleware: Context.Key<FormI, FormS>,
) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(PublicSessionInfo),
          cursor: Schema.Struct({
            previous: Session.ListCursor.pipe(Schema.optional),
            next: Session.ListCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.stats", "/api/experimental/session/stats", {
        query: Schema.Struct({
          from: Schema.NumberFromString.pipe(Schema.optional).annotateKey({
            description:
              "Start of the range in Unix milliseconds, inclusive. Defaults to the earliest recorded message.",
          }),
          to: Schema.NumberFromString.pipe(Schema.optional).annotateKey({
            description: "End of the range in Unix milliseconds, exclusive. Defaults to now.",
          }),
          project: Project.ID.pipe(Schema.optional),
          timezone: Schema.String.pipe(Schema.optional).annotateKey({
            description: "IANA time zone used to group activity by day. Defaults to UTC.",
          }),
          tools: SessionStats.ToolMode.pipe(Schema.optional).annotateKey({
            description:
              "How much tool usage to report: none, summary totals, or per-tool detail. Defaults to summary.",
          }),
        }),
        success: Schema.Struct({ data: SessionStats.Info }),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.stats",
          summary: "Get session statistics",
          description: "Aggregate local session activity, usage, and tool reliability for a time range.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional).annotate({
            description: "If a session with this ID already exists, it is returned unchanged, so retries are safe.",
          }),
          parentID: Session.ID.pipe(Schema.optional).annotate({
            description:
              'Creates a child session at the parent\'s location. Each time the child finishes running, it sends its last reply to the parent as a `<background-result kind="subagent">` message and wakes the parent, unless the parent has a staged revert.',
          }),
          title: Schema.String.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.PublicRef.pipe(Schema.optional).annotate({
            description: "Defaults to the server's working directory. Ignored when parentID is set.",
          }),
          metadata: Session.Metadata.pipe(Schema.optional).annotate({
            description: "Opaque to OpenCode. Child sessions inherit the parent's metadata unless you pass your own.",
          }),
          permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
            description:
              "Applied on top of the agent's rules. Child sessions inherit the parent's rules unless you pass your own.",
          }),
        }),
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.create",
          summary: "Create session",
          description:
            "Create a session at the requested location. A parentID creates a linked child session at its parent's location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.import", "/api/experimental/session/import", {
        payload: Schema.Struct({
          info: PublicSessionTransfer.fields.info,
          messages: ImportedMessages,
          location: Location.PublicRef.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.import",
          summary: "Import session",
          description:
            "Import a projected session transcript at the requested location. Accepts transcripts exported by earlier releases. If parentID is supplied, the parent session must already exist; import parents before children.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.export", "/api/experimental/session/:sessionID/export", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          sanitize: BooleanFromString.pipe(Schema.optional).annotateKey({
            description: "Set to true to redact titles, message text, file data, paths and metadata from the export.",
          }),
        }),
        success: Schema.Struct({ data: PublicSessionTransfer }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.export",
          summary: "Export session",
          description: "Export a complete projected session transcript.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.active",
          summary: "List active sessions",
          description:
            "List the sessions whose agent is running right now in this server process. Sessions missing from the result are idle.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.cache", "/api/experimental/session/cache", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionCache.Expiry) }).annotate({
          identifier: "SessionCacheResponse",
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.cache",
          summary: "List prompt-cache expiries",
          description:
            "The provider prompt-cache entry holding each session's own conversation, while it is within its retention window as the cache ledger knows it: the entry at the tip of the session's last request (its last cache breakpoint, or for formats that cache every prefix automatically its full prompt), which a next turn extending that request reuses for the whole conversation. Shorter prefixes such as the system prompt and tools, which other sessions share and keep warm, do not count: once the tip expired the session is absent, even if its next turn would still reuse such a prefix. expires is when the entry leaves the window and ttl the window's length (both in milliseconds; expires is epoch time), tokens the prompt tokens the entry covers, promptTokens those of the session's last request (tokens / promptTokens is the cached share). session.cache.updated carries a session's new value each time a confirmed provider response changes it: each step of the session, and any request (a keep-alive generation, a fork reading its parent's tip) that refreshed or evicted the session's tip entry. Nothing is published when an entry expires in time. A preflight reports what a given next turn reuses, shared prefixes included.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.search", "/api/experimental/session/search", {
        query: SessionSearchQuery,
        success: SessionSearch.Response,
        error: [InvalidCursorError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.search",
          summary: "Search session messages",
          description: `Full-text search over user prompts and the visible text of finished assistant messages (not tool calls, tool output or reasoning) across sessions. Words match ignoring case, diacritics and English inflections, so run also finds running. Each match names its session and message, with a one-line snippet of at most ${SessionSearch.MAX_SNIPPET_LENGTH} characters whose matches are located by character offsets. Matches are ranked by relevance (BM25), newer first among equal ranks; use cursor.next for the following page. Filters narrow the sessions searched as session.list's do. Messages written before the index existed are indexed in the background after the server starts: until index.complete, results come only from the messages indexed so far, and index.processed of index.total says how far it is. A 503 means this server's SQLite cannot hold the index.`,
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.searchSessions", "/api/experimental/session/search/sessions", {
        query: SessionSearchSessionsQuery,
        success: SessionSearch.SessionsResponse,
        error: [InvalidCursorError, InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.searchSessions",
          summary: "Search whole sessions",
          description: `Finds the sessions whose messages, taken together, match a query of terms combined by AND, OR, exclusion and parentheses: a term holds when any one of the session's messages matches it, searching what session.search searches. Each session comes once, with its message best matching the terms it holds and that message's snippet; a session matching only by what it lacks has none. Sessions are ranked by the sum of each held term's best relevance (BM25), then the most recently updated; use cursor.next for the following page. Filters narrow the sessions searched as session.list's do, and the index catches up with older messages as for session.search, which it shares.`,
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.get",
          summary: "Get session",
          description: "Retrieve a session by ID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.remove", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.remove",
          summary: "Delete session",
          description: "Delete a session and its child sessions.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.fork", "/api/session/:sessionID/fork", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ before: SessionMessage.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: [SessionNotFoundError, MessageNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.fork",
          summary: "Fork session",
          description:
            "Create a child session with this session's history before a message. Omit before to copy the full history.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.switchAgent",
          summary: "Switch session agent",
          description: "Change the agent the session uses from its next model call on.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.switchModel",
          summary: "Switch session model",
          description: "Change the model the session uses from its next model call on.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("session.update", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          title: Schema.String.pipe(Schema.optional),
          metadata: Session.Metadata.pipe(Schema.optional),
          permissions: Permission.Ruleset.pipe(Schema.optional),
          archived: Schema.Boolean.pipe(Schema.optional).annotate({
            description:
              "Archive the session with true or restore it with false. Repeating the current state is a no-op.",
          }),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, LocationNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.update",
          summary: "Update session",
          description: "Update mutable session properties.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.move", "/api/session/:sessionID/move", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ ...Location.PublicRef.fields, delivery: SessionInbox.Delivery.pipe(Schema.optional) }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.move",
          summary: "Move session",
          description: "Move a session to another project directory at the requested delivery boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional).annotate({
            description:
              "Sending the same ID again returns the original item instead of adding a second one, so retries are safe. Reusing it in another session or for another kind of item fails with 409.",
          }),
          ...PromptInput.Prompt.fields,
          metadata: SessionCache.PromptMetadata.pipe(optional).annotateKey({
            description:
              "Stored on the message. The model doesn't see it. Its thinkingLoss decides what the turn does with stale thinking.",
          }),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional).annotate({
            description:
              "false adds the message to the inbox without starting the agent; it is delivered the next time the session runs.",
          }),
        }),
        success: Schema.Struct({ data: SessionInbox.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description:
              "Send a user message and start the agent unless resume is false. Returns once the message is queued, not when the agent finishes: wait with experimental.session.wait or the session.execution.* events, then read the reply with session.message.list.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          name: Schema.String,
          ...PromptInput.Prompt.fields,
          text: PromptInput.Prompt.fields.text.annotate({
            description: "The command's arguments.",
          }),
          metadata: SessionCache.PromptMetadata.pipe(optional).annotateKey({
            description: "Forwarded to the prompt the command sends, as the prompt route's metadata.",
          }),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, CommandNotFoundError, CommandExecutionError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Run command",
            description:
              "Run a named command in the session. Most commands send a prompt, so like session.prompt this returns before the agent finishes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.preflight", "/api/experimental/session/:sessionID/preflight", {
        params: { sessionID: Session.ID },
        payload: SessionCache.PreflightInput,
        success: Schema.Struct({ data: SessionCache.PreflightReport }).annotate({
          identifier: "SessionPreflightResponse",
        }),
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.preflight",
            summary: "Preflight the next turn",
            description:
              "Predict how much of the provider's prompt cache the next turn reuses, and whether earlier signed thinking no longer matches the conversation, by dry-running the exact request it would send: the selected or given agent and model, the history, any pending instruction update, and a message built from text, files or a command. Nothing is enqueued, persisted or sent. While a turn runs the report is unknown. When staleThinking is present, a turn sent with metadata.thinkingLoss 'ask' fails with a thinking.stale error (unless its reason is 'unknown binding': those blocks are sent, and only a provider refusal fails the turn); with 'accept' it drops them (replaying them as text when staleThinking.asText is not false), as staleThinking.consent predicts; without thinkingLoss the provider drops them. previous.expires and previous.ttl describe the entry a turn extending the previous request reuses: its longest prefix with a live entry, shared prefixes (the system prompt and tools other sessions keep warm) included, unlike experimental.session.cache, which counts only the entry of the session's own conversation. An unknown command or agent, or an unavailable model, is a 400.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.thinking", "/api/experimental/session/:sessionID/thinking", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          data: Schema.Struct({ dropped: Schema.Array(SessionCache.DroppedThinking) }),
        }).annotate({ identifier: "SessionThinkingResponse" }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.thinking",
          summary: "List dropped thinking",
          description:
            "Reasoning blocks that later requests leave out, oldest first. messageID and ordinal name a block as the session.reasoning events do: the ordinal-th reasoning item, from 0, of that assistant message's content. asText blocks were dropped with the user's consent and replay as <earlier-reasoning> text; the others were dropped by the provider and are omitted. reason says which, and whether anyone was asked: it starts with 'dropped with consent', 'dropped by the provider without asking' (the turn set no thinkingLoss) or 'dropped by the provider'.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.skill", "/api/experimental/session/:sessionID/skill", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Skill.ID,
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SkillNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.skill",
            summary: "Activate skill",
            description: "Activate a skill for a session by appending a skill message and resuming execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.synthetic", "/api/session/:sessionID/synthetic", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional).annotate({
            description:
              "Sending the same ID again returns the original item instead of adding a second one, so retries are safe. Reusing it in another session or for another kind of item fails with 409.",
          }),
          text: Schema.String,
          description: Schema.String.pipe(Schema.optional).annotate({
            description: "Short label shown in the transcript instead of the full text.",
          }),
          metadata: Schema.Record(Schema.String, Schema.Unknown)
            .annotate({
              description: "Stored on the message. The model doesn't see it.",
            })
            .pipe(optional),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional).annotate({
            description:
              "false adds the message to the inbox without starting the agent; it is delivered the next time the session runs.",
          }),
        }),
        success: Schema.Struct({ data: SessionInbox.Synthetic }),
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.synthetic",
          summary: "Add synthetic message",
          description:
            "Add a message the model reads as user input but the user didn't type, such as a notification. Starts the agent unless resume is false or the session has a staged revert.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          command: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description:
              "Execute one shell command in the session's working directory. Emits a shell.started event before execution and a shell.ended event with the merged output after.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.Compaction }),
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.compact",
          summary: "Compact session",
          description:
            "Queue a summary of the session's history. Steers by default: it runs before the next model call, ahead of queued messages.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/experimental/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.wait",
          summary: "Wait for session",
          description:
            "Wait until the session's agent stops running in this server process. Returns at once when idle. Experimental: may change without compatibility guarantees.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Session.Revert }),
        error: [MessageNotFoundError, SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.revert.clear", "/api/session/:sessionID/revert", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.revert.commit", summary: "Commit staged revert" })),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(PublicSessionMessage) }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.context",
          summary: "Get session context",
          description: "Retrieve the active context messages for a session (all messages after the last compaction).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.diff", "/api/session/:sessionID/diff", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          from: Schema.optional(SessionMessage.ID).annotate({
            description: "User message whose turn to diff. Defaults to the turn of the newest user message.",
          }),
          to: Schema.optional(SessionMessage.ID).annotate({
            description: "Later user message whose turn ends the range. Defaults to the turn of `from` alone.",
          }),
          context: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional).annotate({
            description: "Unchanged lines around each hunk. Omit for full-file patches.",
          }),
        }),
        success: Schema.Struct({ data: Schema.Array(FileDiff.Info) }),
        error: [InvalidRequestError, MessageNotFoundError, SessionNotFoundError, UnknownError, LocationNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.diff",
          summary: "Diff session turns",
          description:
            "Structured per-file diffs of the files a turn changed. A turn runs from the first prompt after the session was last idle until its next idle marker, so prompts steered in while it was busy belong to the same turn; `to` extends the range through a later turn. Compares the range's first recorded snapshot with its last; a step still running in the active session compares against the working copy. Ranges that span a location change are rejected. In sessions without any idle marker, a prompt's turn spans until the next user message.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.inbox.list", "/api/session/:sessionID/inbox", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(PublicInboxInfo) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.list",
          summary: "List session inbox",
          description:
            "List user, synthetic, compaction and move items not yet delivered to the agent, oldest first. Delivered user and synthetic items move to session.message.list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.inbox.cancel", "/api/session/:sessionID/inbox/:inboxID", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.cancel",
          summary: "Cancel inbox input",
          description: "Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("session.inbox.update", "/api/session/:sessionID/inbox/:inboxID", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        payload: Schema.Struct({ delivery: SessionInbox.Delivery }),
        success: HttpApiSchema.NoContent,
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.update",
          summary: "Update inbox item",
          description: "Change a pending inbox item's delivery mode. Steering wakes session execution.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get(
        "session.instructions.entry.list",
        "/api/experimental/session/:sessionID/instructions/entries",
        {
          params: { sessionID: Session.ID },
          success: Schema.Struct({ data: Schema.Array(InstructionEntry.Info) }),
          error: SessionNotFoundError,
        },
      ).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.instructions.entry.list",
          summary: "List instruction entries",
          description: "List API-managed instruction entries attached to the session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.put(
        "session.instructions.entry.put",
        "/api/experimental/session/:sessionID/instructions/entries/:key",
        {
          params: { sessionID: Session.ID, key: InstructionEntry.Key },
          payload: Schema.Struct({ value: Schema.Json }),
          success: HttpApiSchema.NoContent,
          error: [SessionNotFoundError, InstructionEntry.ValueTooLargeError],
        },
      ).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.instructions.entry.put",
          summary: "Put instruction entry",
          description:
            "Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete(
        "session.instructions.entry.remove",
        "/api/experimental/session/:sessionID/instructions/entries/:key",
        {
          params: { sessionID: Session.ID, key: InstructionEntry.Key },
          success: HttpApiSchema.NoContent,
          error: SessionNotFoundError,
        },
      ).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.instructions.entry.remove",
          summary: "Remove instruction entry",
          description: "Remove one instruction entry; the removal is announced to the model at the next step boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.generate", "/api/session/:sessionID/generate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ prompt: Schema.String }),
        success: Schema.Struct({
          // Same `tokens` and `cost` an assistant message reports for a step.
          data: Schema.Struct({ text: Schema.String, tokens: TokenUsage.Info, cost: Money.USD }),
        }).annotate({ identifier: "SessionGenerateResponse" }),
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.generate",
            summary: "Generate text from session context",
            description:
              "Generate transient text from the current session context without mutating session history. Its tokens and cost count toward the session's totals.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.log", "/api/experimental/session/:sessionID/log", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(Event.Seq), Schema.optional).annotateKey({
            description: "Only return events after this sequence number.",
          }),
          follow: BooleanFromString.pipe(Schema.optional).annotateKey({
            description: "Set to true to keep the stream open and send live events after the stored ones.",
          }),
        },
        success: HttpApiSchema.StreamSse({
          data: Schema.Union([SessionEvent.Durable, EventLog.Synced]).annotate({ identifier: "SessionLogItem" }),
        }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.log",
          summary: "Read the session log",
          description:
            "Experimental durable session event log. Reads events after an exclusive aggregate sequence and continues with live events when follow=true.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        query: {
          resume: BooleanFromString.pipe(Schema.optional).annotateKey({
            description:
              "Set to true to resume pending steering input and next-in-line control items after interrupting.",
          }),
        },
        success: Schema.Struct({
          interrupted: Schema.Boolean.annotate({
            description: "Whether an active execution owned by this OpenCode process was interrupted.",
          }),
        }).annotate({ identifier: "SessionInterruptResponse" }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.interrupt",
          summary: "Interrupt session execution",
          description:
            "Stop the session's agent if it is running in this server process; interrupted=false means nothing was running. With resume=true it continues with pending steer items, compaction and moves, while queued messages keep waiting.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.background", "/api/session/:sessionID/background", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.background",
          summary: "Background blocking session tools",
          description:
            "Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: PublicSessionMessage }),
        error: [SessionNotFoundError, MessageNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message.get",
          summary: "Get session message",
          description: "Retrieve one message of the session by ID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.form.list", "/api/session/:sessionID/form", {
        params: { sessionID: Schema.String },
        success: Schema.Struct({ data: Schema.Array(Form.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.list",
            summary: "List session forms",
            description: "Retrieve pending forms for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.form.create", "/api/session/:sessionID/form", {
        params: { sessionID: Schema.String },
        payload: FormCreatePayload,
        success: Schema.Struct({ data: Form.Info }),
        error: [SessionNotFoundError, ConflictError, InvalidRequestError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.create",
            summary: "Create session form",
            description: "Create a form for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.form.get", "/api/session/:sessionID/form/:formID", {
        params: { sessionID: Schema.String, formID: Form.ID },
        success: Schema.Struct({ data: Form.Detail }),
        error: [SessionNotFoundError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.get",
            summary: "Get session form",
            description: "Retrieve a form and its current state for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.form.reply", "/api/session/:sessionID/form/:formID/reply", {
        params: { sessionID: Schema.String, formID: Form.ID },
        payload: Form.Reply,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, FormAlreadySettledError, FormInvalidAnswerError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.reply",
            summary: "Reply to form",
            description: "Submit an answer to a pending form.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.form.cancel", "/api/session/:sessionID/form/:formID", {
        params: { sessionID: Schema.String, formID: Form.ID },
        query: Schema.Struct({
          message: Schema.optional(Schema.String).annotateKey({
            description: "Why the form was not answered, passed on to the asker.",
          }),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, FormAlreadySettledError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.cancel",
            summary: "Cancel form",
            description: "Cancel a pending form, optionally telling the asker why it was not answered.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.environment", "/api/session/:sessionID/environment", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ variables: Schema.Record(Schema.String, Schema.String) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.environment",
          summary: "Set session environment",
          description: "Replace the process environment used by local shell commands for this session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.view", "/api/session/:sessionID/view", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ idle: DateTimeUtcFromMillis }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.view",
          summary: "View session",
          description: "Mark the idle transition observed by the viewer as viewed.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session",
        description: "Experimental session routes.",
      }),
    )
