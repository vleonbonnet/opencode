import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Scope } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import type { SessionRunner } from "@opencode/core/session/runner/index"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** The execution harness of the upstream SessionExecution tests, which host these. */
export interface Harness {
  readonly it: { readonly effect: (name: string, body: () => Effect.Effect<unknown, unknown, Provided>) => void }
  readonly seedSessions: (
    database: Database.Service["Service"],
    sessionIDs: ReadonlyArray<Session.ID>,
  ) => Effect.Effect<void, unknown, unknown>
  readonly claims: (database: Database.Service["Service"]) => Effect.Effect<Record<string, boolean>, unknown, unknown>
  readonly buildExecution: (
    scope: Scope.Closeable,
    drain: (input: Parameters<SessionRunner.Interface["drain"]>[0]) => Effect.Effect<void, SessionRunner.RunError>,
  ) => Effect.Effect<Context.Context<SessionExecution.Service | SessionRestart.Service>, unknown, unknown>
}

export const forkTests = ({ it, seedSessions, claims, buildExecution }: Harness) =>
  describe("SessionExecution lifecycle (fork)", () => {
    it.effect("settles a declined tool call as a user stop that never resurrects", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const sessionID = Session.ID.make("ses_claim_declined")
        yield* seedSessions(database, [sessionID])

        const draining = yield* Deferred.make<void>()
        const drained: Session.ID[] = []
        const interrupted: SessionEvent.Execution.Interrupted[] = []
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        // The runner names the stop and then interrupts itself, as a declined Step does.
        const context = yield* buildExecution(scope, (input) =>
          Effect.suspend(() => {
            drained.push(input.sessionID)
            const report = input.reportDeclined ?? (() => Effect.void)
            return Deferred.succeed(draining, undefined).pipe(
              Effect.andThen(report()),
              Effect.andThen(Effect.interrupt),
            )
          }),
        )
        const execution = Context.get(context, SessionExecution.Service)
        const restart = Context.get(context, SessionRestart.Service)
        yield* bus.project(SessionEvent.Execution.Interrupted, (event) =>
          Effect.sync(() => void interrupted.push(event)),
        )

        yield* execution.resume(sessionID).pipe(Effect.forkScoped)
        yield* Deferred.await(draining)
        yield* execution.awaitIdle(sessionID)

        // A decline is the user's own stop: it settles as "user" and releases the claim, where an
        // unnamed interrupt reads as "shutdown" and holds the claim for the next server start.
        expect(interrupted.map((event) => event.data.reason)).toEqual(["user"])
        expect((yield* claims(database))[sessionID]).toBe(false)

        // The recovery sweep finds nothing left to resume.
        yield* restart.resumeSuspendedSessions
        expect(drained).toEqual([sessionID])
      }),
    )
  })
