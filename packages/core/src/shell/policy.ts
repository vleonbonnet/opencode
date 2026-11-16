export * as ShellPolicy from "./policy.js"

import { Effect, Result } from "effect"
import type { Permission } from "@opencode/schema/permission"
import { PermissionMatch } from "../permission/match.js"
import { ShellParse } from "./parse.js"

export { decidingResource } from "../permission/match.js"

// A shell command decided as the shell tool decides it, for the hooks of agents that cannot run OpenCode (Claude Code,
// Codex), which bundle this module on its own. Each command the scan finds is decided by the rule deciding its
// spellings; a denied command denies the call, and one that asks, or that no rule decides, asks for it. A command the
// scan cannot read is denied, as the shell tool refuses it.
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
  if (Result.isFailure(scanned)) return { effect: "deny", reason: scanned.failure.message }
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
