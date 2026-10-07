import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
// Commands that run the command given in their trailing words.  `values` lists
// the options that consume the next word, so that word is not taken for the
// command; `operands` counts the plain words that precede it (timeout's
// duration).
const RUNNERS: Record<string, { values: string[]; operands?: number }> = {
  builtin: { values: [] },
  busybox: { values: [] },
  caffeinate: { values: ["-t", "-w"] },
  command: { values: [] },
  doas: { values: ["-C", "-u"] },
  env: { values: ["-C", "-P", "-S", "-u", "--chdir", "--split-string", "--unset"] },
  exec: { values: ["-a"] },
  nice: { values: ["-n", "--adjustment"] },
  nohup: { values: [] },
  stdbuf: { values: ["-e", "-i", "-o", "--error", "--input", "--output"] },
  sudo: {
    values: [
      ...["-C", "-D", "-R", "-T", "-U", "-g", "-h", "-p", "-r", "-t", "-u"],
      ...["--chdir", "--chroot", "--close-from", "--command-timeout", "--group", "--host"],
      ...["--other-user", "--prompt", "--role", "--type", "--user"],
    ],
  },
  time: { values: ["-f", "-o", "--format", "--output"] },
  timeout: { values: ["-k", "-s", "--kill-after", "--signal"], operands: 1 },
  gtimeout: { values: ["-k", "-s", "--kill-after", "--signal"], operands: 1 },
  watch: { values: ["-n", "-q", "--chgexit", "--equexit", "--interval", "--shell"] },
  xargs: {
    values: [
      ...["-E", "-I", "-J", "-L", "-P", "-R", "-S", "-a", "-d", "-n", "-s"],
      ...["--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs"],
      ...["--process-slot-var", "--replace"],
    ],
  },
}
// Shells that run a script string given with -c.
const SHELLS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"])
const SHELL_VALUES = new Set(["-O", "+O", "-o", "+o", "--init-file", "--rcfile"])
// A script string nested deeper than this is only checked as the text of the
// command that carries it.
const MAX_SCRIPT_DEPTH = 4

type Part = {
  type: string
  text: string
}

// A command as it will run: the bare program name and its argument words.
type View = {
  name: string
  args: Part[]
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

// Statements that change the environment of the commands after them, which bash
// parses apart from commands: `export`, `declare`, `local`, `readonly`,
// `typeset`, `unset`, and `NAME=value` on its own.  An assignment prefixed to a
// command is part of that command and is checked with it.
function assignments(node: Node) {
  const owners = ["command", "declaration_command", "variable_assignments"]
  return node
    .descendantsOfType(["declaration_command", "unset_command", "variable_assignments", "variable_assignment"])
    .filter((child): child is Node => Boolean(child))
    .filter((child) => child.type !== "variable_assignment" || !owners.includes(child.parent?.type ?? ""))
}

// Every command a bash command node runs: the node itself, then whatever its
// runners (`env`, `sudo`, `xargs`, …) and `find -exec` run in turn, together
// with the script strings it hands to a shell's -c, to `eval`, to `env -S` or
// to `watch`.  Each inner command has fewer words than the one running it, so
// the walk ends.
function unwrap(node: Node) {
  const name = node.childForFieldName("name")
  if (!name) return { views: [], scripts: [] }
  const views: View[] = [
    {
      name: program(name.text),
      args: node
        .childrenForFieldName("argument")
        .filter((item): item is Node => Boolean(item))
        .map((item) => ({ type: item.type, text: item.text })),
    },
  ]
  const scripts: string[] = []
  for (let i = 0; i < views.length; i++) {
    const next = inner(views[i])
    views.push(...next.views)
    scripts.push(...next.scripts)
  }
  return { views, scripts }
}

// The commands and script strings one command runs on behalf of its words.
function inner(item: View): { views: View[]; scripts: string[] } {
  if (item.name === "eval") {
    return { views: [], scripts: item.args.length ? [item.args.map((arg) => literal(arg.text)).join(" ")] : [] }
  }
  if (item.name === "find") return { views: execs(item.args), scripts: [] }
  if (SHELLS.has(item.name)) return { views: [], scripts: script(item.args) }
  const runner = RUNNERS[item.name]
  if (!runner) return { views: [], scripts: [] }

  const scripts: string[] = []
  const state = { operands: runner.operands ?? 0, exec: false, at: item.args.length }
  for (let i = 0; i < item.args.length; i++) {
    const word = literal(item.args[i].text)
    if (word === "--") {
      state.at = i + 1
      break
    }
    if (item.name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (word.startsWith("-") && word.length > 1) {
      const opt = option(word, runner.values)
      const value = opt.next ? literal(item.args[i + 1]?.text ?? "") : opt.value
      if (opt.next) i++
      if (item.name === "env" && (opt.flag === "-S" || opt.flag === "--split-string") && value) scripts.push(value)
      if (item.name === "watch" && (word === "-x" || word === "--exec")) state.exec = true
      continue
    }
    if (state.operands > 0) {
      state.operands--
      continue
    }
    state.at = i
    break
  }

  const rest = item.args.slice(state.at)
  if (!rest.length) return { views: [], scripts }
  // Without -x, watch hands its words to `sh -c` as one script.
  if (item.name === "watch" && !state.exec) {
    return { views: [], scripts: [...scripts, rest.map((arg) => literal(arg.text)).join(" ")] }
  }
  return { views: [{ name: program(rest[0].text), args: rest.slice(1) }], scripts }
}

// How an option word takes its value, getopt style: a long option takes what
// follows `=`, and in a short cluster the first option that wants a value takes
// the rest of the cluster, or the next word when nothing is left of it.
function option(word: string, values: string[]) {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=")
    if (eq >= 0) return { flag: word.slice(0, eq), value: word.slice(eq + 1), next: false }
    return { flag: word, value: undefined, next: values.includes(word) }
  }
  const at = [...word.slice(1)].findIndex((char) => values.includes("-" + char))
  if (at < 0) return { flag: undefined, value: undefined, next: false }
  const rest = word.slice(at + 2)
  return { flag: "-" + word[at + 1], value: rest || undefined, next: !rest }
}

// The commands find runs for -exec, -execdir, -ok and -okdir, each ending at a
// `;` or `+` word.
function execs(args: Part[]) {
  const words = args.map((arg) => literal(arg.text))
  const starts = words.flatMap((word, i) => (["-exec", "-execdir", "-ok", "-okdir"].includes(word) ? [i + 1] : []))
  return starts.flatMap((start) => {
    const end = words.findIndex((word, i) => i > start && (word === ";" || word === "+"))
    const stop = end < 0 ? words.length : end
    if (stop <= start) return []
    return [{ name: program(args[start].text), args: args.slice(start + 1, stop) }]
  })
}

// The script a shell runs with -c: its first operand after the options.
function script(args: Part[]) {
  const words = args.map((arg) => literal(arg.text))
  const state = { command: false }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === "--") return state.command && i + 1 < words.length ? [words[i + 1]] : []
    if (SHELL_VALUES.has(word)) {
      i++
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith("-") && word.includes("c")) state.command = true
      continue
    }
    if (word.startsWith("--")) continue
    return state.command ? [word] : []
  }
  return []
}

