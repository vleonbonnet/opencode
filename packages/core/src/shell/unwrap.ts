export * as ShellUnwrap from "./unwrap.js"

// Bash and Zsh name those shells. Posix covers sh, dash and any other shell, and stays sound for each of them.
export type Dialect = "bash" | "zsh" | "posix"

// A script string a command hands to a shell, in the dialect of the shell that runs it. `dynamic` tells that the
// word holding it is only known at run time, so it may be whatever the command reads.
export type Script = { text: string; dialect: Dialect; dynamic?: true }

// A command as it will run: `name` is the program without its quoting, directory or Windows executable suffix, which
// rules name, and `program` and `args` are its words as written. An implied command is the shell a runner starts
// when it is given no command (`sudo -s`, `ssh host`), which reads its input.
export type View = { name: string; program: string; args: string[]; implied?: true }

export type Unwrapped = {
  views: View[]
  scripts: Script[]
  // Script text handed to a shell whose language is not POSIX shell (pwsh, cmd, fish, csh), checked as written.
  texts: string[]
  // More commands than MAX_VIEWS, so not all of them were found.
  truncated?: true
}

// A script string nested deeper than this cannot be checked, so the command carrying it is refused.
export const MAX_SCRIPT_DEPTH = 4
// Commands one command may run, past which it is refused rather than partly checked.
const MAX_VIEWS = 256
// The readings of option words whose grammar is unknown, and the commands composed from one input.
const MAX_PARSES = 16
const MAX_INPUTS = 16

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const CLUSTER = /^-[A-Za-z]{2,}$/
const STDIN = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"])

// How a command reads its options, getopt style: `values` take the rest of a short cluster, what follows `=`, or
// else the next word; `optional` take a value only when it is attached; `flags` take none; after one of `none` no
// command runs; `operands` counts the plain words before the command (timeout's duration, chroot's directory);
// `dash` makes a lone `-` an option; `numeric` makes a cluster of digits one (`nice -10`); `shell` names the
// options, or `true` for always, under which a runner given no command starts a shell that reads its input. Long
// options may be abbreviated, as getopt_long allows. An option the grammar does not list, or a word known only at
// run time, is read every way it may be: taking a value and not, an option and the command.
type Grammar = {
  values?: readonly string[]
  optional?: readonly string[]
  flags?: readonly string[]
  none?: readonly string[]
  operands?: number
  dash?: true
  numeric?: true
  shell?: readonly string[] | true
}

type Option = { name: string; value?: string }
type Parse = { options: Option[]; at: number }
type Step = Omit<Unwrapped, "truncated">

const HELP = ["-h", "--help", "-V", "--version"]

const SU_SCRIPTS = ["-c", "--command", "-C", "--session-command"]
const SU: Grammar = {
  values: [...SU_SCRIPTS, "-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"],
  flags: ["-l", "--login", "-m", "-p", "--preserve-environment", "-P", "--pty", "-f", "--fast"],
  none: HELP,
  dash: true,
}
const RUNUSER: Grammar = { ...SU, values: [...SU.values!, "-u", "--user"] }

const SSH: Grammar = {
  values: [
    ...["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-P", "-p", "-Q"],
    ...["-R", "-S", "-W", "-w"],
  ],
  flags: [...["-4", "-6", "-A", "-a", "-C", "-f", "-g", "-K", "-k", "-M", "-n", "-q", "-T", "-t", "-v", "-X", "-x"]],
  // No remote command runs: port forwarding, a subsystem, a control command, or a query.
  none: ["-G", "-N", "-O", "-Q", "-s", "-V", "-W", "-Y", "-y"],
}

