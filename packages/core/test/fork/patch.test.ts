import { describe, expect, test } from "bun:test"
import { Patch } from "@opencode/util/patch"
import { Result } from "effect"

const parse = (input: string) => Result.getOrThrow(Patch.parse(input))

describe("Patch", () => {
  describe("line endings", () => {
    test.each([
      { name: "LF file with an LF patch", file: "\n", patch: "\n" },
      { name: "CRLF file with an LF patch", file: "\r\n", patch: "\n" },
      { name: "LF file with a CRLF patch", file: "\n", patch: "\r\n" },
      { name: "CRLF file with a CRLF patch", file: "\r\n", patch: "\r\n" },
    ])("keeps the endings of a $name across hunks", ({ file, patch }) => {
      const [hunk] = parse(
        [
          "*** Begin Patch",
          "*** Update File: example.org",
          "@@ first",
          "-old1",
          "+new1",
          "+inserted",
          "@@",
          "-old2",
          "+new2",
          " ",
          " last",
          "*** End of File",
          "*** End Patch",
        ].join(patch),
      )
      if (hunk?.type !== "update") throw new Error("expected an update hunk")
      expect(hunk.chunks).toHaveLength(2)
      const original = ["first", "old1", "middle", "old2", "", "last", ""].join(file)
      expect(Patch.derive("example.org", hunk.chunks, original).content).toBe(
        ["first", "new1", "inserted", "middle", "new2", "", "last", ""].join(file),
      )
    })

    test("keeps each line's own ending in a mixed-ending file", () => {
      expect(
        Patch.derive("mixed.org", [{ oldLines: ["old"], newLines: ["changed"] }], "first\r\nold\nlast\r\n").content,
      ).toBe("first\r\nchanged\nlast\r\n")
    })

    test("gives added lines the replaced region's dominant ending", () => {
      expect(
        Patch.derive(
          "mixed.org",
          [{ oldLines: ["one", "two", "three"], newLines: ["one", "TWO", "added", "three"] }],
          "zero\r\none\ntwo\r\nthree\nfour\r\n",
        ).content,
      ).toBe("zero\r\none\nTWO\r\nadded\nthree\nfour\r\n")
    })

    test("appends lines with the file's dominant ending", () => {
      expect(Patch.derive("append.txt", [{ oldLines: [], newLines: ["three"] }], "one\r\ntwo\nfour\r\n").content).toBe(
        "one\r\ntwo\nfour\r\nthree\r\n",
      )
    })

    test("adds a missing final newline using the file's CRLF convention", () => {
      expect(
        Patch.derive("no-newline.org", [{ oldLines: ["old"], newLines: ["changed"] }], "first\r\nold").content,
      ).toBe("first\r\nchanged\r\n")
      expect(Patch.derive("no-newline.org", [{ oldLines: [], newLines: ["added"] }], "first\r\nlast").content).toBe(
        "first\r\nlast\r\nadded\r\n",
      )
    })

    test("keeps carriage returns inside line content", () => {
      expect(
        Patch.derive(
          "literal-cr.txt",
          [{ oldLines: ["old"], newLines: ["changed"] }],
          "first\rmiddle\r\nold\r\nlast\r\n",
        ).content,
      ).toBe("first\rmiddle\r\nchanged\r\nlast\r\n")
    })

    test("rewrites a large region whose lines all end alike", () => {
      const before = Array.from({ length: 50_000 }, (_, index) => `old ${index}`)
      const after = Array.from({ length: 50_000 }, (_, index) => `new ${index}`)
      for (const ending of ["\n", "\r\n"])
        expect(
          Patch.derive("large.txt", [{ oldLines: before, newLines: after }], [...before, ""].join(ending)).content,
        ).toBe([...after, ""].join(ending))
    })

    test("rewrites a large mixed-ending region line for line", () => {
      const ending = (index: number) => (index % 2 === 0 ? "\r\n" : "\n")
      const before = Array.from({ length: 50_000 }, (_, index) => `old ${index}`)
      const after = Array.from({ length: 50_000 }, (_, index) => `new ${index}`)
      expect(
        Patch.derive(
          "large.txt",
          [{ oldLines: before, newLines: after }],
          before.map((line, index) => line + ending(index)).join(""),
        ).content,
      ).toBe(after.map((line, index) => line + ending(index)).join(""))
    })

    test("parses CRLF heredoc patches that add files", () => {
      expect(
        parse(
          ["cat <<'EOF'", "*** Begin Patch", "*** Add File: new.txt", "+first", "+second", "*** End Patch", "EOF"].join(
            "\r\n",
          ),
        ),
      ).toEqual([{ type: "add", path: "new.txt", contents: "first\nsecond" }])
    })
  })
})
