export * as CacheWire from "./wire.js"

// Wire capture: observes the request bodies that leave the process for Session model calls, after every plugin
// `http.request` hook has run. Prompt-cache reuse is decided by the provider on those bytes, so this is the only
// place where cache prediction can be grounded without modelling opencode's own request construction.
//
// A WebSocket exchange never crosses the HTTP middleware; its frames carry the body the HTTP fallback would post, so
// it is captured in that HTTP-equivalent form (`compileHttpRequest`), without authenticating it: the ledger names the
// credential by its stored identity, and rendering must not load or refresh one. In dry-run mode the request is
// captured and the exchange fails before any network I/O: the HTTP handler and the WebSocket executor are never called.

import { AIError, TransportError, type LLMRequest } from "@opencode/ai/effect"
import {
  compileHttpRequest,
  type HttpHandler,
  type HttpMiddleware,
  type StreamOptions,
  type WebSocketChannelExecutor,
} from "@opencode/ai/route"
import { Cause, Clock, Effect } from "effect"
import { HttpClientRequest } from "effect/http"

/** An HTTP-equivalent request as it reached the wire. Lives in memory only, and briefly: the headers carry credentials. */
export interface Captured {
  readonly url: string
  readonly method: string
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly time: number
  /**
   * What the request authenticates with, as the auth store names it (`ModelResolver.credentialIdentity`), not the
   * header: tokens refresh and requests are signed, and neither moves the provider's cache. Undefined when nothing
   * stable names it; the cache namespace then leaves it out.
   */
  readonly credential?: string
}

export type Mode =
  | { readonly type: "dryrun" }
  /** `sent` sees every request right before it is handed to the transport; it must not fail. */
  | { readonly type: "send"; readonly sent?: (request: Captured) => Effect.Effect<void> }

export const DRY_RUN_MESSAGE = "Dry run: the request was captured and not sent"

/** Raised in place of sending a dry-run request; the executor wraps it as a transport error. */
export class DryRunCaptured extends Error {
  readonly _tag = "CacheWire.DryRunCaptured"
  constructor() {
    super(DRY_RUN_MESSAGE)
    this.name = "CacheWire.DryRunCaptured"
  }
}

export interface Wire {
  /** The stream options with the tap installed around the given transports, when it records or captures. */
  readonly options: (options: {
    readonly http?: HttpMiddleware
    readonly webSocket?: WebSocketChannelExecutor
  }) => StreamOptions
  /** The request a dry run captured, once its stream has run; always undefined when sending. */
  readonly captured: () => Captured | undefined
}

const decompress = (bytes: Uint8Array, encoding: string | null): Uint8Array | undefined => {
  if (encoding === null || encoding === "" || encoding === "identity") return bytes
  // Looked up at call time, like the compressor: a runtime without node:zlib could not have compressed the body.
  const zlib = globalThis.process?.getBuiltinModule?.("node:zlib")
  try {
    if (encoding === "gzip") return zlib?.gunzipSync(bytes)
    if (encoding === "zstd") return zlib?.zstdDecompressSync?.(bytes)
  } catch {
    return undefined
  }
  return undefined
}

/** The HTTP request a handler is about to send, with its body text. Never fails: an unreadable body is undefined. */
export const fromHttp = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const time = yield* Clock.currentTimeMillis
    const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.option)
    if (web._tag === "None")
      return {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)])),
        body: undefined,
        time,
      } satisfies Captured
    const bytes = yield* Effect.tryPromise(() => web.value.clone().arrayBuffer()).pipe(Effect.option)
    const decoded =
      bytes._tag === "Some"
        ? decompress(new Uint8Array(bytes.value), web.value.headers.get("content-encoding"))
        : undefined
    return {
      url: web.value.url,
      method: web.value.method,
      headers: Object.fromEntries(web.value.headers.entries()),
      body: decoded === undefined || decoded.byteLength === 0 ? undefined : new TextDecoder().decode(decoded),
      time,
    } satisfies Captured
  })

/**
 * The HTTP-equivalent form of a request a WebSocket carries, without its authentication. Undefined when the request
 * does not compile.
 */
export const fromRequest = (request: LLMRequest) =>
  Effect.gen(function* () {
    const time = yield* Clock.currentTimeMillis
    const compiled = yield* compileHttpRequest(request, { authenticate: false }).pipe(Effect.option)
    if (compiled._tag === "None") return undefined
    return {
      url: compiled.value.url,
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(compiled.value.headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      body: compiled.value.body,
      time,
    } satisfies Captured
  })

const dryRunTransportError = (url: string | undefined) =>
  new AIError({
    reason: new TransportError({
      message: DRY_RUN_MESSAGE,
      transport: "websocket",
      operation: "request",
      code: "dry-run",
      phase: "prepare",
      delivery: "not-sent",
      url,
    }),
  })

// Accounting never breaks the request it observes.
const quietly = (effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("prompt-cache wire tap failed", cause),
    ),
  )

/** A tap for one prepared request. */
export const make = (input: {
  readonly request: LLMRequest
  readonly mode: Mode
  /** Stamped on every capture: the credential identity of the model the request was built for. */
  readonly credential?: string
}): Wire => {
  let captured: Captured | undefined
  const mode = input.mode
  const stamp = (request: Captured): Captured =>
    input.credential === undefined ? request : { ...request, credential: input.credential }

  const tapped =
    (handler: HttpHandler): HttpHandler =>
    (request) =>
      Effect.gen(function* () {
        const seen = stamp(yield* fromHttp(request))
        if (mode.type === "dryrun") {
          captured = seen
          return yield* Effect.fail(new DryRunCaptured())
        }
        if (mode.sent) yield* quietly(mode.sent(seen))
        return yield* handler(request)
      })

  const http =
    (inner: HttpMiddleware | undefined): HttpMiddleware =>
    (request, handler) =>
      // The tap wraps the handler the plugin middleware calls, so it sees the request after `http.request` hooks.
      inner ? inner(request, tapped(handler)) : tapped(handler)(request)

  const webSocket = (inner: WebSocketChannelExecutor): WebSocketChannelExecutor => ({
    execute: (exchange) =>
      Effect.gen(function* () {
        const compiled = yield* fromRequest(input.request)
        const seen = compiled && stamp(compiled)
        if (mode.type === "dryrun") {
          captured = seen
          return yield* dryRunTransportError(exchange.connect?.url)
        }
        if (seen && mode.sent) yield* quietly(mode.sent(seen))
        return yield* inner.execute(exchange)
      }),
  })

  // A send nobody accounts for needs no tap: the transports pass through untouched.
  const active = mode.type === "dryrun" || mode.sent !== undefined
  return {
    options: (options) =>
      active
        ? { http: http(options.http), ...(options.webSocket ? { webSocket: webSocket(options.webSocket) } : {}) }
        : {
            ...(options.http ? { http: options.http } : {}),
            ...(options.webSocket ? { webSocket: options.webSocket } : {}),
          },
    captured: () => captured,
  }
}

/** True for the failure a dry run ends with once its request was captured. */
export const isDryRunFailure = (error: unknown) => {
  if (error instanceof DryRunCaptured) return true
  if (!(error instanceof AIError) || error.reason._tag !== "Transport") return false
  return error.reason.code === "dry-run" || error.reason.message.includes(DRY_RUN_MESSAGE)
}
