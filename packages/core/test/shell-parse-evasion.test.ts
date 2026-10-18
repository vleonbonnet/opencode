import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "@opencode/core/shell/parse"
import { ShellUnwrap } from "@opencode/core/shell/unwrap"
import { Wildcard } from "@opencode/core/util/wildcard"

// The scan of COMMAND by the legacy scanner, then the portable one: the result, or the error a refused command fails
// with, which then does not run.
async function scans(command: string, shell = "/bin/bash") {
  return Promise.all(
    [false, true].map(async (portable) => {
      const exit = await Effect.runPromiseExit(ShellParse.scan(command, shell, "/workspace", { portable }))
      if (exit._tag === "Success") return exit.value
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (!failure || failure._tag !== "Fail") throw new Error(`${command}: scan died`)
      return failure.error as Error
    }),
  )
}

// Every text the rules are checked against for COMMAND in each scanner: each command's resource and its alternate
// spellings, or undefined when the scanner refuses the command. Scanners that both read it must agree.
async function seen(command: string, shell = "/bin/bash") {
  const results = (await scans(command, shell)).map((result) =>
    result instanceof Error
      ? undefined
      : result.commands.flatMap((item) => [item.resource, ...(item.alternates ?? [])]),
  )
  if (results[0] && results[1]) expect(results[1], command).toEqual(results[0])
  return results
}

// Whether RULE sees COMMAND in both scanners: each refuses it or checks a spelling the rule matches.
async function matched(command: string, rule: string, shell = "/bin/bash") {
  const results = await seen(command, shell)
  expect(results.some(Boolean), `${command}: refused by both scanners`).toBe(true)
  return results.every((texts) => !texts || texts.some((text) => Wildcard.match(text, rule)))
}

