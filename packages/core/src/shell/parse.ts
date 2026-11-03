export * as ShellParse from "./parse.js"

import { Effect, Result } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ShellPowerShell } from "./powershell.js"
import { ShellScan } from "./scan.js"
import { ShellSelect } from "./select.js"
import { ShellUnwrap } from "./unwrap.js"
import { Wildcard } from "../util/wildcard.js"

type Part = { type: string; text: string; raw: string; unquotedTilde?: boolean }
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const POWERSHELL_LITERAL_FLAG_RE =
  /^-(?:lp|l(?:i(?:t(?:e(?:r(?:a(?:l(?:p(?:a(?:t(?:h)?)?)?)?)?)?)?)?)?)?|psp(?:a(?:t(?:h)?)?)?):?$/i
const POWERSHELL_STACK_FLAG_RE = /^-(?:stack(?:name|nam|na|n)?|st):?$/i

export type Result = {
  // Each command found: the resource as written; the prefix an approval saves, absent when no pattern would match
  // this command alone; and the other spellings of the same command, which the rules are checked against together
  // with the resource, absent when it has none.
  commands: Array<{ resource: string; save?: string; alternates?: string[] }>
  directories: string[]
}

const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}
const PREFIX_LENGTH = Math.max(...Object.values(ARITY))

// A command the portable scanner cannot read fails the scan, and so does one nesting scripts too deep or running too
// many commands to check.
export function scan(command: string, shell: string, cwd: string): Effect.Effect<Result, Error> {
  return Effect.suspend(() => {
    const powershell = ShellSelect.ps(shell)
    // The commands of a script, for what it does with what it reads.
    const commands = (script: Script) => {
      const nested = ShellScan.statements(script.text, script.dialect)
      if (nested.kind === "opaque") return
      return nested.commands
        .filter((item) => !item.declaration && !item.assignment && item.redirectPrefixEnd === undefined)
        .map((item) => ShellUnwrap.unwrap(portableWords(item), script.dialect))
    }
    // The commands of a script handed to PowerShell, as those of a PowerShell command are read.
    const powershellCommands = (text: string) => {
      const nested = ShellScan.scanPowerShell(text)
      if (nested.kind === "opaque") return
      return nested.commands
        .filter((item) => !item.declaration && !item.assignment && !foreachBlock(item))
        .map((item) => ({ text: item.resource, words: portableWords(item) }))
    }
    const options: Options = {
      powershell,
      posix: posix(shell),
      cwd,
      shell,
      dialect: dialect(shell),
      commands,
      powershellCommands,
    }
    const result = powershell
      ? statementsOf(ShellScan.scanPowerShell(command))
      : ShellScan.statements(command, options.dialect)
    if (result.kind === "opaque")
      return Effect.fail(new Error(`Portable shell scanner cannot analyze command: ${result.reason}`))

    const output = collector()
    const scripts = portableCommands(output, result, options)
    // A script is read in the dialect of the shell that runs it, and refused as the command would be when it cannot be.
    follow(output, scripts, (script) => {
      const nested = ShellScan.statements(script.text, script.dialect)
      if (nested.kind === "opaque") {
        output.fail(`Portable shell scanner cannot analyze command: ${nested.reason} in a script it runs`)
        return []
      }
      return portableCommands(output, nested, { ...options, powershell: false, posix: true, dialect: script.dialect })
    })
    return finish(output)
  })
}

type Options = {
  powershell: boolean
  posix: boolean
  cwd: string
  shell: string
  dialect: ShellUnwrap.Dialect
  // The commands of a script, as unwrapped; none when the script cannot be read.
  commands: (script: Script) => ShellUnwrap.Unwrapped[] | undefined
  // The commands of a script handed to PowerShell, each as written and as its words; none when it cannot be read.
  powershellCommands: (text: string) => PowerShellCommand[] | undefined
}
type PowerShellCommand = { text: string; words: string[] }
type Script = ShellUnwrap.Script

type Range = { start: number; end: number }

// TEXT, which starts at START, without the RANGES that start inside it, up to its end: a body's range can run past
// the end of a command's text only by the blank lines trimmed from that text.
function without(text: string, start: number, ranges: readonly Range[]) {
  const end = start + text.length
  const inside = ranges.filter((range) => range.start >= start && range.start < end).sort((a, b) => a.start - b.start)
  if (!inside.length) return text
  const state = { text: "", at: start }
  for (const range of inside) {
    if (range.start < state.at) continue
    state.text += text.slice(state.at - start, range.start - start)
    state.at = Math.min(range.end, end)
  }
  return state.text + text.slice(state.at - start)
}

type Portable = Extract<ShellScan.Statements, { kind: "scanned" }>
type Command = Portable["commands"][number]

