export * as SystemBaseline from "./system-baseline"

import { eq } from "drizzle-orm"
import { Effect, Option, Schema, type Types } from "effect"
import { ulid } from "ulid"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Database } from "@opencode-ai/core/database/database"
import { SessionSystemBaselineTable } from "@opencode-ai/core/database/system-baseline.sql"
import { Instruction } from "./instruction"
import { PartID, type MessageID, type SessionID } from "./schema"

// A session freezes the dynamic sections of its system prompt, the way the v2
// runner's context epoch does (core/src/session/context-epoch.ts): every
// request repeats the frozen sections, and a change on disk reaches the model
// as a synthetic part stored on the next user message. Re-rendering them for
// every request changed the system prompt whenever an AGENTS.md was edited,
// which discarded the prompt cache and invalidated every earlier thinking
// signature of the session. The frozen sections are rebuilt only after a
// compaction, which discards both anyway.

const Entry = Schema.Struct({ source: Schema.String, content: Schema.String })

/** The dynamic system prompt sections, each as sent today. */
export const Sections = Schema.Struct({
  environment: Schema.Array(Schema.String),
  instructions: Schema.Array(Entry),
  mcp: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
})
export type Sections = typeof Sections.Type

/** What an update part carries in its metadata, under METADATA_KEY. */
export const Update = Schema.Struct({
  /** The baseline generation the update extends. */
  generation: Schema.String,
  /** The new value of each section that changed. */
  sections: Schema.Struct({
    environment: Schema.optional(Sections.fields.environment),
    instructions: Schema.optional(Sections.fields.instructions),
    mcp: Schema.optional(Sections.fields.mcp),
    skills: Schema.optional(Sections.fields.skills),
  }),
  /** One line per change, for clients. */
  changes: Schema.Array(Schema.String),
})
export type Update = typeof Update.Type

export const METADATA_KEY = "systemBaseline"

const decodeSections = Schema.decodeUnknownOption(Sections)
const decodeUpdate = Schema.decodeUnknownOption(Update)

type DB = Database.Interface["db"]

type Baseline = {
  readonly generation: string
  readonly sections: Sections
  readonly compaction: MessageID | undefined
}

/** The system prompt parts SECTIONS render, in the order they have always been sent. */
export function render(sections: Sections) {
  return [
    ...sections.environment,
    ...sections.instructions.map(Instruction.render),
    ...sections.mcp,
    ...sections.skills,
  ]
}

/**
 * The system prompt for the next request of a session, and its history as the
 * model sees it. At a turn boundary (USER has no answer yet), sections that
 * changed since the baseline and its updates are delivered as a synthetic part
 * on USER, through STORE. Without PERSIST (preflight and other dry runs)
 * nothing is written: the result is what the real request would send.
 */
export const prepare = Effect.fn("SystemBaseline.prepare")(function* (input: {
  db: DB
  sessionID: SessionID
  messages: SessionV1.WithParts[]
  user: SessionV1.User
  /** Render the sections from their current sources. */
  observe: Effect.Effect<Sections>
  store: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>
  persist: boolean
}) {
  const stored = yield* load(input.db, input.sessionID)
  const compaction = latestCompaction(input.messages)
  if (!stored || stored.compaction !== compaction) {
    // A new session, or the first request after a compaction (or a revert
    // across one): the conversation is re-sent uncached anyway.
    const baseline = { generation: ulid(), sections: yield* input.observe, compaction }
    if (input.persist) yield* save(input.db, input.sessionID, baseline)
    return { system: render(baseline.sections), messages: current(input.messages, baseline.generation) }
  }
  const messages = current(input.messages, stored.generation)
  const system = render(stored.sections)
  // Mid-turn, the model keeps the context the turn started with: an update
  // part on an already-sent message would change the cached prefix.
  const answered = messages.some((msg) => msg.info.role === "assistant" && msg.info.parentID === input.user.id)
  if (answered) return { system, messages }
  const update = diff(effective(stored, messages), yield* input.observe)
  if (!update) return { system, messages }
  const target = messages.find((msg) => msg.info.id === input.user.id)
  if (!target) return { system, messages }
  const part: SessionV1.TextPart = {
    id: PartID.ascending(),
    messageID: input.user.id,
    sessionID: input.sessionID,
    type: "text",
    text: update.text,
    synthetic: true,
    metadata: {
      [METADATA_KEY]: {
        generation: stored.generation,
        sections: update.sections,
        changes: update.changes,
      } satisfies Update,
    },
  }
  target.parts.push(input.persist ? yield* input.store(part) : part)
  return { system, messages }
})

/**
 * Give session TO the baseline of session FROM, which it was forked from:
 * MESSAGES maps FROM's message IDs to the copies made for TO. Nothing is
 * copied when the baseline was built after a compaction the fork left out;
 * the fork then builds its own.
 */
export const copy = Effect.fn("SystemBaseline.copy")(function* (
  db: DB,
  input: { from: SessionID; to: SessionID; messages: ReadonlyMap<string, MessageID> },
) {
  const stored = yield* load(db, input.from)
  if (!stored) return
  const compaction = stored.compaction ? input.messages.get(stored.compaction) : undefined
  if (stored.compaction && !compaction) return
  yield* save(db, input.to, { ...stored, compaction })
})

