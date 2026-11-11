import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Formatter } from "@opencode/core/formatter"
import { FileMutation } from "@opencode/core/file-mutation"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PatchTool } from "@opencode/core/tool/plugin/patch"
import { transformEnvironmentFiles } from "../fixture/environment"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "../lib/tool"

// The patch tool in a temporary directory, as the upstream PatchTool tests build it, with every permission granted
// and no formatter.
const patchToolNode = makeLocationNode({
  name: "test/patch-tool-plugin",
  layer: Layer.effectDiscard(
    registerToolPlugin(PatchTool.Plugin, {
      session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    }),
  ),
  deps: [
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_patch_tool_test")
const withTempTool = <A, E, R>(body: (directory: string, registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  withTempDir((tmp) =>
    Effect.gen(function* () {
      return yield* body(tmp.path, yield* Tool.Service)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, patchToolNode]), [
          Environment.node.replace(transformEnvironmentFiles((files) => files)),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
        ]),
      ),
    ),
  )

const call = (patchText: string, id = "call-patch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "patch", input: { patchText } },
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )
const it = testEffect(Layer.empty)

describe("PatchTool", () => {
  it.live("preserves each file's line endings and BOM when updating and moving files", () =>
    withTempTool((directory, registry) =>
      Effect.gen(function* () {
        const original = path.join(directory, "windows.org")
        const moved = path.join(directory, "nested", "windows.org")
        const unix = path.join(directory, "unix.txt")
        yield* Effect.promise(() =>
          fs.writeFile(original, "﻿#+name: example\r\n#+begin_src bash\r\necho old\r\n#+end_src\r\n"),
        )
        yield* Effect.promise(() => fs.writeFile(unix, "before\nold\nafter\n"))
        const settled = yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Update File: windows.org\n*** Move to: nested/windows.org\n@@\n-echo old\n+echo new\n+echo added\n*** Update File: unix.txt\n@@\n-old\n+new\n*** End Patch",
          ),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        expect(yield* exists(original)).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(moved, "utf8"))).toBe(
          "﻿#+name: example\r\n#+begin_src bash\r\necho new\r\necho added\r\n#+end_src\r\n",
        )
        expect(yield* Effect.promise(() => fs.readFile(unix, "utf8"))).toBe("before\nnew\nafter\n")
        const output = Schema.decodeUnknownSync(PatchTool.Output)(settled.output)
        expect(output.files[0]?.patch).not.toContain("-#+name:")
        expect(output.files[0]?.patch).not.toContain("+#+name:")
        expect(output.files[0]?.patch).not.toContain("﻿")
        expect(output.files[0]).toMatchObject({ additions: 2, deletions: 1 })
      }),
    ),
  )
})