const DOCKER_GLOBAL: Grammar = {
  values: ["--config", "-c", "--context", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
  flags: ["-D", "--debug", "--tls", "--tlsverify", "--remote", "-r"],
}
const DOCKER_EXEC: Grammar = {
  values: ["--detach-keys", "-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--preserve-fds"],
  flags: ["-d", "--detach", "-i", "--interactive", "--privileged", "-t", "--tty", "-l", "--latest"],
}
const DOCKER_RUN: Grammar = {
  values: [
    ...["-a", "--attach", "--add-host", "--annotation", "--blkio-weight", "--blkio-weight-device", "--cap-add"],
    ...["--cap-drop", "--cgroup-parent", "--cgroupns", "--cidfile", "--cpu-period", "--cpu-quota"],
    ...["--cpu-rt-period", "--cpu-rt-runtime", "-c", "--cpu-shares", "--cpus", "--cpuset-cpus", "--cpuset-mems"],
    ...["--detach-keys", "--device", "--device-cgroup-rule", "--device-read-bps", "--device-read-iops"],
    ...["--device-write-bps", "--device-write-iops", "--dns", "--dns-option", "--dns-search", "--domainname"],
    ...["--entrypoint", "-e", "--env", "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd"],
    ...["--health-interval", "--health-retries", "--health-start-interval", "--health-start-period"],
    ...["--health-timeout", "-h", "--hostname", "--ip", "--ip6", "--ipc", "--isolation", "--kernel-memory"],
    ...["-l", "--label", "--label-file", "--link", "--link-local-ip", "--log-driver", "--log-opt"],
    ...["--mac-address", "-m", "--memory", "--memory-reservation", "--memory-swap", "--memory-swappiness"],
    ...["--mount", "--name", "--network", "--net", "--network-alias", "--oom-score-adj", "--pid", "--pids-limit"],
    ...["--platform", "-p", "--publish", "--pull", "--restart", "--runtime", "--security-opt", "--shm-size"],
    ...["--stop-signal", "--stop-timeout", "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "-u", "--user"],
    ...["--userns", "--uts", "-v", "--volume", "--volume-driver", "--volumes-from", "-w", "--workdir"],
  ],
  optional: ["--sig-proxy", "--disable-content-trust"],
  flags: [
    ...["-d", "--detach", "--init", "-i", "--interactive", "--no-healthcheck", "--oom-kill-disable"],
    ...["--privileged", "-P", "--publish-all", "-q", "--quiet", "--read-only", "--rm", "-t", "--tty"],
  ],
}
const KUBECTL: Grammar = {
  values: [
    ...["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token"],
    ...["--as", "--as-group", "--as-uid", "--certificate-authority", "--client-certificate", "--client-key"],
    ...["--tls-server-name", "--request-timeout", "--cache-dir", "-v", "--v", "--vmodule", "--log-file"],
    ...["--password", "--username", "--profile", "--profile-output", "-c", "--container", "-f", "--filename"],
    ...["--pod-running-timeout"],
  ],
  flags: ["-i", "--stdin", "-t", "--tty", "-q", "--quiet", "--insecure-skip-tls-verify", "--warnings-as-errors"],
}

// Commands that run the command given in their trailing words.
const RUNNERS: Record<string, Grammar> = {
  // Zsh's `- cmd` runs cmd as a login command.
  "-": {},
  builtin: {},
  busybox: {},
  caffeinate: { values: ["-t", "-w"], flags: ["-d", "-i", "-m", "-s", "-u"] },
  chroot: {
    values: ["--groups", "--userspec"],
    flags: ["--skip-chdir"],
    none: ["--help", "--version"],
    operands: 1,
    shell: true,
  },
  chrt: {
    values: ["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"],
    flags: [
      ...["-a", "--all-tasks", "-b", "--batch", "-d", "--deadline", "-f", "--fifo", "-i", "--idle", "-o", "--other"],
      ...["-r", "--rr", "-R", "--reset-on-fork", "-v", "--verbose"],
    ],
    none: ["-m", "--max", "-p", "--pid", ...HELP],
    operands: 1,
  },
  command: { flags: ["-p", "-v", "-V"] },
  coproc: {},
  doas: { values: ["-a", "-C", "-u"], flags: ["-L", "-n", "-s"], shell: ["-s"] },
  env: {
    values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0", "-P"],
    optional: ["--block-signal", "--default-signal", "--ignore-signal"],
    flags: [...["-i", "--ignore-environment", "-0", "--null", "-v", "--debug", "--list-signal-handling"]],
    none: ["--help", "--version"],
    dash: true,
  },
  exec: { values: ["-a"], flags: ["-c", "-l"] },
  flock: {
    values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"],
    flags: [
      ...["-s", "--shared", "-x", "-e", "--exclusive", "-u", "--unlock", "-n", "--nb", "--nonblock", "-o"],
      ...["--close", "-F", "--no-fork", "--verbose"],
    ],
    none: HELP,
    operands: 1,
  },
  ionice: {
    values: ["-c", "--class", "-n", "--classdata"],
    flags: ["-t", "--ignore"],
    none: ["-p", "--pid", "-P", "--pgid", "-u", "--uid", ...HELP],
  },
  nice: { values: ["-n", "--adjustment"], none: ["--help", "--version"], numeric: true },
  nocorrect: {},
  noglob: {},
  nohup: { none: ["--help", "--version"] },
  nsenter: {
    values: ["-t", "--target", "-S", "--setuid", "-G", "--setgroups", "-W", "--wdns"],
    optional: [
      ...["-m", "-u", "-i", "-n", "-p", "-C", "-U", "-T", "-r", "-w", "--mount", "--uts", "--ipc", "--net"],
      ...["--pid", "--cgroup", "--user", "--time", "--root", "--wd"],
    ],
    flags: [
      ...["-a", "--all", "-F", "--no-fork", "-Z", "--follow-context", "-c", "--join-cgroup", "-e", "--env"],
      ...["--preserve-credentials", "--keep-caps", "--user-parent"],
    ],
    none: HELP,
  },
  pkexec: { values: ["--user"], flags: ["--disable-internal-agent", "--keep-cwd"], none: ["--help", "--version"] },
  setsid: { flags: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"], none: HELP },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], none: ["--help", "--version"] },
  sudo: {
    values: [
      ...["-C", "-D", "-R", "-T", "-U", "-a", "-c", "-g", "-p", "-r", "-t", "-u"],
      ...["--close-from", "--chdir", "--chroot", "--command-timeout", "--group", "--host", "--login-class"],
      ...["--other-user", "--prompt", "--role", "--type", "--user"],
    ],
    optional: ["-h", "--preserve-env"],
    flags: [
      ...["-A", "-B", "-b", "-E", "-H", "-i", "-k", "-l", "-N", "-n", "-P", "-S", "-s"],
      ...["--askpass", "--bell", "--background", "--set-home", "--login", "--reset-timestamp", "--list"],
      ...["--no-update", "--non-interactive", "--preserve-groups", "--stdin", "--shell", "--help"],
    ],
    // -e edits files, and the others run nothing.
    none: ["-e", "--edit", "-K", "--remove-timestamp", "-V", "--version", "-v", "--validate"],
    shell: ["-s", "-i", "--shell", "--login"],
  },
  "systemd-run": {
    values: [
      ...["-u", "--unit", "-p", "--property", "--description", "--slice", "--service-type", "--uid", "--gid"],
      ...["--nice", "--working-directory", "-E", "--setenv", "--on-active", "--on-boot", "--on-startup"],
      ...["--on-unit-active", "--on-unit-inactive", "--on-calendar", "--timer-property", "--path-property"],
      ...["--socket-property", "-H", "--host", "-M", "--machine", "--json", "--background"],
    ],
    optional: ["--expand-environment"],
    flags: [
      ...["--user", "--system", "--scope", "-r", "--remain-after-exit", "--send-sighup", "-t", "--pty", "-P"],
      ...["--pipe", "-q", "--quiet", "-G", "--collect", "--no-block", "--wait", "--no-ask-password", "-d"],
      ...["--same-dir", "--slice-inherit", "--on-timezone-change", "--on-clock-change", "-S", "--shell"],
    ],
    none: ["-h", "--help", "--version"],
    shell: ["-S", "--shell"],
  },
  taskset: { flags: ["-a", "--all-tasks", "-c", "--cpu-list"], none: ["-p", "--pid", ...HELP], operands: 1 },
  time: {
    values: ["-f", "--format", "-o", "--output"],
    flags: ["-p", "--portability", "-a", "--append", "-v", "--verbose", "-q", "--quiet"],
    none: ["-V", "--version", "--help"],
  },
  unshare: {
    values: [
      ...["--map-user", "--map-group", "--map-users", "--map-groups", "--propagation", "--setgroups", "-R"],
      ...["--root", "-w", "--wd", "-S", "--setuid", "-G", "--setgid", "--monotonic", "--boottime"],
    ],
    optional: [
      ...["-i", "-m", "-n", "-p", "-u", "-U", "-C", "-T", "--ipc", "--mount", "--net", "--pid", "--uts", "--user"],
      ...["--cgroup", "--time", "--kill-child", "--mount-proc", "--mount-binfmt"],
    ],
    flags: ["-f", "--fork", "-r", "--map-root-user", "-c", "--map-current-user", "--map-auto", "--keep-caps"],
    none: HELP,
  },
  timeout: {
    values: ["-k", "--kill-after", "-s", "--signal"],
    flags: ["-f", "--foreground", "-p", "--preserve-status", "-v", "--verbose"],
    none: ["--help", "--version"],
    operands: 1,
  },
  watch: {
    values: ["-n", "--interval", "-q", "--equexit"],
    optional: ["-d", "--differences"],
    flags: [
      ...["-b", "--beep", "-c", "--color", "-C", "--no-color", "-e", "--errexit", "-g", "--chgexit", "-p"],
      ...["--precise", "-r", "--no-rerun", "-t", "--no-title", "-w", "--no-wrap", "-x", "--exec"],
    ],
    none: HELP,
  },
  xargs: {
    values: [
      ...["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs"],
      ...["-s", "--max-chars", "--process-slot-var", "-J", "-R", "-S"],
    ],
    // GNU xargs takes these values only when attached: `-iR`, `--replace=R`.
    optional: ["-e", "--eof", "-i", "--replace", "-l", "--max-lines"],
    flags: [
      ...["-0", "--null", "-o", "--open-tty", "-p", "--interactive", "-r", "--no-run-if-empty", "-t"],
      ...["--verbose", "-x", "--exit", "--show-limits"],
    ],
    none: ["--help", "--version"],
  },
}
RUNNERS.gtimeout = RUNNERS.timeout

const PARALLEL: Grammar = {
  values: [
    ...["-j", "--jobs", "-P", "--max-procs", "-a", "--arg-file", "-n", "--max-args", "-N", "--max-replace-args"],
    ...["-I", "-S", "--sshlogin", "--colsep", "-C", "--env", "--delay", "--timeout", "--tmpdir", "--workdir"],
    ...["--wd", "-d", "--delimiter", "-E", "--results", "--res", "--joblog", "--halt", "--retries", "-L"],
    ...["--block", "--block-size", "--sshloginfile", "--slf", "--basefile", "--bf", "--return", "--transferfile"],
    ...["--tf", "--memfree", "--load", "--limit", "--nice", "-J", "--profile", "--tagstring", "--ssh"],
    ...["--termseq", "--header", "-s", "--max-chars"],
  ],
  optional: ["-i", "--replace", "-e", "--eof", "-l", "--max-lines"],
  flags: [
    ...["-k", "--keep-order", "-X", "-m", "-q", "--quote", "--pipe", "--tag", "-u", "--ungroup", "--line-buffer"],
    ...["--lb", "-v", "--verbose", "--dry-run", "--progress", "--bar", "--eta", "-0", "--null", "-r"],
    ...["--no-run-if-empty", "--xargs", "--plus", "--will-cite", "--citation", "--group", "--shuf"],
  ],
  none: ["--help", "--version"],
}
const PARALLEL_SEPARATORS = new Set([":::", "::::", ":::+", "::::+"])

const SCRIPT: Grammar = {
  values: [
    ...["-c", "--command", "-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T"],
    ...["--log-timing", "-m", "--logging-format", "-o", "--output-limit", "-t"],
  ],
  flags: [...["-a", "--append", "-e", "--return", "-f", "--flush", "--force", "-q", "--quiet", "-k", "-F", "-r"]],
  none: ["-p", ...HELP],
}

const FISH: Grammar = {
  values: [
    ...["-c", "--command", "-C", "--init-command", "-d", "--debug", "-o", "--debug-output", "-f", "--features"],
    ...["-p", "--profile", "--profile-startup"],
  ],
  flags: ["-i", "--interactive", "-l", "--login", "-n", "--no-execute", "-N", "--no-config", "-P", "--private"],
}
const FISH_SCRIPTS = ["-c", "--command", "-C", "--init-command"]

// POSIX-family shells, each with the dialect its scripts are read in. The ksh family reads as Bash does.
const SHELLS: Record<string, Dialect> = {
  ash: "posix",
  bash: "bash",
  dash: "posix",
  hush: "posix",
  ksh: "bash",
  ksh93: "bash",
  lksh: "bash",
  mksh: "bash",
  oksh: "bash",
  pdksh: "bash",
  posh: "posix",
  rbash: "bash",
  sh: "posix",
  yash: "posix",
  zsh: "zsh",
}
const SHELL_LONG_VALUES = new Set(["--init-file", "--rcfile", "--emulate"])
const POWERSHELLS = new Set(["pwsh", "powershell", "pwsh-preview"])

const FIND_EXECS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

// Every command a simple command runs, from its words as written: the command itself, then whatever its runners
// (`env`, `sudo`, `xargs`, …), `find -exec` and container tools run in turn, together with the script strings it
// hands to a shell's -c, to `eval`, to `env -S`, to `watch`, to `ssh` or to `su`. DIALECT is the shell reading the
// words, which `eval` runs its script in. Each inner command has fewer words than the one running it, so the walk
// ends.
export function unwrap(words: readonly string[], dialect: Dialect = "posix"): Unwrapped {
  const result: Unwrapped = { views: [], scripts: [], texts: [] }
  if (!words.length) return result
  result.views.push(view(words, 0, dialect))
  for (let i = 0; i < result.views.length; i++) {
    const item = result.views[i]
    if (item.implied) continue
    const step = inner(item, dialect)
    for (const found of step.views) {
      if (result.views.some((known) => same(known, found))) continue
      if (result.views.length >= MAX_VIEWS) result.truncated = true
      else result.views.push(found)
    }
    for (const script of step.scripts)
      if (!result.scripts.some((known) => known.text === script.text && known.dialect === script.dialect))
        result.scripts.push(script)
    for (const text of step.texts) if (!result.texts.includes(text)) result.texts.push(text)
  }
  return result
}

function same(a: View, b: View) {
  return a.program === b.program && a.implied === b.implied && a.args.join("\0") === b.args.join("\0")
}

function view(words: readonly string[], at: number, dialect: Dialect): View {
  return { name: program(words[at], dialect), program: words[at], args: words.slice(at + 1) }
}

function implied(): View {
  return { name: "sh", program: "sh", args: [], implied: true }
}

function empty(): Step {
  return { views: [], scripts: [], texts: [] }
}

// The commands and script strings one command runs on behalf of its words.
function inner(item: View, dialect: Dialect): Step {
  const name = item.name.toLowerCase()
  if (name === "eval")
    return {
      ...empty(),
      scripts: item.args.length ? [script(item.args.map(literal).join(" "), dialect, item.args)] : [],
    }
  if (name === "find") return { ...empty(), views: execs(item.args, dialect) }
  if (SHELLS[name]) return shell(item, SHELLS[name]).step
  if (POWERSHELLS.has(name)) return { ...empty(), texts: powershell(item.args) }
  if (name === "cmd") return { ...empty(), texts: cmd(item.args) }
  if (name === "fish") return { ...empty(), texts: fish(item.args) }
  if (name === "csh" || name === "tcsh") return { ...empty(), texts: csh(item.args) }
  if (name === "su") return su(item, SU, dialect)
  if (name === "runuser") return su(item, RUNUSER, dialect)
  if (name === "ssh") return ssh(item)
  if (name === "script") return scriptCommand(item, dialect)
  if (name === "parallel") return parallel(item, dialect)
  if (name === "docker" || name === "podman" || name === "nerdctl") return docker(item, dialect)
  if (name === "kubectl" || name === "oc") return kubectl(item, dialect)
  const grammar = RUNNERS[name]
  if (!grammar) return empty()
  return runner(item, grammar, dialect, (parse, rest, step) => {
    if (name === "env")
      for (const option of parse.options)
        if ((option.name === "-S" || option.name === "--split-string") && option.value)
          step.scripts.push({ text: option.value, dialect: "posix" })
    // flock's -c comes after the lock file.
    if (name === "flock" && rest.length && ["-c", "--command"].includes(literal(rest[0]))) {
      if (rest[1] !== undefined) step.scripts.push(script(literal(rest[1]), "posix", [rest[1]]))
      return true
    }
    // Without -x, watch hands its words to `sh -c` as one script.
    if (name === "watch" && rest.length && !parse.options.some((option) => ["-x", "--exec"].includes(option.name))) {
      step.scripts.push(script(rest.map(literal).join(" "), "posix", rest))
      return true
    }
    return false
  })
}

// The generic runner: its options, operands and assignments, then the command. AFTER may take over the words that
// follow the options and operands, returning true when it has.
function runner(
  item: View,
  grammar: Grammar,
  dialect: Dialect,
  after?: (parse: Parse, rest: string[], step: Step) => boolean,
) {
  const step = empty()
  for (const parse of options(item.args, grammar)) {
    if (parse.options.some((option) => grammar.none?.includes(option.name))) continue
    let at = Math.min(item.args.length, parse.at + (grammar.operands ?? 0))
    if (after?.(parse, item.args.slice(at), step)) continue
    while (at < item.args.length && !dynamic(item.args[at]) && ASSIGNMENT.test(literal(item.args[at]))) at++
    if (at < item.args.length) step.views.push(view(item.args, at, dialect))
    else if (
      grammar.shell === true ||
      parse.options.some(
        (option) => grammar.shell !== undefined && grammar.shell !== true && grammar.shell.includes(option.name),
      )
    )
      step.views.push(implied())
  }
  return step
}

// Reads ARGS as GRAMMAR's options, returning each way they can be read: the options and the index of the first word
// after them.
function options(args: readonly string[], grammar: Grammar): Parse[] {
  const done: Parse[] = []
  const stack: Array<{ i: number; options: Option[] }> = [{ i: 0, options: [] }]
  const branch = (i: number, found: Option[]) => {
    if (done.length + stack.length < MAX_PARSES) stack.push({ i, options: found })
  }
  while (stack.length > 0) {
    const state = stack.pop()!
    const found = state.options
    let i = state.i
    words: for (; i < args.length; i++) {
      if (dynamic(args[i])) {
        branch(i + 1, [...found, { name: args[i] }])
        break
      }
      const word = literal(args[i])
      if (word === "--") {
        i++
        break
      }
      if (word === "-") {
        if (!grammar.dash) break
        found.push({ name: "-" })
        continue
      }
      if (!word.startsWith("-")) break
      if (word.startsWith("--")) {
        const eq = word.indexOf("=")
        const name = eq < 0 ? word : word.slice(0, eq)
        const known = long(grammar, name)
        if (eq >= 0) found.push({ name: known?.name ?? name, value: word.slice(eq + 1) })
        else if (known?.kind === "value") found.push({ name: known.name, value: next(args, i++) })
        else if (known) found.push({ name: known.name })
        else {
          branch(i + 2, [...found, { name, value: next(args, i) }])
          found.push({ name })
        }
        continue
      }
      if (grammar.numeric && /^-\d+$/.test(word)) {
        found.push({ name: word })
        continue
      }
      for (let k = 1; k < word.length; k++) {
        const name = "-" + word[k]
        const rest = word.slice(k + 1)
        const kind = short(grammar, name)
        if (kind === "value") {
          found.push({ name, value: rest || next(args, i) })
          if (!rest) i++
          continue words
        }
        if (kind === "optional") {
          found.push({ name, value: rest || undefined })
          continue words
        }
        if (!kind) branch(rest ? i + 1 : i + 2, [...found, { name, value: rest || next(args, i) }])
        found.push({ name })
      }
    }
    done.push({ options: found, at: Math.min(i, args.length) })
  }
  return done
}

function next(args: readonly string[], i: number) {
  return i + 1 < args.length ? literal(args[i + 1]) : undefined
}

type Kind = "value" | "optional" | "flag"

function short(grammar: Grammar, name: string): Kind | undefined {
  if (grammar.values?.includes(name)) return "value"
  if (grammar.optional?.includes(name)) return "optional"
  if (grammar.flags?.includes(name) || grammar.none?.includes(name)) return "flag"
}

// A long option by its name or by an abbreviation getopt_long accepts: a prefix of exactly one option.
function long(grammar: Grammar, name: string): { name: string; kind: Kind } | undefined {
  const exact = short(grammar, name)
  if (exact) return { name, kind: exact }
  const all = [
    ...(grammar.values ?? []),
    ...(grammar.optional ?? []),
    ...(grammar.flags ?? []),
    ...(grammar.none ?? []),
  ]
  const matches = all.filter((item) => item.startsWith("--") && item.startsWith(name))
  if (matches.length === 1) return { name: matches[0], kind: short(grammar, matches[0])! }
}

// The commands find runs for -exec, -execdir, -ok and -okdir, each ending at a `;` or `+` word.
function execs(args: string[], dialect: Dialect): View[] {
  const words = args.map(literal)
  const starts = words.flatMap((word, i) => (FIND_EXECS.has(word) ? [i + 1] : []))
  return starts.flatMap((start) => {
    const end = words.findIndex((word, i) => i > start && (word === ";" || word === "+"))
    const stop = end < 0 ? words.length : end
    if (stop <= start) return []
    return [{ ...view(args, start, dialect), args: args.slice(start + 1, stop) }]
  })
}

function script(text: string, dialect: Dialect, words: readonly string[]): Script {
  return words.some(dynamic) ? { text, dialect, dynamic: true } : { text, dialect }
}

// What a POSIX-family shell runs from its words: the command string of -c, also with its positional parameters
// filled in when they are static, else a script file or its input. Each -o and -O in an option cluster takes the
// next word.
export function shell(item: View, dialect: Dialect): { step: Step; file?: string; input: boolean } {
  const step = empty()
  const args = item.args
  const state = { command: false, input: false, i: 0 }
  for (; state.i < args.length; state.i++) {
    if (dynamic(args[state.i])) break
    const word = literal(args[state.i])
    if (word === "--" || word === "-") {
      state.i++
      break
    }
    if (word.startsWith("--")) {
      if (SHELL_LONG_VALUES.has(word)) state.i++
      continue
    }
    if (!/^[-+][A-Za-z]+$/.test(word)) break
    for (const char of word.slice(1)) {
      if (char === "o" || char === "O") state.i++
      if (word[0] === "-" && char === "c") state.command = true
      if (word[0] === "-" && char === "s") state.input = true
    }
  }
  const operands = args.slice(state.i)
  if (state.command) {
    // A command string known only at run time may be an option, and the next word the command string.
    for (const at of dynamic(operands[0] ?? "") && operands.length > 1 ? [0, 1] : [0]) {
      if (operands[at] === undefined) continue
      const text = literal(operands[at])
      step.scripts.push(script(text, dialect, [operands[at]]))
      const filled = positional(text, operands.slice(at + 1))
      if (filled !== undefined && filled !== text) step.scripts.push({ text: filled, dialect })
    }
    return { step, input: false }
  }
  if (state.input || !operands.length) return { step, input: true }
  const file = dynamic(operands[0]) ? undefined : literal(operands[0])
  return { step, file, input: file !== undefined && STDIN.has(file) }
}

// TEXT with its positional parameters ($0 first) replaced by PARAMS, each quoted, when they are all static and the
// text names one.
function positional(text: string, params: readonly string[]) {
  if (!/\$(?:[@*\d]|\{(?:[@*]|\d+)\})/.test(text) || params.some(dynamic)) return
  const values = params.map(literal)
  const args = values.slice(1).map(quote).join(" ")
  return text.replace(/"\$(?:\{([@*]|\d+)\}|([@*\d]))"|\$(?:\{([@*]|\d+)\}|([@*\d]))/g, (...match: string[]) => {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (name === "@" || name === "*") return args
    return quote(values[Number(name)] ?? "")
  })
}

// VALUE as one shell word.
export function quote(value: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

// PowerShell's command text: what -Command, -CommandWithArgs or -EncodedCommand give, or the words it runs as a
// command when no parameter names them. Parameters match by prefix, case-insensitively, after `-` or `/`; `-Command
// -` reads the command from the input.
function powershell(args: readonly string[]) {
  const texts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const word = literal(args[i])
    const param = /^[-/]([A-Za-z?]+)(?::(.*))?$/s.exec(word)
    if (!param) {
      texts.push(args.slice(i).map(literal).join(" "))
      break
    }
    const kind = powershellParam(param[1].toLowerCase())
    const inline = param[2]
    if (kind === "command") {
      const rest = [...(inline ? [inline] : []), ...args.slice(i + 1).map(literal)]
      if (rest.length && !(rest.length === 1 && rest[0] === "-")) texts.push(rest.join(" "))
      break
    }
    if (kind === "cwa") {
      const value = inline ?? (i + 1 < args.length ? literal(args[i + 1]) : undefined)
      if (value) texts.push(value)
      break
    }
    if (kind === "encoded") {
      const value = inline ?? (i + 1 < args.length ? literal(args[++i]) : undefined)
      const decoded = value === undefined ? undefined : decodePowerShell(value)
      if (decoded) texts.push(decoded)
      continue
    }
    if (kind === "file") break
    if (kind === "value" && inline === undefined) i++
  }
  return texts
}

const POWERSHELL_PARAMS: Record<string, string> = {
  command: "command",
  commandwithargs: "cwa",
  configurationfile: "value",
  configurationname: "value",
  custompipename: "value",
  encodedarguments: "value",
  encodedcommand: "encoded",
  executionpolicy: "value",
  file: "file",
  help: "flag",
  inputformat: "value",
  interactive: "flag",
  login: "flag",
  mta: "flag",
  noexit: "flag",
  nologo: "flag",
  noninteractive: "flag",
  noprofile: "flag",
  noprofileloadtime: "flag",
  outputformat: "value",
  settingsfile: "value",
  sta: "flag",
  version: "flag",
  windowstyle: "value",
  workingdirectory: "value",
}
const POWERSHELL_ALIASES: Record<string, string> = {
  "?": "flag",
  c: "command",
  cwa: "cwa",
  e: "encoded",
  ea: "value",
  ec: "encoded",
  ep: "value",
  ex: "value",
  f: "file",
  if: "value",
  o: "value",
  of: "value",
  w: "value",
  wd: "value",
}

function powershellParam(name: string) {
  if (POWERSHELL_ALIASES[name]) return POWERSHELL_ALIASES[name]
  if (POWERSHELL_PARAMS[name]) return POWERSHELL_PARAMS[name]
  const kinds = new Set(
    Object.keys(POWERSHELL_PARAMS)
      .filter((item) => item.startsWith(name))
      .map((item) => POWERSHELL_PARAMS[item]),
  )
  return kinds.size === 1 ? [...kinds][0] : "flag"
}

// -EncodedCommand is Base64 of UTF-16LE text.
function decodePowerShell(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return
  const bytes = Buffer.from(value, "base64")
  if (bytes.length % 2 !== 0) return
  return bytes.toString("utf16le")
}

// The command text cmd.exe runs after /c or /k (`//c` under MSYS path conversion), its other switches skipped.
function cmd(args: readonly string[]) {
  for (let i = 0; i < args.length; i++) {
    const word = literal(args[i])
    const run = /^\/\/?[ckr]/i.exec(word)
    if (run) return [[word.slice(run[0].length), ...args.slice(i + 1).map(literal)].filter(Boolean).join(" ")]
    if (!word.startsWith("/")) return [args.slice(i).map(literal).join(" ")]
  }
  return []
}

// The command text fish runs for -c, --command, -C and --init-command.
function fish(args: readonly string[]) {
  return options(args, FISH).flatMap((parse) =>
    parse.options.flatMap((option) => (FISH_SCRIPTS.includes(option.name) && option.value ? [option.value] : [])),
  )
}

// The command text the C shells run for -c: their first operand.
function csh(args: readonly string[]) {
  let command = false
  for (const raw of args) {
    const word = literal(raw)
    if (/^-[A-Za-z]+$/.test(word)) {
      if (word.includes("c")) command = true
      continue
    }
    return command ? [word] : []
  }
  return []
}

// su and runuser: the scripts their -c options, and a -c among the words after the user, hand to the user's shell,
// or with runuser's -u the command itself. Without a script, they start the user's shell, which reads its input.
function su(item: View, grammar: Grammar, dialect: Dialect): Step {
  const step = empty()
  for (const parse of options(item.args, grammar)) {
    if (parse.options.some((option) => grammar.none?.includes(option.name))) continue
    const scripts = parse.options.filter((option) => SU_SCRIPTS.includes(option.name) && option.value !== undefined)
    for (const option of scripts) step.scripts.push({ text: option.value!, dialect: "posix" })
    if (parse.options.some((option) => option.name === "-u" || option.name === "--user")) {
      if (parse.at < item.args.length) step.views.push(view(item.args, parse.at, dialect))
      continue
    }
    const call = shell({ name: "sh", program: "sh", args: item.args.slice(parse.at + 1) }, "posix")
    step.scripts.push(...call.step.scripts)
    if (!scripts.length && !call.step.scripts.length) step.views.push(implied())
  }
  return step
}

// ssh: options before and after the destination, then the remote command's words, which the remote shell reads as
// one script. With no command, the remote shell reads the input, unless -n gives it none.
function ssh(item: View): Step {
  const step = empty()
  for (const first of options(item.args, SSH)) {
    if (first.at >= item.args.length) continue
    const after = item.args.slice(first.at + 1)
    for (const second of options(after, SSH)) {
      const found = [...first.options, ...second.options]
      if (found.some((option) => SSH.none!.includes(option.name))) continue
      const rest = after.slice(second.at)
      if (rest.length) step.scripts.push(script(rest.map(literal).join(" "), "posix", rest))
      else if (!found.some((option) => option.name === "-n")) step.views.push(implied())
    }
  }
  return step
}

// script(1): util-linux runs -c's command in a shell, BSD the command after the typescript file. With neither, it
// starts a shell, which reads its input.
function scriptCommand(item: View, dialect: Dialect): Step {
  const step = empty()
  for (const parse of options(item.args, SCRIPT)) {
    if (parse.options.some((option) => SCRIPT.none!.includes(option.name))) continue
    const commands = parse.options.filter((option) => ["-c", "--command"].includes(option.name) && option.value)
    for (const option of commands) step.scripts.push({ text: option.value!, dialect: "posix" })
    const at = Math.min(item.args.length, parse.at + 1)
    if (at < item.args.length) step.views.push(view(item.args, at, dialect))
    else if (!commands.length) step.views.push(implied())
  }
  return step
}

// GNU parallel runs its command through a shell, with each input in place of `{}` or after it; with no command, each
// input is a command itself.
function parallel(item: View, dialect: Dialect): Step {
  const step = empty()
  for (const parse of options(item.args, PARALLEL)) {
    if (parse.options.some((option) => PARALLEL.none!.includes(option.name))) continue
    const rest = item.args.slice(parse.at)
    const split = rest.findIndex((word) => PARALLEL_SEPARATORS.has(literal(word)))
    const command = split < 0 ? rest : rest.slice(0, split)
    const inputs = split < 0 ? [] : rest.slice(split + 1).filter((word) => !PARALLEL_SEPARATORS.has(literal(word)))
    if (!command.length) {
      for (const input of inputs.slice(0, MAX_INPUTS)) step.scripts.push(script(literal(input), dialect, [input]))
      continue
    }
    if (command.length > 1) step.views.push(view(command, 0, dialect))
    const text = command.map(literal).join(" ")
    step.scripts.push(script(text, dialect, command))
    for (const input of inputs.slice(0, MAX_INPUTS)) {
      if (dynamic(input)) continue
      const value = quote(literal(input))
      step.scripts.push({ text: text.includes("{}") ? text.replaceAll("{}", value) : `${text} ${value}`, dialect })
    }
  }
  return step
}

// docker, podman and nerdctl: the command `exec` and `run` start in a container, after its container or image, with
// `run --entrypoint` naming its program.
function docker(item: View, dialect: Dialect): Step {
  const step = empty()
  for (const global of options(item.args, DOCKER_GLOBAL)) {
    const at = global.at + (literal(item.args[global.at] ?? "") === "container" ? 1 : 0)
    const sub = literal(item.args[at] ?? "")
    if (sub !== "exec" && sub !== "run") continue
    const args = item.args.slice(at + 1)
    for (const parse of options(args, sub === "exec" ? DOCKER_EXEC : DOCKER_RUN)) {
      const start = Math.min(args.length, parse.at + 1)
      const entrypoint = parse.options.findLast((option) => option.name === "--entrypoint")?.value
      const words = entrypoint ? [quote(entrypoint), ...args.slice(start)] : args.slice(start)
      if (words.length) step.views.push(view(words, 0, dialect))
    }
  }
  return step
}

// kubectl exec, run and debug: the command after `--`, or for exec without it, the words after the pod.
function kubectl(item: View, dialect: Dialect): Step {
  const step = empty()
  for (const global of options(item.args, KUBECTL)) {
    const sub = literal(item.args[global.at] ?? "")
    if (!["exec", "run", "debug"].includes(sub)) continue
    const args = item.args.slice(global.at + 1)
    const dashes = args.findIndex((word) => literal(word) === "--")
    if (dashes >= 0) {
      if (dashes + 1 < args.length) step.views.push(view(args, dashes + 1, dialect))
      continue
    }
    if (sub !== "exec") continue
    for (const parse of options(args, KUBECTL)) {
      const start = Math.min(args.length, parse.at + 1)
      if (start < args.length) step.views.push(view(args, start, dialect))
    }
  }
  return step
}

// The program a command word names, without its quoting or directory, Windows executable suffix or Zsh `=`
// expansion, so rules written for `rm` also see `\rm`, `"rm"`, `/bin/rm`, `C:\bin\rm.exe` and `=rm`. A name
// computed at run time stays as written.
export function program(text: string, dialect: Dialect = "posix") {
  if (dynamic(text)) return text
  const value = literal(text)
  const expanded = dialect === "zsh" && /^=[^=\s]/.test(value) ? value.slice(1) : value
  const base = expanded.slice(Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\")) + 1)
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, "") || base || value
}

// Whether a word's value is only known at run time: it holds a command, parameter, arithmetic, process or backtick
// expansion outside single quotes. `$'…'` and `$"…"` are static quoting, decoded by `literal`.
export function dynamic(text: string) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return false
      i = end
      continue
    }
    if (char === "$" && text[i + 1] === "'") {
      i = ansiEnd(text, i + 1)
      continue
    }
    if (char === '"' || (char === "$" && text[i + 1] === '"')) {
      let j = char === "$" ? i + 2 : i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\") {
          j++
          continue
        }
        if (text[j] === "`" || (text[j] === "$" && expansion(text[j + 1]))) return true
      }
      i = j
      continue
    }
    if (char === "`" || (char === "$" && expansion(text[i + 1]))) return true
    if ((char === "<" || char === ">") && text[i + 1] === "(") return true
  }
  return false
}