const load = Effect.fnUntraced(function* (db: DB, sessionID: SessionID) {
  const row = yield* db
    .select()
    .from(SessionSystemBaselineTable)
    .where(eq(SessionSystemBaselineTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  // A baseline this code cannot read is rebuilt, like a missing one.
  return Option.match(decodeSections(row.sections), {
    onNone: () => undefined,
    onSome: (sections): Baseline => ({
      generation: row.generation,
      sections,
      compaction: row.compaction_id ?? undefined,
    }),
  })
})

const save = Effect.fnUntraced(function* (db: DB, sessionID: SessionID, baseline: Baseline) {
  const values = {
    generation: baseline.generation,
    sections: baseline.sections,
    compaction_id: baseline.compaction ?? null,
  }
  yield* db
    .insert(SessionSystemBaselineTable)
    .values({ session_id: sessionID, ...values })
    .onConflictDoUpdate({ target: SessionSystemBaselineTable.session_id, set: values })
    .run()
    .pipe(Effect.orDie)
})

/** The update an update part carries, if PART is one. */
export function updateOf(part: SessionV1.Part) {
  if (part.type !== "text" || !part.synthetic) return
  const value = part.metadata?.[METADATA_KEY]
  if (value === undefined) return
  return Option.getOrUndefined(decodeUpdate(value))
}

/** The completed compaction the history starts from, if any. */
function latestCompaction(messages: SessionV1.WithParts[]) {
  const summarized = new Set(
    messages.flatMap((msg) =>
      msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error
        ? [msg.info.parentID]
        : [],
    ),
  )
  return messages
    .filter(
      (msg) =>
        msg.info.role === "user" && summarized.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"),
    )
    .map((msg) => msg.info.id)
    .toSorted()
    .at(-1)
}

/**
 * MESSAGES without the update parts of earlier generations: the baseline that
 * replaced them already holds their content, and replaying them after it
 * would override it with older text.
 */
function current(messages: SessionV1.WithParts[], generation: string) {
  return messages.map((msg) => {
    const parts = msg.parts.filter((part) => {
      const update = updateOf(part)
      return !update || update.generation === generation
    })
    return parts.length === msg.parts.length ? msg : { ...msg, parts }
  })
}

/** The sections the model was last told about: the baseline with every update of its generation applied. */
function effective(baseline: Baseline, messages: SessionV1.WithParts[]): Sections {
  return messages
    .flatMap((msg) => msg.parts)
    .flatMap((part) => {
      const update = updateOf(part)
      return update && update.generation === baseline.generation ? [{ id: part.id, update }] : []
    })
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .reduce((sections, item) => ({ ...sections, ...item.update.sections }), baseline.sections)
}

/** The update telling the model about the sections that changed from BEFORE to AFTER, if any. */
function diff(before: Sections, after: Sections) {
  const sections: Types.Mutable<Update["sections"]> = {}
  const texts: string[] = []
  const changes: string[] = []

  const previous = new Map(before.instructions.map((entry) => [entry.source, entry.content]))
  const next = new Set(after.instructions.map((entry) => entry.source))
  const changed = after.instructions.filter((entry) => previous.get(entry.source) !== entry.content)
  const removed = before.instructions.filter((entry) => !next.has(entry.source))
  if (changed.length > 0 || removed.length > 0) {
    sections.instructions = after.instructions
    for (const entry of changed) {
      const known = previous.has(entry.source)
      texts.push(
        known
          ? `Instructions from: ${entry.source} (replaces the earlier version)\n${entry.content}`
          : Instruction.render(entry),
      )
      changes.push(`${known ? "updated" : "added"} instructions: ${entry.source}`)
    }
    for (const entry of removed) {
      texts.push(`The instructions from ${entry.source} no longer apply.`)
      changes.push(`removed instructions: ${entry.source}`)
    }
  }

  if (!same(before.environment, after.environment)) {
    sections.environment = after.environment
    texts.push(`The environment information is now:\n${after.environment.join("\n")}`)
    changes.push("environment")
  }
  if (!same(before.mcp, after.mcp)) {
    sections.mcp = after.mcp
    texts.push(
      after.mcp.length > 0
        ? `The MCP server instructions are now:\n${after.mcp.join("\n")}`
        : "The earlier MCP server instructions no longer apply.",
    )
    changes.push("MCP server instructions")
  }
  if (!same(before.skills, after.skills)) {
    sections.skills = after.skills
    texts.push(
      after.skills.length > 0
        ? `The available skills are now:\n${after.skills.join("\n")}`
        : "No skills are available any more.",
    )
    changes.push("skills")
  }

  if (texts.length === 0) return
  return {
    sections,
    changes,
    text: [
      "<system-reminder>",
      "Part of your system prompt changed during this conversation. What follows replaces the corresponding part of the system prompt, and of any earlier update like this one.",
      "",
      texts.join("\n\n"),
      "</system-reminder>",
    ].join("\n"),
  }
}

function same(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}
