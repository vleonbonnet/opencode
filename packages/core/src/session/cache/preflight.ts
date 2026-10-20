export * as SessionPreflight from "./preflight.js"

// Preflight: predict how much of the provider's prompt cache the next turn reuses, before the client sends it.
//
// The prediction is grounded in the exact request the next turn would send: the Session's selection (with the agent
// or model the turn would switch to), its history as the runner loads it, a pending instruction update, the
// hypothetical user message, and every request hook. The request is captured at the wire and never sent; nothing is
// enqueued, persisted or scheduled (hooks see `dryRun`). When earlier thinking is stale, the turn sent with consent is
// built and predicted too, since it replays those blocks as text.

import { LLMClient, Message } from "@opencode/ai"
import type { ModelRef, PreflightInput } from "@opencode/schema/session-cache"
import { Cause, Clock, DateTime, Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Command } from "../../command.js"
import { Database } from "../../database/database.js"
import { Instance } from "../../instance/service.js"
import { Instructions } from "../../instructions/index.js"
import { Plugin } from "../../plugin/service.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { AgentNotFoundError } from "../error.js"
import { SessionHistory } from "../history.js"
import { SessionInbox } from "../inbox.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionPrompt } from "../prompt.js"
import { MAX_STEPS_PROMPT } from "../runner/max-steps.js"
import { SessionRunnerModel } from "../runner/model.js"
import type { SessionSchema } from "../schema.js"
import { CacheGate } from "./gate.js"
import { CacheModel } from "./model.js"
import { SessionCache } from "./service.js"

export type Input = PreflightInput

/** The preflight names something the turn could not use: an unknown command or agent, or an unavailable model. */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("SessionPreflight.InvalidInputError", {
  field: Schema.String,
  message: Schema.String,
}) {}

/** The first line of what went wrong, for a report's reasons: never a stack trace. */
const describe = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause)
  return message.split("\n", 1)[0].trim() || "unknown error"
}

/** Predict the next turn of SESSION. Provides the Session's location itself. */
export const run = Effect.fn("SessionPreflight.run")(function* (input: {
  readonly session: SessionSchema.Info
  readonly request: Input
}) {
  const instances = yield* Instance.Service
  const cache = yield* SessionCache.Service
  return yield* predict(input).pipe(
    // A hook or request builder that breaks makes the turn unpredictable, not the preflight a server error.
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const failure = Cause.findErrorOption(cause)
      if (failure._tag === "Some") return Effect.fail(failure.value)
      return cache.unknown({
        sessionID: input.session.id,
        reason: `the next turn could not be built: ${describe(Cause.squash(cause))}`,
      })
    }),
    instances.provide(input.session),
  )
})

