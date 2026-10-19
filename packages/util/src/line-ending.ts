export * as LineEnding from "./line-ending.js"

const crlf = "\r\n"

/** The dominant line ending in text, or fallback when CRLF and LF are equally common (including when neither occurs). */
export function dominant(text: string, fallback: string) {
  const crlfCount = text.split(crlf).length - 1
  const lfCount = text.split("\n").length - 1 - crlfCount
  if (crlfCount === lfCount) return fallback
  return crlfCount > lfCount ? crlf : "\n"
}

// 64 MiB of table cells; a larger middle section pairs its lines by position instead.
const MAX_CELLS = 16 * 1024 * 1024

/**
 * For each line of `after`, the index of the `before` line it keeps (longest common subsequence) or, between kept
 * lines, the line it takes the place of; undefined for lines with no counterpart. Common leading and trailing lines
 * always pair with each other; when what lies between them is too large to align, its lines pair by position.
 */
export function align(before: ReadonlyArray<string>, after: ReadonlyArray<string>) {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  const middle = { before: before.slice(head, before.length - tail), after: after.slice(head, after.length - tail) }
  const inner =
    (middle.before.length + 1) * (middle.after.length + 1) > MAX_CELLS
      ? middle.after.map((_, index) => (index < middle.before.length ? index : undefined))
      : subsequence(middle.before, middle.after)
  return [
    ...Array.from({ length: head }, (_, index) => index),
    ...inner.map((index) => (index === undefined ? undefined : head + index)),
    ...Array.from({ length: tail }, (_, index) => before.length - tail + index),
  ]
}

function subsequence(before: ReadonlyArray<string>, after: ReadonlyArray<string>) {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  const result: (number | undefined)[] = []
  const gap = { before: [] as number[], after: [] as number[] }
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]))
    gap.before = []
    gap.after = []
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result[j++] = i++
      continue
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) gap.before.push(i++)
    else gap.after.push(j++)
  }
  while (i < before.length) gap.before.push(i++)
  while (j < after.length) gap.after.push(j++)
  flush()
  return result
}
