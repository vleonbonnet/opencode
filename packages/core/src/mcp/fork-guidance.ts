export * as ForkMcpGuidance from "./fork-guidance.js"

// MCP servers in Code Mode work like skills: the catalog gives each server one line, and its instructions reach the
// model only once the session searches or calls one of its tools.
//
// The loaded set is the session's committed `core/mcp-guidance` value: a server listed there has had its
// instructions delivered, and that value already survives restarts, carries into forks and outlives compaction. A
// server a run touches waits in `pending` only until the next instruction sync commits it.

import type { CodeMode } from "@opencode/codemode"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
import { InstructionBlobTable, InstructionStateTable } from "../session/sql.js"
import type { Tool } from "../tool.js"
import { normalizedName } from "../tool/runtime.js"

type DatabaseService = Database.Interface["db"]

const KEY = "core/mcp-guidance"
const SUMMARY_LIMIT = 200

/** One line for a server: its first sentence, cut at a word boundary past SUMMARY_LIMIT characters. */
export function summary(instructions: string | undefined) {
  const line = instructions?.trim().split("\n", 1)[0]?.trim() ?? ""
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(line)?.[1] ?? line
  if (sentence.length <= SUMMARY_LIMIT) return sentence === "" ? undefined : sentence
  const cut = sentence.slice(0, SUMMARY_LIMIT - 1)
  const space = cut.lastIndexOf(" ")
  return `${space > 0 ? cut.slice(0, space) : cut}…`
}

/** A server's catalog line: the configured `description`, else the first sentence of its instructions. */
export const describe = (configured: string | undefined, instructions: string | undefined) =>
  configured?.trim() || summary(instructions)

/** Registers a described Code Mode namespace for each server whose tools Code Mode exposes. */
export function register(
  editor: Tool.Editor,
  tools: ReadonlyArray<{ readonly server: string; readonly codemode?: boolean; readonly serverDescription?: string }>,
) {
  const described = new Map<string, string>()
  for (const tool of tools)
    if (tool.codemode !== false && tool.serverDescription !== undefined && !described.has(tool.server))
      described.set(tool.server, tool.serverDescription)
  for (const [server, description] of described)
    editor.namespace({ name: normalizedName({ name: server }), description })
}

const pending = new Map<string, Set<string>>()

const touch = (sessionID: string, namespace: string | undefined) => {
  if (namespace === undefined || namespace === "") return
  const set = pending.get(sessionID) ?? new Set<string>()
  set.add(namespace)
  pending.set(sessionID, set)
}

/** The first segment of a search result path such as `tools.reynard.open_tab` or `tools["anvil-eval"]["read"]`. */
export function namespaceOf(path: string) {
  const rest = path.startsWith("tools") ? path.slice("tools".length) : `.${path}`
  const dotted = /^\.([^.[\]]+)/.exec(rest)
  if (dotted) return dotted[1]
  const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest)
  if (!quoted) return undefined
  try {
    const value: unknown = JSON.parse(quoted[1])
    return typeof value === "string" ? value.split(".", 1)[0] : undefined
  } catch {
    return undefined
  }
}

const searchPaths = (value: unknown) => {
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item: unknown) =>
    typeof item === "object" && item !== null && "path" in item && typeof item.path === "string" ? [item.path] : [],
  )
}

/** Wraps a run's hooks so the namespaces its searches return and its calls reach count as loaded for the session. */
export function observe<R>(hooks: CodeMode.Hooks<R>, sessionID: string): CodeMode.Hooks<R> {
  const before = hooks["tool.before"]
  const after = hooks["tool.after"]
  return {
    ...hooks,
    "tool.before": (call) => {
      if (call.name !== "search") touch(sessionID, call.name.split(".", 1)[0])
      return before?.(call) ?? Effect.void
    },
    "tool.after": (call, result) => {
      if (call.name === "search" && result.status === "success")
        for (const path of searchPaths(result.value)) touch(sessionID, namespaceOf(path))
      return after?.(call, result) ?? Effect.void
    },
  }
}

/** Namespaces whose server instructions the session has loaded: committed ones, then those waiting for the next sync. */
export const loaded = Effect.fn("ForkMcpGuidance.loaded")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const committed = yield* stored(db, sessionID)
  const waiting = pending.get(sessionID)
  if (waiting) {
    for (const namespace of committed) waiting.delete(namespace)
    if (waiting.size === 0) pending.delete(sessionID)
  }
  return new Set([...committed, ...(waiting ?? [])]) as ReadonlySet<string>
})

const stored = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const state = yield* db
    .select({ current: InstructionStateTable.current_values })
    .from(InstructionStateTable)
    .where(eq(InstructionStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const hash = state?.current[KEY]
  if (hash === undefined) return []
  const blob = yield* db
    .select({ value: InstructionBlobTable.value })
    .from(InstructionBlobTable)
    .where(eq(InstructionBlobTable.hash, hash))
    .get()
    .pipe(Effect.orDie)
  const value: unknown = blob?.value
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    "server" in item &&
    typeof item.server === "string" &&
    !("codemode" in item && item.codemode === false)
      ? [normalizedName({ name: item.server })]
      : [],
  )
})

/** Whether a Code Mode server's instructions stay out of the session until it loads the server. */
export const unloaded = (loaded: ReadonlySet<string> | undefined, namespace: string) =>
  loaded !== undefined && !loaded.has(namespace)
