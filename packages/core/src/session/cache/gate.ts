export * as CacheGate from "./gate.js"

// Before a primary Step is sent, the newest user message decides what happens to thinking that may no longer match
// (`thinkingLoss`). Without it nobody is asked: the request lets the provider drop such blocks ("drop_block"), as
// upstream does. "ask": when the Session has thinking bindings on record, or the provider refused a block, dry-run the
// exact request and refuse it if a block is stale; the request asks the provider to fail on whatever the check could
// not foresee ("error"). "accept": mark the stale blocks dropped and rebuild the request so they replay as text; the
// provider drops what the check could not foresee. Only models whose requests bind thinking are checked.

import { LLMClient, type LLMClientShape } from "@opencode/ai/effect"
import { Effect, Exit, Option, Stream } from "effect"
import { StepFailedError } from "../error.js"
import type { SessionMessage } from "../message.js"
import type { SessionModelRequest } from "../model-request.js"
import type { SessionSchema } from "../schema.js"
import type { CacheLedger } from "./ledger.js"
import { SessionCache } from "./service.js"
import type { CacheWire } from "./wire.js"

/** How the gate asks the runner to build a request. */
export interface Build {
  readonly dryRun: boolean
  /** Undefined where nothing is checked: the protocol default applies, as nothing could ask for consent. */
  readonly thinkingBinding?: "error" | "drop_block"
  /** How the request treats stale thinking, for the ledger; undefined where nothing is checked. */
  readonly mode?: CacheLedger.Mode
  readonly dropped: ReadonlyArray<SessionCache.Dropped>
}

/** Run a dry-run request's stream to the wire and return what it captured. Nothing is sent. */
export const capture = (llm: LLMClientShape, prepared: SessionModelRequest.Prepared<unknown>) =>
  Effect.gen(function* () {
    const exit = yield* llm.stream(prepared.request, prepared.options).pipe(Stream.runDrain, Effect.exit)
    const captured = prepared.captured?.()
    return { captured, exit } as { readonly captured?: CacheWire.Captured; readonly exit: Exit.Exit<void, unknown> }
  })

export const make = Effect.gen(function* () {
  const cache = Option.getOrUndefined(yield* Effect.serviceOption(SessionCache.Service))
  const llm = yield* LLMClient.Service

  const prepare = Effect.fn("CacheGate.prepare")(function* <P extends SessionModelRequest.Prepared<unknown>>(input: {
    readonly sessionID: SessionSchema.ID
    readonly step: number
    /** Whether the Step's model binds thinking to the prompt (`CacheModel.checksThinking`). */
    readonly checks: boolean
    /** The Step's history: its newest user message decides, and converted blocks are found in it. */
    readonly messages: ReadonlyArray<SessionMessage.Info>
    readonly dropped?: ReadonlyArray<SessionCache.Dropped>
    readonly build: (build: Build) => Effect.Effect<P>
  }) {
    if (!cache || !input.checks) return yield* input.build({ dryRun: false, dropped: input.dropped ?? [] })
    const mode = SessionCache.thinkingMode(input.messages, input.step)
    if (mode === "unasked")
      return yield* input.build({
        dryRun: false,
        thinkingBinding: "drop_block",
        mode,
        dropped: yield* cache.dropped(input.sessionID),
      })
    const accept = mode === "accept"
    const thinkingBinding = accept ? ("drop_block" as const) : ("error" as const)
    const state = yield* cache.step({ sessionID: input.sessionID, accept })
    let dropped = state.dropped
    if (state.check) {
      const dry = yield* input.build({ dryRun: true, thinkingBinding, mode, dropped })
      const run = yield* capture(llm, dry)
      if (!run.captured) {
        // The request failed before reaching the wire; sending it fails the same way and reports why.
        yield* Effect.logDebug("stale thinking check did not reach the wire", { sessionID: input.sessionID })
      } else {
        const verdict = yield* cache.consent({
          sessionID: input.sessionID,
          request: run.captured,
          accept,
          messages: input.messages,
        })
        if (verdict.type === "refused") return yield* new StepFailedError({ error: verdict.error })
        if (verdict.type === "converted") dropped = verdict.dropped
      }
    }
    return yield* input.build({ dryRun: false, thinkingBinding, mode, dropped })
  })

  /** The Session's dropped-thinking markers, for requests built outside a Step. */
  const dropped = (sessionID: SessionSchema.ID) => (cache ? cache.dropped(sessionID) : Effect.succeed([]))

  /** Forget a Step's request no usage will confirm (KEY is its assistant message). */
  const discard = (sessionID: SessionSchema.ID, key: string) =>
    cache ? cache.discard({ sessionID, key }) : Effect.void

  return { prepare, dropped, discard }
})
