import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import type { Tool } from "@opencode/core/tool"
import { withTempDir } from "../../fixture/tmpdir"
import { executeTool, toolIdentity } from "../../lib/tool"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any
type Live = (name: string, body: () => Effect.Effect<unknown, unknown, Provided>, opts?: number) => void
interface Suite {
  readonly live: Live & { readonly skip: Live }
}

/** The shell tool harness of the upstream ShellTool tests, which host these. */
export interface Harness {
  readonly it: Suite
  readonly permissionIt: Suite
  readonly reset: () => void
  readonly assertions: ReadonlyArray<Permission.AssertInput>
  readonly call: (input: typeof ShellTool.Input.Type, id?: string) => Parameters<Tool.Snapshot["execute"]>[0]
  readonly withSession: <A, E, R>(
    directory: string,
    body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, unknown>
  readonly withScanner: <A, E, R>(
    body: (registry: Tool.Interface, fixture: { active: string; outside: string }) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, unknown>
  readonly runPermissionCommand: (
    registry: Tool.Interface,
    command: string,
    marker: string,
    replies: ReadonlyArray<Permission.Reply>,
  ) => Effect.Effect<
    { readonly exit: Exit.Exit<unknown, unknown>; readonly requests: ReadonlyArray<Permission.Request> },
    unknown,
    unknown
  >
}

export const forkTests = (harness: Harness) => {
  const { it, permissionIt, reset, assertions, call, withSession, withScanner, runPermissionCommand } = harness

  describe("ShellTool scanner permissions (fork)", () => {
    const test = process.platform === "win32" || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live

    test("a denial reaches the command behind runners and an option cluster", () =>
      withScanner((registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "rm -r *", effect: "deny" },
              ]
            }),
          )
          const victim = path.join(fixture.active, "victim")
          yield* Effect.promise(() => fs.mkdir(victim))
          const result = yield* runPermissionCommand(registry, "env nice -n 5 rm -rf victim", victim, [])
          expect(result.requests).toEqual([])
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
          })
          expect(yield* Effect.promise(() => fs.stat(victim).then((stat) => stat.isDirectory()))).toBe(true)
        }),
      ))

    test("a rule on heredoc text applies to bodies a shell runs, not to data", () =>
      withScanner((registry, fixture) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "*kanopy-oidc*", effect: "deny" },
              ]
            }),
          )
          const notes = path.join(fixture.active, "notes")
          const data = yield* runPermissionCommand(registry, "cat > notes <<'EOF'\nkanopy-oidc\nEOF", notes, [])
          expect(data.requests).toEqual([])
          expect(data.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
          expect(yield* Effect.promise(() => Bun.file(notes).text())).toBe("kanopy-oidc\n")

          const marker = path.join(fixture.active, "marker")
          const script = yield* runPermissionCommand(
            registry,
            "sh <<'EOF'\nprintf kanopy-oidc > marker\nEOF",
            marker,
            [],
          )
          expect(script.requests).toEqual([])
          expect(script.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ))
  })

  describe("ShellTool (fork)", () => {
    it.live(
      "names the command, directory, shell and timeout of a permission request",
      () =>
        withTempDir((tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: "printf one && printf two" }, "call-compound")),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions).toHaveLength(1)
                expect(assertions[0]).toMatchObject({
                  resources: ["printf one", "printf two"],
                  metadata: {
                    command: "printf one && printf two",
                    cwd: realpathSync(tmp.path),
                    shell: expect.any(String),
                    timeout: ShellTool.DEFAULT_TIMEOUT_MS,
                  },
                })
              }),
            ),
          )
        }),
      15_000,
    )
  })
}
