import { Effect } from "effect"
import type { ToolPermissionCheck } from "@opencode-ai/plugin"
import type { Plugin } from "@/plugin"
import type * as Tool from "./tool"

export class InvalidCheckError extends Error {
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`A plugin's tool.permission hook returned an invalid check for ${tool}: ${detail}. The call was refused.`)
  }
}

/**
 * Ask the `tool.permission` hooks which checks a call needs beyond the tool's
 * own, and run each through the calling agent's rules.  Plugins can only add
 * checks: the tool keeps its own, so a hook makes a call stricter or leaves it
 * as it is.  A malformed check refuses the call rather than being skipped, so a
 * broken hook fails closed.
 */
export const check = Effect.fn("ToolPermission.check")(function* (input: {
  plugin: Plugin.Interface
  tool: string
  args: unknown
  ctx: Pick<Tool.Context, "agent" | "sessionID" | "callID" | "ask">
}) {
  const output: { checks: ToolPermissionCheck[] } = { checks: [] }
  yield* input.plugin.trigger(
    "tool.permission",
    {
      tool: input.tool,
      agent: input.ctx.agent,
      sessionID: input.ctx.sessionID,
      callID: input.ctx.callID ?? "",
      args: input.args,
    },
    output,
  )
  if (!Array.isArray(output.checks)) return yield* Effect.die(new InvalidCheckError(input.tool, "checks is not a list"))
  const checks = yield* Effect.forEach(output.checks, (item) => validate(input.tool, item))
  for (const item of checks) yield* input.ctx.ask(item)
})

function validate(tool: string, value: unknown) {
  const invalid = (detail: string) => Effect.die(new InvalidCheckError(tool, detail))
  if (typeof value !== "object" || value === null) return invalid("a check is not an object")
  const item = value as Record<string, unknown>
  if (typeof item.permission !== "string" || item.permission === "")
    return invalid("permission must be a non-empty string")
  if (!strings(item.patterns) || item.patterns.length === 0)
    return invalid(`patterns of ${item.permission} must be a non-empty list of strings`)
  if (item.always !== undefined && !strings(item.always))
    return invalid(`always of ${item.permission} must be a list of strings`)
  if (
    item.metadata !== undefined &&
    (typeof item.metadata !== "object" || item.metadata === null || Array.isArray(item.metadata))
  )
    return invalid(`metadata of ${item.permission} must be an object`)
  return Effect.succeed({
    permission: item.permission,
    patterns: [...item.patterns],
    always: item.always === undefined ? [...item.patterns] : [...(item.always as string[])],
    metadata: (item.metadata as Record<string, unknown> | undefined) ?? {},
  })
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

export * as ToolPermission from "./permission-checks"
