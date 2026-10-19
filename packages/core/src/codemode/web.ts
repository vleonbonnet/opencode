export * as CodeModeWeb from "./web.js"

import { Extension } from "@opencode/codemode"
import type { Context } from "@opencode/schema/tool"
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
 * The `fetch` global of one execution. A request is sent only once `authorize` resolves; aborting `signal` when the
 * execution ends stops a request still in flight.
 */
export const extension = (authorize: (request: Request) => Promise<void>, signal: AbortSignal) => {
  const fetch = async (input: string | URL, init: Init = {}) => {
    if (URL.parse(String(input))?.protocol === "file:")
      throw new Error("fetch cannot be used for filesystem access.")
    await authorize(display([input, init]))
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
  return Extension.make({ name: "web", globals: { fetch } })
}

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>): Request => {
  const [input, init] = args as [string | URL, Init | undefined]
  return { method: init?.method?.toUpperCase() ?? "GET", url: String(input) }
}