function expansion(char: string | undefined) {
  return char !== undefined && /[A-Za-z0-9_@*#?$!({[-]/.test(char)
}

// The index of the quote closing the `$'…'` span whose opening quote is at START.
function ansiEnd(text: string, start: number) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++
      continue
    }
    if (text[i] === "'") return i
  }
  return text.length
}

// The value of a shell word with its quoting removed: '…' verbatim, "…" and $"…" with their backslash escapes
// resolved, $'…' with its ANSI-C escapes decoded, and a bare backslash escaping the next character. A backslash
// before a newline continues the line, so both go. An expansion (`$(…)`, `${…}`, `…`) stays as written, with the
// quotes inside it, since its value is only known at run time; an unterminated quote stays as well.
export function literal(text: string) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "\\" && i + 1 < text.length) {
      if (text[i + 1] !== "\n") out += text[i + 1]
      i++
      continue
    }
    if (char === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) out += char
      else {
        out += text.slice(i + 1, end)
        i = end
      }
      continue
    }
    if (char === "$" && text[i + 1] === "'") {
      const end = ansiEnd(text, i + 1)
      if (end >= text.length) out += char
      else {
        out += ansiDecode(text.slice(i + 2, end))
        i = end
      }
      continue
    }
    const locale = char === "$" && text[i + 1] === '"'
    if (char === '"' || locale) {
      const open = locale ? i + 1 : i
      const end = quoteEnd(text, open)
      if (end < 0) out += char
      else {
        out += doubleValue(text.slice(open + 1, end))
        i = end
      }
      continue
    }
    const expansion = expansionAt(text, i)
    if (expansion > i) {
      out += text.slice(i, expansion)
      i = expansion - 1
      continue
    }
    out += char
  }
  return out
}

