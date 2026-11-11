import { describe, expect } from "bun:test"
import { Effect } from "effect"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** The provider compaction fixture of the upstream native compaction tests, which host these. */
export interface Harness {
  readonly it: { readonly live: (name: string, body: () => Effect.Effect<unknown, unknown, Provided>) => void }
  readonly setup: (options?: { endpoint?: boolean }) => Effect.Effect<
    {
      readonly prompt: (text: string) => Effect.Effect<unknown, unknown, unknown>
      readonly compact: Effect.Effect<unknown, unknown, unknown>
      readonly checkpoint: Effect.Effect<object, unknown, unknown>
    },
    unknown,
    unknown
  >
}

export const forkTests = ({ it, setup }: Harness) =>
  describe("native compaction (fork)", () => {
    for (const endpoint of [false, true])
      it.live(`leaves the next request's prompt unestimated after ${endpoint ? "endpoint" : "native"} compaction`, () =>
        Effect.gen(function* () {
          const fixture = yield* setup({ endpoint })
          yield* fixture.prompt("Original user")
          expect(yield* fixture.compact).toEqual({ status: "completed" })
          // An encrypted window has no locally measurable size, so the next request's prompt is left unestimated.
          expect(yield* fixture.checkpoint).not.toHaveProperty("context")
        }),
      )
  })
