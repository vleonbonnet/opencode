export * as ShellParse from "./parse.js"

import { Effect } from "effect"
import { fileURLToPath } from "url"
import os from "os"
import path from "path"
import type { Node } from "web-tree-sitter"
import { shellParserWasm } from "#shell-parser-wasm"
import type { ShellScan } from "./scan.js"
import { ShellSelect } from "./select.js"
import { ShellUnwrap } from "./unwrap.js"
import { lazy } from "../util/lazy.js"
import { Wildcard } from "../util/wildcard.js"

type Part = { type: string; text: string }
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const POWERSHELL_PATH_FLAG_RE =
  /^-(?:p(?:ath|at|a)?|lp|l(?:i(?:t(?:e(?:r(?:a(?:l(?:p(?:a(?:t(?:h)?)?)?)?)?)?)?)?)?)?|psp(?:a(?:t(?:h)?)?)?):?$/i
// A redirect operator after line continuations, which make a descriptor word before them part of the redirect.
const CONTINUED_REDIRECT_RE = /(?:\\\n)+[<>]/y

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

export const scan = Effect.fnUntraced(function* (
  command: string,
  shell: string,
  cwd: string,
  options?: { portable?: boolean; wasm?: typeof shellParserWasm },
) {
  if (options?.portable || (options?.wasm ?? shellParserWasm).bash === "")
    return yield* scanPortable(command, shell, cwd)
  return yield* scanLegacy(command, shell, cwd)
})

const scanLegacy = Effect.fnUntraced(function* (command: string, shell: string, cwd: string) {
  const parsers = yield* Effect.promise(load)
  const powershell = ShellSelect.ps(shell)
  const tree = (powershell ? parsers.ps : parsers.bash).parse(command)
  if (!tree) return yield* Effect.fail(new Error("Failed to parse shell command"))

  return yield* Effect.acquireUseRelease(
    Effect.succeed(tree),
    (tree) =>
      Effect.sync(() => {
        const output = collector()
        const options = { powershell, posix: posix(shell), cwd, shell, dialect: dialect(shell) }
        const scripts = legacyCommands(output, tree.rootNode, command, options)
        // A script is read as the command is: what Tree-sitter finds in it, errors and all.
        follow(output, scripts, (script) => {
          const nested = parsers.bash.parse(script.text)
          if (!nested) {
            output.fail("Failed to parse shell command")
            return []
          }
          try {
            return legacyCommands(output, nested.rootNode, script.text, {
              ...options,
              posix: true,
              dialect: script.dialect,
            })
          } finally {
            nested.delete()
          }
        })
        return output
      }),
    (tree) => Effect.sync(() => tree.delete()),
  ).pipe(Effect.flatMap(finish))
})

type Options = { powershell: boolean; posix: boolean; cwd: string; shell: string; dialect: ShellUnwrap.Dialect }
type Script = ShellUnwrap.Script

