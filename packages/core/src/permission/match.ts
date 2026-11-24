export * as PermissionMatch from "./match.js"

import type { Permission } from "@opencode/schema/permission"
import type { PermissionPolicy } from "./policy.js"
import { Wildcard } from "../util/wildcard.js"

// How rules decide a request, without the services that collect them, so agents other than OpenCode can bundle it.

/** Actions whose resources are file paths. */
export const pathActions = ["external_directory", "read", "edit"] as const

/** macOS volumes ignore case by default, so `.OPENCODE/x` opens `.opencode/x`; rules for file paths must match it too. */
export function ignoresCase(action: string) {
  return process.platform === "darwin" && pathActions.some((item) => item === action)
}

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    deciding(action, resource, ...rulesets) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

// The rule that decides ACTION on RESOURCE, the last one matching; none when no rule matches, and asking is the
// default.
export function deciding(action: string, resource: string, ...rulesets: Permission.Ruleset[]) {
  const ignoreCase = ignoresCase(action)
  return rulesets
    .flat()
    .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource, ignoreCase))
}

// The spellings of the resource at INDEX of a request: the resource, then its alternates.
export function spellings(input: Pick<Permission.Request, "resources" | "alternates">, index: number) {
  return [input.resources[index], ...(input.alternates?.[index] ?? [])]
}

// The rule that decides ACTION on a resource written as SPELLINGS: the latest rule in the merged order that matches
// any of them, with the spelling it matched; none when no rule matches any, and asking is the default.
export function decidingAny(action: string, spellings: readonly string[], ...rulesets: Permission.Ruleset[]) {
  const rules = rulesets.flat()
  const ignoreCase = ignoresCase(action)
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]
    if (!Wildcard.match(action, rule.action)) continue
    const spelling = spellings.find((item) => Wildcard.match(item, rule.resource, ignoreCase))
    if (spelling !== undefined) return { rule, spelling }
  }
}

// The rule that decides ACTION on a resource written as SPELLINGS, with the spelling it matched: a spelling the rule
// deciding it alone denies, else the latest rule matching any of them; none when no rule matches any.
export function decidingResource(action: string, spellings: readonly string[], ...rulesets: Permission.Ruleset[]) {
  for (const spelling of spellings) {
    const rule = deciding(action, spelling, ...rulesets)
    if (rule?.effect === "deny") return { rule, spelling }
  }
  return decidingAny(action, spellings, ...rulesets)
}

// The first resource of a request RULES deny, with the rule and the spelling it denies.
export function denial(
  input: Pick<Permission.Request, "action" | "resources" | "alternates">,
  rules: Permission.Ruleset,
) {
  for (const [index, resource] of input.resources.entries()) {
    const decided = decidingResource(input.action, spellings(input, index), rules)
    if (decided?.rule.effect === "deny") return { resource, ...decided }
  }
}

// Why RULE denies ACTION, as the agent is told: its message after the permission, none when it has no message.
export function reason(action: string, rule: Permission.Rule) {
  return rule.message === undefined ? undefined : `Permission denied: ${action}. ${rule.message}`
}

type Match = { rule: Permission.Rule; spelling: string }
type Input = Pick<Permission.Request, "action" | "resources" | "alternates">

export function policyMatch(policy: PermissionPolicy.Policy, action: string, names: readonly string[]): Match | undefined {
  switch (policy._tag) {
    case "rules":
      return decidingAny(action, names, policy.rules)
    case "override":
      return decidingAny(action, names, policy.next) ?? policyMatch(policy.base, action, names)
    case "restrict": {
      const denies = policy.denies.map((rule) => ({ ...rule, effect: "deny" as const }))
      return decidingAny(action, names, denies) ?? policyMatch(policy.base, action, names)
    }
    case "fallback": {
      const primary = policyMatch(policy.base, action, names)
      if (primary && primary.rule.effect !== "ask") return primary
      return policyMatch(policy.secondary, action, names) ?? primary
    }
  }
}

function matchResource(policy: PermissionPolicy.Policy, action: string, names: readonly string[]) {
  if (policy._tag === "rules") return decidingResource(action, names, policy.rules)
  for (const name of names) {
    const decision = policyMatch(policy, action, [name])
    if (decision?.rule.effect === "deny") return decision
  }
  return policyMatch(policy, action, names)
}

export function reasons(input: Input, policies: ReadonlyArray<PermissionPolicy.Policy>) {
  return input.resources.flatMap((resource, index): Permission.Reason[] => {
    const names = spellings(input, index)
    for (const policy of policies) {
      const decided = matchResource(policy, input.action, names)
      if (!decided) return [{ resource }]
      if (decided.rule.effect === "ask")
        return [{ resource, ...(decided.spelling === resource ? {} : { spelling: decided.spelling }), rule: decided.rule }]
    }
    return []
  })
}

export function assess(input: Input, policy: PermissionPolicy.Policy) {
  let effect: Permission.Effect = "allow"
  for (const index of input.resources.keys()) {
    const decided = matchResource(policy, input.action, spellings(input, index))
    if (decided?.rule.effect === "deny") return { effect: "deny", denial: decided.rule } as const
    if (!decided || decided.rule.effect === "ask") effect = "ask"
  }
  return { effect }
}