// A PowerShell scan has no heredocs to follow.
function statementsOf(result: ShellScan.Result): ShellScan.Statements {
  return result.kind === "opaque" ? result : { ...result, heredocs: [], places: new Map(), downstream: new Map() }
}

// Whether a PowerShell ITEM is a bare statement-head foreach block, which the shipped PowerShell grammar treats as
// control flow rather than a command.
function foreachBlock(item: Command) {
  const words = portableWords(item)
  return (
    item.statementHead === true &&
    /^foreach(?:-|$)/i.test(words[0] ?? "") &&
    words.length > 1 &&
    words.slice(1).every((word) => word.startsWith("{"))
  )
}

// Adds the commands the portable scanner found and returns the script strings they hand to a shell.
function portableCommands(output: Collector, scanned: Portable, options: Options) {
  const { powershell, cwd, shell } = options
  const heredocs = options.posix ? portableHeredocs(scanned, options) : { spans: [], reads: [] }
  const scripts: Script[] = []
  const reads = [...heredocs.reads]
  // Statements of assignments, by where they start: one with redirects is also reported as a redirect statement.
  const assigned = new Set(
    scanned.commands.flatMap((item) => {
      const place = item.assignment ? scanned.places.get(item) : undefined
      return place ? [`${place.text}:${place.start}`] : []
    }),
  )
  for (const item of scanned.commands) {
    // The data-only heredoc bodies in the text the command was read from are left out of its text and words.
    const place = scanned.places.get(item)
    const spans = place ? heredocs.spans.filter((span) => span.text === place.text) : []
    const kept = place ? without(item.resource, place.start, spans) : item.resource
    // Trimmed as the legacy resource is once its bodies are left out.
    const resource = kept === item.resource ? kept : kept.trim()
    const cutWords = (words: readonly string[]) =>
      place ? words.map((word, index) => without(word, place.words[index], spans)) : words
    // A statement of redirects alone runs no command; its text is checked, saved up to its first redirect. With
    // assignments, it is checked as the assignment statement it is, its redirects in its text.
    if (item.redirectPrefixEnd !== undefined) {
      if (place && assigned.has(`${place.text}:${place.start}`)) continue
      const head = item.resource.slice(0, item.redirectPrefixEnd)
      const next = item.resource[item.redirectPrefixEnd]
      const separator = next === "\t" || next === "\n" ? next : " "
      output.command(resource, `${head}${separator}*`)
      continue
    }
    // Declarations and assignments are checked as written, which the substitutions within them are as well.
    if (item.declaration || item.assignment) {
      if (options.posix)
        variables(
          output,
          resource,
          cutWords(portableWords(item)),
          Boolean(item.declaration),
          redirects(item, place, spans),
        )
      continue
    }
    const words = portableWords(item)
    if (powershell && foreachBlock(item)) continue
    // Words before the first redirect, as PowerShell reads a directory change.
    const leading = item.redirectWordCount === undefined ? words : words.slice(0, item.redirectWordCount)
    const parts = powershell
      ? leading.flatMap((raw, index): Part[] => {
          const text =
            !raw.includes("`$") && /['"`]/.test(raw) ? (item.words[index] ?? raw) : raw.replaceAll("`$", "\0")
          if (!/^-[A-Za-z_?][\w?-]*(?::|$)/.test(raw)) return [{ type: "word", text, raw }]
          const colon = text.indexOf(":")
          if (colon >= 0) {
            const rawColon = raw.indexOf(":")
            return colon + 1 < text.length
              ? [
                  { type: "command_parameter", text: text.slice(0, colon), raw: raw.slice(0, rawColon) },
                  { type: "word", text: text.slice(colon + 1), raw: rawColon >= 0 ? raw.slice(rawColon + 1) : raw },
                ]
              : [{ type: "command_parameter", text: text.slice(0, colon), raw }]
          }
          return [{ type: "command_parameter", text, raw }]
        })
      : item.rawWords.map((raw, index): Part => {
          const word = item.words[index] ?? raw
          return {
            type: "word",
            text: isStaticBashWord(raw) ? word.replaceAll("$", "\0") : "$",
            raw,
            unquotedTilde: raw.startsWith("~"),
          }
        })
    const directoryCommand = unwrapDirectoryCommand(powershell ? leading : item.rawWords, parts, powershell)
    if (directoryCommand) {
      const resolved = directoryArgs(directoryCommand, powershell, cwd, shell)
      output.result.directories.push(...resolved.directories)
      // A directory change whose target is known is checked as a directory; any other is checked as a command too.
      if (directoryCommand === parts && resolved.complete) continue
    }
    const selected = prefix(words.slice(0, PREFIX_LENGTH))
    const conventional = `${selected.join(" ")} *`
    const end = item.wordEnds?.[selected.length - 1]
    // Keep existing grants stable unless normalized spacing loses the original source boundary.
    const save =
      !powershell || end === undefined || Wildcard.match(item.resource, conventional)
        ? conventional
        : item.resource[end] === "("
          ? `${item.resource.slice(0, end)}(*`
          : (() => {
              const boundary =
                item.wordEnds?.find(
                  (value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value])),
                ) ?? end
              const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0]
              return `${item.resource.slice(0, boundary)}${separator ?? " "}*`
            })()
    if (!options.posix) {
      if (powershell) powershellCommand(output, { text: resource, words }, save, options)
      else output.command(resource, save)
      continue
    }
    const assignments = place?.assignments.map((item) => without(item.raw, item.start, spans)) ?? []
    const found = expand(
      output,
      resource,
      save,
      cutWords(words),
      options.dialect,
      assignments,
      false,
      redirects(item, place, spans),
    )
    scripts.push(...found.scripts)
    powershellScripts(output, found.powershell, options)
    const downstream = scanned.downstream.get(item)
    if (downstream)
      reads.push(
        ...piped(
          found,
          () =>
            downstream
              .filter((next) => !next.declaration && !next.assignment && next.redirectPrefixEnd === undefined)
              .map((next) => ShellUnwrap.unwrap(portableWords(next), options.dialect)),
          options,
        ),
      )
  }
  return [...emit(output, reads, options), ...scripts]
}

