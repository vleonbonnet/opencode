import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "../../src/shell/parse.js"

describe("Bash shared heredoc delimiter grammar", () => {
  // Bash ends a body whose delimiter keeps a backslash at that delimiter, and the data is left out.
  test.each([
    ['(cat <<"E\\OF"\nhello\nE\\OF\n)', 'cat <<"E\\OF"'],
    ['(cat <<-"E\\OF"\n\thello\n\tE\\OF\n)', 'cat <<-"E\\OF"'],
  ])("leaves out a data-only body: %s", async (source, resource) => {
    const expected = { commands: [{ resource, save: "cat *" }], directories: [] }
    expect(await Effect.runPromise(ShellParse.scan(source, "/bin/bash", "/workspace"))).toEqual(expected)
  })
})
