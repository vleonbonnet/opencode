import { expect, test } from "bun:test"
import { LineEnding } from "./line-ending.js"

test.each([
  { text: "", expected: "fallback" },
  { text: "a\nb\n", expected: "\n" },
  { text: "a\r\nb\r\n", expected: "\r\n" },
  { text: "a\r\nb\nc\r\n", expected: "\r\n" },
  { text: "a\r\nb\n", expected: "fallback" },
  { text: "a\rb\r", expected: "fallback" },
])("dominant(%j)", ({ text, expected }) => {
  expect(LineEnding.dominant(text, "fallback")).toBe(expected)
})

test("align maps kept lines and in-place replacements to their source lines", () => {
  expect(LineEnding.align(["a", "b", "c"], ["a", "B", "added", "c"])).toEqual([0, 1, undefined, 2])
  expect(LineEnding.align(["a", "b"], ["b"])).toEqual([1])
  expect(LineEnding.align([], ["a"])).toEqual([undefined])
})

test("align pairs lines by position when the inputs are too large to align", () => {
  const before = Array.from({ length: 50_000 }, (_, index) => `old ${index}`)
  const after = Array.from({ length: 50_001 }, (_, index) => `new ${index}`)
  expect(LineEnding.align(["head", ...before, "tail"], ["head", ...after, "tail"])).toEqual([
    0,
    ...before.map((_, index) => index + 1),
    undefined,
    before.length + 1,
  ])
})