// Adds the commands of a tree parsed from SOURCE and returns the script strings they hand to a shell.
function legacyCommands(output: Collector, root: Node, source: string, options: Options) {
  const text = (node: Node) => (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
  const scripts: Script[] = []
  for (const node of root.descendantsOfType("command")) {
    if (!node) continue
    const command = parts(node)
    const tokens = command.map((part) => part.text)
    if (tokens.length === 0) continue
    const name = options.powershell ? tokens[0].toLowerCase() : tokens[0]
    if (CWD.has(name)) {
      output.result.directories.push(...directoryArgs(command, options.powershell, options.cwd, options.shell))
      continue
    }
    const save = `${prefix(tokens).join(" ")} *`
    if (!options.posix) {
      output.command(text(node), save)
      continue
    }
    scripts.push(...expand(output, text(node), save, legacyWords(node, source), options.dialect))
  }
  return scripts
}

// The words a command runs with, as written: its name and arguments, without assignments and redirects. Bash removes
// line continuations before it reads words, which Tree-sitter does not: it can split one shell word into several
// nodes (`$"…"`, a word continued on the next line), which are joined back here, and it reads the descriptor of a
// redirect whose operator starts the next line (`2\` then `>out`) as an argument, which is left out.
function legacyWords(node: Node, source: string) {
  const name = node.childForFieldName("name")
  if (!name) return []
  const nodes = [name, ...node.childrenForFieldName("argument").filter((item): item is Node => Boolean(item))]
  return nodes
    .reduce<Array<{ start: number; end: number }>>((words, item) => {
      const last = words.at(-1)
      if (last && /^(?:\\\n)*$/.test(source.slice(last.end, item.startIndex))) last.end = item.endIndex
      else words.push({ start: item.startIndex, end: item.endIndex })
      return words
    }, [])
    .filter((word, index) => {
      if (index === 0 || !/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(source.slice(word.start, word.end))) return true
      CONTINUED_REDIRECT_RE.lastIndex = word.end
      return !CONTINUED_REDIRECT_RE.test(source)
    })
    .map((word) => source.slice(word.start, word.end))
}

export const scanPortable = Effect.fnUntraced(function* (command: string, shell: string, cwd: string) {
  const { ShellScan } = yield* Effect.tryPromise({
    try: () => import("./scan.js"),
    catch: (cause) => new Error(`Portable shell scanner failed to load: ${cause}`, { cause }),
  })
  const powershell = ShellSelect.ps(shell)
  const options = { powershell, posix: posix(shell), cwd, shell, dialect: dialect(shell) }
  const result = powershell ? ShellScan.scanPowerShell(command) : ShellScan.scan(command, options.dialect)
  if (result.kind === "opaque")
    return yield* Effect.fail(new Error(`Portable shell scanner cannot analyze command: ${result.reason}`))

  const output = collector()
  const scripts = portableCommands(output, result.commands, options)
  // A script is read in the dialect of the shell that runs it, and refused as the command would be when it cannot be.
  follow(output, scripts, (script) => {
    const nested = ShellScan.scan(script.text, script.dialect)
    if (nested.kind === "opaque") {
      output.fail(`Portable shell scanner cannot analyze command: ${nested.reason} in a script it runs`)
      return []
    }
    return portableCommands(output, nested.commands, {
      ...options,
      powershell: false,
      posix: true,
      dialect: script.dialect,
    })
  })
  return yield* finish(output)
})

// Adds the commands the portable scanner found and returns the script strings they hand to a shell.
function portableCommands(
  output: Collector,
  commands: Extract<ShellScan.Result, { kind: "scanned" }>["commands"],
  options: Options,
) {
  const { powershell, cwd, shell } = options
  const scripts: Script[] = []
  for (const item of commands) {
    // The legacy command walk skips declarations, not the substitutions within them.
    if (item.declaration) continue
    const words = item.redirectWordCount === undefined ? item.rawWords : item.rawWords.slice(0, item.redirectWordCount)
    // The shipped PowerShell grammar treats bare statement-head foreach blocks as control flow.
    if (
      powershell &&
      item.statementHead &&
      /^foreach(?:-|$)/i.test(words[0] ?? "") &&
      words.length > 1 &&
      words.slice(1).every((word) => word.startsWith("{"))
    )
      continue
    const name = powershell ? words[0]?.toLowerCase() : words[0]
    if (CWD.has(name)) {
      output.result.directories.push(
        ...directoryArgs(
          powershell
            ? words.flatMap((raw, index): Part[] => {
                const text =
                  !raw.includes("`$") && /['"`]/.test(raw) ? (item.words[index] ?? raw) : raw.replaceAll("`$", "\0")
                if (!/^-[A-Za-z_?][\w?-]*(?::|$)/.test(raw)) return [{ type: "word", text }]
                const colon = text.indexOf(":")
                if (colon >= 0)
                  return colon + 1 < text.length
                    ? [
                        { type: "command_parameter", text: text.slice(0, colon) },
                        { type: "word", text: text.slice(colon + 1) },
                      ]
                    : [{ type: "command_parameter", text: text.slice(0, colon) }]
                return [{ type: "command_parameter", text }]
              })
            : item.rawWords.map((text, index) => ({
                type: "word",
                // Only literal quoting resolves to a static directory.
                text: text.startsWith("$'") || (!/[$`~\\]/.test(text) && /['"]/.test(text)) ? item.words[index] : text,
              })),
          powershell,
          cwd,
          shell,
        ),
      )
      continue
    }
    const selected = prefix(words.slice(0, PREFIX_LENGTH))
    const conventional = `${selected.join(" ")} *`
    const end = item.wordEnds?.[selected.length - 1]
    // Keep existing grants stable unless normalized spacing loses the original source boundary.
    const save =
      !powershell || end === undefined || Wildcard.match(item.resource, conventional)
        ? conventional
        : (() => {
            const boundary =
              item.wordEnds?.find(
                (value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value])),
              ) ?? end
            const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0]
            return `${item.resource.slice(0, boundary)}${separator ?? " "}*`
          })()
    if (!options.posix) {
      output.command(item.resource, save)
      continue
    }
    scripts.push(...expand(output, item.resource, save, words, options.dialect))
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
// command, apart from the resource itself. A command that cannot be checked fails the scan.
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
    command(resource: string, save: string | undefined, alternates: readonly string[] = []) {
      seen.add(resource)
      push(resource, save, alternates)
    },
    extra(resource: string, save: string | undefined, alternates: readonly string[] = []) {
      if (seen.has(resource)) return
      seen.add(resource)
      push(resource, save, alternates)
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
// handed to a shell that is not POSIX. Rules match command text, so each is checked on its own: this only adds
// resources and spellings, so it can add a prompt or a denial, never lift one. Returns the script strings the command
// hands to a POSIX shell.
function expand(
  output: Collector,
  resource: string,
  save: string,
  words: readonly string[],
  dialect: ShellUnwrap.Dialect,
) {
  // The legacy grammar gives a statement of assignments with a redirect an empty command name.
  const found = ShellUnwrap.unwrap(words[0] ? words : [], dialect)
  if (found.truncated) output.fail("Shell command runs too many nested commands to check")
  const [head, ...rest] = found.views
  output.command(resource, save, head ? ShellUnwrap.spellings(head) : [])
  if (head) renamed(output, head)
  for (const view of rest) {
    if (view.implied || !view.program || CWD.has(view.name)) continue
    output.extra(
      ShellUnwrap.text(view),
      `${prefix([view.name, ...view.args]).join(" ")} *`,
      ShellUnwrap.spellings(view),
    )
    renamed(output, view)
  }
  for (const text of found.texts) output.extra(text, exact(text))
  return found.scripts
}

// The command as its bare program name runs it, when that differs from the program as written.
function renamed(output: Collector, view: ShellUnwrap.View) {
  const bare = ShellUnwrap.renamed(view)
  if (bare)
    output.extra(
      ShellUnwrap.text(bare),
      `${prefix([bare.name, ...bare.args]).join(" ")} *`,
      ShellUnwrap.spellings(bare),
    )
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

function parts(node: Node) {
  return Array.from({ length: node.childCount }).flatMap((_, index): Part[] => {
    const child = node.child(index)
    if (!child) return []
    if (child.type === "command_elements")
      return Array.from({ length: child.childCount }).flatMap((_, itemIndex): Part[] => {
        const item = child.child(itemIndex)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") return []
        return [{ type: item.type, text: item.text }]
      })
    if (!["command_name", "command_name_expr", "word", "string", "raw_string", "concatenation"].includes(child.type))
      return []
    return [{ type: child.type, text: child.text }]
  })
}

function directoryArgs(command: Part[], powershell: boolean, cwd: string, shell: string) {
  if (!powershell)
    return command
      .slice(1)
      .filter((part) => !part.text.startsWith("-"))
      .map((part) => directoryArgument(part.text, powershell, cwd, shell))
      .filter((part) => part !== undefined)

  const directories: string[] = []
  let path = false
  let endOfParameters = false
  for (const part of command.slice(1)) {
    if (!endOfParameters && part.text === "--") {
      endOfParameters = true
      continue
    }
    if (path) {
      const value = directoryArgument(part.text, powershell, cwd, shell)
      if (value) directories.push(value)
      path = false
      continue
    }
    if (!endOfParameters && part.type === "command_parameter") {
      path = POWERSHELL_PATH_FLAG_RE.test(part.text)
      continue
    }
    const value = directoryArgument(part.text, powershell, cwd, shell)
    if (value) directories.push(value)
  }
  return directories
}

function directoryArgument(value: string, powershell: boolean, cwd: string, shell: string) {
  const quote = value[0]
  const text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value
  if (!powershell) return expandKnownDirectory(text)

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
  )
}

function expandKnownDirectory(value: string) {
  // Unknown shell expressions cannot be resolved safely during permission analysis.
  if (value.includes("$") || value.includes("`") || value.startsWith("(")) return
  const resolved = value.replaceAll("\0", "$")
  if (resolved === "~") return os.homedir()
  if (resolved.startsWith("~/") || (process.platform === "win32" && resolved.startsWith("~\\"))) {
    return path.join(os.homedir(), resolved.slice(2))
  }
  return resolved
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

function resolve(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (path.isAbsolute(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const load = lazy(initialize)

async function initialize() {
  const { Parser, Language } = await import("web-tree-sitter")
  await Parser.init({ locateFile: () => resolve(shellParserWasm.runtime) })
  const [bashLanguage, psLanguage] = await Promise.all([
    Language.load(resolve(shellParserWasm.bash)),
    Language.load(resolve(shellParserWasm.powershell)),
  ])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
}
