export * as PermissionDelegation from "./delegation.js"

import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { PermissionMatch } from "./match.js"
import type { PermissionPolicy } from "./policy.js"
import type { Session } from "@opencode/schema/session"

/** The delegating agent whose own rules bind what it delegates, as v1 bound plan-launched subagents. */
export const plan = Agent.ID.make("plan")

// Plan's rules for launching subagents choose whom plan may launch, not whom its delegates may launch.
const subagent = "subagent"

/** Rules a delegation holds a Session to besides its own: any ceiling that denies or asks decides. */
export interface Ceiling {
  readonly delegator: Session.Delegator
  readonly rules: Permission.Ruleset
}

/**
 * The ceiling one delegator imposes, built from current rules at every check. The delegating Session's deny and
 * external_directory rules always bind, as v1 forwarded them. When plan delegated, plan's own rules bind too, followed by
 * those Session rules the way plan evaluates them; a plan agent that no longer exists denies everything.
 */
export function ceiling(input: {
  readonly delegator: Session.Delegator
  readonly session: Pick<Session.Info, "permissions"> | undefined
  readonly agent: Pick<Agent.Info, "permissions"> | undefined
}): Ceiling {
  const forwarded = (input.session?.permissions ?? []).filter(
    (rule) => rule.effect === "deny" || rule.action === "external_directory",
  )
  if (input.delegator.agent !== plan)
    return { delegator: input.delegator, rules: [{ action: "*", resource: "*", effect: "allow" }, ...forwarded] }
  if (input.agent === undefined)
    return { delegator: input.delegator, rules: [{ action: "*", resource: "*", effect: "deny" }] }
  return {
    delegator: input.delegator,
    rules: [...input.agent.permissions.filter((rule) => rule.action !== subagent), ...forwarded],
  }
}

/** Delegators that impose distinct ceilings: a Session's non-plan agents all forward the same Session rules. */
export function distinct(delegators: ReadonlyArray<Session.Delegator>) {
  const seen = new Set<string>()
  return delegators.filter((delegator) => {
    const key = `${delegator.sessionID}\0${delegator.agent === plan}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const delegatedDenial = (action: string, ceiling: Ceiling) =>
  `Permission denied: ${action}. The ${ceiling.delegator.agent} agent that delegated this task does not permit it.`

// Report the first denying policy, so BlockedError lists the rules of the agent that refused.
export function denied(
  input: Pick<Permission.Request, "action" | "resources" | "alternates">,
  bounds: ReadonlyArray<PermissionPolicy.Policy>,
  ceilings: ReadonlyArray<Ceiling>,
) {
  for (const [index, policy] of bounds.entries()) {
    const { denial } = PermissionMatch.assess(input, policy)
    if (!denial) continue
    const message = index === 0
      ? PermissionMatch.reason(input.action, denial)
      : [delegatedDenial(input.action, ceilings[index - 1]), denial.message].filter(Boolean).join(" ")
    return { effect: "deny" as const, policy, message, reasons: [] }
  }
}
