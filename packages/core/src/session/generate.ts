export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { LLMClient, Message, type AIError } from "@opencode/ai/effect"
import { Effect, Option } from "effect"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionCache } from "./cache/service.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionMessage } from "./message.js"
import { SessionUsage } from "./usage.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const cache = Option.getOrUndefined(yield* Effect.serviceOption(SessionCache.Service))
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session)
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
      dropped: cache ? yield* cache.dropped(selection.session.id) : [],
    })
    // Keep-alive generations share the Session's prefix: their usage refreshes what the ledger knows is cached, and
    // nothing else. They choose nothing about stale thinking (the provider drops it), so the Session's thinking state
    // is left to its own turns.
    const cacheKey = SessionMessage.ID.create()
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(input.prompt),
      ],
      cacheKey,
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(
      ModelRetry.retry,
      // A generation that fails is never confirmed.
      Effect.onError(() => (cache ? cache.discard({ sessionID: selection.session.id, key: cacheKey }) : Effect.void)),
    )
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    if (cache) {
      const tokens = SessionUsage.tokens(response.usage)
      yield* cache.confirm({
        sessionID: selection.session.id,
        key: cacheKey,
        usage: { input: tokens.input, read: tokens.cache.read, write: tokens.cache.write },
      })
    }
    return response.text
  }).pipe(instances.provide(input.session))
})
