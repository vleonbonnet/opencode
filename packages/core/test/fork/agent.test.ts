import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { SessionSchema } from "@opencode/core/session/schema"
import { it } from "../lib/effect"

describe("Agent.exposure", () => {
  const agent = (id: string, mode: Agent.Info["mode"], effect: Permission.Rule["effect"], hidden = false) =>
    Agent.Info.make({
      ...Agent.Info.default(Agent.ID.make(id)),
      mode,
      hidden,
      permissions: [{ action: id, resource: "*", effect }],
    })
  const plan = agent("plan", "primary", "deny")
  const build = agent("build", "primary", "allow")
  const custom = agent("custom", "all", "ask")
  const explore = agent("explore", "subagent", "deny")
  const title = agent("title", "primary", "deny", true)
  const all = [build, plan, custom, explore, title]
  const root = {}
  const child = { parentID: SessionSchema.ID.make("ses_parent") }

  it.effect("shares one exposure across selectable agents of a root Session, led by the agent's own rules", () =>
    Effect.sync(() => {
      expect(Agent.exposure(plan, all, root)).toEqual([plan.permissions, build.permissions, custom.permissions])
      expect(Agent.exposure(build, all, root)).toEqual([build.permissions, plan.permissions, custom.permissions])
      expect(Agent.exposure(custom, all, root)).toEqual([custom.permissions, build.permissions, plan.permissions])
    }),
  )

  it.effect("keeps subagents, hidden agents, and any agent running in a child Session to their own rules", () =>
    Effect.sync(() => {
      expect(Agent.exposure(explore, all, root)).toEqual([explore.permissions])
      expect(Agent.exposure(title, all, root)).toEqual([title.permissions])
      expect(Agent.exposure(custom, all, child)).toEqual([custom.permissions])
      expect(Agent.exposure(build, all, child)).toEqual([build.permissions])
    }),
  )
})