// The program a command word names, without its quoting or directory, so rules
// written for `rm` also see `\rm`, `"rm"` and `/bin/rm`.  A name computed at
// run time stays as written.
function program(text: string) {
  if (dynamic(text, false)) return text
  return path.posix.basename(literal(text))
}

// The value of a shell word with its quoting removed: '…' verbatim, "…" with
// its backslash escapes resolved, and a bare backslash escaping the next
// character.
function literal(text: string) {
  return text.replace(
    /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gs,
    (_, single: string | undefined, double: string | undefined, escaped: string) => {
      if (single !== undefined) return single
      if (double !== undefined) return double.replace(/\\([$`"\\\n])/g, "$1")
      return escaped
    },
  )
}

// The same command with its short option clusters split (`-rf` as `-r -f`), so
// a rule can name one option whatever it is combined with.
function split(item: View) {
  const cluster = /^-[A-Za-z]{2,}$/
  if (!item.args.some((arg) => cluster.test(arg.text))) return
  return {
    name: item.name,
    args: item.args.flatMap((arg) =>
      cluster.test(arg.text) ? [...arg.text.slice(1)].map((char) => ({ type: arg.type, text: "-" + char })) : [arg],
    ),
  }
}

function text(item: View) {
  return [item.name, ...item.args.map((arg) => arg.text)].join(" ")
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      const files = Effect.fnUntraced(function* (command: Part[]) {
        for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
          const resolved = yield* argPath(arg, cwd, ps, shell)
          yield* Effect.logInfo("resolved path", { arg, resolved })
          if (!resolved || containsPath(resolved, instance)) continue
          const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
          scan.dirs.add(dir)
        }
      })

      // A statement that sets or clears a variable decides what the commands
      // after it see (`export KUBECONFIG=…`), so its text is checked as well.
      const declared = (node: Node) => {
        if (ps || shellKind === "cmd") return
        for (const item of assignments(node)) {
          const statement = item.text.trim()
          scan.patterns.add(statement)
          scan.always.add(
            item.type === "declaration_command" || item.type === "unset_command"
              ? `${item.child(0)?.text} *`
              : `${statement.split("=")[0]}=*`,
          )
        }
      }

      // Script strings found on the way are parsed and their commands queued
      // behind the rest; their trees live until the caller's scope closes.
      declared(root)
      const queue = commands(root).map((node) => ({ node, depth: 0 }))
      for (let i = 0; i < queue.length; i++) {
        const node = queue[i].node
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) yield* files(command)

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }

        if (ps || shellKind === "cmd") continue

        // Rules match command text, so a command behind a runner, a variable
        // assignment, a directory or quoting would be judged by that prefix
        // alone.  Each command it runs is checked as well.  This only adds
        // patterns: it can add a prompt or a denial, never lift one.
        const found = unwrap(node)
        for (const [index, item] of found.views.entries()) {
          if (CWD.has(item.name)) continue
          const words = [{ type: "word", text: item.name }, ...item.args]
          if (FILES.has(item.name) && !(index === 0 && item.name === cmd)) yield* files(words)
          scan.patterns.add(text(item))
          scan.always.add(BashArity.prefix(words.map((word) => word.text)).join(" ") + " *")
          const flat = split(item)
          if (flat) scan.patterns.add(text(flat))
        }

        if (queue[i].depth >= MAX_SCRIPT_DEPTH) continue
        for (const item of found.scripts) {
          const tree = yield* Effect.acquireRelease(parse(item, false), (tree) => Effect.sync(() => tree.delete()))
          declared(tree.rootNode)
          queue.push(...commands(tree.rootNode).map((child) => ({ node: child, depth: queue[i].depth + 1 })))
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds. If it was waiting for something else to finish, such as a build, deploy or job, do not retry with a longer sleep: poll a command that reports completion, in a loop that exits as soon as it succeeds and gives up after a deadline.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
