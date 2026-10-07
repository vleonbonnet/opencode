import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })]],
  ),
)

const writePlugins = (files: Record<string, string[]>) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const configDir = path.join(instance.directory, ".opencode")
    const root = path.join(configDir, "plugin")
    yield* Effect.promise(() => mkdir(root, { recursive: true }))
    yield* Effect.promise(() => markPluginDependenciesReady(configDir))
    for (const [name, lines] of Object.entries(files)) {
      yield* Effect.promise(() => Bun.write(path.join(root, name), lines.join("\n")))
    }
  })

const authFile = () =>
  Effect.promise(() =>
    Bun.file(path.join(Global.Path.data, "auth.json"))
      .text()
      .catch(() => ""),
  )

describe("plugin auth.credentials", () => {
  it.instance(
    "registers valid credentials in memory and skips invalid or failing ones",
    Effect.gen(function* () {
      yield* writePlugins({
        "a-credentials.ts": [
          "export default async () => ({",
          '  "auth.credentials": async () => ({',
          '    "runtime-demo": { type: "api", key: "runtime-key" },',
          '    "broken-demo": { type: "api" },',
          "  }),",
          "})",
          "",
        ],
        "b-failing.ts": [
          "export default async () => ({",
          '  "auth.credentials": async () => { throw new Error("pass locked") },',
          "})",
          "",
        ],
      })
      const plugin = yield* Plugin.Service
      const auth = yield* Auth.Service
      yield* plugin.init()
      expect(yield* auth.get("runtime-demo")).toEqual({ type: "api", key: "runtime-key" })
      expect(yield* auth.get("broken-demo")).toBeUndefined()
      expect((yield* auth.stored())["runtime-demo"]).toBeUndefined()
      expect(yield* authFile()).not.toContain("runtime-key")
    }),
  )

  it.instance(
    "a provider auth loader receives the in-memory credential",
    Effect.gen(function* () {
      yield* writePlugins({
        "demo-provider.ts": [
          "export default async () => ({",
          "  async config(cfg) {",
          "    cfg.provider ??= {}",
          "    cfg.provider.demo = {",
          '      name: "Demo Provider",',
          '      npm: "@ai-sdk/openai-compatible",',
          '      api: "https://example.com/v1",',
          '      options: { apiKey: "placeholder" },',
          '      models: { chat: { name: "Demo Chat", limit: { context: 128000, output: 4096 } } },',
          "    }",
          "  },",
          '  "auth.credentials": async () => ({ demo: { type: "api", key: "runtime-key" } }),',
          "  auth: {",
          '    provider: "demo",',
          '    methods: [{ type: "api", label: "Demo key" }],',
          "    loader: async (getAuth) => {",
          "      const info = await getAuth()",
          '      return { seenKey: info?.type === "api" ? info.key : "none" }',
          "    },",
          "  },",
          "})",
          "",
        ],
      })
      const providers = yield* Provider.use.list()
      const demo = providers[ProviderV2.ID.make("demo")]
      expect(demo).toBeDefined()
      expect(demo.options.seenKey).toBe("runtime-key")
      expect(yield* authFile()).not.toContain("runtime-key")
    }),
  )
})
