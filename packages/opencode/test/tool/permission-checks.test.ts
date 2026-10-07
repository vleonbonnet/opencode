import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Plugin } from "@/plugin"
import { ToolPermission } from "@/tool/permission-checks"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"

type Ask = Parameters<Tool.Context["ask"]>[0]

function harness(hook: (input: any, output: { checks: unknown[] }) => void) {
  const asked: Ask[] = []
  const seen: { name: string; input: any }[] = []
  const plugin = {
    trigger: ((name: string, input: any, output: any) =>
      Effect.sync(() => {
        seen.push({ name, input })
        if (name === "tool.permission") hook(input, output)
        return output
      })) as Plugin.Interface["trigger"],
  } as Plugin.Interface
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_permission"),
    messageID: MessageID.make("msg_permission"),
    agent: "plan",
    abort: new AbortController().signal,
    callID: "call_permission",
    messages: [],
    metadata: () => Effect.void,
    ask: (req) => Effect.sync(() => void asked.push(req)),
  }
  const run = (args: unknown) => Effect.runPromiseExit(ToolPermission.check({ plugin, tool: "srv_write", args, ctx }))
  return { asked, seen, run }
}

function defect(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) throw new Error("expected the check to refuse the call")
  return String(Cause.squash(exit.cause))
}

describe("tool.permission", () => {
  test("hands the hook the tool, the calling agent, the call and its arguments", async () => {
    const h = harness(() => {})
    await h.run({ path: "a.txt" })
    expect(h.seen).toEqual([
      {
        name: "tool.permission",
        input: {
          tool: "srv_write",
          agent: "plan",
          sessionID: SessionID.make("ses_permission"),
          callID: "call_permission",
          args: { path: "a.txt" },
        },
      },
    ])
  })

  test("asks nothing more when no hook adds a check", async () => {
    const h = harness(() => {})
    expect(Exit.isSuccess(await h.run({}))).toBe(true)
    expect(h.asked).toEqual([])
  })

  test("runs every added check through ask, in order, with always defaulting to the patterns", async () => {
    const h = harness((_input, output) => {
      output.checks.push({ permission: "edit", patterns: ["AGENTS.md"], metadata: { filepath: "/r/AGENTS.md" } })
      output.checks.push({ permission: "emacs-eval-write", patterns: ["*"], always: ["*"] })
    })
    expect(Exit.isSuccess(await h.run({}))).toBe(true)
    expect(h.asked).toEqual([
      { permission: "edit", patterns: ["AGENTS.md"], always: ["AGENTS.md"], metadata: { filepath: "/r/AGENTS.md" } },
      { permission: "emacs-eval-write", patterns: ["*"], always: ["*"], metadata: {} },
    ])
  })

  test("a refused check stops the call before the later checks", async () => {
    const asked: string[] = []
    const plugin = {
      trigger: ((name: string, _input: any, output: any) =>
        Effect.sync(() => {
          if (name === "tool.permission")
            output.checks.push({ permission: "edit", patterns: ["a"] }, { permission: "edit", patterns: ["b"] })
          return output
        })) as Plugin.Interface["trigger"],
    } as Plugin.Interface
    const exit = await Effect.runPromiseExit(
      ToolPermission.check({
        plugin,
        tool: "srv_write",
        args: {},
        ctx: {
          agent: "plan",
          sessionID: SessionID.make("ses_permission"),
          callID: "c",
          ask: (req) =>
            Effect.suspend(() => {
              asked.push(req.patterns[0]!)
              return Effect.die(new Error("denied"))
            }),
        },
      }),
    )
    expect(defect(exit)).toContain("denied")
    expect(asked).toEqual(["a"])
  })

  const malformed: [string, unknown, string][] = [
    ["a check that is not an object", "edit", "a check is not an object"],
    ["an empty permission", { permission: "", patterns: ["a"] }, "permission must be a non-empty string"],
    ["no patterns", { permission: "edit", patterns: [] }, "patterns of edit must be a non-empty list of strings"],
    ["a pattern that is not a string", { permission: "edit", patterns: [1] }, "patterns of edit must be"],
    ["always that is not a list", { permission: "edit", patterns: ["a"], always: "a" }, "always of edit must be"],
    ["metadata that is a list", { permission: "edit", patterns: ["a"], metadata: [] }, "metadata of edit must be"],
  ]
  for (const [name, check, message] of malformed) {
    test(`refuses the call, asking nothing, on ${name}`, async () => {
      const h = harness((_input, output) => {
        output.checks.push({ permission: "edit", patterns: ["fine"] })
        output.checks.push(check)
      })
      const text = defect(await h.run({}))
      expect(text).toContain("srv_write")
      expect(text).toContain(message)
      expect(h.asked).toEqual([])
    })
  }

  test("refuses the call when a hook replaces checks with something that is not a list", async () => {
    const h = harness((_input, output) => {
      ;(output as any).checks = "edit"
    })
    expect(defect(await h.run({}))).toContain("checks is not a list")
  })
})
