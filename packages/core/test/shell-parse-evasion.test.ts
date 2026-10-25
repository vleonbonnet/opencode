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
    `"C:\\Program Files\\Git\\bin\\bash.exe" -c 'kubectl delete pod x'`,
    `'C:\\tools\\kubectl.exe' delete pod x`,
    "/usr/local/bin/kubectl delete pod x",
  ])("names the program without its directory and Windows suffix: %s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  // Program names are case-insensitive only on Windows.
  test.skipIf(process.platform !== "win32")("names the program in any case: KUBECTL.EXE delete pod x", async () => {
    expect(await matched("KUBECTL.EXE delete pod x", "kubectl delete *")).toBe(true)
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
    "bash <<'EOF'\nkubectl delete pod x\nalias a=b\nEOF",
    "sh <<'EOF'\nkubectl delete pod x\na[$i]=1\nEOF",
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

describe("ShellParse heredoc delimiters read as bash reads them", () => {
  test.each([
    `cat <<E"O"F > notes\nEOF\nkubectl delete pod x\nE"O"F`,
    `cat <<E'O'F > notes\nEOF\nkubectl delete pod x\nE'O'F`,
    `cat <<$'EOF' > notes\nEOF\nkubectl delete pod x\n$'EOF'`,
    `cat <<-E"O"F > notes\n\tEOF\nkubectl delete pod x\nE"O"F`,
  ])("%s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  test.each([
    `cat <<'EOF' > notes\nEOFX\nkubectl delete pod x\nEOF`,
    `cat <<'EOF' > notes\nEOF \nkubectl delete pod x\nEOF`,
    `cat <<'E\\OF' > notes\nEOF\nkubectl delete pod x\nE\\OF`,
    `cat <<'A' <<'B' > notes\nB\nA\nkubectl delete pod x\nB`,
  ])("leaves out data the legacy parse misreads as commands: %s", async (command) => {
    const [legacy, portable] = await seen(command)
    expect(legacy).toEqual(portable)
    expect(portable?.some((text) => text.includes("kubectl delete"))).toBe(false)
  })
})

describe("ShellParse heredoc and here-string readers", () => {
  // Bodies a shell or another interpreter runs, or that become arguments, are checked; the rule sees them.
  test.each([
    "python3 - <<'EOF'\nprint('kanopy-oidc')\nEOF",
    "python3 <<'EOF'\nprint('kanopy-oidc')\nEOF",
    "node - <<'EOF'\nconsole.log('kanopy-oidc')\nEOF",
    "perl <<'EOF'\nprint 'kanopy-oidc'\nEOF",
    "ruby <<'EOF'\nputs 'kanopy-oidc'\nEOF",
    "psql -d app <<'EOF'\nselect 'kanopy-oidc';\nEOF",
    "sqlite3 app.db <<'EOF'\nselect 'kanopy-oidc';\nEOF",
    "mongosh <<'EOF'\nprint('kanopy-oidc')\nEOF",
    "at now <<'EOF'\nkanopy-oidc\nEOF",
    "crontab - <<'EOF'\n* * * * * kanopy-oidc\nEOF",
    "ionice -c 3 bash <<'EOF'\nkanopy-oidc\nEOF",
    "docker exec -i app sh <<'EOF'\nkanopy-oidc\nEOF",
    "kubectl exec -i app -- sh <<'EOF'\nkanopy-oidc\nEOF",
    "ssh host <<'EOF'\nkanopy-oidc\nEOF",
    "cat <<'EOF' > >(bash)\nkanopy-oidc\nEOF",
    "cat > run.sh <<'EOF' && bash run.sh\nkanopy-oidc\nEOF",
    "cat > run.sh <<'EOF'\nkanopy-oidc\nEOF\nchmod +x run.sh && ./run.sh",
    "cat > run.py <<'EOF'\nprint('kanopy-oidc')\nEOF\npython3 run.py",
    "rm -rf $(cat <<'EOF'\nkanopy-oidc\nEOF\n)",
    "bash <<< 'kanopy-oidc'",
    "echo 'kanopy-oidc' | sh",
    "printf 'kanopy-oidc\\n' | bash",
    "printf 'pod kanopy-oidc' | xargs kubectl delete",
    "cat <<'EOF' | xargs kubectl delete\npod kanopy-oidc\nEOF",
  ])("%s", async (command) => {
    expect(await matched(command, "*kanopy-oidc*")).toBe(true)
  })

  test.each([
    "bash <<< 'kubectl delete pod x'",
    "echo 'kubectl delete pod x' | sh",
    "sh -c '\"$@\"' _ kubectl delete pod x",
    "bash -c 'kubectl \"$1\" pod x' _ delete",
    "printf 'delete pod x' | xargs kubectl",
    "cat <<'EOF' | xargs -I {} kubectl {}\ndelete pod x\nEOF",
  ])("composes the command it runs: %s", async (command) => {
    expect(await matched(command, "kubectl delete *")).toBe(true)
  })

  // Data a command only stores or prints stays out of the text rules see.
  test.each([
    "cat > notes <<'EOF'\nkanopy-oidc\nEOF",
    "tee notes <<'EOF'\nkanopy-oidc\nEOF",
    "sudo tee /etc/notes <<'EOF' > /dev/null\nkanopy-oidc\nEOF",
    "sudo bash -c 'cat > /etc/notes' <<'EOF'\nkanopy-oidc\nEOF",
    "python3 script.py <<'EOF'\nkanopy-oidc\nEOF",
    "cat > run.sh <<'EOF'\nkanopy-oidc\nEOF\nbash other.sh",
  ])("leaves data out: %s", async (command) => {
    const [legacy, portable] = await seen(command)
    expect(legacy?.some((text) => text.includes("kanopy-oidc"))).toBe(false)
    expect(portable?.some((text) => text.includes("kanopy-oidc"))).toBe(false)
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

describe("ShellParse rules see the words after a redirect", () => {
  // Bash takes one word after a redirect operator as its target; the words after it are the command's.
  test.each([
    ["rm >/dev/null -rf build", "rm -r *"],
    ["rm 2>&1 -fr build", "rm * -r *"],
    ["kubectl >/dev/null delete pod x", "kubectl delete *"],
    ["printf ok | FOO=bar >output kubectl delete pod x", "kubectl delete *"],
    ["sudo >/dev/null rm -rf build", "rm -r *"],
  ])("%s", async (command, rule) => {
    expect(await matched(command, rule)).toBe(true)
  })
})

// The rules denying a recursive Remove-Item, whatever spelling runs it.
const REMOVE_RECURSE = ["Remove-Item -Recurse *", "Remove-Item * -Recurse *"]

// Whether a rule of RULES sees COMMAND in both scanners, as `matched` does for one rule.
async function matchedAny(command: string, rules: readonly string[], shell = "/bin/bash") {
  const results = await seen(command, shell)
  expect(results.some(Boolean), `${command}: refused by both scanners`).toBe(true)
  return results.every((texts) => !texts || texts.some((text) => rules.some((rule) => Wildcard.match(text, rule))))
}

// -EncodedCommand's argument: Base64 of UTF-16LE text.
function encoded(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

describe("ShellParse rules see the cmdlet a PowerShell command runs, with its parameters' full names", () => {
  test.each([
    "Remove-Item -Recurse C:\\x",
    "Remove-Item C:\\x -Recurse",
    "remove-item -recurse x",
    "Remove-Item -Force -Recurse -Path x",
    "Remove-Item -r x",
    "Remove-Item x -rec -fo",
    "Remove-Item x -Recurse:$true",
    "rm -Recurse x",
    "ri -r x",
    "del x -Recurse",
    "erase -rec x",
    "rd -r x",
    "rmdir x -Recurse",
    "RM -R x",
    "Microsoft.PowerShell.Management\\Remove-Item -Recurse x",
    "& Remove-Item -Recurse x",
    "& 'Remove-Item' -Recurse x",
    "Get-ChildItem x | Remove-Item -Recurse",
    "if (Test-Path x) { Remove-Item x -Recurse -Force }",
    "foreach ($d in $dirs) { rm $d -r }",
    "$null = Remove-Item -Recurse x",
    "pwsh -c 'Remove-Item -Recurse x'",
    `powershell -EncodedCommand ${encoded("Remove-Item -Recurse x")}`,
  ])("%s", async (command) => {
    expect(await matchedAny(command, REMOVE_RECURSE, "pwsh")).toBe(true)
  })

  test.each([
    "Remove-Item x",
    "Remove-Item x -Force",
    "Remove-Item x -Recurse:$false",
    "Remove-Item '-Recurse' x",
    "Get-ChildItem -Recurse x",
    "Write-Output 'Remove-Item -Recurse x'",
  ])("does not see a recursive Remove-Item in %s", async (command) => {
    expect(await matchedAny(command, REMOVE_RECURSE, "pwsh")).toBe(false)
  })

  test.each([
    `powershell -Command "Remove-Item -Recurse x"`,
    `pwsh -NoProfile -c 'Get-Date; Remove-Item x -Recurse'`,
    `powershell.exe -c "rm -r x"`,
    `pwsh -EncodedCommand ${encoded("Get-Date\nri -rec x")}`,
    `echo 'Remove-Item -Recurse x' | pwsh -Command -`,
    `bash -c "pwsh -c 'Remove-Item -Recurse x'"`,
    `pwsh -c "pwsh -c 'del -r x'"`,
  ])("reads the scripts bash hands to PowerShell: %s", async (command) => {
    expect(await matchedAny(command, REMOVE_RECURSE)).toBe(true)
  })

  test("keeps each PowerShell command as written for the rules", async () => {
    const [legacy] = await seen("rm -r x; Remove-Item y", "pwsh")
    expect(legacy).toEqual(["rm -r x", "Remove-Item -Recurse x", "Remove-Item y"])
  })

  test("refuses PowerShell scripts nested past the depth it follows, in both scanners", async () => {
    const levels = (count: number) =>
      Array.from({ length: count }).reduce<string>(
        (script) => `pwsh -EncodedCommand ${encoded(script)}`,
        "Get-ChildItem",
      )
    for (const result of await scans(levels(5)))
      expect(result instanceof Error ? result.message : result).toContain("nests")
    for (const result of await scans(levels(4))) expect(result).not.toBeInstanceOf(Error)
  })
})
