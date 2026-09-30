import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"

const rules = (config: Record<string, any>) => Permission.fromConfig(config)

describe("Permission exposure", () => {
  const plan = rules({ "*": "allow", glob: "deny", edit: { "*": "deny", "plans/*.md": "allow" } })
  const build = rules({ "*": "allow", webfetch: "deny" })

  test("a tool is hidden only when every ruleset hides it", () => {
    expect([...Permission.disabled(["glob", "webfetch"], plan)]).toEqual(["glob"])
    expect([...Permission.disabledForAll(["glob", "webfetch"], [plan, build])]).toEqual([])
    const both = rules({ "*": "allow", glob: "deny" })
    expect([...Permission.disabledForAll(["glob", "webfetch"], [plan, both])]).toEqual(["glob"])
    expect(Object.keys(Permission.visibleToAny({ glob: 1, webfetch: 2 }, [plan, both]))).toEqual(["webfetch"])
    expect([...Permission.disabledForAll(["glob"], [])]).toEqual([])
  })

  test("deniedForAll needs a deny from every ruleset", () => {
    const denyGeneral = rules({ task: { general: "deny" } })
    expect(Permission.deniedForAll("task", "general", [denyGeneral])).toBe(true)
    expect(Permission.deniedForAll("task", "general", [denyGeneral, build])).toBe(false)
    expect(Permission.deniedForAll("task", "general", [])).toBe(false)
  })
})

describe("Agent.exposureOf", () => {
  const agent = (name: string, mode: Agent.Info["mode"], permission: any, hidden?: boolean): Agent.Info => ({
    name,
    mode,
    hidden,
    permission,
    options: {},
  })
  const plan = agent("plan", "primary", rules({ glob: "deny" }))
  const build = agent("build", "primary", rules({ webfetch: "deny" }))
  const custom = agent("custom", "all", rules({ bash: "deny" }))
  const explore = agent("explore", "subagent", rules({ edit: "deny" }))
  const title = agent("title", "primary", rules({ "*": "deny" }), true)
  const all = [plan, build, custom, explore, title]

  test("selectable agents share one exposure, led by their own ruleset", () => {
    expect(Agent.exposureOf(plan, all)).toEqual([plan.permission, build.permission, custom.permission])
    expect(Agent.exposureOf(build, all)).toEqual([build.permission, plan.permission, custom.permission])
  })

  test("subagents and hidden agents keep their own exposure", () => {
    expect(Agent.exposureOf(explore, all)).toEqual([explore.permission])
    expect(Agent.exposureOf(title, all)).toEqual([title.permission])
  })
})