// The words a command runs with, as written. Bash takes one word after a redirect operator as its target, which is
// not among them; the words after it are the command's (`rm >/dev/null -rf build` runs `rm -rf build`).
function portableWords(item: Command) {
  return item.rawWords
}

// What the heredocs and here-strings of a scan hold: the spans of the heredoc bodies, with their closing delimiter,
// that are only data and are left out of the text rules see, and what their readers do with each. Declarations and
// assignments among the readers only store what they read, as the legacy walk has them.
function portableHeredocs(scanned: Portable, options: Options) {
  const spans: ShellScan.Span[] = []
  const reads: Read[] = []
  const commands = (items: readonly Command[]) =>
    items
      .filter((item) => !item.declaration && !item.assignment && item.redirectPrefixEnd === undefined)
      .map((item) => ShellUnwrap.unwrap(portableWords(item), options.dialect))
  for (const heredoc of scanned.heredocs) {
    const later = scanned.commands.filter((item) => {
      const place = scanned.places.get(item)
      return place?.text === heredoc.text && place.start > heredoc.at && !heredoc.readers.includes(item)
    })
    // The body its reader gets, without the leading tabs of its lines for `<<-`.
    const text = heredoc.tabs ? heredoc.body.replace(/^\t+/gm, "") : heredoc.body
    const result = read(
      { text, readers: commands(heredoc.readers), targets: heredoc.targets, later: commands(later) },
      options,
    )
    reads.push(result)
    if (heredoc.quoted && !heredoc.substituted && result.data) spans.push(...heredoc.spans)
  }
  return { spans, reads }
}

// An input commands read: a heredoc body, a here-string, or the static text echo or printf writes into a pipeline,
// with the commands reading it, the files its statement writes it to, and the commands after it in the same script,
// which may run those files.
type Input = {
  text: string
  readers: readonly ShellUnwrap.Unwrapped[]
  targets: readonly string[]
  later: readonly ShellUnwrap.Unwrapped[]
}

// What the commands reading an input do with it: the scripts to check that run it, its text to check whole when an
// interpreter runs it and, when that is PowerShell, command by command as well, the commands composed from it, and
// whether it is only data.
type Read = { data: boolean; scripts: Script[]; texts: string[]; powershell: string[]; views: ShellUnwrap.View[] }

