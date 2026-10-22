export * as CodeModeWeb from "./web.js"

import { Extension } from "@opencode/codemode"
import { isRecord } from "@opencode/ai/utils/record"
import type { Context } from "@opencode/schema/tool"
import { Effect } from "effect"
import type { Permission } from "../permission.js"
import type { WebFetchTool } from "../tool/plugin/webfetch.js"

const TIMEOUT_MS = 30_000

// Fetching from Code Mode needs what the webfetch tool needs.
const action: typeof WebFetchTool.name = "webfetch"

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

/** A request a program makes, as its permission request and progress row show it. */
export type Request = { readonly method: string; readonly url: string }

/** The webfetch permission a request needs, asked as the execute call that makes it. */
export const permission = (request: Request, context: Context): Permission.AssertInput => ({
  action,
  resources: [request.url],
  save: ["*"],
  metadata: request,
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool", messageID: context.messageID, id: context.id },
})

/**
 * The `fetch` global. A request is sent only once `authorize` succeeds. Both run as an Effect in the calling
 * execution's context, so ending the execution interrupts them, withdrawing a pending permission request and
 * aborting a request in flight.
 */
export const extension = <R>(authorize: (request: Request) => Effect.Effect<void, unknown, R>) => {
  const fetch = (input: string | URL, init: Init = {}) =>
    Effect.gen(function* () {
      if (URL.parse(String(input))?.protocol === "file:")
        return yield* Effect.fail(new Error("fetch cannot be used for filesystem access."))
      yield* authorize(display([input, init]))
      return yield* Effect.tryPromise({ try: (signal) => send(input, init, signal), catch: (reason) => reason })
    })
  return Extension.make({ name: "web", globals: { fetch } })
}

const send = async (input: string | URL, init: Init, signal: AbortSignal) => {
  const response = await globalThis.fetch(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
  })
  const bytes = await response.bytes()
  const headers = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      has: (name: string) => name.toLowerCase() in headers,
      entries: () => Object.entries(headers),
    },
    text: async () => text(),
    json: async () => JSON.parse(text()) as unknown,
    bytes: async () => bytes,
  }
}

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>): Request => {
  const [input, init] = args
  const method = isRecord(init) && typeof init.method === "string" ? init.method.toUpperCase() : "GET"
  return { method, url: String(input) }
}
