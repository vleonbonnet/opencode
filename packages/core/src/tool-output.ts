export * as ToolOutput from "./tool-output.js"

import path from "path"
import type { Tool } from "./tool.js"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Identifier } from "@opencode/schema/identifier"
import type { SessionError } from "@opencode/schema/session-error"
import { FileRetention } from "./file-retention.js"
import { State } from "./state.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"

export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

type Result = Tool.NormalizedResult

type Limits = {
  maxLines: number
  maxBytes: number
}

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly truncate: (result: Result) => Effect.Effect<Result>
  /** Bounds a failed call's model-visible error text with the same limits, saving any text it cuts. */
  readonly truncateError: (error: SessionError.Error) => Effect.Effect<SessionError.Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

const preview = (cut: { readonly kept: string; readonly marker: string }) =>
  cut.kept === "" ? cut.marker : `${cut.kept}\n${cut.marker}`

const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    /**
     * The leading lines of text that exceed the limits; undefined when it fits. With `partial`, a first line too long
     * to fit keeps as many leading characters as fit instead of nothing.
     */
    const bound = (text: string, partial: boolean) => {
      const limits = state.get()
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const totalBytes = Buffer.byteLength(text, "utf-8")
      if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes) return undefined

      const kept: string[] = []
      let bytes = 0
      for (const line of lines.slice(0, limits.maxLines)) {
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > limits.maxBytes) break
        kept.push(line)
        bytes += size
      }
      if (kept.length > 0 || !partial || lines[0] === undefined)
        return {
          kept: kept.join("\n"),
          shown: `${kept.length > 0 ? `lines 1-${kept.length}` : "0 lines"} of ${lines.length}`,
        }
      // encodeInto stops before a character that would not fit, so the kept text never ends in a split one.
      const first = lines[0]
      const prefix = new TextEncoder().encodeInto(first, new Uint8Array(limits.maxBytes))
      return {
        kept: first.slice(0, prefix.read),
        shown: `${prefix.written} of ${Buffer.byteLength(first, "utf-8")} bytes of line 1 of ${lines.length}`,
      }
    }

    const save = Effect.fnUntraced(function* (text: string) {
      const file = path.join(directory, fileName())
      yield* fs.ensureDir(directory)
      yield* fs.writeFileString(file, text)
      return file
    })

    /** Saves text that exceeds the limits and returns the leading lines that fit; undefined when it fits. */
    const cut = Effect.fnUntraced(function* (text: string, label: string) {
      const bounded = bound(text, false)
      if (bounded === undefined) return undefined
      const file = yield* save(text).pipe(Effect.orDie)
      return { kept: bounded.kept, file, marker: `[showing ${bounded.shown}; full ${label} saved to ${file}]` }
    })

    // A failed save must not turn the tool's error into a defect, so the bounded text says the rest is lost instead.
    const cutError = Effect.fnUntraced(function* (text: string, label: string) {
      const bounded = bound(text, true)
      if (bounded === undefined) return undefined
      const saved = yield* save(text).pipe(
        Effect.map((file) => `full ${label} saved to ${file}`),
        Effect.catch((error) =>
          Effect.logWarning("failed to save truncated tool error", { error }).pipe(
            Effect.as(`the full ${label} could not be saved`),
          ),
        ),
      )
      return { kept: bounded.kept, marker: `[showing ${bounded.shown}; ${saved}]` }
    })

    const truncate = Effect.fnUntraced(function* (result: Result) {
      if (result.metadata?.truncated !== undefined) return result
      const content = result.content
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const saved = yield* cut(text, "output")
      if (saved === undefined) return { ...result, metadata: { ...result.metadata, truncated: false } }
      const { file, marker } = saved
      const bounded: Tool.Content[] = []
      let remaining = saved.kept.length
      let seenText = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        if (seenText && remaining > 0) remaining--
        seenText = true
        if (remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        if (!marked) bounded.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }
      if (!marked) bounded.push({ type: "text", text: marker })
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, outputPath: file },
      }
    })

    // The model reads an error's message and any provider response body, so each is bounded like output.
    const truncateError = Effect.fnUntraced(function* (error: SessionError.Error) {
      const message = yield* cutError(error.message, "error")
      const body = error.response === undefined ? undefined : yield* cutError(error.response.body, "response body")
      if (message === undefined && body === undefined) return error
      return {
        ...error,
        ...(message === undefined ? {} : { message: preview(message) }),
        ...(body === undefined ? {} : { response: { ...error.response, body: preview(body) } }),
      }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      truncateError,
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