// The value of the inside of "…": backslashes escape `$`, `` ` ``, `"`, `\` and a newline, which goes, and expansions
// stay as written.
function doubleValue(inner: string) {
  let out = ""
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    if (char === "\\" && i + 1 < inner.length && '$`"\\\n'.includes(inner[i + 1])) {
      if (inner[i + 1] !== "\n") out += inner[i + 1]
      i++
      continue
    }
    const expansion = expansionAt(inner, i)
    if (expansion > i) {
      out += inner.slice(i, expansion)
      i = expansion - 1
      continue
    }
    out += char
  }
  return out
}

// The end of the `$(…)`, `$((…))`, `${…}` or backquoted expansion starting at START, past its nested quotes and
// expansions; START itself when none starts there.
function expansionAt(text: string, start: number): number {
  if (text[start] === "`") {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\\") i++
      else if (text[i] === "`") return i + 1
    }
    return text.length
  }
  if (text[start] !== "$" || (text[start + 1] !== "(" && text[start + 1] !== "{")) return start
  const open = text[start + 1]
  const close = open === "(" ? ")" : "}"
  let depth = 0
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === "'" && open === "(") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return text.length
      i = end
      continue
    }
    if (char === '"') {
      const end = quoteEnd(text, i)
      if (end < 0) return text.length
      i = end
      continue
    }
    const nested = i > start + 1 ? expansionAt(text, i) : i
    if (nested > i) {
      i = nested - 1
      continue
    }
    if (char === open) depth++
    else if (char === close && --depth === 0) return i + 1
  }
  return text.length
}

