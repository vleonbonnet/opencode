import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import type { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { codeModeListings, toolIdentity } from "../../lib/tool"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** The MCP harness of the upstream MCP tests, which host these. */
export interface Harness {
  readonly it: { readonly effect: (name: string, body: () => Effect.Effect<unknown, unknown, Provided>) => void }
  /** Starts a test with a fresh permission assertion, no permission decision and no MCP tool invocation. */
  readonly reset: Effect.Effect<void>
  /** The MCP tool calls made since the last reset. */
  readonly invocations: () => ReadonlyArray<Parameters<Mcp.Interface["callTool"]>[0]>
}

export const forkTests = ({ it, reset, invocations }: Harness) =>
  describe("MCP tools (fork)", () => {
    it.effect("lists MCP tools another selectable agent allows and refuses them to an agent that disables them", () =>
      Effect.gen(function* () {
        yield* reset
        const registry = yield* Tool.Service
        const registration = yield* McpTool.Service
        yield* registration.flush
        const build: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
        const plan: Permission.Ruleset = [
          ...build,
          { action: McpTool.name("direct", "lookup"), resource: "*", effect: "deny" },
          { action: McpTool.name("demo", "search"), resource: "*", effect: "deny" },
        ]
        const planned = yield* registry.snapshot(plan, { exposure: [plan, build] })

        // Alone, plan would leave both tools out; build's rules keep them listed for plan too.
        expect((yield* registry.snapshot(plan)).definitions.map((tool) => tool.name)).not.toContain("direct_lookup")
        expect(planned.definitions.map((tool) => tool.name)).toContain("direct_lookup")
        expect(codeModeListings(planned.codeModeCatalog!).map((tool) => tool.path)).toContain("demo.search")

        const asPlan = { sessionID: Session.ID.make("ses_mcp_plan"), ...toolIdentity, agent: Agent.ID.make("plan") }
        const direct = yield* planned
          .execute({ ...asPlan, call: { type: "tool-call", id: "call_plan_lookup", name: "direct_lookup", input: {} } })
          .pipe(Effect.flip)
        expect(toSessionError(direct)).toEqual({
          type: "permission.rejected",
          message: "The plan agent is not permitted to use direct_lookup.",
        })
        const script = yield* planned.execute({
          ...asPlan,
          call: {
            type: "tool-call",
            id: "call_plan_search",
            name: "execute",
            input: { code: "return await tools.demo.search({})" },
          },
        })
        expect(JSON.stringify(script.content)).toContain("The plan agent is not permitted to use demo_search")
        expect(invocations()).toEqual([])
      }),
    )
  })
