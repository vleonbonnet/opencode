import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ToolOutput } from "@opencode/core/tool-output"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { withTempDir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

// The store fixture of the upstream ToolOutput tests.
const withStore = <A, E, R>(
  body: (output: ToolOutput.Interface, fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>,
  limits?: { maxLines?: number; maxBytes?: number },
) =>
  withTempDir((tmp) => {
    const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
      Global.node.replace(Global.layerWith({ data: tmp.path })),
    ])
    return Effect.gen(function* () {
      const output = yield* ToolOutput.Service
      const fs = yield* FSUtil.Service
      if (limits) yield* output.transform((editor) => editor.configure(limits))
      return yield* body(output, fs, tmp.path)
    }).pipe(Effect.provide(layer))
  })

describe("ToolOutput", () => {
  it.live("returns errors that fit unchanged without saving them", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          const error = { type: "tool.execution", message: "one\ntwo\n", response: { body: "small" } }
          expect(yield* output.truncateError(error)).toBe(error)
          expect(yield* fs.exists(path.join(root, ToolOutput.DIRECTORY))).toBe(false)
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("bounds an oversized error message and response body, saving each in full", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          const error = {
            type: "provider.invalid-request",
            message: "one\ntwo\nthree",
            status: 400,
            response: { body: "a\nb\nc\nd" },
          }
          const bounded = yield* output.truncateError(error)
          const message = /^one\ntwo\n\[showing lines 1-2 of 3; full error saved to (.+)\]$/.exec(bounded.message)
          const body = /^a\nb\n\[showing lines 1-2 of 4; full response body saved to (.+)\]$/.exec(
            bounded.response?.body ?? "",
          )
          expect(bounded).toMatchObject({ type: "provider.invalid-request", status: 400 })
          expect(message).not.toBeNull()
          expect(body).not.toBeNull()
          if (!message || !body) return
          expect(message[1]).not.toBe(body[1])
          expect(yield* fs.readFileString(message[1]!)).toBe("one\ntwo\nthree")
          expect(yield* fs.readFileString(body[1]!)).toBe("a\nb\nc\nd")
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("keeps the start of an error whose first line exceeds the byte limit", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          // Two bytes per character: the sixth would cross the limit, and no character is split.
          const message = `${"é".repeat(50)}\nsecond`
          const bounded = yield* output.truncateError({ type: "tool.execution", message })
          const kept = /^é{5}\n\[showing 10 of 100 bytes of line 1 of 2; full error saved to (.+)\]$/.exec(
            bounded.message,
          )
          expect(bounded).toEqual({ type: "tool.execution", message: expect.any(String) })
          expect(kept).not.toBeNull()
          expect(yield* fs.readFileString(kept![1]!)).toBe(message)
        }),
      { maxLines: 2, maxBytes: 11 },
    ),
  )

  it.live("still bounds an error whose full text cannot be saved", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          // A file where the directory belongs makes the save fail.
          yield* fs.writeFileString(path.join(root, ToolOutput.DIRECTORY), "")
          expect(yield* output.truncateError({ type: "tool.execution", message: "one\ntwo\nthree" })).toEqual({
            type: "tool.execution",
            message: "one\ntwo\n[showing lines 1-2 of 3; the full error could not be saved]",
          })
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )
})