// The index of the quote closing the "…" span whose opening quote is at START, past the expansions inside it; -1 when
// none does.
function quoteEnd(text: string, start: number) {
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === '"') return i
    const expansion = expansionAt(text, i)
    if (expansion > i) i = expansion - 1
  }
  return -1
}

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

// The value of a `$'…'` body as Bash decodes it: named escapes, octal, hex and Unicode code points and control
// characters, an unknown escape kept with its backslash, and the value cut at a NUL.
function ansiDecode(body: string) {
  let out = ""
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i]
      continue
    }
    const next = body[i + 1]
    if (next === undefined) return out + "\\"
    if (next in ANSI_ESCAPES) {
      out += ANSI_ESCAPES[next]
      i++
      continue
    }
    if (next === "c" && body[i + 2] !== undefined) {
      const point = body[i + 2] === "?" ? 0x7f : body.charCodeAt(i + 2) & 0x1f
      if (point === 0) return out
      out += String.fromCharCode(point)
      i += 2
      continue
    }
    const hex = next === "x" || next === "u" || next === "U"
    const digits = hex
      ? new RegExp(`^[0-9a-fA-F]{1,${next === "x" ? 2 : next === "u" ? 4 : 8}}`).exec(body.slice(i + 2))?.[0]
      : /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0]
    const point = digits === undefined ? undefined : parseInt(digits, hex ? 16 : 8)
    if (point === undefined || point > 0x10ffff) {
      out += "\\"
      continue
    }
    if (point === 0) return out
    out += String.fromCodePoint(point)
    i += hex ? digits!.length + 1 : digits!.length
  }
  return out
}

