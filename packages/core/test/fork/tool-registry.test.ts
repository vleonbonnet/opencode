import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { toSessionError } from "@opencode/core/session/to-session-error"
import type { Info } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { codeModeListings } from "../lib/tool"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"

// The registry fixture of the upstream Tool tests, without its image normalization.
const registryLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node]), [
  Image.node.replace(Layer.mock(Image.Service, {})),
  Permission.node.replace(permissionLayer()),
])
const it = testEffect(registryLayer)
const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = Session.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (): Info => ({
  name: "echo",
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
})

const transform = (service: Tool.Interface, tools: Readonly<Record<string, Info>>, options?: Tool.Options) =>
  service.transform((editor) =>
    Object.entries(tools).forEach(([name, tool]) => editor.add({ ...tool, name, options: options ?? tool.options })),
  )

describe("Tool", () => {
  it.effect("lists what any exposure ruleset allows and refuses it to an acting agent that disables it", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { insert: make(), remove: make() }, { codemode: false })
      yield* transform(service, { lookup: make(), write_note: make() }, { codemode: true })
      const plan: Permission.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "insert", resource: "*", effect: "deny" },
        { action: "write_note", resource: "*", effect: "deny" },
        { action: "remove", resource: "*", effect: "deny" },
      ]
      const build: Permission.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "remove", resource: "*", effect: "deny" },
      ]
      const planned = yield* service.snapshot(plan, [plan, build])
      const built = yield* service.snapshot(build, [build, plan])

      // Only a tool every ruleset disables is left out, so both agents list the same tools and catalog.
      expect(planned.definitions.map((tool) => tool.name)).toEqual(["insert", "execute"])
      expect(planned.definitions).toEqual(built.definitions)
      expect(codeModeListings(planned.codeModeCatalog!).map((tool) => tool.path)).toEqual(["lookup", "write_note"])
      expect(planned.codeModeCatalog).toEqual(built.codeModeCatalog)

      const asPlan = (input: Parameters<Tool.Snapshot["execute"]>[0]) => ({ ...input, agent: Agent.ID.make("plan") })
      const refused = yield* planned.execute(asPlan(call("insert"))).pipe(Effect.flip)
      expect(toSessionError(refused)).toEqual({
        type: "permission.rejected",
        message: "The plan agent is not permitted to use insert.",
      })
      expect((yield* built.execute(call("insert"))).content).toEqual([{ type: "text", text: "insert" }])

      const script = (code: string) => ({
        ...call("execute", `call-${code.length}`),
        call: { type: "tool-call" as const, id: `call-${code.length}`, name: "execute", input: { code } },
      })
      const inner = 'return (await tools.write_note({ text: "note" })).text'
      expect(JSON.stringify((yield* planned.execute(asPlan(script(inner)))).content)).toContain(
        "The plan agent is not permitted to use write_note",
      )
      expect((yield* built.execute(script(inner))).content).toEqual([{ type: "text", text: "note" }])
      expect(
        (yield* planned.execute(asPlan(script('return (await tools.lookup({ text: "found" })).text')))).content,
      ).toEqual([{ type: "text", text: "found" }])
    }),
  )

  it.effect("refuses a call the acting rules wholly disable before any execute.before hook sees it", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      yield* transform(service, { insert: make() }, { codemode: false })
      yield* transform(service, { lookup: make() }, { codemode: true })
      const seen: string[] = []
      yield* hooks.register("tool", "execute.before", (event) =>
        Effect.sync(() => {
          seen.push(event.tool)
        }),
      )
      const plan: Permission.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "insert", resource: "*", effect: "deny" },
        { action: "execute", resource: "*", effect: "deny" },
      ]
      const build: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
      const planned = yield* service.snapshot(plan, [plan, build])
      const built = yield* service.snapshot(build, [build, plan])
      const asPlan = (input: Parameters<Tool.Snapshot["execute"]>[0]) => ({ ...input, agent: Agent.ID.make("plan") })
      const script = {
        ...call("execute", "call-script"),
        call: {
          type: "tool-call" as const,
          id: "call-script",
          name: "execute",
          input: { code: 'return (await tools.lookup({ text: "found" })).text' },
        },
      }

      // Build allows both, so plan lists them too, but plan may call neither: not even Code Mode itself.
      expect(planned.definitions).toEqual(built.definitions)
      expect(toSessionError(yield* planned.execute(asPlan(call("insert"))).pipe(Effect.flip))).toEqual({
        type: "permission.rejected",
        message: "The plan agent is not permitted to use insert.",
      })
      expect(toSessionError(yield* planned.execute(asPlan(script)).pipe(Effect.flip))).toEqual({
        type: "permission.rejected",
        message: "The plan agent is not permitted to use execute.",
      })
      expect(seen).toEqual([])

      expect((yield* built.execute(call("insert"))).content).toEqual([{ type: "text", text: "insert" }])
      expect((yield* built.execute(script)).content).toEqual([{ type: "text", text: "found" }])
      expect(seen).toEqual(["insert", "execute", "lookup"])
    }),
  )

  it.effect("leaves out what any delegation ceiling wholly disables, whatever the exposure allows", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { insert: make(), remove: make() }, { codemode: false })
      yield* transform(service, { lookup: make(), write_note: make() }, { codemode: true })
      const allow: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
      const delegator = { sessionID: Session.ID.make("ses_parent"), agent: Agent.ID.make("plan") }
      const ceiling = (rules: Permission.Ruleset): Permission.Ceiling => ({ delegator, rules: [...allow, ...rules] })
      const bounded = yield* service.snapshot(
        allow,
        [allow],
        [
          ceiling([{ action: "insert", resource: "*", effect: "deny" }]),
          // A narrower exception keeps the tool listed; its calls answer to the ceiling when the tool asserts.
          ceiling([
            { action: "write_note", resource: "*", effect: "deny" },
            { action: "remove", resource: "*", effect: "deny" },
            { action: "remove", resource: "drafts/*", effect: "allow" },
          ]),
        ],
      )

      expect(bounded.definitions.map((tool) => tool.name)).toEqual(["remove", "execute"])
      expect(codeModeListings(bounded.codeModeCatalog!).map((tool) => tool.path)).toEqual(["lookup"])
      expect(yield* bounded.execute(call("insert")).pipe(Effect.flip)).toMatchObject({
        message: 'No tool named "insert" is currently available. Please use a tool from the available tool list.',
      })

      const closed = yield* service.snapshot(
        allow,
        [allow],
        [ceiling([{ action: "execute", resource: "*", effect: "deny" }])],
      )
      // Without Code Mode its tools are exposed directly, still bound by the ceiling.
      expect(closed.definitions.map((tool) => tool.name)).toEqual(["insert", "lookup", "remove", "write_note"])
      expect(closed.codeModeCatalog).toBeUndefined()
    }),
  )
})
