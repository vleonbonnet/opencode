import { describe, expect } from "bun:test"
import { $ } from "bun"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Git } from "@opencode/core/git"
import { AbsolutePath } from "@opencode/core/schema"
import { initRepo } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

// Git for Windows names a path on a subst or mapped network drive by the drive's target.
const substTest = process.platform === "win32" ? it.live : it.live.skip

describe("Git on a substituted drive", () => {
  substTest("keeps the drive the repository was reached through", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(path.join(root.path, "repo")))
      const drive = yield* Effect.acquireRelease(
        Effect.promise(() => substitute(root.path)),
        (drive) => Effect.promise(() => $`subst ${drive} /D`.quiet()),
      )
      const directory = AbsolutePath.make(path.join(`${drive}\\`, "repo"))
      const git = yield* Git.Service
      const repository = yield* git.repo.discover(directory)
      if (!repository) throw new Error("Repository not found")

      expect(repository.worktree).toBe(directory)
      expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(directory, ".git")))
      expect(repository.commonDirectory).toBe(repository.gitDirectory)
      expect((yield* git.worktree.list(repository)).map((entry) => entry.directory)).toEqual([directory])
    }),
  )
})

async function substitute(directory: string) {
  for (const letter of "QPONMLKJIHGF") {
    const drive = `${letter}:`
    if ((await $`subst ${drive} ${directory}`.nothrow().quiet()).exitCode === 0) return drive
  }
  throw new Error("No free drive letter to substitute")
}
