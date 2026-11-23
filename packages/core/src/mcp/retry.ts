export * as McpRetry from "./retry.js"

import { Duration, Effect, Fiber, type Scope } from "effect"

// How long each retry of a connection that failed or closed waits, counted from the failure before it. After the
// last of these, every retry waits five minutes, for as long as the server stays configured and enabled.
const DELAYS = [Duration.seconds(2), Duration.seconds(10), Duration.seconds(30), Duration.minutes(2)]
const LAST = Duration.minutes(5)

/** How long the nth retry since the connection last connected waits, counting from 1. */
export const delay = (retry: number) => DELAYS[retry - 1] ?? LAST

/** Retries one connection until it connects, logging each retry and how it went once. */
export interface Retrier {
  /**
   * Reports an attempt that failed. A failure that may pass retries after the next delay, unless a retry is already
   * waiting; one that can't pass without a config or credential change is not retried.
   */
  readonly failed: (error: string, retryable: boolean) => Effect.Effect<void>
  /** Reports a live connection that closed on its own. It retries after the first delay. */
  readonly closed: (reason: string) => Effect.Effect<void>
  /** Reports an attempt that connected. The next failure retries after the first delay again. */
  readonly connected: Effect.Effect<void>
  /**
   * Cancels the retry that is waiting or making its attempt, unless the caller is that retry, and starts the delays
   * over. A start or stop of the connection calls it, so a manual connect, a disconnect, a config change or a
   * disposed Location leaves no retry behind.
   */
  readonly reset: Effect.Effect<void>
  /** True while a retry makes its attempt. */
  readonly retrying: boolean
}

/** For a connection that doesn't retry on its own. */
export const disabled: Retrier = {
  failed: () => Effect.void,
  closed: () => Effect.void,
  connected: Effect.void,
  reset: Effect.void,
  retrying: false,
}

export const make = (input: {
  /** Names the server in logs. */
  readonly server: string
  /** Retries run here, so closing it cancels them. */
  readonly scope: Scope.Scope
  /** Makes one attempt, which reports how it went through `failed` or `connected`. */
  readonly attempt: Effect.Effect<void>
}): Retrier => {
  interface Retry {
    readonly number: number
    fiber?: Fiber.Fiber<void>
  }
  // Retries since the connection last connected or was reset; the next one waits `delay(retries + 1)`.
  let retries = 0
  // The retry waiting out its delay, and the one making its attempt. A failing attempt schedules the next retry
  // while it still runs, so both can be set at once.
  let waiting: Retry | undefined
  let running: Retry | undefined

  const cancel = (retry: Retry | undefined) =>
    retry?.fiber && retry.fiber !== Fiber.getCurrent() ? Fiber.interrupt(retry.fiber) : Effect.void

  const schedule = Effect.suspend(() => {
    if (waiting) return Effect.void
    const retry: Retry = { number: ++retries }
    waiting = retry
    return Effect.sleep(delay(retry.number)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (waiting === retry) waiting = undefined
          running = retry
          return input.attempt
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (waiting === retry) waiting = undefined
          if (running === retry) running = undefined
        }),
      ),
      // Started at once, so the delay counts from the failure even when the caller's fiber keeps running.
      Effect.forkIn(input.scope, { startImmediately: true }),
      Effect.map((fiber) => {
        retry.fiber = fiber
      }),
    )
  })

  return {
    failed: (error, retryable) =>
      Effect.gen(function* () {
        const retry = running
        if (retry)
          yield* Effect.logWarning("mcp reconnect failed", {
            server: input.server,
            retry: retry.number,
            error,
            ...(retryable ? { retryIn: Duration.format(delay(retries + 1)) } : {}),
          })
        if (retryable) yield* schedule
      }),
    closed: (reason) =>
      Effect.suspend(() => {
        retries = 0
        return Effect.logWarning("mcp connection closed", {
          server: input.server,
          reason,
          retryIn: Duration.format(delay(1)),
        }).pipe(Effect.andThen(schedule))
      }),
    connected: Effect.suspend(() => {
      const retry = running
      retries = 0
      return retry ? Effect.logInfo("mcp reconnected", { server: input.server, retry: retry.number }) : Effect.void
    }),
    reset: Effect.suspend(() => {
      const pending = [waiting, running]
      retries = 0
      waiting = undefined
      running = undefined
      return Effect.forEach(pending, cancel, { discard: true })
    }),
    get retrying() {
      return running !== undefined
    },
  }
}
