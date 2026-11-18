import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator", () => {
  it.effect("settles a drain that stops itself with the reason it named, keeping its wakes", () =>
    Effect.gen(function* () {
      let runs = 0
      const reasons: Array<string | undefined> = []
      let stop: (key: string) => Effect.Effect<void> = () => Effect.void
      const coordinator = yield* SessionRunCoordinator.make<string, never, string>({
        drain: (key) => Effect.suspend(() => (++runs === 2 ? stop(key) : Effect.void)),
        settled: (_key, _exit, reason) => Effect.sync(() => void reasons.push(reason)),
      })
      // Work recorded before the stop is a new admission, not part of the stopped intent.
      stop = (key) =>
        coordinator
          .wake(key)
          .pipe(Effect.andThen(coordinator.stopReason(key, "user")), Effect.andThen(Effect.interrupt))

      // Naming a stop while idle records nothing for a later execution.
      yield* coordinator.stopReason("session", "early")
      yield* coordinator.run("session")
      const exit = yield* coordinator.run("session").pipe(Effect.exit)
      yield* coordinator.awaitIdle("session")

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(runs).toBe(3)
      expect(reasons).toEqual([undefined, "user", undefined])
    }),
  )
})
