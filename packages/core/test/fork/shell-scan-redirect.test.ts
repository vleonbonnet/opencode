import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "../../src/shell/parse.js"
import { Wildcard } from "../../src/util/wildcard.js"

// The resource check of the upstream redirect oracle tests, which also accepts a command's other spellings.
async function checkResources(source: string) {
  const parsed = await Effect.runPromise(ShellParse.scan(source, "/bin/bash", "/workspace"))
  for (const command of parsed.commands) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*=/.test(command.resource) &&
      !/^(?:\d*>>?|\d*>&|&>>?|\d*<|\d*<>|>\|)/.test(command.resource) &&
      !command.resource.includes("\\\n")
    ) {
      // A save matches the command as written or as one of its other spellings; a glob prefix saves none.
      const spellings = [command.resource, ...(command.alternates ?? [])]
      expect(
        command.save === undefined || spellings.some((text) => Wildcard.match(text, command.save!)),
        `${source}: ${JSON.stringify(command)}`,
      ).toBe(true)
    }
  }
}

describe("Bash redirect resource oracle", () => {
  test.each([
    ["printf hello | cat > marker", ["printf hello", "cat > marker"]],
    ["printf ok && git status > output", ["printf ok", "git status > output"]],
    ["cat > output", ["cat > output"]],
    ["cat > output | cat", ["cat > output", "cat"]],
    // A spelling keeps its command's redirects, after its words.
    ["pwd | > output cat > tail", ["pwd", "> output cat > tail", "cat > output > tail"]],
    // Bash takes one word as a redirect's target; `file` is cat's.
    ["pwd && cat > output file", ["pwd", "cat > output file", "cat file > output"]],
    ["pwd; cat > output", ["pwd", "cat > output"]],
    ["pwd\ncat > output", ["pwd", "cat > output"]],
  ] as const)("spells each command with its redirects across lists and pipelines: %s", async (source, resources) => {
    const parsed = await Effect.runPromise(ShellParse.scan(source, "/bin/bash", "/workspace"))
    // The redirect-free spelling of a command is an alternate of the resource as written, not a separate resource.
    const spellings = parsed.commands.flatMap((command) => [command.resource, ...(command.alternates ?? [])])
    expect(spellings).toEqual([...resources])
    await checkResources(source)
  })
})
