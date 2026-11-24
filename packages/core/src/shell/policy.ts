export * as ShellPolicy from "./policy.js"

import { Effect, Result } from "effect"
import type { Permission } from "@opencode/schema/permission"
import { PermissionMatch } from "../permission/match.js"
import { Wildcard } from "../util/wildcard.js"
import { ShellParse } from "./parse.js"

export { decidingResource } from "../permission/match.js"

// A shell command decided as the shell tool decides it, for the hooks of agents that cannot run OpenCode (Claude Code,
// Codex), which bundle this module on its own. Each command the scan finds is decided by the rule deciding its
// spellings; a denied command denies the call, and one that asks, or that no rule decides, asks for it. A command the
// scan cannot read is decided as the shell tool decides it: denied when any shell rule denies, since that rule cannot
// be matched against the commands within it, and otherwise decided as one resource, the whole command.
export type Decision = {
  effect: Permission.Effect
  // The command that decides the call, the rule deciding it and the spelling the rule matched; no rule when none
  // matches, and nothing for an allowed call or one the scan refuses.
  resource?: string
  rule?: Permission.Rule
  spelling?: string
  // What the agent is told when the call is denied.
  reason?: string
}

export type Input = {
  command: string
  // The shell running the command, which picks its dialect.
  shell: string
  cwd: string
  rules: Permission.Ruleset
}

const action = "shell"

export async function decide(input: Input): Promise<Decision> {
  const scanned = await Effect.runPromise(Effect.result(ShellParse.scan(input.command, input.shell, input.cwd)))
  if (Result.isFailure(scanned)) return unreadable(input, scanned.failure)
  const decided = scanned.success.commands.map((command) => ({
    resource: command.resource,
    ...PermissionMatch.decidingResource(action, [command.resource, ...(command.alternates ?? [])], input.rules),
  }))
  const denied = decided.find((item) => item.rule?.effect === "deny")
  if (denied?.rule)
    return {
      effect: "deny",
      resource: denied.resource,
      rule: denied.rule,
      spelling: denied.spelling,
      reason: PermissionMatch.reason(action, denied.rule) ?? `Permission denied: ${action}`,
    }
  const asked = decided.find((item) => item.rule?.effect !== "allow")
  if (asked)
    return {
      effect: "ask",
      resource: asked.resource,
      ...(asked.rule ? { rule: asked.rule, spelling: asked.spelling } : {}),
    }
  return { effect: "allow" }
}

function unreadable(input: Input, failure: ShellParse.OpaqueError): Decision {
  if (input.rules.some((rule) => rule.effect === "deny" && Wildcard.match(action, rule.action)))
    return {
      effect: "deny",
      reason: `${failure.message}. A shell deny rule is configured and the command cannot be checked against it; rewrite it without eval or other dynamic execution.`,
    }
  const decided = PermissionMatch.decidingResource(action, [input.command], input.rules)
  if (decided?.rule.effect === "allow") return { effect: "allow" }
  return {
    effect: "ask",
    resource: input.command,
    ...(decided ? { rule: decided.rule, spelling: decided.spelling } : {}),
  }
}