// What the commands reading INPUT do with it (see ShellUnwrap.reading). The commands of a -c script reading it read
// it in turn, and a file it is written to that a later command runs is run as a script, as a program, or as its
// first line says. It is data only when nothing does any of that.
function read(input: Input, options: Options, depth = 1): Read {
  const reading = ShellUnwrap.reading(input.readers, input.text, options.dialect)
  const result: Read = {
    data: !reading.code,
    scripts: [...reading.scripts],
    texts: reading.text ? [input.text] : [],
    powershell: reading.powershell ? [input.text] : [],
    views: [...reading.views],
  }
  for (const script of reading.nested) {
    const commands = depth < ShellUnwrap.MAX_SCRIPT_DEPTH ? options.commands(script) : undefined
    if (!commands) {
      result.data = false
      continue
    }
    const inner = read({ text: input.text, readers: commands, targets: [], later: [] }, options, depth + 1)
    result.data &&= inner.data
    result.scripts.push(...inner.scripts)
    result.texts.push(...inner.texts)
    result.powershell.push(...inner.powershell)
    result.views.push(...inner.views)
  }
  const tees = input.readers.flatMap((item) =>
    item.views.flatMap((view) =>
      view.name === "tee" ? view.args.filter((arg) => !ShellUnwrap.dynamic(arg) && !arg.startsWith("-")) : [],
    ),
  )
  const targets = [...input.targets, ...tees.map(ShellUnwrap.literal)].map(normal)
  for (const command of input.later)
    for (const view of command.views) {
      const run = ShellUnwrap.executes(view, options.dialect)
      if (!run || !targets.includes(normal(run.path))) continue
      result.data = false
      const shell = "dialect" in run ? run.dialect : "program" in run ? ShellUnwrap.shebang(input.text) : undefined
      if (shell) result.scripts.push({ text: input.text, dialect: shell })
      else result.texts.push(input.text)
    }
  // Read by shells of several dialects, a script is read as POSIX, which is sound for each of them.
  const dialects = new Set(result.scripts.filter((item) => item.text === input.text).map((item) => item.dialect))
  result.scripts = [
    ...(dialects.size ? [{ text: input.text, dialect: dialects.size > 1 ? "posix" : [...dialects][0] }] : []),
    ...result.scripts.filter((item) => item.text !== input.text),
  ]
  return result
}

function normal(file: string) {
  return path.posix.normalize(file)
}

// What the commands downstream of FOUND do with the text it writes, when it is an echo or printf of static words.
function piped(found: ShellUnwrap.Unwrapped, downstream: () => ShellUnwrap.Unwrapped[], options: Options) {
  const texts = found.views.flatMap((view) => ShellUnwrap.output(view) ?? [])
  if (!texts.length) return []
  const readers = downstream()
  return texts.map((text) => read({ text, readers, targets: [], later: [] }, options))
}

// Emits what READS found: the text of each input an interpreter runs, and each command composed from one, with what
// it runs. Returns the scripts to check that run an input.
function emit(output: Collector, reads: readonly Read[], options: Options) {
  const scripts: Script[] = []
  for (const item of reads) {
    for (const text of item.texts) output.extra(text, exact(text))
    powershellScripts(output, item.powershell, options)
    for (const view of item.views) {
      const found = expand(
        output,
        ShellUnwrap.text(view),
        undefined,
        [view.program, ...view.args],
        options.dialect,
        [],
        true,
      )
      scripts.push(...found.scripts)
      powershellScripts(output, found.powershell, options)
    }
    scripts.push(...item.scripts)
  }
  return scripts
}

// Bash-family shells; PowerShell and cmd.exe give runners, quoting and scripts other meanings.
function posix(shell: string) {
  return !ShellSelect.ps(shell) && ShellSelect.name(shell) !== "cmd"
}

// The dialect a shell's commands are read in.
function dialect(shell: string): ShellUnwrap.Dialect {
  const name = ShellSelect.name(shell)
  return name === "bash" || name === "zsh" ? name : "posix"
}

type Collector = ReturnType<typeof collector>

// Permission resources in the order they are found. A command as written is always listed, as each command was
// before; what it runs is listed unless the same resource already is. Each carries the other spellings of that one
// command, apart from the resource itself. A command that cannot be checked fails the scan, and `misread` tells the
// legacy scan that Tree-sitter read a heredoc otherwise than bash.
function collector() {
  const result: Result = { commands: [], directories: [] }
  const seen = new Set<string>()
  const failures: string[] = []
  const push = (resource: string, save: string | undefined, alternates: readonly string[]) => {
    const others = [...new Set(alternates)].filter((spelling) => spelling !== resource)
    result.commands.push({
      resource,
      ...(save === undefined ? {} : { save }),
      ...(others.length ? { alternates: others } : {}),
    })
  }
  return {
    result,
    failures,
    misread: false,
    command(resource: string, save: string | undefined, alternates: readonly string[] = []) {
      seen.add(resource)
      push(resource, save, alternates)
    },
    extra(resource: string, save: string | undefined, alternates: readonly string[] = []) {
      if (seen.has(resource)) return
      seen.add(resource)
      push(resource, save, alternates)
    },
    // Lists RESOURCE as `extra` does, or adds ALTERNATES to it when it is listed already.
    respelled(resource: string, save: string | undefined, alternates: readonly string[]) {
      const listed = result.commands.find((item) => item.resource === resource)
      if (!listed) {
        seen.add(resource)
        return push(resource, save, alternates)
      }
      const others = [...new Set([...(listed.alternates ?? []), ...alternates])].filter((item) => item !== resource)
      if (others.length) listed.alternates = others
    },
    fail(reason: string) {
      failures.push(reason)
    },
  }
}