const predict = Effect.fn("SessionPreflight.predict")(function* (input: {
  readonly session: SessionSchema.Info
  readonly request: Input
}) {
  yield* Plugin.awaitActivation
  const cache = yield* SessionCache.Service
  const context = yield* SessionContext.Service
  const compaction = yield* SessionCompaction.Service
  const commands = yield* Command.Service
  const agents = yield* Agent.Service
  const llm = yield* LLMClient.Service
  const db = (yield* Database.Service).db
  const sessionID = input.session.id
  const request = input.request
  const unknown = (reason: string, extra?: { readonly ref?: ModelRef; readonly lostTokens?: number }) =>
    cache.unknown({ sessionID, reason, ...extra })

  // Where the turn goes: a command may switch the agent or model, or prompt a subagent session instead.
  let agent = request.agent
  let model = request.model
  if (request.command) {
    const name = request.command.name
    if (!(yield* commands.get(name)))
      return yield* new InvalidInputError({ field: "command", message: `Command not found: ${name}` })
    const target = yield* commands.target(name)
    const commandAgent = target?.agent === undefined ? undefined : yield* agents.get(Agent.ID.make(target.agent))
    if (target?.subagent === true || commandAgent?.mode === "subagent")
      return yield* unknown(
        `command ${name} prompts a new subagent session, which does not reuse this session's cache`,
        {
          lostTokens: 0,
        },
      )
    if (target?.agent !== undefined) agent = Agent.ID.make(target.agent)
    model = target?.model ?? commandAgent?.model ?? model
  }

  const selection = yield* context.select(sessionID, { agent, model }).pipe(Effect.result)
  if (selection._tag === "Failure") {
    if (
      selection.failure instanceof AgentNotFoundError &&
      request.agent !== undefined &&
      selection.failure.agent === request.agent
    )
      return yield* new InvalidInputError({ field: "agent", message: selection.failure.message })
    return yield* unknown(selection.failure.message)
  }
  const selected = selection.success
  const resolved = yield* context.resolveModel(selected.session).pipe(Effect.result)
  if (resolved._tag === "Failure") {
    if (
      resolved.failure instanceof SessionRunnerModel.ModelUnavailableError &&
      request.model !== undefined &&
      resolved.failure.providerID === request.model.providerID &&
      resolved.failure.modelID === request.model.id
    )
      return yield* new InvalidInputError({ field: "model", message: resolved.failure.message })
    return yield* unknown(`model not available: ${resolved.failure.message}`)
  }
  const resolvedModel = resolved.success
  const ref = { id: resolvedModel.ref.id, providerID: resolvedModel.ref.providerID }

  // History as the runner loads it, plus the instruction update the next Step would admit first.
  const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, resolvedModel.ref).pipe(
    Effect.result,
  )
  if (history._tag === "Failure")
    return yield* unknown(
      history.failure instanceof Instructions.InitializationBlocked
        ? `instructions cannot be loaded: ${describe(history.failure)}`
        : describe(history.failure),
      { ref },
    )

  const created = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
  const time = { created }
  const added: SessionMessage.Info[] = []
  const stored = input.session
  if (
    model !== undefined &&
    (stored.model?.providerID !== model.providerID ||
      stored.model?.id !== model.id ||
      (stored.model?.variant ?? "default") !== (model.variant ?? "default"))
  )
    added.push(
      SessionMessage.ModelSelected.make({
        id: SessionMessage.ID.create(),
        type: "model-switched",
        model,
        ...(stored.model === undefined ? {} : { previous: stored.model }),
        time,
      }),
    )
  if (agent !== undefined && agent !== stored.agent)
    added.push(
      SessionMessage.AgentSelected.make({
        id: SessionMessage.ID.create(),
        type: "agent-switched",
        agent,
        ...(stored.agent === undefined ? {} : { previous: stored.agent }),
        time,
      }),
    )
  if (history.success.instructionUpdate)
    added.push(
      SessionMessage.System.make({
        id: SessionMessage.ID.create(),
        type: "system",
        text: history.success.instructionUpdate,
        time,
      }),
    )

  // Input already waiting to steer in is delivered with this turn, ahead of it; a control item runs first.
  for (const item of yield* SessionInbox.list(db, sessionID)) {
    if (item.delivery !== "steer") continue
    if (item.type === "compaction") return yield* unknown("a pending compaction runs before the next request", { ref })
    if (item.type === "move") return yield* unknown("a pending move runs before the next request", { ref })
    if (item.type === "user")
      added.push(
        SessionMessage.User.make({
          id: item.id,
          type: "user",
          text: item.payload.text,
          files: item.payload.files,
          agents: item.payload.agents,
          skills: item.payload.skills,
          metadata: item.payload.metadata,
          time,
        }),
      )
    if (item.type === "synthetic")
      added.push(
        SessionMessage.Synthetic.make({
          id: item.id,
          type: "synthetic",
          text: item.payload.text,
          description: item.payload.description,
          metadata: item.payload.metadata,
          time,
        }),
      )
  }

  // The new message only changes the uncached tail, but it is the message the turn sends.
  const files = request.files?.length ? yield* SessionPrompt.attachments(request.files) : undefined
  added.push(
    SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: request.text ?? request.command?.arguments ?? "",
      ...(files ? { files } : {}),
      time,
    }),
  )

  const dropped = yield* cache.dropped(sessionID)
  const loaded: SessionContext.Loaded = {
    session: selected.session,
    agent: selected.agent,
    model: resolvedModel,
    initial: history.success.initial,
    messages: [...history.success.messages, ...added],
    tools: selected.tools,
    dropped,
  }
  if (yield* compaction.due(loaded))
    return yield* unknown("the context is past the compaction threshold; the next turn starts with compaction", {
      ref,
    })

  const stepLimitReached = loaded.agent.info.steps !== undefined && 1 >= loaded.agent.info.steps
  // The turn as the runner's first Step builds it, with the Session's markers or the ones consent would add.
  const dryRun = (markers: ReadonlyArray<SessionCache.Dropped>, thinkingBinding: "error" | "drop_block") =>
    Effect.gen(function* () {
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
        dropped: markers,
      })
      const prepared = yield* context.request.primary({
        session: loaded.session,
        agent: loaded.agent.id,
        model: loaded.model,
        tools: loaded.tools,
        system: transcript.system,
        messages: stepLimitReached
          ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
          : transcript.messages,
        toolChoice: stepLimitReached ? "none" : undefined,
        webSocket: "session",
        inputTokens: SessionCompaction.estimatePrompt(loaded),
        dryRun: true,
        thinkingBinding,
      })
      return yield* CacheGate.capture(llm, prepared)
    })
  const checksThinking = CacheModel.checksThinking(loaded.model.model)
  const run = yield* dryRun(dropped, "error")
  if (!run.captured)
    return yield* unknown(
      `the dry run did not reach the wire: ${run.exit._tag === "Failure" ? describe(Cause.squash(run.exit.cause)) : "its stream completed without a request"}`,
      { ref },
    )
  const report = yield* cache.predict({ sessionID, request: run.captured, ref, checksThinking })
  if (!report.staleThinking) return report

  // The consented turn replays every block from the first reported one on as text, so it shares the previous prompt
  // only up to there.
  const markers = yield* cache.consented({ sessionID, request: run.captured, messages: loaded.messages })
  const consented = markers ? yield* dryRun(markers, "drop_block") : undefined
  if (!consented?.captured) return report
  const outcome = yield* cache.predict({ sessionID, request: consented.captured, ref, checksThinking })
  return {
    ...report,
    staleThinking: {
      ...report.staleThinking,
      consent: { reusableTokens: outcome.reusableTokens, lostTokens: outcome.lostTokens },
    },
  }
})
