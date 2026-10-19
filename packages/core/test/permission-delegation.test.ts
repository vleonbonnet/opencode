import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { PermissionDelegation } from "@opencode/core/permission/delegation"
import { SessionSchema } from "@opencode/core/session/schema"

type Effect = Permission.Rule["effect"]
const rule = (action: string, resource: string, effect: Effect): Permission.Rule => ({ action, resource, effect })
const base = [
  rule("*", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
]
const parent = SessionSchema.ID.make("ses_parent")
const plan = { sessionID: parent, agent: PermissionDelegation.plan }
const build = { sessionID: parent, agent: Agent.ID.make("build") }

/** The delegate's decision under its own rules and the ceiling of plan delegating from a Session with `session` rules. */
const delegated = (delegating: Permission.Ruleset, delegate: Permission.Ruleset, session: Permission.Ruleset = []) => {
  const ceilings = [
    PermissionDelegation.ceiling({ delegator: plan, session: { permissions: session }, agent: { permissions: delegating } }),
  ]
  return (action: string, resource: string) => Permission.decide(action, resource, delegate, ceilings)
}

describe("PermissionDelegation.ceiling", () => {
  test("binds the delegate to plan's approval and deny rules", () => {
    const general = [...base, rule("edit", "*", "allow"), rule("shell", "*", "allow")]
    const decide = delegated(
      [
        ...base,
        rule("edit", "*", "ask"),
        rule("edit", "*.pem", "deny"),
        rule("shell", "*", "allow"),
        rule("shell", "rm *", "deny"),
      ],
      general,
    )

    expect(decide("edit", "src/app.ts")).toBe("ask")
    expect(decide("edit", "secret.pem")).toBe("deny")
    expect(decide("shell", "rm -rf src")).toBe("deny")
    expect(decide("shell", "git status")).toBe("allow")
    expect(decide("read", "notes.md")).toBe("allow")
  })

  test("keeps plan's exception only where the delegate allows it too", () => {
    const planRules = [...base, rule("edit", "*", "deny"), rule("edit", "/home/.opencode/plan/*", "allow")]
    const general = [...base, rule("question", "*", "deny")]
    const explore = [...base, rule("*", "*", "deny"), rule("read", "*", "allow"), ...base.slice(1)]

    expect(delegated(planRules, general)("edit", "src/app.ts")).toBe("deny")
    expect(delegated(planRules, general)("edit", "/home/.opencode/plan/next.md")).toBe("allow")
    expect(delegated(planRules, explore)("edit", "/home/.opencode/plan/next.md")).toBe("deny")
    expect(delegated(planRules, explore)("read", "src/app.ts")).toBe("allow")
  })

  test("does not resurrect restrictions plan overrides itself", () => {
    const explore = [
      ...base,
      rule("*", "*", "deny"),
      rule("read", "*", "allow"),
      rule("external_directory", "*", "ask"),
      rule("external_directory", "/tmp/tool-output/*", "allow"),
      rule("external_directory", "*", "allow"),
    ]
    const decide = delegated(
      [
        ...base,
        rule("question", "*", "deny"),
        rule("external_directory", "*", "ask"),
        rule("external_directory", "/tmp/tool-output/*", "allow"),
        rule("question", "*", "allow"),
        rule("external_directory", "/data/plans/*", "allow"),
        rule("edit", "*", "deny"),
        rule("edit", ".opencode/plans/*.md", "allow"),
        rule("external_directory", "*", "allow"),
      ],
      explore,
    )

    expect(decide("external_directory", "/elsewhere/project")).toBe("allow")
    // A plan allow that overrides its own deny must not widen the delegate.
    expect(decide("question", "*")).toBe("deny")
    expect(decide("edit", ".opencode/plans/x.md")).toBe("deny")
  })

  test("keeps plan's exceptions only where the delegate allows them", () => {
    const decide = delegated(
      [
        rule("external_directory", "*", "ask"),
        rule("external_directory", "/tmp/tool-output/*", "allow"),
        rule("external_directory", "/data/plans/*", "allow"),
      ],
      [
        rule("*", "*", "deny"),
        rule("external_directory", "*", "ask"),
        rule("external_directory", "/tmp/tool-output/*", "allow"),
      ],
    )

    expect(decide("external_directory", "/elsewhere")).toBe("ask")
    expect(decide("external_directory", "/tmp/tool-output/x")).toBe("allow")
    expect(decide("external_directory", "/data/plans/x")).toBe("ask")
  })

  test("never loosens a narrower delegate rule that a broader plan rule covers", () => {
    const decide = delegated(
      [rule("*", "*", "allow"), rule("edit", "*", "ask")],
      [rule("*", "*", "allow"), rule("edit", "*.pem", "deny"), rule("edit", "public.pem", "allow")],
    )

    expect(decide("edit", "src/app.ts")).toBe("ask")
    expect(decide("edit", "secret.pem")).toBe("deny")
    expect(decide("edit", "public.pem")).toBe("ask")
  })

  test("never loosens a narrower plan rule with a broader delegate rule", () => {
    const decide = delegated(
      [rule("*", "*", "allow"), rule("edit", "*", "ask"), rule("edit", "*.pem", "deny")],
      [rule("*", "*", "allow"), rule("edit", "*", "allow")],
    )

    expect(decide("edit", "src/app.ts")).toBe("ask")
    expect(decide("edit", "secret.pem")).toBe("deny")
  })

  test("decides per value where plan and delegate patterns overlap without containing each other", () => {
    // Plan's cat exception overlaps its redirect deny; neither pattern contains the other.
    const shell = delegated(
      [...base, rule("shell", "*", "deny"), rule("shell", "cat *", "allow"), rule("shell", "*>*", "deny")],
      base,
    )
    expect(shell("shell", "cat a")).toBe("allow")
    expect(shell("shell", "cat a > b")).toBe("deny")
    expect(shell("shell", "ls")).toBe("deny")

    // The delegate's exception covers a key that plan denies by extension.
    const keys = delegated(
      [...base, rule("edit", "*.pem", "deny")],
      [...base, rule("edit", "*", "deny"), rule("edit", "keys/*", "allow")],
    )
    expect(keys("edit", "keys/notes.md")).toBe("allow")
    expect(keys("edit", "keys/server.pem")).toBe("deny")
    expect(keys("edit", "src/app.ts")).toBe("deny")
  })

  test("leaves out plan's rules for launching subagents", () => {
    const decide = delegated([...base, rule("subagent", "*", "deny"), rule("subagent", "explore", "allow")], base)

    expect(decide("subagent", "general")).toBe("allow")
  })

  test("forwards the delegating Session's deny and external_directory rules for any delegator", () => {
    const session = [
      rule("shell", "rm *", "deny"),
      rule("external_directory", "*", "ask"),
      rule("external_directory", "/tmp/*", "allow"),
      rule("edit", "*", "allow"),
    ]
    const delegate = [...base, rule("edit", "*", "deny"), rule("external_directory", "*", "allow")]
    for (const delegator of [build, plan]) {
      const ceilings = [
        PermissionDelegation.ceiling({ delegator, session: { permissions: session }, agent: { permissions: base } }),
      ]
      const decide = (action: string, resource: string) => Permission.decide(action, resource, delegate, ceilings)

      expect(decide("shell", "rm -rf src")).toBe("deny")
      expect(decide("shell", "git status")).toBe("allow")
      expect(decide("external_directory", "/elsewhere")).toBe("ask")
      expect(decide("external_directory", "/tmp/output")).toBe("allow")
      // The Session's allow is not forwarded, and a ceiling never loosens the delegate.
      expect(decide("edit", "src/app.ts")).toBe("deny")
    }
    // Only plan's agent rules bind; build's own rules govern build alone.
    const fromBuild = [
      PermissionDelegation.ceiling({
        delegator: build,
        session: undefined,
        agent: { permissions: [rule("edit", "*", "deny")] },
      }),
    ]
    expect(Permission.decide("edit", "src/app.ts", base, fromBuild)).toBe("allow")
  })

  test("denies everything when the plan agent no longer exists", () => {
    const ceilings = [PermissionDelegation.ceiling({ delegator: plan, session: undefined, agent: undefined })]

    expect(Permission.decide("read", "README.md", base, ceilings)).toBe("deny")
  })

  test("applies saved approvals to a ceiling's ask as to the delegate's own", () => {
    const ceilings = [
      PermissionDelegation.ceiling({
        delegator: plan,
        session: undefined,
        agent: { permissions: [...base, rule("shell", "*", "ask")] },
      }),
    ]
    const saved = [rule("shell", "git *", "allow")]

    expect(Permission.decide("shell", "git status", base, ceilings, saved)).toBe("allow")
    expect(Permission.decide("shell", "make", base, ceilings, saved)).toBe("ask")
  })
})

describe("PermissionDelegation.distinct", () => {
  test("keeps one delegator per Session and kind of ceiling", () => {
    const other = SessionSchema.ID.make("ses_other")
    const general = { sessionID: parent, agent: Agent.ID.make("general") }

    expect(
      PermissionDelegation.distinct([plan, build, general, plan, { sessionID: other, agent: build.agent }]),
    ).toEqual([plan, build, { sessionID: other, agent: build.agent }])
  })
})
