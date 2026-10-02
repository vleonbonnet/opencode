import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. When delegating from plan, its effective approval and deny rules
 *    (see `effectiveRestrictions`), followed by the parent session's hard
 *    denies and external_directory rules. Other parent agents leave the
 *    subagent's own capabilities alone.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgentPermission?: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    // Plan-mode delegation must not bypass the parent's approval rules.
    ...(input.parentAgentPermission
      ? effectiveRestrictions(
          input.parentAgentPermission.filter((rule) => rule.permission !== "task"),
          input.subagent.permission,
        )
      : []),
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * True when every resource matched by `inner` is also matched by `outer`.
 * Conservative: a `?` in `outer` never covers anything but itself.
 */
function covers(outer: string, inner: string) {
  if (outer === inner) return true
  if (outer.includes("?")) return false
  return Wildcard.match(inner, outer)
}

/**
 * Project a parent ruleset down to the restrictions it actually enforces,
 * expressed so they can be appended after the subagent's own rules.
 *
 * Rules are evaluated last-match-wins, so a parent `ask`/`deny` that a later
 * parent rule fully overrides (e.g. the built-in `external_directory: *: ask`
 * followed by a user `external_directory: allow`) has no effect on the parent
 * and must not be resurrected in the child. Surviving restrictions are kept
 * in order, together with the parent's narrower `allow` exceptions to them;
 * an exception is capped at what the subagent itself would decide, so it
 * re-opens a hole in the parent's restriction without widening the subagent.
 */
function effectiveRestrictions(parent: PermissionV1.Ruleset, subagent: PermissionV1.Ruleset): PermissionV1.Rule[] {
  const overridden = (index: number) =>
    parent
      .slice(index + 1)
      .some(
        (later) => covers(later.permission, parent[index].permission) && covers(later.pattern, parent[index].pattern),
      )
  const kept: PermissionV1.Rule[] = []
  parent.forEach((rule, index) => {
    if (overridden(index)) return
    if (rule.action !== "allow") {
      kept.push(rule)
      return
    }
    const excepts = kept.some(
      (restriction) =>
        restriction.action !== "allow" &&
        covers(restriction.permission, rule.permission) &&
        covers(restriction.pattern, rule.pattern),
    )
    if (!excepts) return
    kept.push({ ...rule, action: Permission.evaluate(rule.permission, rule.pattern, subagent).action })
  })
  return kept
}
