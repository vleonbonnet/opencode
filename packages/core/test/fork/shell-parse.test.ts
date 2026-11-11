import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "@opencode/core/shell/parse"

async function scanned(command: string, shell = "/bin/bash") {
  return Effect.runPromise(ShellParse.scan(command, shell, "/workspace"))
}

// Every spelling the rules are checked against: each command's resource together with its alternate spellings.
function spellings(result: { commands: ReadonlyArray<{ resource: string; alternates?: readonly string[] }> }) {
  return result.commands.flatMap((command) => [command.resource, ...(command.alternates ?? [])])
}

describe("ShellParse commands behind a prefix", () => {
  test.each<{ name: string; command: string; resources: string[]; save?: string[] }>([
    {
      name: "variable assignments",
      command: "KUBECONFIG=x kubectl delete pod y",
      resources: ["KUBECONFIG=x kubectl delete pod y", "kubectl delete pod y"],
      save: ["kubectl delete *"],
    },
    {
      name: "env with options and assignments",
      command: "env -u FOO A=1 kubectl delete pod y",
      resources: ["env -u FOO A=1 kubectl delete pod y", "kubectl delete pod y"],
      save: ["env *", "kubectl delete *"],
    },
    { name: "env -S", command: "env -S 'kubectl delete pod x'", resources: ["kubectl delete pod x"] },
    { name: "a directory before the program", command: "/opt/bin/kubectl get pods", resources: ["kubectl get pods"] },
    { name: "a backslash before the program", command: "\\rm -r foo", resources: ["rm -r foo"] },
    { name: "command", command: "command rm d -r", resources: ["rm d -r"] },
    {
      name: "timeout with its options and duration",
      command: "timeout -s KILL 10 kubectl get pods",
      resources: ["kubectl get pods"],
    },
    { name: "nice", command: "nice -n 5 git push", resources: ["git push"], save: ["git push *"] },
    {
      name: "sudo with a value option ending a cluster",
      command: "sudo -Eu root rm -rf build",
      resources: ["rm -rf build", "rm -r -f build"],
      save: ["rm *"],
    },
    {
      name: "xargs with value options",
      command: "xargs -n 1 -I {} kubectl delete pod {}",
      resources: ["kubectl delete pod {}"],
    },
    { name: "nested runners", command: "sudo env A=1 nohup kubectl apply -f x", resources: ["kubectl apply -f x"] },
    {
      name: "a shell's -c script",
      command: `bash -lc "kubectl delete pod 'a b'"`,
      resources: ["kubectl delete pod 'a b'"],
    },
    { name: "eval", command: `eval "kubectl delete pod x"`, resources: ["kubectl delete pod x"] },
    { name: "watch", command: "watch -n 5 kubectl get pods", resources: ["kubectl get pods"] },
    { name: "watch -x", command: "watch -x kubectl get pods", resources: ["kubectl get pods"] },
    {
      name: "find -exec",
      command: "find . -name '*.log' -exec rm -f {} \\; -execdir kubectl delete pod {} +",
      resources: ["rm -f {}", "kubectl delete pod {}"],
    },
    {
      name: "a script inside a runner",
      command: `xargs sh -c 'env kubectl delete pod "$1"' _`,
      resources: [`kubectl delete pod "$1"`],
    },
    { name: "a program named at run time", command: "$cmd delete pod", resources: ["$cmd delete pod"] },
    { name: "a word split by a line continuation", command: "\\\nrm -r fo\\\no", resources: ["rm -r fo\\\no"] },
  ])("checks the command behind $name", async ({ command, resources, save }) => {
    const result = await scanned(command)
    for (const resource of resources) expect(spellings(result)).toContain(resource)
    for (const item of save ?? []) expect(result.commands.map((entry) => entry.save)).toContain(item)
  })

  test("keeps the command as written first and spells each command once", async () => {
    const result = await scanned("env kubectl get pods 2>&1")
    expect(result.commands).toEqual([
      { resource: "env kubectl get pods 2>&1", save: "env *" },
      { resource: "kubectl get pods", save: "kubectl get *" },
    ])
  })

  test("checks a command a script runs in its directory", async () => {
    expect(await scanned("bash -c 'cd /outside && git status'")).toEqual({
      commands: [
        {
          resource: "bash -c 'cd /outside && git status'",
          save: "bash *",
          alternates: ["bash -c cd /outside && git status"],
        },
        { resource: "git status", save: "git status *" },
      ],
      directories: ["/outside"],
    })
  })

  test("refuses a command nesting scripts too deep", async () => {
    const nest = (levels: number) =>
      Array.from({ length: levels }).reduce<string>(
        (acc) => `eval '${acc.replaceAll("'", `'\\''`)}'`,
        "kubectl get pods",
      )
    const resources = async (command: string) => (await scanned(command)).commands.map((item) => item.resource)
    expect(await resources(nest(2))).toContain("kubectl get pods")
    expect(await resources(nest(4))).toContain("kubectl get pods")
    expect(await Effect.runPromise(Effect.result(ShellParse.scan(nest(5), "/bin/bash", "/workspace")))).toMatchObject({
      _tag: "Failure",
      failure: { message: "Shell command nests scripts more than 4 levels deep" },
    })
  })

  test("refuses a script the portable scanner cannot analyze, as it refuses the command", async () => {
    const command = "bash -c 'echo \"unterminated'"
    expect(await Effect.runPromise(Effect.result(ShellParse.scan(command, "/bin/bash", "/workspace")))).toMatchObject({
      _tag: "Failure",
      failure: { message: "Portable shell scanner cannot analyze command: unterminated-quote in a script it runs" },
    })
  })

  test.each(["pwsh", "cmd"])("leaves %s commands as written", async (shell) => {
    const result = await Effect.runPromise(ShellParse.scan("env rm -rf build", shell, "/workspace"))
    expect(result.commands).toEqual([{ resource: "env rm -rf build", save: "env *" }])
  })
})

describe("ShellParse statements that set or clear variables", () => {
  test.each<{ name: string; command: string; resources: string[]; save?: string[] }>([
    {
      name: "an export before a command",
      command: "export KUBECONFIG=~/.kube/admin; kubectl get pods",
      resources: ["export KUBECONFIG=~/.kube/admin", "kubectl get pods"],
      save: ["export KUBECONFIG=*"],
    },
    {
      name: "an assignment statement before a command",
      command: "KUBECONFIG=x; kubectl get pods",
      resources: ["KUBECONFIG=x"],
      save: ["KUBECONFIG=x"],
    },
    {
      name: "assignments grouped before a command, one variable each",
      command: "A=1 B=2; ls",
      resources: ["A=1", "B=2"],
      save: ["A=1", "B=2"],
    },
    {
      name: "a declaration of several variables, one each",
      command: "declare -x A=1 B; ls",
      resources: ["declare -x A=1", "declare -x B"],
      save: ["declare -x A=*", "declare -x B"],
    },
    {
      name: "assignments with a redirect, as written and one variable each",
      command: "A=1 B=2 > log",
      resources: ["A=1 B=2 > log", "A=1", "B=2"],
      save: ["A=1 B=2 > log", "A=1", "B=2"],
    },
    {
      name: "an appending assignment",
      command: "PATH+=:/opt/bin; ls",
      resources: ["PATH+=:/opt/bin"],
      save: ["PATH+=:/opt/bin"],
    },
    {
      name: "an unset before a command",
      command: "unset KUBECONFIG; ls",
      resources: ["unset KUBECONFIG"],
      save: ["unset KUBECONFIG"],
    },
    {
      name: "a declaration inside a script",
      command: `bash -c 'declare -x KUBECONFIG=x; kubectl get pods'`,
      resources: ["declare -x KUBECONFIG=x", "kubectl get pods"],
    },
    { name: "a declaration in a compound statement", command: "if true; then local K=x; fi", resources: ["local K=x"] },
    { name: "a declaration with a redirect", command: "export X=1 > log", resources: ["export X=1 > log"] },
    { name: "an assignment in a substitution", command: "echo $(X=1)", resources: ["X=1"], save: ["X=1"] },
  ])("checks $name", async ({ command, resources, save }) => {
    const result = await scanned(command)
    for (const resource of resources) expect(result.commands.map((item) => item.resource)).toContain(resource)
    for (const item of save ?? []) expect(result.commands.map((entry) => entry.save)).toContain(item)
  })

  test("checks an assignment prefixed to a command with that command, and on its own", async () => {
    expect((await scanned("FOO=1 ls")).commands).toEqual([
      { resource: "FOO=1 ls", save: "ls *", alternates: ["ls"] },
      { resource: "FOO=1", save: "FOO=1" },
    ])
  })

  test("leaves the arithmetic of a C-style for loop alone", async () => {
    expect((await scanned("for ((i=0; i<2; i++)); do printf ok; done")).commands).toEqual([
      { resource: "printf ok", save: "printf *" },
    ])
  })

  test("leaves cmd.exe statements to the commands they run", async () => {
    expect(await Effect.runPromise(ShellParse.scan("export X=1; Y=2; unset X", "cmd", "/workspace"))).toEqual({
      commands: [],
      directories: [],
    })
  })
})

describe("ShellParse heredoc bodies", () => {
  test.each<{ name: string; command: string; resources?: string[]; body: boolean }>([
    {
      // The interpreter runs the body, which is checked whole, as text.
      name: "a quoted heredoc an interpreter reads",
      command: "python3 - <<'EOF'\nprint('kanopy-oidc')\nEOF\ntail -3 f",
      resources: ["print('kanopy-oidc')\n", "tail -3 f"],
      body: true,
    },
    {
      name: "a quoted heredoc a script reads as data",
      command: "python3 script.py <<'EOF'\nkanopy-oidc\nEOF",
      resources: ["python3 script.py <<'EOF'"],
      body: false,
    },
    { name: "a double-quoted delimiter", command: 'cat > f <<"EOF"\nkanopy-oidc\nEOF', body: false },
    { name: "an escaped delimiter", command: "cat <<-\\EOF\n\tkanopy-oidc\n\tEOF", body: false },
    {
      // Where the substituted word ends up is not followed, so a substituted body is kept.
      name: "a heredoc substituted into an argument",
      command: `git commit -m "$(cat <<'EOF'\nuse kanopy-oidc\nEOF\n)" && echo done`,
      resources: [
        `git commit -m "$(cat <<'EOF'\nuse kanopy-oidc\nEOF\n)"`,
        "cat <<'EOF'\nuse kanopy-oidc\nEOF",
        "echo done",
      ],
      body: true,
    },
    { name: "a heredoc assigned to a variable", command: "x=$(cat <<'EOF'\nkanopy-oidc\nEOF\n)", body: true },
    {
      name: "a tab-stripped heredoc assigned to a variable",
      command: "x=$(cat <<-'EOF'\n\tkanopy-oidc\n\tEOF\n)",
      resources: ["x=$(cat <<-'EOF'\n\tkanopy-oidc\n\tEOF\n)", "cat <<-'EOF'\n\tkanopy-oidc\n\tEOF"],
      body: true,
    },
    {
      name: "a heredoc read by a loop",
      command: `while read f; do echo "$f"; done <<'EOF'\nkanopy-oidc\nEOF`,
      body: false,
    },
    { name: "a heredoc in a backquoted substitution", command: "echo `cat <<'EOF'\nkanopy-oidc\nEOF\n`", body: true },
    {
      // The shell runs the file the heredoc is written to, so the body is a script.
      name: "a heredoc written to a file a shell runs after a list operator",
      command: "cat <<'EOF' > f && bash f\nkanopy-oidc\nEOF",
      resources: ["bash f", "kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc written to a file nothing runs",
      command: "cat <<'EOF' > f && bash g\nkanopy-oidc\nEOF",
      resources: ["cat <<'EOF' > f", "bash g"],
      body: false,
    },
    {
      name: "an unquoted heredoc",
      command: "cat <<EOF\nkanopy-oidc $(whoami)\nEOF",
      resources: ["whoami"],
      body: true,
    },
    {
      name: "a heredoc a shell reads",
      command: "bash <<'EOF'\nkubectl delete pod kanopy-oidc\nEOF",
      resources: ["kubectl delete pod kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc piped into a shell behind a runner",
      command: "cat <<'EOF' | tee log | sudo bash -s\nkubectl delete pod kanopy-oidc\nEOF",
      resources: ["kubectl delete pod kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc piped from a group into a shell",
      command: "{ cat <<'EOF'\nkubectl delete pod kanopy-oidc\nEOF\n} | sh",
      resources: ["kubectl delete pod kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc sudo -s reads",
      command: "sudo -s <<'EOF'\nrm -r kanopy-oidc\nEOF",
      resources: ["rm -r kanopy-oidc", "rm -r kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc a program named at run time reads",
      command: `"$run" <<'EOF'\nkubectl delete pod kanopy-oidc\nEOF`,
      resources: ["kubectl delete pod kanopy-oidc"],
      body: true,
    },
    {
      name: "a heredoc whose lines a loop hands to a shell",
      command: `while read line; do bash -c "$line"; done <<'EOF'\nrm -rf kanopy-oidc\nEOF`,
      resources: ["rm -rf kanopy-oidc", "rm -r -f kanopy-oidc"],
      body: true,
    },
    { name: "a heredoc xargs reads", command: "cat <<'EOF' | xargs rm\n-r kanopy-oidc\nEOF", body: true },
    {
      name: "a heredoc substituted into a shell's -c script",
      command: `bash -c "$(cat <<'EOF'\nkubectl delete pod kanopy-oidc\nEOF\n)"`,
      body: true,
    },
    {
      name: "a heredoc substituted into a statement that runs a shell",
      command: `echo "$(cat <<'EOF'\nkanopy-oidc\nEOF\n)" | sh`,
      body: true,
    },
  ])("$name: body checked $body", async ({ command, resources, body }) => {
    const result = spellings(await scanned(command))
    for (const resource of resources ?? []) expect(result).toContain(resource)
    expect(result.some((resource) => resource.includes("kanopy-oidc"))).toBe(body)
  })

  test("parses the body a shell reads as a script, checking each of its commands", async () => {
    expect(await scanned("bash <<'EOF'\nexport KUBECONFIG=x\nsudo rm -rf build\nEOF")).toEqual({
      commands: [
        { resource: "bash <<'EOF'\nexport KUBECONFIG=x\nsudo rm -rf build\nEOF", save: "bash *" },
        { resource: "export KUBECONFIG=x", save: "export KUBECONFIG=*" },
        { resource: "sudo rm -rf build", save: "sudo *", alternates: ["sudo rm -r -f build"] },
        { resource: "rm -rf build", save: "rm *", alternates: ["rm -r -f build"] },
      ],
      directories: [],
    })
  })

  test("refuses a body a shell reads when the portable scanner cannot analyze it", async () => {
    const command = "bash <<'EOF'\necho \"unterminated\nEOF"
    expect(await Effect.runPromise(Effect.result(ShellParse.scan(command, "/bin/bash", "/workspace")))).toMatchObject({
      _tag: "Failure",
      failure: { message: "Portable shell scanner cannot analyze command: unterminated-quote in a script it runs" },
    })
  })
})
