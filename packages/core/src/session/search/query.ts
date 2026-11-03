export * as SessionSearchQuery from "./query.js"

import { SessionSearch } from "@opencode/schema/session-search"
import { MARK_END, MARK_START } from "./ddl.js"

/** A query term: a word or a quoted phrase, matched whole, or a word ending in `*`, matched as a prefix. */
export type Term = { readonly text: string; readonly prefix: boolean }

const SEARCHABLE = /[\p{L}\p{N}]/u
const MIN_PREFIX = 2

/**
 * Reads a user's query: whitespace separates words, double quotes group a phrase (an unterminated quote runs to the
 * end), and a word ending in `*` matches as a prefix when at least two characters precede it. Terms with no letter
 * or digit cannot match anything and are dropped. Nothing in the query is FTS syntax.
 */
export function terms(query: string): Term[] {
  const result: Term[] = []
  const pattern = /"([^"]*)"?|([^\s"]+)/g
  for (const match of query.matchAll(pattern)) {
    const phrase = match[1]
    if (phrase !== undefined) {
      const text = phrase.trim()
      if (SEARCHABLE.test(text)) result.push({ text, prefix: false })
      continue
    }
    const word = match[2]!
    const base = word.replace(/\*+$/, "")
    if (!SEARCHABLE.test(base)) continue
    result.push({ text: base, prefix: base !== word && [...base].length >= MIN_PREFIX })
  }
  return result
}

/** The FTS5 expression matching every term: each one quoted, so the tokenizer, never the FTS parser, reads it. */
export function expression(input: ReadonlyArray<Term>) {
  return input.map((term) => `"${term.text.replaceAll('"', '""')}"${term.prefix ? "*" : ""}`).join(" ")
}

const ELLIPSIS = "…"
const CONTEXT_BEFORE = 60

/**
 * Turns an FTS5 snippet, whose matches are wrapped in {@link MARK_START} and {@link MARK_END}, into one line of at
 * most {@link SessionSearch.MAX_SNIPPET_LENGTH} characters with the matches located. Runs of whitespace become one
 * space. A longer line keeps the context before its first match and is cut with an ellipsis.
 */
export function snippet(raw: string): SessionSearch.Snippet {
  const characters: string[] = []
  const matches: { start: number; end: number }[] = []
  let open = false
  let start: number | undefined
  let space = false
  for (const character of raw) {
    if (character === MARK_START) {
      open = true
      start = undefined
      continue
    }
    if (character === MARK_END) {
      if (open && start !== undefined) matches.push({ start, end: characters.length })
      open = false
      continue
    }
    if (/\s/u.test(character)) {
      space = true
      continue
    }
    if (space && characters.length > 0) characters.push(" ")
    space = false
    if (open && start === undefined) start = characters.length
    characters.push(character)
  }
  const max = SessionSearch.MAX_SNIPPET_LENGTH
  if (characters.length <= max) return { text: characters.join(""), matches }
  const first = matches[0]?.start ?? 0
  const from = Math.max(0, Math.min(first - CONTEXT_BEFORE, characters.length - max))
  const head = from > 0 ? 1 : 0
  const to = Math.min(characters.length, from + max - head)
  const tail = to < characters.length ? 1 : 0
  const cut = to - tail
  const text = (head ? ELLIPSIS : "") + characters.slice(from, cut).join("") + (tail ? ELLIPSIS : "")
  return {
    text,
    matches: matches
      .filter((match) => match.start >= from && match.end <= cut)
      .map((match) => ({ start: match.start - from + head, end: match.end - from + head })),
  }
}
