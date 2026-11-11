import { describe, expect } from "bun:test"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { Permission } from "@opencode/schema/permission"
import { Config } from "@opencode/core/config"
import { ConfigPolicyPlugin } from "@opencode/core/config/plugin/policy"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)

const document = (...policies: ConfigPolicy.Info[]) => new Document({ type: "document", info: decode({ policies }) })
const tool = (effect: ConfigPolicy.Effect, resource: string): ConfigPolicy.Info => ({
  action: "tool.use",
  resource,
  effect,
})

const addPlugin = Effect.fn(function* (entries: Entry[]) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* ConfigPolicyPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
})

// Evaluates a permission the way the upstream policy tests do, with the other spellings of each resource.
const evaluate = Effect.fn(function* (
  action: string,
  resources: string[],
  effect: Permission.Effect = "allow",
  alternates?: string[][],
) {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("permission", "evaluate", {
    sessionID: Session.ID.make("ses_policy"),
    action,
    resources,
    ...(alternates ? { alternates } : {}),
    effect,
  })
  return { effect: event.effect, message: event.message }
})

describe("ConfigPolicyPlugin.Plugin", () => {
  it.effect("denies a resource when a tool.use policy denies any of its spellings", () =>
    Effect.gen(function* () {
      yield* addPlugin([document(tool("allow", "shell:*"), tool("deny", "shell:kubectl delete *"))])
      expect((yield* evaluate("shell", [`kubectl "delete" pod x`])).effect).toBe("allow")
      expect((yield* evaluate("shell", [`kubectl "delete" pod x`], "allow", [["kubectl delete pod x"]])).effect).toBe(
        "deny",
      )
    }),
  )
})
