import { describe, expect, test } from "bun:test"
import { CodeModeDiffs } from "@opencode/core/codemode/diffs"
import { fileDiff } from "@opencode/core/tool/plugin/file-diff"

describe("CodeModeDiffs", () => {
  test("takes a shell command's changes and a write's diff from their results' metadata.files", () => {
    const changed = fileDiff("src/a.ts", "a\n", "b\n")
    const created = fileDiff("src/b.ts", "", "x\ny\n", "added")
    expect(
      CodeModeDiffs.changes(
        "shell",
        { command: "sed -i s/a/b/ src/a.ts" },
        {
          output: {},
          metadata: { files: [changed, created] },
        },
      ),
    ).toEqual([
      { file: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: changed.patch },
      { file: "src/b.ts", status: "added", additions: 2, deletions: 0, patch: created.patch },
    ])
    const overwrite = fileDiff("n.md", "x\n", "y\n")
    expect(
      CodeModeDiffs.changes(
        "write",
        { path: "n.md", content: "y\n" },
        { output: "Wrote file successfully: n.md", metadata: { files: [overwrite] } },
      ),
    ).toEqual([{ file: "n.md", status: "modified", additions: 1, deletions: 1, patch: overwrite.patch }])
  })

  test("a shell command that changed nothing reports nothing", () => {
    expect(CodeModeDiffs.changes("shell", { command: "ls" }, { output: {} })).toEqual([])
  })
})