describe("ShellParse rules see quoted and escaped arguments", () => {
  test.each([
    `kubectl "delete" pod x`,
    `kubectl 'delete' pod x`,
    `kubectl de\\lete pod x`,
    `kubectl d"ele"te pod x`,
    `sudo kubectl 'delete' pod x`,
    `bash -c 'kubectl "delete" pod x'`,
    `env -- kubectl "delete" pod x`,
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  test("splits an option cluster once it is unquoted", async () => {
    expect(await matched(`rm "-rf" build`, "rm -r *")).toBe(true)
  })
})

describe("ShellParse rules see ANSI-C and locale quoted words", () => {
  test.each([
    `bash -c $'kubectl delete pod x'`,
    `eval $'kubectl delete pod x'`,
    `$'kubectl' delete pod x`,
    `sudo $'kubectl' delete pod x`,
    `$"kubectl" delete pod x`,
    `$'\\x6bubectl' delete pod x`,
    `$'\\153ubectl' delete pod x`,
    `$'\\u006bubectl' delete pod x`,
    `kubectl $'delete' pod x`,
    `bash -c $'echo start\\nkubectl delete pod x'`,
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })
})

describe("ShellParse rules see commands behind assignments a runner passes", () => {
  test.each([
    "sudo X=1 kubectl delete pod x",
    "sudo -u root X=1 Y=2 kubectl delete pod x",
    "time X=1 kubectl delete pod x",
    "nice X=1 kubectl delete pod x",
    "env -i X=1 kubectl delete pod x",
    "env - X=1 kubectl delete pod x",
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })
})

describe("ShellParse runner option grammars", () => {
  test.each([
    // GNU xargs takes these values only after `=`.
    "xargs --replace kubectl delete pod {}",
    "xargs --eof kubectl delete pod x",
    "xargs --max-lines kubectl delete pod x",
    "xargs -i kubectl delete pod {}",
    // procps-ng watch: --chgexit takes no value.
    "watch --chgexit kubectl delete pod x",
    "watch -g kubectl delete pod x",
    // Each -o or -O in a shell's option cluster takes the next word.
    "bash -co pipefail 'kubectl delete pod x'",
    "bash -cO extglob 'kubectl delete pod x'",
    "bash -o pipefail -c 'kubectl delete pod x'",
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  test("does not split clusters after --", async () => {
    expect(await matched("rm -- -rf", "rm * -r *")).toBe(false)
  })
})

describe("ShellParse runners and shells that run another command", () => {
  test.each([
    "su -c 'kubectl delete pod x'",
    "su root -c 'kubectl delete pod x'",
    "su - root -c 'kubectl delete pod x'",
    "su --command='kubectl delete pod x' root",
    "runuser -u root -- kubectl delete pod x",
    "runuser root -c 'kubectl delete pod x'",
    "pkexec kubectl delete pod x",
    "pkexec --user root kubectl delete pod x",
    "coproc kubectl delete pod x",
    "parallel kubectl delete pod ::: x y",
    "parallel 'kubectl delete pod {}' ::: x",
    "ionice -c 3 kubectl delete pod x",
    "ionice -c3 -n7 kubectl delete pod x",
    "chroot /srv kubectl delete pod x",
    "chroot --userspec=nobody /srv kubectl delete pod x",
    "setsid -f kubectl delete pod x",
    "flock /tmp/lock kubectl delete pod x",
    "flock -n -w 5 /tmp/lock kubectl delete pod x",
    "flock /tmp/lock -c 'kubectl delete pod x'",
    "script -q -c 'kubectl delete pod x' /dev/null",
    "script -q /dev/null kubectl delete pod x",
    "nsenter -t 1 -m -u kubectl delete pod x",
    "unshare -r --fork kubectl delete pod x",
    "taskset 0x3 kubectl delete pod x",
    "taskset -c 0-3 kubectl delete pod x",
    "chrt 10 kubectl delete pod x",
    "chrt -f 10 kubectl delete pod x",
    "systemd-run --user -p Nice=5 kubectl delete pod x",
    "ssh host kubectl delete pod x",
    "ssh -t host 'kubectl delete pod x'",
    "ssh -p 2222 -o BatchMode=yes host kubectl delete pod x",
    "noglob kubectl delete pod x",
    "nocorrect kubectl delete pod x",
    "mksh -c 'kubectl delete pod x'",
    "ksh -c 'kubectl delete pod x'",
    "dash -c 'kubectl delete pod x'",
    "pwsh -c 'kubectl delete pod x'",
    "pwsh -NoProfile -Command kubectl delete pod x",
    "powershell kubectl delete pod x",
    "tcsh -c 'kubectl delete pod x'",
    "csh -fc 'kubectl delete pod x'",
    "fish -c 'kubectl delete pod x'",
    "fish --command='kubectl delete pod x'",
    "cmd /c kubectl delete pod x",
    "cmd.exe //c kubectl delete pod x",
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  test.each([
    "bash.exe -c 'kubectl delete pod x'",
    "kubectl.exe delete pod x",
    "KUBECTL.EXE delete pod x",
    `"C:\\Program Files\\Git\\bin\\bash.exe" -c 'kubectl delete pod x'`,
    `'C:\\tools\\kubectl.exe' delete pod x`,
    "/usr/local/bin/kubectl delete pod x",
  ])("names the program without its directory and Windows suffix: %s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })
})

// COMMAND inside LEVELS of eval.
function nested(levels: number, command: string) {
  return Array.from({ length: levels }).reduce<string>((acc) => `eval '${acc.replaceAll("'", `'\\''`)}'`, command)
}

describe("ShellParse refuses scripts it cannot read", () => {
  test.each([
    "bash -c 'kubectl delete pod x; alias a=b'",
    "sh -c 'kubectl delete pod x; a[$i]=1'",
    "eval 'kubectl delete pod x; alias a=b'",
    "ssh host 'kubectl delete pod x; alias a=b'",
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  test("refuses a script nested past the depth it follows, in both scanners", async () => {
    for (const result of await scans(nested(5, "kubectl get pods")))
      expect(result instanceof Error ? result.message : result).toContain("nests scripts")
    for (const result of await scans(nested(4, "kubectl get pods"))) expect(result).not.toBeInstanceOf(Error)
  })

  test("refuses a script whose directory change it cannot read", async () => {
    const [legacy, portable] = await scans("bash -c 'cd /outside; alias a=b'")
    expect(legacy instanceof Error ? undefined : legacy.directories).toEqual(["/outside"])
    expect(portable instanceof Error ? portable.message : portable).toContain(
      "Portable shell scanner cannot analyze command",
    )
  })

  test.each([
    ["bash -c 'a[$i]=1; kubectl delete pod x'", false],
    ["zsh -c 'a[$i]=1; kubectl delete pod x'", false],
    ["ksh -c 'a[$i]=1; kubectl delete pod x'", false],
    ["sh -c 'a[$i]=1; kubectl delete pod x'", true],
    ["dash -c 'a[$i]=1; kubectl delete pod x'", true],
  ] as const)("reads a script in the dialect of the shell that runs it: %s", async (command, refused) => {
    const [, portable] = await scans(command)
    expect(portable instanceof Error).toBe(refused)
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })
})

// The patterns an "always" reply to COMMAND saves; both scanners must save the same ones.
async function saves(command: string, shell = "/bin/bash") {
  const results = (await scans(command, shell)).map((result) =>
    result instanceof Error ? result : result.commands.flatMap((item) => (item.save === undefined ? [] : [item.save])),
  )
  expect(results[1], command).toEqual(results[0])
  if (results[0] instanceof Error) throw results[0]
  return results[0]
}

// Whether PATTERNS, saved as approvals, allow COMMAND in both scanners: each of its commands has a spelling one of
// them matches.
async function allows(patterns: readonly string[], command: string, shell = "/bin/bash") {
  return (await scans(command, shell)).every(
    (result) =>
      !(result instanceof Error) &&
      result.commands.every((item) =>
        [item.resource, ...(item.alternates ?? [])].some((text) =>
          patterns.some((pattern) => Wildcard.match(text, pattern)),
        ),
      ),
  )
}

describe("ShellParse saved approvals", () => {
  test.each([
    "FOO=1 ls",
    ">out ls",
    '"kubectl" get pods',
    "/opt/bin/kubectl get pods",
    "kubectl $'get' pods",
    "git $(printf diff) --stat",
    "npm run 123",
    "export X=1",
    'export "A"=1',
    "export -p > out",
    "declare -x A=1 B=2",
    "A=1 B=2",
    "unset A B",
    "KUBECONFIG=x kubectl get pods",
    "sudo X=1 kubectl get pods",
    "env A=1 B=2 ls",
    "time -p git status",
    "printf ok > out",
    "pwsh -c 'Get-Item x'",
  ])("an approval covers the command it was given for: %s", async (command) => {
    expect(await allows(await saves(command), command)).toBe(true)
  })

  test.each([
    ["export X=1", "export KUBECONFIG=x"],
    ["export X=1", "export PATH=/tmp/x"],
    ["A=1 B=2", "A=1 PATH=/tmp/x:$PATH"],
    ["A=1", "A=1 PATH=/tmp/x ls"],
    ["A=1 ls", "A=1 PATH=/tmp/x ls"],
    ["env A=1 ls", "env PATH=/tmp/x ls"],
    ["sudo A=1 ls", "sudo PATH=/tmp/x ls"],
    ["unset A", "unset KUBECONFIG"],
    ["declare A=1", "declare -n A=PATH"],
    ['"kubectl" get pods', '"kubectl" delete pod x'],
    ["/usr/bin/kubectl get pods", "/usr/bin/kubectl delete pod x"],
    ["git $(printf diff) --stat", "git --stat"],
    ["npm run 123", "npm run build"],
    ["* x", "rm -rf /"],
    ["l? -la", "ls -la"],
    ["kubectl * pods", "kubectl delete pods"],
  ])("an approval of %s does not cover %s", async (approved, other) => {
    expect(await allows(await saves(approved), other)).toBe(false)
  })
})

describe("ShellUnwrap.literal keeps expansions whole", () => {
  test.each([
    [`"$(printf '%s' "x")"`, `$(printf '%s' "x")`],
    [`"a $(printf "%s" b) c"`, `a $(printf "%s" b) c`],
    [`"$(cat <<"EOF"\nx\nEOF\n)"`, `$(cat <<"EOF"\nx\nEOF\n)`],
    ['"a `printf "%s" b` c"', 'a `printf "%s" b` c'],
    [`"\${x:-"y z"}"`, `\${x:-"y z"}`],
    [`'a'"b"$'\\x63'\\d`, `abcd`],
    [`"unterminated`, `"unterminated`],
  ])("%s", (word, value) => {
    expect(ShellUnwrap.literal(word)).toBe(value)
  })

  test("reads a script whose substitution holds a quoted heredoc delimiter", async () => {
    const command = `bash -c "$(cat <<"E\\OF"\nkubectl delete pod x\nE\\OF\n)"`
    for (const result of await scans(command)) expect(result).not.toBeInstanceOf(Error)
  })
})