// ARGS with their short option clusters split (`-rf` as `-r -f`), except after `--` and in the value of an option
// in VALUES; none when nothing splits.
function split(args: readonly string[], values: readonly string[] = []) {
  const out: string[] = []
  let changed = false
  for (let i = 0; i < args.length; i++) {
    const word = literal(args[i])
    if (word === "--") {
      out.push(...args.slice(i))
      break
    }
    if (values.includes(word)) {
      out.push(...args.slice(i, i + 2))
      i++
      continue
    }
    if (CLUSTER.test(word)) {
      out.push(...[...word.slice(1)].map((char) => "-" + char))
      changed = true
      continue
    }
    out.push(args[i])
  }
  return changed ? out : undefined
}

export function text(item: View) {
  return [item.program, ...item.args].join(" ")
}

// The spellings of one command the rules are checked against together: as written, fully unquoted and decoded when
// every word is static, and each of those with its option clusters split.
export function spellings(item: View) {
  const written = [item.program, ...item.args]
  const forms = [written]
  if (!written.some(dynamic)) forms.push(written.map(literal))
  const values = RUNNERS[item.name.toLowerCase()]?.values
  for (const form of [...forms]) {
    const flat = split(form.slice(1), values)
    if (flat) forms.push([form[0], ...flat])
  }
  return [...new Set(forms.map((form) => form.join(" ")))]
}

// The command named by its bare program when that differs from the program as written (`/bin/rm`, `rm.exe`): another
// file may run under that name, so it is a command of its own, which must be allowed as well.
export function renamed(item: View): View | undefined {
  if (dynamic(item.program) || literal(item.program) === item.name) return
  return { name: item.name, program: quote(item.name), args: item.args }
}
