// Wire capture: observes the HTTP-equivalent request bodies that leave the process
// for session LLM calls, after every SDK, plugin and custom-fetch layer has
// run. Prompt-cache reuse is decided by the provider on those bytes, so this
// is the only place where cache prediction can be grounded without modelling
// opencode's own request construction.
//
// A request opts in by carrying the `x-opencode-wire` header. The hook strips
// the header before anything is sent. In `dryrun` mode the body is captured and
// the request is aborted before it reaches the network.

export const HEADER = "x-opencode-wire"

export type Mode = "send" | "dryrun"

export type Captured = {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly time: number
}

export type Tag = {
  readonly mode: Mode
  readonly sessionID: string
  readonly id: string
}

export class DryRunCaptured extends Error {
  readonly _tag = "WireDryRunCaptured"
  constructor(readonly id: string) {
    super("opencode wire dry run: request captured, not sent")
    this.name = "WireDryRunCaptured"
  }
}

export function isDryRunCaptured(error: unknown): boolean {
  // Errors cross SDK boundaries and may be wrapped; match on the marker chain.
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof DryRunCaptured) return true
    if (typeof current === "object" && (current as { name?: unknown }).name === "WireDryRunCaptured") return true
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

const SENTINEL = Symbol.for("opencode.wire-capture")
const captured = new Map<string, Captured>()
const senders = new Set<(tag: Tag, request: Captured) => void>()
const guards = new Set<(tag: Tag, request: Captured) => void>()
const observers = new Set<(tag: Tag, request: Captured) => void>()
let counter = 0

export function nextID() {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER
  return `${Date.now().toString(36)}${counter.toString(36)}`
}

export function header(tag: Tag): Record<string, string> {
  return { [HEADER]: `${tag.mode}.${tag.id}.${tag.sessionID}` }
}

function parse(value: string): Tag | undefined {
  const first = value.indexOf(".")
  const second = value.indexOf(".", first + 1)
  if (first < 0 || second < 0) return
  const mode = value.slice(0, first)
  if (mode !== "send" && mode !== "dryrun") return
  return { mode, id: value.slice(first + 1, second), sessionID: value.slice(second + 1) }
}

/** Register a listener for every tagged request that is actually sent. */
export function onSend(listener: (tag: Tag, request: Captured) => void) {
  senders.add(listener)
  return () => senders.delete(listener)
}

/**
 * Register a guard for tagged "send" requests: throw to stop the request
 * before it reaches the network. Listeners run in registration order ahead
 * of `onSend` accounting.
 */
export function guard(listener: (tag: Tag, request: Captured) => void) {
  guards.add(listener)
  return () => guards.delete(listener)
}

/** Observe every tagged request, dry runs included (diagnostics and tests). */
export function onCapture(listener: (tag: Tag, request: Captured) => void) {
  observers.add(listener)
  return () => observers.delete(listener)
}

function notify(set: Set<(tag: Tag, request: Captured) => void>, tag: Tag, request: Captured) {
  for (const listener of set) {
    try {
      listener(tag, request)
    } catch {
      // Accounting must never break the request itself.
    }
  }
}

/** Take the body captured by a dry run, if the request reached the wire layer. */
export function take(id: string): Captured | undefined {
  const value = captured.get(id)
  captured.delete(id)
  return value
}

function mergedHeaders(input: RequestInfo | URL, init: RequestInit | undefined) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

async function bodyText(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string | undefined> {
  const body = init?.body
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (body === undefined || body === null) {
    if (input instanceof Request && input.body) return input.clone().text()
    return
  }
  // Streams and form data are not produced by the JSON LLM SDKs; record them
  // as unknown rather than consuming a body the real request still needs.
  return
}

function url(input: RequestInfo | URL) {
  if (input instanceof URL) return input.href
  if (typeof input === "string") return input
  return input.url
}

/** Capture and strip the tag before either HTTP or WebSocket transport runs. */
export async function intercept(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit | undefined> {
  const headers = mergedHeaders(input, init)
  const raw = headers.get(HEADER)
  if (!raw) return init
  headers.delete(HEADER)
  const tag = parse(raw)
  const forward: RequestInit = { ...init, headers }
  if (!tag) return forward

  const request: Captured = {
    url: url(input),
    method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body: await bodyText(input, init),
    time: Date.now(),
  }
  notify(observers, tag, request)
  if (tag.mode === "dryrun") {
    captured.set(tag.id, request)
    // Bound memory if a caller never collects its capture.
    if (captured.size > 64) captured.delete(captured.keys().next().value!)
    throw new DryRunCaptured(tag.id)
  }
  // Guards run ahead of accounting and may throw to stop the request.
  for (const guard of guards) guard(tag, request)
  notify(senders, tag, request)
  return forward
}

/**
 * Install the process-wide hook on `globalThis.fetch`. Idempotent. SDKs and
 * plugin fetch wrappers resolve `fetch` at call time, so every layer above
 * this one has already applied its body and header transformations.
 */
export function install() {
  const current = globalThis.fetch as typeof fetch & { [SENTINEL]?: true }
  if (current[SENTINEL]) return
  const original = current
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return original(input, await intercept(input, init))
  }
  Object.assign(patched, original, { [SENTINEL]: true })
  globalThis.fetch = patched as typeof fetch
}

export * as Wire from "./wire"