function finish(output: Collector) {
  if (output.failures.length) return Effect.fail(new Error(output.failures[0]))
  return Effect.succeed(output.result)
}

// Emits the command written as RESOURCE, with the other spellings of the command its WORDS run, and each command it
// runs behind a runner (`sudo`, `env`, `xargs`, …), under a bare program name (`/bin/rm` as `rm`) or as a script
// handed to a shell that is not POSIX, together with the ASSIGNMENTS prefixed to it and those its runners pass, each
// a resource of its own. Rules match command text, so each is checked on its own: this only adds resources and
// spellings, so it can add a prompt or a denial, never lift one. FALLBACK is saved for a statement with no command,
// and ONCE lists the command only when it is not listed yet. Returns what the command runs, with the script strings
// it hands to a POSIX shell.
function expand(
  output: Collector,
  resource: string,
  fallback: string | undefined,
  words: readonly string[],
  dialect: ShellUnwrap.Dialect,
  assignments: readonly string[] = [],
  once = false,
  redirected = "",
) {
  // The legacy grammar gives a statement of assignments with a redirect an empty command name.
  const found = ShellUnwrap.unwrap(words[0] ? words : [], dialect)
  if (found.truncated) output.fail("Shell command runs too many nested commands to check")
  const [head, ...rest] = found.views
  const save = head ? saved(head) : fallback
  const alternates = head ? withRedirects(ShellUnwrap.spellings(head), redirected) : []
  if (once) output.extra(resource, save, alternates)
  else output.command(resource, save, alternates)
  for (const word of [...assignments, ...found.assignments])
    output.extra(word, ShellUnwrap.assignment(word), spelled([word]))
  if (head) renamed(output, head)
  for (const view of rest) {
    if (view.implied || !view.program || CWD.has(view.name)) continue
    output.extra(ShellUnwrap.text(view), saved(view), ShellUnwrap.spellings(view))
    renamed(output, view)
  }
  for (const text of found.texts) output.extra(text, exact(text))
  return found
}

// Emits COMMAND of a PowerShell script DEPTH scripts deep, with the spelling of the cmdlet it runs, saved as SAVE,
// then reads the scripts it hands to PowerShell in turn.
function powershellCommand(
  output: Collector,
  command: PowerShellCommand,
  save: string | undefined,
  options: Options,
  depth = 0,
) {
  const spellings = ShellPowerShell.spellings(command.words)
  if (depth === 0) output.command(command.text, save, spellings)
  else output.respelled(command.text, save, spellings)
  powershellScripts(output, ShellUnwrap.powershellScripts(command.words), options, depth + 1)
}

// Reads each script of TEXTS handed to PowerShell DEPTH scripts deep command by command, as a POSIX script is read,
// while the script stays checked whole as written as well. One that cannot be read is checked whole only.
function powershellScripts(output: Collector, texts: readonly string[], options: Options, depth = 1) {
  if (!texts.length) return
  if (depth > ShellUnwrap.MAX_SCRIPT_DEPTH)
    return output.fail(`Shell command nests scripts more than ${ShellUnwrap.MAX_SCRIPT_DEPTH} levels deep`)
  for (const text of texts)
    for (const command of options.powershellCommands(text) ?? [])
      if (command.words.length) powershellCommand(output, command, exact(command.text), options, depth)
}

// The command as its bare program name runs it, when that differs from the program as written.
function renamed(output: Collector, view: ShellUnwrap.View) {
  const bare = ShellUnwrap.renamed(view)
  if (bare) output.extra(ShellUnwrap.text(bare), saved(bare), ShellUnwrap.spellings(bare))
}

// The prefix an approval of a command saves: its words, unquoted when every one is static, as far as the arity of
// its program reaches, so the save matches the spelling the rules check; none when one of those words is a glob,
// whose expansion no saved pattern can name.
function saved(view: ShellUnwrap.View) {
  const words = ShellUnwrap.words(view)
  const length = prefix([view.name, ...words.slice(1)].slice(0, PREFIX_LENGTH)).length
  const head = words.slice(0, length)
  return head.some((word) => /[*?]/.test(word)) ? undefined : `${head.join(" ")} *`
}

