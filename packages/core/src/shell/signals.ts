export * as ShellSignals from "./signals.js"

import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { collectStream } from "@opencode/util/process"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { ShellScan } from "./scan.js"
import { ShellSelect } from "./select.js"
import { ShellUnwrap } from "./unwrap.js"

export type Target = {
  target: string
  kind: "pid" | "group" | "all" | "shell" | "job" | "dynamic"
  name?: string
  command?: string
}

export type Action = { command: string; signal: string; targets: Target[] }

// These wrappers keep the process namespace. Never resolve an ssh/container target on this host.
const LOCAL = new Set([
  "kill",
  "builtin",
  "command",
  "env",
  "exec",
  "nohup",
  "nice",
  "timeout",
  "stdbuf",
  "setsid",
  "sudo",
  "doas",
  "sh",
  "bash",
  "dash",
  "zsh",
])

export function scan(command: string, shell: string): Action[] {
  if (ShellSelect.ps(shell)) return []
  const name = ShellSelect.name(shell)
  const dialect = name === "bash" || name === "zsh" ? name : "posix"
  return commands(command, dialect, 0)
}

function commands(text: string, dialect: ShellUnwrap.Dialect, depth: number): Action[] {
  const parsed = ShellScan.statements(text, dialect)
  if (parsed.kind !== "scanned") return []
  return parsed.commands.flatMap((item) => {
    if (item.declaration || item.assignment || item.redirectPrefixEnd !== undefined) return []
    const unwrapped = ShellUnwrap.unwrap(item.rawWords, dialect)
    if (unwrapped.truncated || unwrapped.views.some((view) => !LOCAL.has(view.name))) return []
    if (
      unwrapped.views.some(
        (view) => view.name === "sudo" && view.args.some((arg) => /^(-[hR]|--(?:host|chroot)(?:=|$))/.test(arg)),
      )
    )
      return []
    const actions = unwrapped.views.flatMap((view) => {
      if (view.name !== "kill") return []
      const action = signal(view.args)
      return action ? [{ command: item.resource, ...action }] : []
    })
    if (depth >= ShellUnwrap.MAX_SCRIPT_DEPTH) return actions
    return [
      ...actions,
      ...unwrapped.scripts.flatMap((script) =>
        script.dynamic ? [] : commands(script.text, script.dialect, depth + 1),
      ),
    ]
  })
}

function signal(raw: readonly string[]): Omit<Action, "command"> | undefined {
  const args = raw.map(ShellUnwrap.literal)
  let selected = "TERM"
  let explicit = false
  let index = 0
  for (; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") {
      index++
      break
    }
    if (!arg.startsWith("-")) break
    if (explicit && /^-\d+$/.test(arg)) break
    if (arg === "-s" || arg === "-n" || arg === "--signal") {
      selected = args[++index] ?? ""
      explicit = true
      continue
    }
    if (arg.startsWith("--signal=")) {
      selected = arg.slice(9)
      explicit = true
      continue
    }
    if (arg === "--verbose") continue
    if (!/^-(?:\d+|(?:SIG)?[A-Z][A-Z0-9+-]*)$/.test(arg)) return
    // -L lists signals; -l/-p and the extended GNU options are not simple signal operations either.
    if (arg === "-L") return
    selected = arg.slice(1)
    explicit = true
  }
  if (!/^(?:\d+|(?:SIG)?[A-Z][A-Z0-9+-]*)$/.test(selected) || index === args.length) return
  return {
    signal: selected.replace(/^SIG/, ""),
    targets: args.slice(index).map(
      (target, offset): Target => ({
        target,
        kind:
          /^\d+$/.test(target) && Number(target) > 0 && Number(target) <= 0x7fffffff
            ? "pid"
            : target === "-1"
              ? "all"
              : /^(?:0|-\d+)$/.test(target)
                ? "group"
                : raw[index + offset] === "$$" || raw[index + offset] === '"$$"'
                  ? "shell"
                  : target.startsWith("%")
                    ? "job"
                    : "dynamic",
      }),
    ),
  }
}

// A fixed read-only script, with validated decimal PIDs as positional arguments. /proc also uses the
// shell's MSYS/Cygwin PID namespace; looking those numbers up with Windows Get-Process would name the wrong process.
const SNAPSHOT = `
PATH=/usr/bin:/bin:$PATH
for pid do
  printf '%s\\0' "$pid"
  if [ -r "/proc/$pid/comm" ]; then
    name=$(cat "/proc/$pid/comm" 2>/dev/null)
    printf '%s\\0' "$name"
    tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null
  elif [ -r "/proc/$pid/exename" ]; then
    name=$(cat "/proc/$pid/exename" 2>/dev/null)
    name=\${name##*/}
    printf '%s\\0' "$name"
    tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null
  else
    name=$(ps -p "$pid" -o comm= 2>/dev/null)
    printf '%s\\0' "$name"
    ps -ww -p "$pid" -o args= 2>/dev/null
  fi
  printf '\\0'
done
`

export const inspect = Effect.fn("ShellSignals.inspect")(function* (
  invocation: ShellCreateBefore,
  spawner: ChildProcessSpawner["Service"],
) {
  const actions = scan(invocation.command, invocation.shell)
  const pids = [
    ...new Set(
      actions.flatMap((action) =>
        action.targets.filter((target) => target.kind === "pid").map((target) => target.target),
      ),
    ),
  ]
  if (pids.length === 0) return actions
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(invocation.shell, ["-c", SNAPSHOT, "opencode-process-info", ...pids], {
          cwd: invocation.cwd,
          env: { ...invocation.env, LC_ALL: "C" },
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      const [output] = yield* Effect.all([collectStream(child.stdout, 64 * 1024), child.exitCode], {
        concurrency: "unbounded",
      })
      return output.truncated ? "" : new TextDecoder().decode(output.buffer)
    }),
  ).pipe(
    Effect.timeout("2 seconds"),
    Effect.catch(() => Effect.succeed("")),
  )
  const fields = snapshot.split("\0")
  const processes = new Map<string, { name: string; command: string }>()
  for (let index = 0; index + 3 < fields.length; index += 3) {
    const name = fields[index + 1].trim()
    if (name) processes.set(fields[index], { name, command: fields[index + 2].trim() })
  }
  return actions.map((action) => ({
    ...action,
    targets: action.targets.map((target) => ({ ...target, ...processes.get(target.target) })),
  }))
})
