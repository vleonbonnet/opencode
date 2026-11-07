import { describe, expect, test } from "bun:test"
import { Effect, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ShellSignals } from "../src/shell/signals"
import { ShellSelect } from "../src/shell/select"
import { testEffect } from "./lib/effect"
import { withTempDir } from "./fixture/tmpdir"

describe("signal permission details", () => {
  test.each([
    ["kill 123 456", "TERM"],
    ["kill -TERM 123 456", "TERM"],
    ["kill -SIGTERM 123 456", "TERM"],
    ["kill -s TERM 123 456", "TERM"],
    ["kill --signal=TERM 123 456", "TERM"],
    ["kill -n 9 123 456", "9"],
    ["/bin/kill -9 '123' \"456\"", "9"],
    ["builtin kill -0 123 456", "0"],
    ["sudo kill -- 123 456", "TERM"],
  ])("reads the signal and PID operands of %s", (command, signal) => {
    expect(ShellSignals.scan(command, "bash")).toEqual([
      {
        command,
        signal,
        targets: [
          { target: "123", kind: "pid" },
          { target: "456", kind: "pid" },
        ],
      },
    ])
  })

  test("keeps groups, jobs and dynamic operands distinct from PIDs", () => {
    expect(ShellSignals.scan("kill -TERM -- -123 0 -1 $$ %2 $PIDS '$$'", "bash")[0].targets).toEqual([
      { target: "-123", kind: "group" },
      { target: "0", kind: "group" },
      { target: "-1", kind: "all" },
      { target: "$$", kind: "shell" },
      { target: "%2", kind: "job" },
      { target: "$PIDS", kind: "dynamic" },
      { target: "$$", kind: "dynamic" },
    ])
  })

  test("finds signals in compound commands and literal nested shell scripts", () => {
    expect(
      ShellSignals.scan("echo ok && kill -TERM 123; bash -c 'kill -0 456'", "bash").map((item) => item.command),
    ).toEqual(["kill -TERM 123", "kill -0 456"])
  })

  test.each(["kill -TERM -123", "kill -s TERM -123", "kill -9 -123", "kill -- -123"])(
    "recognizes the negative process-group operand of %s",
    (command) => {
      expect(ShellSignals.scan(command, "bash")[0].targets).toEqual([{ target: "-123", kind: "group" }])
    },
  )

  test.each([
    "echo 'kill 123'",
    "kill -l",
    "kill -L 9",
    "kill --help",
    "kill -s",
    "kill --timeout 100 TERM 123",
    "ssh host kill 123",
    "docker exec app kill 123",
    "nsenter -t 456 -p kill 123",
    "sudo -h other kill 123",
  ])("does not invent local process targets for %s", (command) => {
    expect(ShellSignals.scan(command, "bash")).toEqual([])
  })

  test("does not interpret PowerShell's kill alias as POSIX kill", () => {
    expect(ShellSignals.scan("kill 123", "pwsh")).toEqual([])
  })
})

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const shell = process.platform === "win32" ? (ShellSelect.gitbash() ?? Bun.which("sh")) : "/bin/sh"
// A POSIX shell is needed to exercise its PID namespace; Windows installations without Git Bash lack it.
const live = shell ? it.live : it.live.skip

live("looks up names and command lines in the execution shell's PID namespace", () =>
  withTempDir((tmp) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const executable = shell ?? "sh"
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["-c", 'printf "%s\\n" "$$"; read -r release'], {
          cwd: tmp.path,
          stdin: Stream.never,
        }),
      )
      const pid = Option.getOrThrow(yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead))
      const actions = yield* ShellSignals.inspect(
        {
          command: `kill -TERM ${pid} 2147483647`,
          shell: executable,
          cwd: tmp.path,
          env: process.env,
          timeout: 0,
        },
        spawner,
      )
      expect(actions[0].targets[0].name).toMatch(/(?:ba|da|z)?sh(?:\.exe)?$/)
      expect(actions[0].targets[0].command).toContain("read -r release")
      expect(actions[0].targets[1]).toEqual({ target: "2147483647", kind: "pid" })
    }).pipe(Effect.scoped),
  ),
)

it.live("an unavailable process inspector leaves the request usable", () =>
  withTempDir((tmp) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      expect(
        yield* ShellSignals.inspect(
          {
            command: "kill 123",
            shell: `${tmp.path}/missing-shell`,
            cwd: tmp.path,
            env: {},
            timeout: 0,
          },
          spawner,
        ),
      ).toEqual([
        {
          command: "kill 123",
          signal: "TERM",
          targets: [{ target: "123", kind: "pid" }],
        },
      ])
    }),
  ),
)
