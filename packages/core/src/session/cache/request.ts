export * as CacheRequest from "./request.js"

// How the fork shapes a model request beyond upstream's: the one-hour prompt cache of a root Session's Claude turns,
// and the summarized display of Claude's adaptive thinking.

import type { CachePolicyObject, LanguageModel, LLMRequest } from "@opencode/ai/effect"
import { AnthropicMessages, BedrockConverse } from "@opencode/ai/protocols"
import { BedrockCache } from "@opencode/ai/protocols/utils/bedrock-cache"
import { claudeVersion } from "@opencode/ai/protocols/utils/claude-model"
import { mergeJsonRecords, mergeProviderOptions, mergeTransport } from "@opencode/ai/route"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import type { Model } from "../../model.js"
import type { SessionSchema } from "../schema.js"
import type { CacheLedger } from "./ledger.js"
import { CacheModel } from "./model.js"
import type { SessionCache } from "./service.js"
import { CacheWire } from "./wire.js"

// The auto placement (last tool, first and last system parts, conversation tail) with a one-hour TTL.
const ONE_HOUR_CACHE: CachePolicyObject = { tools: true, system: true, messages: { tail: 1 }, ttl: "1h" }

// Vercel's gateway wraps the Anthropic Messages protocol under its own protocol ID.
const speaksAnthropicMessages = (model: LanguageModel) =>
  model.route.protocol === AnthropicMessages.protocol.id || model.route.id === "vercel-ai-gateway-messages"

// Bedrock caches some older Claude releases for five minutes only, and the oldest not at all.
const takesOneHour = (model: LanguageModel) => {
  if (!model.id.includes("anthropic.claude-")) return true
  const bedrock = BedrockCache.breakpoints(model)
  return bedrock.supported && bedrock.ttl1h
}

/**
 * Claude prompt caches behind Anthropic Messages (Anthropic, GitHub Copilot, Vertex, Bedrock Mantle and the Anthropic
 * gateways) honour a one-hour TTL, so a short break no longer re-sends the whole conversation. A one-hour write costs
 * 2x base input instead of 1.25x, which pays off only for a root Session's own turns: auxiliary requests and child
 * Sessions run once or back to back, so their entries rarely sit five idle minutes before a reuse. Other models on the
 * protocol keep the default TTL their endpoints are known to take.
 */
export const cachePolicy = (
  model: LanguageModel,
  kind: SessionRequestKind,
  session: SessionSchema.Info,
): CachePolicyObject | undefined =>
  kind === "primary" &&
  session.parentID === undefined &&
  speaksAnthropicMessages(model) &&
  /claude/i.test(model.id) &&
  takesOneHour(model)
    ? ONE_HOUR_CACHE
    : undefined

/** The cache policy of a request: a TTL configured for the model is the user's choice; otherwise `cachePolicy`'s. */
export const cache = (
  model: { readonly cache?: { readonly ttl?: CachePolicyObject["ttl"] }; readonly model: LanguageModel },
  kind: SessionRequestKind,
  session: SessionSchema.Info,
): CachePolicyObject | undefined =>
  model.cache?.ttl !== undefined ? { ttl: model.cache.ttl } : cachePolicy(model.model, kind, session)

const SUMMARIZED = { display: "summarized" } as const

const record = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// Claude 5 and later think adaptively when a request leaves thinking out.
const thinksByDefault = (model: LanguageModel) => (claudeVersion(model.id)?.major ?? 0) >= 5

const withOptions = (request: LLMRequest, thinking: Record<string, unknown>) => ({
  ...request,
  providerOptions: mergeProviderOptions(request.providerOptions, { thinking }),
})

const withBody = (request: LLMRequest, body: Record<string, unknown>) => ({
  ...request,
  http: { ...request.http, body: mergeJsonRecords(request.http?.body, body) },
})

/**
 * Adaptive thinking returns every thinking block empty unless the request asks to show it, since Claude 4.7 and later
 * default `display` to "omitted". A Claude request on Anthropic Messages, or on Bedrock Converse, which takes the same
 * thinking object in `additionalModelRequestFields`, that thinks adaptively without choosing a display asks for the
 * summarized text, as v1 did. That includes a Claude 5 request that leaves thinking out, as it thinks adaptively. The
 * summary is display only, and every request kind gets the same thinking, so none changes the prefix the others cache.
 */
export const summarizedThinking = (request: LLMRequest): LLMRequest => {
  const model = request.model
  if (!/claude/i.test(model.id)) return request
  const options = mergeProviderOptions(model.options?.providerOptions, request.providerOptions)
  const body = mergeTransport(model.options, request).http?.body
  if (model.route.protocol === AnthropicMessages.protocol.id) {
    // The body overlays the thinking the options lower to, field by field.
    const overlaid = record(body?.thinking)
    const thinking = mergeJsonRecords(record(options?.thinking), overlaid)
    if (thinking === undefined)
      return thinksByDefault(model) ? withOptions(request, { type: "adaptive", ...SUMMARIZED }) : request
    if (thinking.type !== "adaptive" || thinking.display !== undefined) return request
    return overlaid?.type === undefined ? withOptions(request, SUMMARIZED) : withBody(request, { thinking: SUMMARIZED })
  }
  if (model.route.protocol === BedrockConverse.protocol.id) {
    // Converse options spell only a manual budget; adaptive thinking reaches it through the body.
    const overlaid = record(record(body?.additionalModelRequestFields)?.thinking)
    const type = overlaid?.type ?? (options?.thinking === undefined ? undefined : "enabled")
    if (type === undefined)
      return thinksByDefault(model)
        ? withBody(request, { additionalModelRequestFields: { thinking: { type: "adaptive", ...SUMMARIZED } } })
        : request
    if (type !== "adaptive" || overlaid?.display !== undefined) return request
    return withBody(request, { additionalModelRequestFields: { thinking: SUMMARIZED } })
  }
  return request
}

/** A request's wire tap: a dry run captures the request, and a sent primary or generate request enters the ledger. */
export const wire = (input: {
  readonly request: LLMRequest
  readonly credential?: string
  readonly kind: SessionRequestKind
  readonly session: SessionSchema.Info
  readonly model: { readonly ref: Model.Ref; readonly model: LanguageModel }
  readonly cache: SessionCache.Interface | undefined
  readonly input: {
    readonly dryRun?: boolean
    readonly capture?: CacheWire.Capture
    readonly cacheKey?: string
    readonly thinkingMode?: CacheLedger.Mode
  }
}) =>
  CacheWire.make({
    request: input.request,
    credential: input.credential,
    mode: input.input.dryRun
      ? { type: "dryrun", capture: input.input.capture }
      : {
          type: "send",
          sent:
            input.cache && input.input.cacheKey !== undefined && (input.kind === "primary" || input.kind === "generate")
              ? input.cache.sent({
                  sessionID: input.session.id,
                  ref: input.model.ref,
                  key: input.input.cacheKey,
                  snapshot: input.kind === "primary",
                  ...(input.input.thinkingMode !== undefined && CacheModel.checksThinking(input.model.model)
                    ? { mode: input.input.thinkingMode }
                    : {}),
                })
              : undefined,
        },
  })