// Emits a statement that sets or clears variables, RESOURCE as written from WORDS, with the REDIRECTED files: one
// resource for each variable, saved as that variable alone (`export NAME=*`, `unset NAME`) or, for a plain
// assignment, as that assignment (`NAME=value`), so approving one never covers another. A statement of one variable
// is that resource as written, and one of none is saved exactly; one of several is listed as written as well when its
// text holds more than its words, such as a redirect.
function variables(
  output: Collector,
  resource: string,
  words: readonly string[],
  declaration: boolean,
  redirected = "",
) {
  const statements = declaration
    ? ShellUnwrap.declarations(words)
    : words.map((word) => ({ words: [word], save: ShellUnwrap.assignment(word) }))
  if (statements.length === 0)
    return output.command(resource, exact(resource), withRedirects(spelled(words), redirected))
  if (statements.length === 1) {
    // An assignment's approval covers it with the files it is redirected to, not with others.
    const save =
      declaration || !redirected
        ? statements[0].save
        : statements[0].save && exact(`${statements[0].save} ${redirected}`)
    return output.command(resource, save, withRedirects(spelled(statements[0].words), redirected))
  }
  if (!bare(resource, words)) output.command(resource, exact(resource))
  for (const statement of statements)
    output.command(statement.words.join(" "), statement.save, spelled(statement.words))
}

// The redirects of ITEM as written, in order: the text of its resource outside its words and the assignments
// prefixed to it, without the data-only heredoc bodies of SPANS; empty when its place is unknown.
function redirects(item: Command, place: ShellScan.Place | undefined, spans: readonly ShellScan.Span[]) {
  if (!place) return ""
  const covered = [
    ...item.rawWords.map((raw, index) => ({ start: place.words[index], end: place.words[index] + raw.length })),
    ...place.assignments.map((assignment) => ({
      start: assignment.start,
      end: assignment.start + assignment.raw.length,
    })),
  ]
    .filter((range) => range.start !== undefined && !Number.isNaN(range.end))
    .sort((a, b) => a.start - b.start)
  const end = place.start + item.resource.length
  const texts: string[] = []
  let at = place.start
  for (const range of [...covered, { start: end, end }]) {
    if (range.start > at)
      texts.push(without(item.resource.slice(at - place.start, range.start - place.start), at, spans))
    at = Math.max(at, range.end)
  }
  return texts
    .map((text) => text.replace(/\\\n/g, " ").trim())
    .filter((text) => text.length > 0)
    .join(" ")
}

// SPELLINGS of a command with the redirects it is written with, so a spelling never stands for the command without
// the files it reads or writes: an approval of `cat` does not cover `cat > file`.
function withRedirects(spellings: readonly string[], redirected: string) {
  return redirected ? spellings.map((spelling) => `${spelling} ${redirected}`) : [...spellings]
}

// The spellings of WORDS: as written, and unquoted when every one is static.
function spelled(words: readonly string[]) {
  const text = words.join(" ")
  return words.some(ShellUnwrap.dynamic) ? [text] : [text, words.map(ShellUnwrap.literal).join(" ")]
}

// Whether TEXT is WORDS alone, with nothing but blanks and line continuations between them.
function bare(text: string, words: readonly string[]) {
  let at = 0
  for (const word of words) {
    at += /^(?:[ \t]|\\\n)*/.exec(text.slice(at))![0].length
    if (!text.startsWith(word, at)) return false
    at += word.length
  }
  return /^(?:[ \t]|\\\n)*$/.test(text.slice(at))
}

// A pattern matching TEXT alone, when no wildcard in it would match more.
function exact(text: string) {
  return /[*?]/.test(text) ? undefined : text
}

// Script strings are checked command by command in the order they are found, down to MAX_SCRIPT_DEPTH levels of
// nesting; a command nesting one deeper cannot be checked, so the scan fails.
function follow(output: Collector, scripts: readonly Script[], visit: (script: Script) => Script[]) {
  const queue = scripts.map((script) => ({ script, depth: 1 }))
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]
    if (entry.depth > ShellUnwrap.MAX_SCRIPT_DEPTH) {
      output.fail(`Shell command nests scripts more than ${ShellUnwrap.MAX_SCRIPT_DEPTH} levels deep`)
      return
    }
    queue.push(...visit(entry.script).map((script) => ({ script, depth: entry.depth + 1 })))
  }
}

function unwrapDirectoryCommand(rawWords: string[], parts: Part[], powershell: boolean) {
  const head = powershell ? rawWords[0]?.toLowerCase() : rawWords[0]
  if (CWD.has(head ?? "")) return parts
  if (powershell) return
  let index = 0
  while (rawWords[index] === "builtin" || rawWords[index] === "command") {
    const wrapper = rawWords[index]
    index++
    while (rawWords[index]?.startsWith("-")) {
      const flag = rawWords[index]
      index++
      if (flag === "--") break
      if (wrapper === "command" && /^-[p]*[vV]/.test(flag)) return
    }
  }
  return index > 0 && CWD.has(rawWords[index] ?? "") ? parts.slice(index) : undefined
}

