export * as PermissionExposure from "./exposure.js"

import type { Permission } from "@opencode/schema/permission"
import type { PermissionDelegation } from "./delegation.js"
import { PermissionPolicy } from "./policy.js"

export function policies(policy: PermissionPolicy.Policy, exposure?: ReadonlyArray<Permission.Ruleset>) {
  return exposure?.length ? exposure.map((rules) => PermissionPolicy.fromRules(rules)) : [policy]
}

export function skills<T>(
  listed: ReadonlyArray<T>,
  policy: PermissionPolicy.Policy,
  available: (listed: ReadonlyArray<T>, policy: PermissionPolicy.Policy) => T[],
  exposure?: ReadonlyArray<Permission.Ruleset>,
  ceilings: ReadonlyArray<PermissionDelegation.Ceiling> = [],
) {
  const shown = new Set(policies(policy, exposure).flatMap((item) => available(listed, item)))
  for (const ceiling of ceilings) {
    const allowed = new Set(available(listed, PermissionPolicy.fromRules(ceiling.rules)))
    for (const item of shown) if (!allowed.has(item)) shown.delete(item)
  }
  return listed.filter((item) => shown.has(item))
}
