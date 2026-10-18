export * as SessionCache from "./session-cache.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { PromptInput } from "./prompt-input.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionMessage } from "./session-message.js"

/** A model as the prompt cache sees it: the variant only changes request fields, never where the cache lives. */
export interface ModelRef extends Schema.Schema.Type<typeof ModelRef> {}
export const ModelRef = Schema.Struct({
  id: Model.Ref.fields.id,
  providerID: Model.Ref.fields.providerID,
}).annotate({ identifier: "SessionCache.ModelRef" })

/** The next turn to predict: the prompt or command a client is about to send, with the agent and model it would use. */
export interface PreflightInput extends Schema.Schema.Type<typeof PreflightInput> {}
export const PreflightInput = Schema.Struct({
  text: Schema.String.pipe(optional),
  files: Schema.Array(PromptInput.FileAttachment).pipe(optional),
  command: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String.pipe(optional),
  }).pipe(optional),
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
}).annotate({ identifier: "SessionCache.PreflightInput" })

export const PreflightStatus = Schema.Literals(["hit", "partial", "miss", "unknown"]).annotate({
  identifier: "SessionCache.PreflightStatus",
})
export type PreflightStatus = typeof PreflightStatus.Type

/**
 * Where the next request stops sharing the previous request's prompt. `index` counts cache units (tool definitions,
 * system blocks, then message content blocks); `unit` names the unit of the next request at that index, and
 * `previousUnit` the unit of the previous request it replaces, when there was one.
 */
export interface Divergence extends Schema.Schema.Type<typeof Divergence> {}
export const Divergence = Schema.Struct({
  unit: Schema.String,
  index: NonNegativeInt,
  previousUnit: Schema.String.pipe(optional),
  excerpt: Schema.String.pipe(optional),
  previousExcerpt: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionCache.Divergence" })

/** What the next turn reuses when it is sent with `thinkingLoss: "accept"` and replays the stale blocks as text. */
export interface ConsentOutcome extends Schema.Schema.Type<typeof ConsentOutcome> {}
export const ConsentOutcome = Schema.Struct({
  reusableTokens: NonNegativeInt,
  lostTokens: NonNegativeInt,
}).annotate({ identifier: "SessionCache.ConsentOutcome" })

/**
 * Signed thinking the next request may no longer replay. A turn sent with `thinkingLoss: "ask"` fails with a
 * `thinking.stale` error, unless `reason` is {@link UNKNOWN_BINDING}: opencode does not know what those blocks were
 * bound to, sends them, and only a provider refusal fails the turn (with the same error).
 */
export interface StaleThinking extends Schema.Schema.Type<typeof StaleThinking> {}
export const StaleThinking = Schema.Struct({
  /** How many thinking blocks consent converts: the first reported block and every signed block after it. */
  count: NonNegativeInt,
  reason: Schema.String,
  /** The first cache unit where the prompt changed since the blocks were accepted, when it is known. */
  unit: Schema.String.pipe(optional),
  /** The turn's cache reuse with consent, when it could be predicted. */
  consent: ConsentOutcome.pipe(optional),
}).annotate({ identifier: "SessionCache.StaleThinking" })

/**
 * The stale-thinking reason for blocks opencode holds no binding for: a session from before the ledger, or one idle for
 * over a month. They may well still match.
 */
export const UNKNOWN_BINDING = "unknown binding"

export interface PreflightReport extends Schema.Schema.Type<typeof PreflightReport> {}
export const PreflightReport = Schema.Struct({
  status: PreflightStatus,
  /** The wire format of the next request: "anthropic", "openai-chat", "openai-responses" or "unknown". */
  format: Schema.String.pipe(optional),
  model: ModelRef.pipe(optional),
  previous: Schema.Struct({
    time: NonNegativeInt,
    promptTokens: NonNegativeInt,
    model: ModelRef,
    ageMs: NonNegativeInt,
  }).pipe(optional),
  reusableTokens: NonNegativeInt,
  reusableExact: Schema.Boolean,
  lostTokens: NonNegativeInt,
  reasons: Schema.Array(Schema.String),
  divergence: Divergence.pipe(optional),
  staleThinking: StaleThinking.pipe(optional),
  /**
   * Set (true) when a turn is running: the next request is not the one the client would send, and input sent now joins
   * that turn. The status is then "unknown"; absent otherwise.
   */
  running: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "SessionCache.PreflightReport" })

/**
 * A reasoning block left out of every later request. `messageID` and `ordinal` name it as the
 * `session.reasoning.started`/`ended` events do (`assistantMessageID`, `ordinal`): the `ordinal`-th reasoning item,
 * counting from 0, of that assistant message's content. `asText` blocks were dropped with the user's consent and replay
 * as `<earlier-reasoning>` text; the others were dropped by the provider, or left out after it rejected them, and are
 * omitted. `reason` says which, and whether anyone was asked: "dropped with consent: …", "dropped by the provider: …"
 * (the turn asked to fail instead) or "dropped by the provider without asking: …" (the turn set no `thinkingLoss`).
 */
export interface DroppedThinkingBlock extends Schema.Schema.Type<typeof DroppedThinkingBlock> {}
export const DroppedThinkingBlock = Schema.Struct({
  messageID: SessionMessage.ID,
  ordinal: NonNegativeInt,
  reason: Schema.String,
  asText: Schema.Boolean,
}).annotate({ identifier: "SessionCache.DroppedThinkingBlock" })

export interface DroppedThinking extends Schema.Schema.Type<typeof DroppedThinking> {}
export const DroppedThinking = Schema.Struct({
  ...DroppedThinkingBlock.fields,
  /** When the block was dropped, in epoch milliseconds. */
  time: NonNegativeInt,
}).annotate({ identifier: "SessionCache.DroppedThinking" })

/**
 * The prompt or command metadata key that says what the turn does with earlier signed thinking that no longer matches
 * the conversation. "ask": fail with a `thinking.stale` error before anything is sent, so the client can ask the user;
 * a block opencode could not vouch for that the provider rejects fails the turn the same way. "accept": replay those
 * blocks as `<earlier-reasoning>` text (the user consented); it covers the first Step answering the message. Absent: the
 * provider drops them and the turn proceeds; the dropped blocks are reported as `session.thinking.dropped`. Only models
 * whose requests bind thinking to the prompt are affected.
 */
export const THINKING_LOSS = "thinkingLoss"

export const ThinkingLoss = Schema.Literals(["ask", "accept"]).annotate({ identifier: "SessionCache.ThinkingLoss" })
export type ThinkingLoss = typeof ThinkingLoss.Type

/** Prompt and command metadata: client-defined keys, and the typed {@link THINKING_LOSS}. */
export const PromptMetadata = Schema.StructWithRest(Schema.Struct({ thinkingLoss: ThinkingLoss.pipe(optional) }), [
  Schema.Record(Schema.String, Schema.Unknown),
]).annotate({ identifier: "SessionCache.PromptMetadata" })
export type PromptMetadata = typeof PromptMetadata.Type

/**
 * The session error type of a turn refused because earlier signed thinking no longer matches the conversation: the
 * turn asked to fail rather than lose it (`thinkingLoss: "ask"`), or the provider rejected a block. The message says
 * what to send instead.
 */
export const STALE_THINKING_ERROR = "thinking.stale"
