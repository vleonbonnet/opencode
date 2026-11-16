import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { ShellPolicy } from "@opencode/core/shell/policy"
import { ShellUnwrap } from "@opencode/core/shell/unwrap"

const cleanup = "Run `agent-cleanup -- PATH...` instead."
const rule = (resource: string, effect: Permission.Effect, message?: string): Permission.Rule => ({
  action: "shell",
  resource,
  effect,
  ...(message === undefined ? {} : { message }),
})
// Rules shaped as those other agents' hooks pass: shell allowed, kubectl asking unless it reads, recursive removal
// denied with a message.
const rules = [
  rule("*", "allow"),
  rule("kubectl *", "ask"),
  rule("kubectl get *", "allow"),
  rule("kubectl * get *", "allow"),
  rule("kubectl delete *", "ask"),
  rule("kubectl exec *", "ask"),
  rule("*KUBECONFIG*", "ask"),
  rule("rm -r *", "deny", cleanup),
  rule("rm * -r *", "deny", cleanup),
  rule("rm -R *", "deny", cleanup),
  rule("rm * -R *", "deny", cleanup),
  rule("rm --r*", "deny", cleanup),
  rule("rm * --r*", "deny", cleanup),
  rule("Remove-Item -Recurse *", "deny", cleanup),
  rule("Remove-Item * -Recurse *", "deny", cleanup),
]

const decide = (command: string, shell = "/bin/zsh") => ShellPolicy.decide({ command, shell, cwd: "/workspace", rules })
const encoded = (text: string) => Buffer.from(text, "utf16le").toString("base64")

describe("ShellPolicy denies recursive removal however a script runs it", () => {
  test.each([
    "rm -rf build",
    "bash <<'EOF'\nrm -rf build\nEOF",
    "bash <<< 'rm -rf build'",
    "echo 'rm -rf build' | bash",
    "cat <<\\EOF\nhi\nEOF\nrm -rf build",
    "cat <<EOF\n$(rm -rf build)\nEOF",
    "cat > c.sh <<'EOF'\nrm -rf build\nEOF\nbash c.sh",
    "echo $((1<<2))\nrm -rf build",
    'grep foo <<<"$t"\nrm -rf build',
    "ssh host rm -rf build",
    "rm $'-rf' build",
    "r\\m -rf build",
    "rm -r\\f build",
    "sudo --user root rm -rf build",
    "timeout --kill-after 5 10 rm -rf build",
    "sudo -t x rm -rf build",
    "xargs -J % rm -rf %",
    "setsid rm -rf build",
    "flock /tmp/l rm -rf build",
    "watch rm -rf build",
    "busybox rm -rf build",
    "su -c 'rm -rf build'",
    "docker exec c rm -rf build",
    "env -S 'rm -rf build'",
    "echo -rf build | xargs rm",
    "find . -exec rm -rf {} \\;",
    "eval 'rm -rf build'",
    'echo "$(rm -rf build)"',
    "echo `rm -rf build`",
    "function f { rm -rf build; }",
    "time -p rm -rf build",
    ">/dev/null rm -rf build",
    "# don't worry\nrm -rf build",
    "echo 'a\\' ; rm -rf build # '",
    "bash -ec 'rm -rf build'",
    "bash -c -- 'rm -rf build'",
    "=rm -rf build",
    "fish -c 'rm -rf build'",
    "cmd /c 'rm -rf build'",
    "fish -c \"fish -c 'rm -rf build'\"",
    "kubectl exec pod -- rm -rf /data",
    "pwsh 'Remove-Item -Recurse x'",
    "pwsh -Comm 'Remove-Item -Recurse x'",
    `pwsh -EncodedCommand ${encoded("Remove-Item -Recurse x")}`,
  ])("%s", async (command) => {
    expect(await decide(command)).toMatchObject({ effect: "deny", reason: `Permission denied: shell. ${cleanup}` })
  })

  test.each(["Remove-Item x `\n -Recurse", "ri x -Rec", "del -r build"])("PowerShell %s", async (command) => {
    expect(await decide(command, "pwsh")).toMatchObject({
      effect: "deny",
      reason: `Permission denied: shell. ${cleanup}`,
    })
  })

  test.skipIf(!ShellUnwrap.CASELESS).each(["RM -rf build", "/bin/RM -rf build"])(
    "%s where file names ignore case",
    async (command) => {
      expect(await decide(command)).toMatchObject({ effect: "deny", rule: rule("rm -r *", "deny", cleanup) })
    },
  )

  test("names the command, the rule and the spelling it matched", async () => {
    expect(await decide("ls && sudo rm -fr build")).toEqual({
      effect: "deny",
      resource: "rm -fr build",
      rule: rule("rm * -r *", "deny", cleanup),
      spelling: "rm -f -r build",
      reason: `Permission denied: shell. ${cleanup}`,
    })
  })
})

describe("ShellPolicy refuses what it cannot read", () => {
  test.each(["alias r='rm -rf'; r build", "echo 'unterminated"])("%s", async (command) => {
    const decided = await decide(command)
    expect(decided.effect).toBe("deny")
    expect(decided.reason).toStartWith("Portable shell scanner cannot analyze command")
  })
})

describe("ShellPolicy asks before kubectl writes however they are written", () => {
  test.each([
    "kubectl delete pod x",
    "watch kubectl delete pod x",
    "ssh host kubectl delete pod x",
    'echo "$(kubectl delete pod x)"',
    "KUBECONFIG=/tmp/k; kubectl get pods",
    "kubectl --kubeconfig=/tmp/k get pods -A; KUBECONFIG=x kubectl get pods",
    "cat > notes <<EOF\nKUBECONFIG\nEOF",
  ])("%s", async (command) => {
    expect(await decide(command)).toMatchObject({ effect: "ask" })
  })

  test("PowerShell environment variables reach the commands after them", async () => {
    expect(await decide('$env:KUBECONFIG = "C:\\k"; kubectl get pods', "pwsh")).toMatchObject({
      effect: "ask",
      resource: "$env:KUBECONFIG",
      rule: rule("*KUBECONFIG*", "ask"),
    })
  })

  test.skipIf(!ShellUnwrap.CASELESS)("a program written in another case where file names ignore case", async () => {
    expect(await decide("KUBECTL delete pod x", "/bin/bash")).toMatchObject({ effect: "ask" })
    expect(await decide("Kubectl delete pod x", "pwsh")).toMatchObject({ effect: "ask" })
  })
})

describe("ShellPolicy allows what no rule stops", () => {
  test.each([
    "ls -la",
    "rm -f build",
    "rm -- -rf",
    "command -v rm -rf x",
    "kubectl get pods",
    "fish -c 'echo hi; ls'",
    "find . -delete",
  ])("%s", async (command) => {
    expect(await decide(command)).toEqual({ effect: "allow" })
  })

  test.each(["$x = 1; kubectl get pods", "Remove-Item x -Recurse:$false"])("PowerShell %s", async (command) => {
    expect(await decide(command, "pwsh")).toEqual({ effect: "allow" })
  })

  test("asks for a command no rule decides", async () => {
    expect(
      await ShellPolicy.decide({
        command: "make",
        shell: "/bin/bash",
        cwd: "/workspace",
        rules: [rule("ls *", "allow")],
      }),
    ).toEqual({ effect: "ask", resource: "make" })
  })
})