function isStaticBashWord(raw: string) {
  let quote: "'" | '"' | "$'" | undefined
  let segmentStarted = false
  let segmentLeadingDot = false
  let segmentGlob = false
  let hasAnsiEscape = false
  let hasUnquotedGlob = false
  const braces: boolean[] = []
  const recordChar = (char: string, unquotedGlob = false) => {
    if (unquotedGlob) hasUnquotedGlob = true
    if (hasAnsiEscape && hasUnquotedGlob) return false
    if (char === "/") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return true
    }
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    if (unquotedGlob) segmentGlob = true
    return !(segmentLeadingDot && segmentGlob)
  }

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    if (quote === "'") {
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    if (quote === "$'") {
      if (char === "\\") {
        hasAnsiEscape = true
        if (hasUnquotedGlob) return false
        index++
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (!recordChar(char)) return false
      continue
    }
    if (quote === '"') {
      if (char === "\\" && '$`"\\\n'.includes(next)) {
        index++
        if (next !== "\n" && !recordChar(next)) return false
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === "`" || (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1))))
        return false
      if (!recordChar(char)) return false
      continue
    }
    if (char === "\\") {
      index++
      if (next !== "\n" && !recordChar(next)) return false
      continue
    }
    if (char === "'") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }
    if (char === "$" && next === "'") {
      quote = "$'"
      index++
      continue
    }
    if (char === "$" && next === '"') {
      quote = '"'
      index++
      continue
    }
    if (
      char === "`" ||
      ((char === "<" || char === ">" || char === "=") && next === "(") ||
      (char === "$" && (/[A-Za-z_0-9@*#?$!({[-]/.test(next) || raw.startsWith("\\\n", index + 1)))
    )
      return false
    if (char === "{") {
      braces.push(false)
      if (!recordChar(char)) return false
      continue
    }
    if (braces.length > 0 && (char === "," || (char === "." && next === "."))) {
      braces[braces.length - 1] = true
    }
    if (char === "}" && braces.length > 0) {
      if (braces.pop()) return false
      if (!recordChar(char)) return false
      continue
    }
    if (!recordChar(char, char === "*" || char === "?" || char === "[")) return false
  }
  return quote === undefined
}

function hasPowerShellDotWildcard(raw: string) {
  let quote: "'" | '"' | undefined
  let segmentStarted = false
  let segmentLeadingDot = false
  let segmentGlob = false
  let hasQuoteEscape = false
  let hasUnquotedGlob = false
  const recordChar = (char: string, unquotedGlob = false) => {
    if (unquotedGlob) hasUnquotedGlob = true
    if (hasQuoteEscape && hasUnquotedGlob) return true
    if (char === "/" || char === "\\") {
      segmentStarted = false
      segmentLeadingDot = false
      segmentGlob = false
      return false
    }
    if (!segmentStarted) {
      segmentStarted = true
      segmentLeadingDot = char === "."
    }
    if (unquotedGlob) segmentGlob = true
    return segmentLeadingDot && segmentGlob
  }

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1] ?? ""
    if (quote === "'") {
      if (char === "'" && next === "'") {
        index++
        if (recordChar("'")) return true
        continue
      }
      if (char === "'") {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    if (quote === '"') {
      if (char === "`") {
        hasQuoteEscape = true
        if (hasUnquotedGlob) return true
        index++
        continue
      }
      if (char === '"' && next === '"') {
        index++
        if (recordChar('"')) return true
        continue
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (recordChar(char)) return true
      continue
    }
    if (char === "`") {
      index++
      if (recordChar(next)) return true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (recordChar(char, char === "*" || char === "?" || char === "[")) return true
  }
  return false
}

function directoryArgs(command: Part[], powershell: boolean, cwd: string, shell: string) {
  const head = command[0]?.text.toLowerCase() ?? ""
  if (head === "popd" || head === "pop-location") return { directories: [], complete: false }

  if (!powershell) {
    let endOfOptions = false
    const operands = command.slice(1).filter((part) => {
      if (endOfOptions) return true
      if (part.text === "--") {
        endOfOptions = true
        return false
      }
      if (part.text === "-") return true
      return !part.text.startsWith("-")
    })
    if (operands.length === 0) return { directories: [], complete: false }
    const resolved = operands.map((part) =>
      part.text === "-" ? undefined : directoryArgument(part.text, false, cwd, shell, part.unquotedTilde),
    )
    const directories = resolved.filter((item): item is string => item !== undefined)
    return { directories, complete: directories.length === operands.length }
  }

  const directories: string[] = []
  let pathFlag = false
  let literalFlag = false
  let endOfParameters = false
  let sawOperand = false
  let complete = true
  for (const part of command.slice(1)) {
    if (!endOfParameters && part.text === "--") {
      endOfParameters = true
      continue
    }
    if (pathFlag) {
      sawOperand = true
      const value =
        !literalFlag && (hasPowerShellDotWildcard(part.raw) || part.text === "-" || part.text === "+")
          ? undefined
          : directoryArgument(part.text, true, cwd, shell)
      if (value) directories.push(value)
      if (!value) complete = false
      pathFlag = false
      literalFlag = false
      continue
    }
    if (!endOfParameters && part.type === "command_parameter") {
      if (POWERSHELL_STACK_FLAG_RE.test(part.text)) {
        complete = false
        return { directories, complete }
      }
      literalFlag = POWERSHELL_LITERAL_FLAG_RE.test(part.text)
      pathFlag = literalFlag || /^-p(?:ath|at|a)?:?$/i.test(part.text)
      continue
    }
    sawOperand = true
    const value =
      hasPowerShellDotWildcard(part.raw) || (!endOfParameters && (part.raw === "-" || part.raw === "+"))
        ? undefined
        : directoryArgument(part.text, true, cwd, shell)
    if (value) directories.push(value)
    if (!value) complete = false
  }
  return { directories, complete: sawOperand && complete }
}

function directoryArgument(value: string, powershell: boolean, cwd: string, shell: string, unquotedTilde = false) {
  if (!powershell) return expandKnownDirectory(value, false, cwd, unquotedTilde)
  const quote = value[0]
  const text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value

  // PowerShell exposes environment variables through $env:NAME and provides these
  // automatic directory variables. Expand only values we can determine without executing code.
  return expandKnownDirectory(
    text
      .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$(?:\{(HOME|PWD|PSHOME)\}|(HOME|PWD|PSHOME)(?=$|[\\/]))/gi, (_, braced?: string, bare?: string) => {
        const key = (braced ?? bare ?? "").toUpperCase()
        if (key === "HOME") return os.homedir()
        if (key === "PWD") return cwd
        return path.dirname(shell)
      }),
    true,
    cwd,
  )
}

function expandKnownDirectory(value: string, powershell: boolean, cwd: string, unquotedTilde = false) {
  // Unknown shell expressions cannot be resolved safely during permission analysis.
  if (value.includes("$") || value.includes("`") || (powershell && value.startsWith("("))) return
  const resolved = value.replaceAll("\0", "$")
  if (resolved === "~") return os.homedir()
  if (resolved.startsWith("~/") || (process.platform === "win32" && resolved.startsWith("~\\"))) {
    return path.join(os.homedir(), resolved.slice(2))
  }
  if (unquotedTilde && process.platform !== "win32") {
    if (resolved === "~+") return cwd
    if (resolved.startsWith("~+/")) return path.join(cwd, resolved.slice(3))
    if (/^~(?:[-+](?:\d+)?|\d+)(?=$|\/)/.test(resolved)) return
    const userMatch = /^~([A-Za-z_][A-Za-z0-9._-]*)(?=$|\/)/.exec(resolved)
    if (userMatch) {
      const user = userMatch[1]
      const home = resolveUserHome(user)
      if (!home) return
      return path.join(home, resolved.slice(user.length + 1))
    }
  }
  return resolved
}

let cachedPasswdHomes: ReadonlyMap<string, string> | undefined

function passwdHomes() {
  if (cachedPasswdHomes) return cachedPasswdHomes
  const content = Result.try(() => fs.readFileSync("/etc/passwd", "utf8"))
  const entries = Result.isSuccess(content)
    ? content.success.split("\n").flatMap((line): Array<[string, string]> => {
        if (!line || line.startsWith("#")) return []
        const fields = line.split(":")
        const name = fields[0]
        const home = fields[5]
        return name && home ? [[name, home]] : []
      })
    : []
  cachedPasswdHomes = new Map(entries)
  return cachedPasswdHomes
}

function resolveUserHome(user: string) {
  const current = Result.try(() => os.userInfo())
  if (Result.isSuccess(current) && current.success.username === user && current.success.homedir) {
    return current.success.homedir
  }
  const fromPasswd = passwdHomes().get(user)
  if (fromPasswd) return fromPasswd
  if (process.platform === "darwin") {
    const candidate = path.join("/Users", user)
    const exists = Result.try(() => fs.statSync(candidate).isDirectory())
    if (Result.isSuccess(exists) && exists.success) return candidate
  }
}

function environment(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function prefix(tokens: string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const arity = ARITY[tokens.slice(0, length).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.slice(0, 1)
}
