import os from "os"
import { Effect, Option, Schema } from "effect"
import { Process } from "@/util/process"

/**
 * The process holding a question's pending request.  A request lives only in
 * the memory of the process that asked it, while every process opened on the
 * same directory (a server, but also short-lived CLI commands) shares the
 * database, so the owner is persisted on the question's tool part.
 */
export const Owner = Schema.Struct({
  pid: Schema.Number,
  /** Process start, in epoch milliseconds, to tell a reused PID apart. */
  start: Schema.Number,
  host: Schema.String,
})
export type Owner = typeof Owner.Type

// `ps` reports elapsed times truncated to the second.
const START_TOLERANCE_MS = 3_000
const PROBE_TIMEOUT_MS = 5_000

/** This process, as recorded on the questions it asks. */
export const current: Owner = {
  pid: process.pid,
  start: Math.round(Date.now() - process.uptime() * 1000),
  host: os.hostname(),
}

const decodeOwner = Schema.decodeUnknownOption(Owner)

/** The owner recorded in tool part METADATA, if any. */
export function fromMetadata(metadata: unknown): Owner | undefined {
  if (typeof metadata !== "object" || metadata === null || !("owner" in metadata)) return undefined
  return Option.getOrUndefined(decodeOwner(metadata.owner))
}

const sameStart = (a: number, b: number) => Math.abs(a - b) <= START_TOLERANCE_MS

/** Whether OWNER is this very process. */
export function isCurrent(owner: Owner) {
  return owner.host === current.host && owner.pid === current.pid && sameStart(owner.start, current.start)
}

type Liveness = "alive" | "dead" | "foreign"

/** Probe PID with signal 0: delivered to our own processes, refused for other users'. */
function signal(pid: number): Liveness {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "ESRCH") return "dead"
    // Another user's process: the PID was reused, an opencode of ours cannot hold it.
    if (code === "EPERM") return "foreign"
    return "alive"
  }
}

/** Start time of live process PID in epoch milliseconds, or undefined when unknown. */
async function startOf(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    const out = await Process.text(
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ],
      { nothrow: true, timeout: PROBE_TIMEOUT_MS },
    )
    const value = Number(out.text.trim())
    return out.code === 0 && Number.isFinite(value) && value > 0 ? value : undefined
  }
  // Elapsed time rather than `lstart`, whose wall-clock rendering depends on the time zone.
  const now = Date.now()
  const out = await Process.text(["ps", "-o", "etime=", "-p", String(pid)], {
    nothrow: true,
    timeout: PROBE_TIMEOUT_MS,
  })
  const elapsed = out.code === 0 ? parseElapsed(out.text) : undefined
  return elapsed === undefined ? undefined : now - elapsed
}

/** Milliseconds in a POSIX `ps` elapsed time, `[[dd-]hh:]mm:ss`. */
export function parseElapsed(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!match) return undefined
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * Whether a question asked by OWNER has lost its pending request, so that
 * re-asking it cannot compete with a live one.  A question without a
 * recorded owner predates ownership tracking and is orphaned.  Our own
 * process counts as orphaned: recovery only runs while bootstrapping an
 * instance, and the instance that asked the question has been torn down.
 * Doubt counts as alive, since stealing a live question loses its answer.
 */
export const orphaned = Effect.fn("QuestionOwner.orphaned")(function* (owner: Owner | undefined) {
  if (!owner) return true
  if (isCurrent(owner)) return true
  if (owner.host !== current.host) return false
  const liveness = signal(owner.pid)
  if (liveness !== "alive") return true
  const start = yield* Effect.promise(() => startOf(owner.pid).catch(() => undefined))
  return start !== undefined && !sameStart(start, owner.start)
})

export * as QuestionOwner from "./owner"
