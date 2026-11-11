import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import type { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { Skill } from "@opencode/core/skill"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { it } from "../lib/effect"
import { readInitial } from "../lib/instructions"

// Skills and the catalog layer of the upstream SkillInstructions tests.
const effect = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Build applications with Effect",
  path: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const denied = Skill.Info.make({
  id: Skill.ID.make("denied"),
  name: Skill.Name.make("Denied"),
  description: "Must not be advertised",
  path: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})

const layer = (list: () => Skill.Info[]) =>
  AppNodeBuilder.build(SkillInstructions.node, [
    Skill.node.replace(Layer.mock(Skill.Service, { list: () => Effect.succeed(list()) })),
  ])

describe("SkillInstructions", () => {
  it.effect("lists a skill unless every ruleset of a shared exposure denies it", () => {
    const plan = [{ action: "skill", resource: "denied", effect: "deny" as const }]
    const build = [
      { action: "skill", resource: "effect", effect: "deny" as const },
      { action: "skill", resource: "denied", effect: "deny" as const },
    ]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const shared = (yield* instructions.load([plan, build]).pipe(Effect.flatMap(readInitial))).text

      // Listed because plan allows it, although build alone would hide it; hidden because both deny it.
      expect(shared).toContain("<id>effect</id>")
      expect(shared).not.toContain("<id>denied</id>")
      expect((yield* instructions.load([build, plan]).pipe(Effect.flatMap(readInitial))).text).toBe(shared)
      expect((yield* instructions.load([build]).pipe(Effect.flatMap(readInitial))).text).toBe("")
    }).pipe(Effect.provide(layer(() => [denied, effect])))
  })

  it.effect("lists only skills that every delegation ceiling allows", () => {
    const ceiling: Permission.Ceiling = {
      delegator: { sessionID: SessionSchema.ID.make("ses_parent"), agent: Agent.ID.make("plan") },
      rules: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    }
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const bounded = (yield* instructions.load([[]], [ceiling]).pipe(Effect.flatMap(readInitial))).text

      expect(bounded).toContain("<id>denied</id>")
      expect(bounded).not.toContain("<id>effect</id>")
    }).pipe(Effect.provide(layer(() => [denied, effect])))
  })
})
