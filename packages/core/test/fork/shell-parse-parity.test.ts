import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "../../src/shell/parse.js"

describe("ShellParse native parity", () => {
  test("reads heredoc bodies across readers, delimiters and statements", async () => {
    const commands = heredocs()
    expect(commands.length).toBeGreaterThan(400)
    const outcomes = new Set<string>()
    for (const command of commands) {
      const native = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))
      const resources = native.commands.map((item) => item.resource)
      outcomes.add(
        !resources.some((resource) => resource.includes("secret"))
          ? "left out"
          : resources.includes("kubectl delete pod secret-$(id)")
            ? "read as a script"
            : "kept",
      )
    }
    expect([...outcomes].sort()).toEqual(["kept", "left out", "read as a script"])
  }, 60_000)
})

// Heredocs whose readers range over data readers, shells, runners and expanders, written in the statements that
// decide which commands read them.
function heredocs() {
  const readers = ["cat", "bash", "python3 -", "xargs rm", "sudo -s", "tee log", '"$run"']
  const delimiters = [
    ["<<'EOF'", "EOF"],
    ['<<"EOF"', "EOF"],
    ["<<EOF", "EOF"],
    ["<<-'EOF'", "\tEOF"],
    ["<<\\EOF", "EOF"],
    // Partly quoted and backslashed delimiters, which Tree-sitter reads otherwise than bash.
    ['<<E"O"F', "EOF"],
    ["<<E'O'F", "EOF"],
    ["<<$'EOF'", "EOF"],
    ["<<E\\OF", "EOF"],
    ["<<'E\\OF'", "E\\OF"],
    ['<<"E\\OF"', "E\\OF"],
  ]
  const statements = [
    (head: string, rest: string) => `${head}${rest}`,
    (head: string, rest: string) => `${head} | sh${rest}`,
    (head: string, rest: string) => `${head} | grep x | sort${rest}`,
    (head: string, rest: string) => `${head} > out && echo done${rest}`,
    (head: string, rest: string) => `echo before; ${head}${rest}`,
    (head: string, rest: string) => `if true; then ${head}${rest}\nfi`,
    (head: string, rest: string) => `x=$(${head}${rest}\n)`,
    (head: string, rest: string) => `echo "$(${head}${rest}\n)" | sh`,
    (head: string, rest: string) => `bash -c "$(${head}${rest}\n)"`,
    (head: string, rest: string) => `(${head}${rest}\n)`,
    (head: string, rest: string) => `{ ${head}${rest}\n} | sh`,
    (head: string, rest: string) => `for f in a; do ${head}${rest}\ndone`,
  ]
  // Lines that only begin with the delimiter, or hold it with more, do not end a body.
  const collisions = ["EOFX\n", "EOF \n", " EOF\n", "EOF\\\n"]
  return [
    ...readers.flatMap((reader) =>
      delimiters.flatMap(([open, close]) =>
        statements.map((statement) =>
          statement(
            `${reader} ${open}`,
            `\n${open.startsWith("<<-") ? "\t" : ""}kubectl delete pod secret-$(id)\n${close}`,
          ),
        ),
      ),
    ),
    ...readers.flatMap((reader) =>
      ["<<'EOF'", "<<EOF"].flatMap((open) =>
        collisions.flatMap((line) =>
          statements
            .slice(0, 4)
            .map((statement) => statement(`${reader} ${open}`, `\n${line}kubectl delete pod secret-$(id)\nEOF`)),
        ),
      ),
    ),
  ]
}
