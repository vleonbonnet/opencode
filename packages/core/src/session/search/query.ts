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
  return input.map(quote).join(" ")
}

/** The FTS5 expression matching any of the terms. */
export function anyOf(input: ReadonlyArray<Term>) {
  return input.map(quote).join(" OR ")
}

const quote = (term: Term) => `"${term.text.replaceAll('"', '""')}"${term.prefix ? "*" : ""}`

/** A query over whole sessions: terms combined by AND, OR and NOT. */
export type Expression =
  | { readonly type: "term"; readonly term: Term }
  | { readonly type: "and"; readonly items: ReadonlyArray<Expression> }
  | { readonly type: "or"; readonly items: ReadonlyArray<Expression> }
  | { readonly type: "not"; readonly item: Expression }

type Token =
  | { readonly type: "open" | "close" | "or" | "not" }
  | { readonly type: "phrase"; readonly text: string }
  | { readonly type: "word"; readonly text: string }

function tokens(query: string): Token[] {
  const result: Token[] = []
  const pattern = /(\s+)|(\()|(\))|"([^"]*)"?|(-)(?=[^\s)])|([^\s"()]+)/g
  for (const match of query.matchAll(pattern)) {
    if (match[1] !== undefined) continue
    if (match[2] !== undefined) result.push({ type: "open" })
    else if (match[3] !== undefined) result.push({ type: "close" })
    else if (match[4] !== undefined) result.push({ type: "phrase", text: match[4] })
    else if (match[5] !== undefined) result.push({ type: "not" })
    else if (match[6] === "OR") result.push({ type: "or" })
    else result.push({ type: "word", text: match[6]! })
  }
  return result
}

const join = (type: "and" | "or", items: Expression[]): Expression | undefined =>
  items.length === 0 ? undefined : items.length === 1 ? items[0] : { type, items }

/**
 * Reads a query over whole sessions. Terms are read as {@link terms} reads them: words, double-quoted phrases (an
 * unterminated quote runs to the end) and prefixes ending in `*`. Terms side by side must all match; `OR`, in
 * capitals, between them matches either; a leading `-` excludes the term or group after it; parentheses group (an
 * unclosed one runs to the end, a stray closing one is ignored). Terms with no letter or digit, and operators left
 * without an operand, are dropped. Nothing in the query is FTS syntax. Undefined when no term is left.
 */
export function parse(query: string): Expression | undefined {
  const input = tokens(query)
  let position = 0
  let depth = 0
  const disjunction = (): Expression | undefined => {
    const items: Expression[] = []
    while (position < input.length) {
      const item = conjunction()
      if (item) items.push(item)
      if (input[position]?.type === "or") position++
      else break
    }
    return join("or", items)
  }
  const conjunction = (): Expression | undefined => {
    const items: Expression[] = []
    while (position < input.length) {
      const next = input[position]!
      if (next.type === "or") break
      if (next.type === "close") {
        if (depth > 0) break
        position++
        continue
      }
      const item = unary()
      if (item) items.push(item)
    }
    return join("and", items)
  }
  const unary = (): Expression | undefined => {
    const next = input[position]
    if (next?.type === "not") {
      position++
      const item = unary()
      return item && (item.type === "not" ? item.item : { type: "not", item })
    }
    return primary()
  }
  const primary = (): Expression | undefined => {
    const next = input[position]
    if (!next || next.type === "or" || next.type === "close") return undefined
    position++
    if (next.type === "open") {
      depth++
      const item = disjunction()
      depth--
      if (input[position]?.type === "close") position++
      return item
    }
    if (next.type !== "phrase" && next.type !== "word") return undefined
    const [term] = terms(next.type === "phrase" ? `"${next.text}"` : next.text)
    return term && { type: "term", term }
  }
  return disjunction()
}

/** Every term of `input`, once each, in the order they come. */
export function termsOf(input: Expression): Term[] {
  const seen = new Map<string, Term>()
  const visit = (node: Expression) => {
    if (node.type === "term") {
      if (!seen.has(key(node.term))) seen.set(key(node.term), node.term)
    } else if (node.type === "not") visit(node.item)
    else node.items.forEach(visit)
  }
  visit(input)
  return [...seen.values()]
}

/** The terms of `input` a matching session holds rather than lacks: those under no `-`, or under two. */
export function positives(input: Expression): Term[] {
  const seen = new Map<string, Term>()
  const visit = (node: Expression, negated: boolean) => {
    if (node.type === "term") {
      if (!negated && !seen.has(key(node.term))) seen.set(key(node.term), node.term)
    } else if (node.type === "not") visit(node.item, !negated)
    else node.items.forEach((item) => visit(item, negated))
  }
  visit(input, false)
  return [...seen.values()]
}

/** Whether `input` holds when `has` tells which terms a session holds. */
export function evaluate(input: Expression, has: (term: Term) => boolean): boolean {
  switch (input.type) {
    case "term":
      return has(input.term)
    case "not":
      return !evaluate(input.item, has)
    case "and":
      return input.items.every((item) => evaluate(item, has))
    case "or":
      return input.items.some((item) => evaluate(item, has))
  }
}

/** Identifies a term: its text, lowercased, and whether it is a prefix. */
export const key = (term: Term) => `${term.prefix ? "*" : "="}${term.text.toLowerCase()}`

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
