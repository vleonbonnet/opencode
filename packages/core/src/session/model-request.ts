export * as SessionModelRequest from "./model-request.js"

import {
  type CachePolicyObject,
  GenerationOptions,
  type GenerationOptionsFields,
  HttpOptions,
  LanguageModel,
  LLM,
  LLMRequest,
  type Media,
  Message,
  mergeHttpOptions,
  mergeJsonRecords,
  mergeProviderOptions,
  SystemPart,
} from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols/anthropic-messages"
import { BedrockConverse } from "@opencode/ai/protocols/bedrock-converse"
import { BedrockCache } from "@opencode/ai/protocols/utils/bedrock-cache"
import { claudeVersion } from "@opencode/ai/protocols/utils/claude-model"
import type { StreamOptions } from "@opencode/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Content } from "@opencode/schema/tool"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { ToolUserStop } from "../tool/user-stop.js"
import { Tool } from "../tool.js"
import { SessionAffinity } from "./affinity.js"
import type { CacheLedger } from "./cache/ledger.js"
import { CacheModel } from "./cache/model.js"
import { SessionCache } from "./cache/service.js"
import { CacheWire } from "./cache/wire.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { toLLMMessages, type DroppedReasoning } from "./runner/to-llm-message.js"
import type { SessionMessage } from "./message.js"

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024 // 25 MiB
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024 // 15 MiB
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"
const GENERATION_KEYS = new Set(Object.keys(GenerationOptions.fields))
// Used when the catalog has no output limit for the model.
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
const OUTPUT_TOKEN_MAX = 256_000
// Prompt text is estimated at about 4 characters per token, which can run low on dense text such as code.
const ESTIMATE_ERROR = 0.15
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
const OUTPUT_TOKEN_MIN = 1_024

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
  /** A dry run's request as it reached the wire, once its stream has run. */
  readonly captured?: () => CacheWire.Captured | undefined
}

export interface Input {
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  readonly messages: Array<Message>
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
  /** Build the request without sending it: hooks are told, and the wire captures it instead of any network I/O. */
  readonly dryRun?: boolean
  /** What a provider that binds thinking to the prompt does with replayed thinking whose prompt changed. */
  readonly thinkingBinding?: "error" | "drop_block"
  /** Why it does so (who was asked), for the prompt-cache ledger's dropped-thinking markers. */
  readonly thinkingMode?: CacheLedger.Mode
  /** Correlates the request with the usage that confirms it in the prompt-cache ledger (the Step's assistant message). */
  readonly cacheKey?: string
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
export const outputLimit = (limit: Model.Info["limit"], inputTokens?: Input["inputTokens"]) => {
  const requested = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  if (inputTokens === undefined || limit.context <= 0) return requested
  const room = limit.context - inputTokens.measured - Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  /** Reasoning that later requests leave out or replay as text (the Session's dropped-thinking markers). */
  readonly dropped?: ReadonlyArray<DroppedReasoning>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    system: [
      input.agent.system
        ? input.agent.system
        : SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name)),
      input.initial,
    ]
      .filter((part) => part.length > 0)
      .map(SystemPart.make),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey, { dropped: input.dropped }),
  }
}

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  const modality = mimeToModality(mime)
  if (!modality) return
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  if (!unsupported) return
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return Buffer.byteLength(media.source.data)
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined; bytes: () => number }) => string | undefined,
) =>
  messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "media") {
        const text = replace({ mime: part.media.mediaType, name: part.filename, bytes: () => mediaBytes(part.media) })
        return text === undefined ? part : Message.text(text)
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return part
      const result = part.result
      const value = result.value.map((item): Content => {
        if (item.type !== "file") return item
        const text = replace({ mime: item.mime, name: item.name, bytes: () => Buffer.byteLength(item.uri) })
        return text === undefined ? item : { type: "text", text }
      })
      return value.every((item, index) => item === result.value[index])
        ? part
        : { ...part, result: { ...result, value } }
    })
    return content.every((part, index) => part === message.content[index])
      ? message
      : new Message({ ...message, content })
  })

export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

export const boundImages = (messages: LLMRequest["messages"]) => {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
  const sizes = messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type === "media") return isImage(part.media.mediaType) ? [mediaBytes(part.media)] : []
      if (part.type !== "tool-result" || part.result.type !== "content") return []
      return part.result.value.flatMap((item: Content) =>
        item.type === "file" && isImage(item.mime) ? [Buffer.byteLength(item.uri)] : [],
      )
    }),
  )
  // Replay the images in order, dropping the oldest down to the target whenever the kept payload passes the trigger.
  // A new image then moves the cut only every (trigger - target) bytes instead of on every request, so the replaced
  // prefix, and with it the provider's prompt cache, stays the same between cuts.
  let cut = 0
  let kept = 0
  for (const size of sizes) {
    kept += size
    if (kept <= IMAGE_BYTES_TRIGGER) continue
    while (kept > IMAGE_BYTES_TARGET) kept -= sizes[cut++]!
  }
  if (cut === 0) return messages

  let index = 0
  return replaceMedia(messages, (media) => {
    if (!isImage(media.mime)) return
    return index++ < cut ? IMAGE_REMOVED : undefined
  })
}

