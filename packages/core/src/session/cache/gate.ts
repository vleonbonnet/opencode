export * as CacheGate from "./gate.js"

// Before a primary Step is sent, the newest user message decides what happens to thinking that may no longer match
// (`thinkingLoss`). Without it nobody is asked: the request lets the provider drop such blocks ("drop_block"), as
// upstream does. "ask": when the Session has thinking bindings on record, or the provider refused a block, dry-run the
// exact request and refuse it if a block is stale; the request asks the provider to fail on whatever the check could
// not foresee ("error"). "accept": mark the stale blocks dropped and rebuild the request so they replay as text; the
// provider drops what the check could not foresee. Only models whose requests bind thinking are checked.
//
// The runner builds each request as upstream does; `build` names what it adds. A dry run goes through `consent`, and
// the runner builds again with the consent it returns.

import { AIError, LLMClient, type LLMClientShape, type LLMRequest } from "@opencode/ai/effect"
import type { StreamOptions } from "@opencode/ai/route"
import { STALE_THINKING_ERROR } from "@opencode/schema/session-cache"
import { Effect, Exit, Option, Stream } from "effect"
import { StepFailedError } from "../error.js"
import type { SessionMessage } from "../message.js"
import type { SessionRunnerModel } from "../runner/model.js"
import type { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { CacheLedger } from "./ledger.js"
import { CacheModel } from "./model.js"
import { SessionCache } from "./service.js"
import type { CacheWire } from "./wire.js"

/** How a Step's request treats stale thinking, once decided. */
export interface Consent {
  readonly thinkingBinding: "error" | "drop_block"
  /** Who decided, for the ledger's dropped-thinking markers. */
  readonly mode: CacheLedger.Mode
  readonly dropped: ReadonlyArray<SessionCache.Dropped>
}

/** A request the gate asks the runner to build: the one to send, or a dry run to check first. */
export interface Build {
  readonly dryRun: boolean
  /** The dropped-thinking markers the transcript applies. */
  readonly dropped: ReadonlyArray<SessionCache.Dropped>
  /** What the build adds to the model request. */
  readonly request: {
    readonly dryRun?: boolean
    readonly capture?: CacheWire.Capture
    /** Undefined where nothing is checked: the protocol default applies, as nothing could ask for consent. */
    readonly thinkingBinding?: "error" | "drop_block"
    readonly thinkingMode?: CacheLedger.Mode
    readonly cacheKey: string
  }
  /** For a dry run, the consent the check starts from. */
  readonly pending?: Consent
}

/** Run a dry-run request's stream to the wire and return what it left in CAPTURE. Nothing is sent. */
export const capture = (
  llm: LLMClientShape,
  prepared: { readonly request: LLMRequest; readonly options: StreamOptions },
  holder: CacheWire.Capture,
) =>
  Effect.gen(function* () {
    const exit = yield* llm.stream(prepared.request, prepared.options).pipe(Stream.runDrain, Effect.exit)
    return { captured: holder.request, exit } as {
      readonly captured?: CacheWire.Captured
      readonly exit: Exit.Exit<void, unknown>
    }
  })

/**
 * A Step attempt whose thinking block the provider refused fails as stale thinking: the error a turn that asked first
 * is refused with, with the same way out. The Step's own failure keeps the provider's words.
 */
export const refusing =
  <I extends { readonly model: SessionRunnerModel.Resolved }, A, E, R>(attempt: (input: I) => Effect.Effect<A, E, R>) =>
  (input: I) =>
    attempt(input).pipe(
      Effect.catchIf(
        (error): error is E & AIError =>
          error instanceof AIError && CacheLedger.isThinkingRefusal(toSessionError(error).message),
        (error) =>
          new StepFailedError({
            error: {
              type: STALE_THINKING_ERROR,
              message: CacheLedger.refusalMessage(
                toSessionError(error).message,
                !CacheModel.isClaudeModel(input.model.model.id),
              ),
            },
          }),
      ),
    )

export const make = Effect.gen(function* () {
  const cache = Option.getOrUndefined(yield* Effect.serviceOption(SessionCache.Service))
  const llm = yield* LLMClient.Service

  /** What the runner builds next for a Step: CONSENT once decided, else what the newest user message asks for. */
  const build = Effect.fn("CacheGate.build")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly step: number
    /** Whether the Step's model binds thinking to the prompt (`CacheModel.checksThinking`). */
    readonly checks: boolean
    /** The Step's history: its newest user message decides. */
    readonly messages: ReadonlyArray<SessionMessage.Info>
    readonly dropped?: ReadonlyArray<SessionCache.Dropped>
    readonly consent?: Consent
    /** Correlates the request with the usage that confirms it (the Step's assistant message). */
    readonly cacheKey: string
  }) {
    const send = (consent?: Consent): Build => ({
      dryRun: false,
      dropped: consent?.dropped ?? input.dropped ?? [],
      request: {
        ...(consent ? { thinkingBinding: consent.thinkingBinding, thinkingMode: consent.mode } : {}),
        cacheKey: input.cacheKey,
      },
    })
    if (input.consent) return send(input.consent)
    if (!cache || !input.checks) return send()
    const mode = SessionCache.thinkingMode(input.messages, input.step)
    if (mode === "unasked")
      return send({ thinkingBinding: "drop_block", mode, dropped: yield* cache.dropped(input.sessionID) })
    const accept = mode === "accept"
    const pending: Consent = {
      thinkingBinding: accept ? "drop_block" : "error",
      mode,
      dropped: [],
    }
    const state = yield* cache.step({ sessionID: input.sessionID, accept })
    if (!state.check) return send({ ...pending, dropped: state.dropped })
    return {
      dryRun: true,
      dropped: state.dropped,
      request: {
        dryRun: true,
        capture: {},
        thinkingBinding: pending.thinkingBinding,
        thinkingMode: mode,
        cacheKey: input.cacheKey,
      },
      pending: { ...pending, dropped: state.dropped },
    } satisfies Build
  })

  /** Check a dry run's request against the Session's thinking: refuse the Step, or decide what it sends. */
  const consent = Effect.fn("CacheGate.consent")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly build: Build
    readonly prepared: { readonly request: LLMRequest; readonly options: StreamOptions }
    /** The Step's history, in which converted blocks are found. */
    readonly messages: ReadonlyArray<SessionMessage.Info>
  }) {
    const pending = input.build.pending
    if (!pending) return yield* Effect.die("CacheGate.consent needs a dry run's build")
    const run = yield* capture(llm, input.prepared, input.build.request.capture ?? {})
    if (!cache || !run.captured) {
      // The request failed before reaching the wire; sending it fails the same way and reports why.
      yield* Effect.logDebug("stale thinking check did not reach the wire", { sessionID: input.sessionID })
      return pending
    }
    const verdict = yield* cache.consent({
      sessionID: input.sessionID,
      request: run.captured,
      accept: pending.mode === "accept",
      messages: input.messages,
    })
    if (verdict.type === "refused") return yield* new StepFailedError({ error: verdict.error })
    return verdict.type === "converted" ? { ...pending, dropped: verdict.dropped } : pending
  })

  /** The Session's dropped-thinking markers, for requests built outside a Step. */
  const dropped = (sessionID: SessionSchema.ID) => (cache ? cache.dropped(sessionID) : Effect.succeed([]))

  /** Forget a Step's request no usage will confirm (KEY is its assistant message). */
  const discard = (sessionID: SessionSchema.ID, key: string) =>
    cache ? cache.discard({ sessionID, key }) : Effect.void

  return { build, consent, dropped, discard }
})
