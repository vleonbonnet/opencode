import { describe, expect } from "bun:test"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { ForkCodeModeCatalog } from "@opencode/core/codemode/fork-catalog"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

// A tool whose signature counts its reads, as the real catalog renders signatures only for the tools it shows.
function tool(name: string, pinned = false) {
  const reads = { count: 0 }
  const entry = {
    type: "tool" as const,
    name,
    description: `Run ${name}`,
    pinned,
    get signature() {
      reads.count += 1
      return `tools.${name}({\n  text: string,\n}): Promise<string>`
    },
  }
  return { entry: entry as CodeModeCatalog.Tool, reads }
}

describe("ForkCodeModeCatalog", () => {
  it.effect("drops the pins tools register upstream without rendering their signatures", () =>
    Effect.sync(() => {
      const move = tool("move", true)
      const adapted = ForkCodeModeCatalog.adapt({
        tools: [
          { type: "namespace", name: "opencode", tools: [{ type: "namespace", name: "session", tools: [move.entry] }] },
        ],
      })
      const session = (adapted?.tools[0] as CodeModeCatalog.Namespace).tools[0] as CodeModeCatalog.Namespace
      expect((session.tools[0] as CodeModeCatalog.Tool).pinned).toBe(false)
      expect(move.reads.count).toBe(0)
      expect(ForkCodeModeCatalog.adapt(undefined)).toBeUndefined()
    }),
  )

  it.effect("lists the session's tools by name only, and points to search", () =>
    Effect.gen(function* () {
      const echo = tool("echo", true)
      const lookup = tool("lookup")
      const initialized = yield* readInitial(
        CodeModeInstructions.make(
          ForkCodeModeCatalog.adapt({
            tools: [{ type: "namespace", name: "notes", tools: [echo.entry, lookup.entry] }],
          }),
          ForkCodeModeCatalog.signatureBudget,
        ),
      )
      expect(initialized.text).toContain("- notes (2 tools, none shown)")
      expect(initialized.text).toContain("find it with the global `search(...)` function")
      expect(initialized.text).not.toContain("tools.echo(")
    }),
  )

  it.effect("counts the tools a change adds instead of listing their signatures", () =>
    Effect.gen(function* () {
      const echo = tool("echo")
      const lookup = tool("lookup")
      const catalog = (...tools: ReadonlyArray<CodeModeCatalog.Tool>) =>
        CodeModeInstructions.make(
          ForkCodeModeCatalog.adapt({ tools: [{ type: "namespace", name: "notes", tools }] }),
          ForkCodeModeCatalog.signatureBudget,
        )
      const initialized = yield* readInitial(catalog(echo.entry))
      const added = yield* readUpdate(catalog(echo.entry, lookup.entry), initialized)
      expect(added.text).toContain("New tools are available in addition to those previously listed:")
      expect(added.text).toContain("  - 1 more; search for them")
      expect(added.text).not.toContain("tools.lookup(")
    }),
  )
})
