import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Logger } from "effect"
import { TestClock } from "effect/testing"
import { McpRetry } from "@opencode/core/mcp/retry"
import { it } from "../lib/effect"

// Waits on real work, never on the test clock, so a retry runs only when a test moves the clock.
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 10_000
    while (!check()) {
      if (performance.now() > deadline) return yield* Effect.die(new Error("condition never became true within 10s"))
      yield* TestClock.withLive(Effect.sleep("1 millis"))
    }
  })

// Gives anything due a chance to run, before asserting that nothing did.
const settle = TestClock.withLive(Effect.sleep("20 millis"))

// The retry messages logged, with their details.
const retryLogs = () => {
  const logs: Array<readonly [string, unknown]> = []
  const logger = Logger.map(Logger.formatStructured, (entry) => {
    if (Array.isArray(entry.message) && /^mcp (reconnect|connection closed)/.test(String(entry.message[0])))
      logs.push([entry.message[0], entry.message[1]])
  })
  return { logs, layer: Logger.layer([logger]) }
}

// A retrier whose attempts record when they ran and then do what `outcome` says.
const retrier = (outcome: (attempt: number) => "failed" | "connected" | "lasting" = () => "failed") =>
  Effect.gen(function* () {
    const attempts: number[] = []
    const scope = yield* Effect.scope
    const retry: McpRetry.Retrier = McpRetry.make({
      server: "flaky",
      scope,
      attempt: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const result = outcome(attempts.length + 1)
        if (result === "connected") yield* retry.connected
        else yield* retry.failed("down", result === "failed")
        // Recorded last, so the next retry is already waiting once the test sees this one.
        attempts.push(now)
      }),
    })
    return { retry, attempts }
  })

describe("McpRetry", () => {
  it.effect("waits 2 s, 10 s, 30 s and 2 min, then every 5 min", () => {
    const captured = retryLogs()
    return Effect.gen(function* () {
      const { retry, attempts } = yield* retrier()
      yield* retry.failed("down", true)
      const delays = [2_000, 10_000, 30_000, 120_000, 300_000, 300_000, 300_000]
      for (const [index, wait] of delays.entries()) {
        yield* TestClock.adjust(wait - 1)
        yield* settle
        expect(attempts).toHaveLength(index)
        yield* TestClock.adjust(1)
        yield* until(() => attempts.length === index + 1)
      }
      expect(attempts).toEqual([2_000, 12_000, 42_000, 162_000, 462_000, 762_000, 1_062_000])
      expect(McpRetry.delay(100)).toEqual(McpRetry.delay(5))
      // One line per retry, naming the wait before the next.
      expect(captured.logs).toEqual(
        ["10s", "30s", "2m", "5m", "5m", "5m", "5m"].map((retryIn, index) => [
          "mcp reconnect failed",
          { server: "flaky", retry: index + 1, error: "down", retryIn },
        ]),
      )
    }).pipe(Effect.provide(captured.layer))
  })

  it.effect("starts the delays over once a retry connects", () => {
    const captured = retryLogs()
    return Effect.gen(function* () {
      const { retry, attempts } = yield* retrier((attempt) => (attempt === 2 ? "connected" : "failed"))
      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      yield* until(() => attempts.length === 1)
      yield* TestClock.adjust("10 seconds")
      yield* until(() => attempts.length === 2)
      yield* settle
      expect(captured.logs.at(-1)).toEqual(["mcp reconnected", { server: "flaky", retry: 2 }])

      // Connected now, so the connection closing retries after the first delay again.
      yield* retry.closed("Connection closed")
      yield* TestClock.adjust(1_999)
      yield* settle
      expect(attempts).toHaveLength(2)
      yield* TestClock.adjust(1)
      yield* until(() => attempts.length === 3)
      expect(attempts).toEqual([2_000, 12_000, 14_000])
      expect(captured.logs).toContainEqual([
        "mcp connection closed",
        { server: "flaky", reason: "Connection closed", retryIn: "2s" },
      ])
    }).pipe(Effect.provide(captured.layer))
  })

  it.effect("schedules one retry however many failures report in", () =>
    Effect.gen(function* () {
      const { retry, attempts } = yield* retrier()
      yield* retry.failed("down", true)
      yield* retry.failed("down", true)
      yield* retry.closed("Connection closed")
      yield* TestClock.adjust("2 seconds")
      yield* until(() => attempts.length === 1)
      yield* settle
      expect(attempts).toEqual([2_000])
    }),
  )

  it.effect("doesn't retry a failure that can't pass", () =>
    Effect.gen(function* () {
      const { retry, attempts } = yield* retrier((attempt) => (attempt === 1 ? "lasting" : "failed"))
      yield* retry.failed("needs a sign-in", false)
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(attempts).toEqual([])

      // Nor once a retry finds that it can't.
      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      yield* until(() => attempts.length === 1)
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(attempts).toEqual([3_602_000])
    }),
  )

  it.effect("cancels the waiting retry on reset and starts the delays over", () =>
    Effect.gen(function* () {
      const { retry, attempts } = yield* retrier()
      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      yield* until(() => attempts.length === 1)
      yield* retry.reset
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(attempts).toEqual([2_000])

      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      yield* until(() => attempts.length === 2)
      expect(attempts).toEqual([2_000, 3_604_000])
    }),
  )

  it.effect("interrupts a retry in the middle of its attempt on reset", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const retry = McpRetry.make({
        server: "stuck",
        scope: yield* Effect.scope,
        attempt: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      })
      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      yield* Deferred.await(started)
      expect(retry.retrying).toBe(true)
      yield* retry.reset
      yield* Deferred.await(interrupted)
      expect(retry.retrying).toBe(false)
    }),
  )

  it.effect("lets a retry reset from inside its own attempt", () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<boolean>()
      const retry: McpRetry.Retrier = McpRetry.make({
        server: "reentrant",
        scope: yield* Effect.scope,
        attempt: Effect.suspend(() => {
          const during = retry.retrying
          return retry.reset.pipe(Effect.andThen(Deferred.succeed(done, during)))
        }),
      })
      yield* retry.failed("down", true)
      yield* TestClock.adjust("2 seconds")
      expect(yield* Deferred.await(done)).toBe(true)
      expect(retry.retrying).toBe(false)
    }),
  )
})