// The auto placement (last tool, first and last system parts, conversation tail) with a one-hour TTL.
const ONE_HOUR_CACHE: CachePolicyObject = { tools: true, system: true, messages: { tail: 1 }, ttlSeconds: 3600 }

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

const SUMMARIZED = { display: "summarized" } as const

const record = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// Claude 5 and later think adaptively when a request leaves thinking out.
const thinksByDefault = (model: LanguageModel) => (claudeVersion(model.id)?.major ?? 0) >= 5

const withOptions = (request: LLMRequest, thinking: Record<string, unknown>) =>
  LLMRequest.update(request, { providerOptions: mergeProviderOptions(request.providerOptions, { thinking }) })

const withBody = (request: LLMRequest, body: Record<string, unknown>) =>
  LLMRequest.update(request, { http: mergeHttpOptions(request.http, new HttpOptions({ body })) })

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
  const options = mergeProviderOptions(
    model.route.defaults.providerOptions,
    model.defaults?.providerOptions,
    request.providerOptions,
  )
  const body = mergeHttpOptions(model.route.defaults.http, model.defaults?.http, request.http)?.body
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

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    const cache = Option.getOrUndefined(yield* Effect.serviceOption(SessionCache.Service))
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind }
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      // Definitions are shared across steps and sessions, and hooks may edit schemas in place,
      // so each hook gets a deep copy.
      const given = new Map(
        tools.definitions.map(
          (t) => [{ description: t.description, input: JSON.parse(JSON.stringify(t.inputSchema)) }, t] as const,
        ),
      )
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      const shaped = yield* shape(
        {
          sessionID: session.id,
          model: model.ref,
          system: input.system,
          messages: input.messages,
          options:
            kind === "primary" || kind === "compaction"
              ? { maxTokens: outputLimit(model.limit, input.inputTokens) }
              : {},
        },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const affinity = SessionAffinity.get(session)
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": affinity,
            "X-Session-Id": affinity,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": affinity,
            "x-opencode-client": app.name,
          },
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        cache: cachePolicy(model.model, kind, session),
        system: shaped.system,
        messages: boundImages(unsupportedParts(shaped.messages, model.capabilities, model.model.provider)),
        tools: Array.from(hooked, ([name, t]) => ({ ...t, name })),
        toolChoice: input.toolChoice,
        generation: Object.keys(generation).length === 0 ? undefined : generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
        // Only where opencode can check the binding itself; elsewhere the protocol default stays.
        ...(input.thinkingBinding !== undefined && CacheModel.checksThinking(model.model)
          ? { thinkingPrefixMismatch: input.thinkingBinding }
          : {}),
      })

      const baseURL = base.model.route.endpoint.baseURL
      // Hooks see a dry run, so they can skip work only a sent request needs (minting a token, metering).
      const dryRun = input.dryRun ? { dryRun: true } : {}
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        ...dryRun,
        baseURL,
        headers: { ...base.http?.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = summarizedThinking(
        LLMRequest.update(base, {
          model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
          http: new HttpOptions({
            ...base.http,
            headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
          }),
        }),
      )
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const before = yield* hooks.trigger("session", "http.request", {
                ...scope,
                ...dryRun,
                request: yield* HttpClientRequest.toWeb(req),
              })
              let sent = HttpClientRequest.fromWeb(before.request)
              if (before.request.body)
                sent = HttpClientRequest.bodyUint8Array(
                  sent,
                  new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                  before.request.headers.get("content-type") ?? undefined,
                )
              const res = yield* handler(sent)
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            })
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                send: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.send", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined

      // Installed whether or not plugins hook HTTP, and after their hooks: the prompt-cache ledger accounts for what
      // reaches the wire, and a dry run is captured there instead of sent.
      const wire = CacheWire.make({
        request,
        credential: model.credential,
        mode: input.dryRun
          ? { type: "dryrun" }
          : {
              type: "send",
              sent:
                cache && input.cacheKey !== undefined && (kind === "primary" || kind === "generate")
                  ? cache.sent({
                      sessionID: session.id,
                      ref: model.ref,
                      key: input.cacheKey,
                      snapshot: kind === "primary",
                      ...(input.thinkingMode !== undefined && CacheModel.checksThinking(model.model)
                        ? { mode: input.thinkingMode }
                        : {}),
                    })
                  : undefined,
            },
      })

      return {
        event: shaped,
        request,
        options: wire.options({ http, webSocket }),
        ...(input.dryRun ? { captured: wire.captured } : {}),
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures,
        // including declines a tool rethrew and its wrapper attached to a Tool.Error, as Promise
        // plugin tools do.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          tools
            .execute({ ...call, definitions: hooked })
            .pipe(Effect.catchCauseFilter(ToolUserStop.fromCause, (decline) => Effect.fail(decline))),
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", input: Input) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, {
          ...draft,
          agent: input.agent,
          tools,
          ...(input.dryRun ? { dryRun: true } : {}),
        })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input)),
      compaction: (input) => prepare("compaction", input, agentHook("compaction", input)),
      generate: (input) => prepare("generate", input, agentHook("generate", input)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node, SessionCache.node],
})
