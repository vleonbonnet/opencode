import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Mcp } from "@opencode/core/mcp/index"
import { McpPool } from "@opencode/core/mcp/pool"
import { isRecord } from "@opencode/util/record"
import { tmpdirScoped } from "../../fixture/tmpdir"

// The upstream layers provide what these effects need. Their service types are local to the upstream file, so the
// hand-off leaves the requirements unchecked, and a missing service fails the test when it runs.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Provided = any

/** What these tests use of the upstream MCP test harness. */
export interface RetryHarness {
  readonly it: { readonly effect: (name: string, body: () => Effect.Effect<unknown, unknown, Provided>) => void }
  /** An in-process HTTP MCP server; `respond` answers a request before the server does. */
  readonly resourceServer: (input: {
    readonly modern: true
    readonly resources: false
    readonly respond: (request: Request) => Promise<Response | undefined>
  }) => Effect.Effect<{ readonly url: string; readonly state: { readonly toolLists: number } }, never, Provided>
  /** One Location's MCP service, configured with the one server "resources". */
  readonly resourceMcpLayer: (
    server: typeof ConfigMCP.Server.Type,
    onFormCreated: undefined,
    options: undefined,
    overrides: {
      readonly pool?: Layer.Layer<McpPool.Service>
      readonly published?: string[]
    },
  ) => Layer.Layer<Provided, Provided, Provided>
  readonly poolLayer: Layer.Layer<McpPool.Service, Provided, Provided>
}

const pinned = (url: string, fields: Partial<ConfigMCP.Remote> = {}) =>
  new ConfigMCP.Remote({ type: "remote", url, oauth: false, protocol: "2026-07-28", ...fields })

// Waits on real work, never on the test clock, so a retry runs only when a test moves the clock.
const until = <A, E, R>(read: Effect.Effect<A, E, R>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 10_000
    while (true) {
      const value = yield* read
      if (check(value)) return value
      if (performance.now() > deadline) return yield* Effect.die(new Error("condition never became true within 10s"))
      yield* TestClock.withLive(Effect.sleep("5 millis"))
    }
  })

// Gives anything due a chance to run, before asserting that nothing did.
const settle = TestClock.withLive(Effect.sleep("100 millis"))

const status = (mcp: Mcp.Interface) => mcp.servers().pipe(Effect.map((servers) => servers[0]?.status))

// The connection messages logged, with their details.
const connectionLogs = () => {
  const logs: Array<readonly [string, Record<string, unknown>]> = []
  const logger = Logger.map(Logger.formatStructured, (entry) => {
    if (!Array.isArray(entry.message)) return
    const [message, details] = entry.message
    if (/^mcp (connect|connected|reconnect|connection closed|pool ignored)/.test(String(message)))
      logs.push([String(message), isRecord(details) ? details : {}])
  })
  return {
    count: (message: string) => logs.filter(([logged]) => logged === message).length,
    logs,
    layer: Logger.layer([logger]),
  }
}

// A 2026-07-28 server whose `server/discover` answers an internal error while it is down, as a stdio bridge
// into a busy process does. Each probe records whether it declared roots, which shared connections never do.
// The first probe waits for `first` to settle before it is answered.
const flakyServer = (harness: RetryHarness, refuse: (roots: boolean) => boolean, first?: Promise<void>) =>
  Effect.gen(function* () {
    const probes: boolean[] = []
    const server = yield* harness.resourceServer({
      modern: true,
      resources: false,
      respond: async (request) => {
        if (request.method !== "POST") return undefined
        const body: unknown = await request.clone().json()
        if (!isRecord(body) || body.method !== "server/discover") return undefined
        const roots = JSON.stringify(body).includes('"roots"')
        probes.push(roots)
        if (probes.length === 1) await first
        if (!refuse(roots)) return undefined
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Internal error" } })
      },
    })
    return { server, probes }
  })

export const retryTests = (harness: RetryHarness) =>
  describe("MCP connect retries (fork)", () => {
    const it = harness.it

    // One Location's MCP service; it connects in the background, like a Location that boots.
    const open = (
      config: typeof ConfigMCP.Server.Type,
      overrides: { readonly pool?: McpPool.Interface; readonly published?: string[] } = {},
    ) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const context = yield* Layer.buildWithScope(
          harness.resourceMcpLayer(config, undefined, undefined, {
            pool: overrides.pool ? Layer.succeed(McpPool.Service, overrides.pool) : undefined,
            published: overrides.published,
          }),
          scope,
        )
        return Context.get(context, Mcp.Service)
      })

    const makePool = Layer.build(harness.poolLayer).pipe(Effect.map((context) => Context.get(context, McpPool.Service)))

    it.effect("retries a failed connect after 2 s, 10 s, 30 s and 2 min, then every 5 min, until it connects", () => {
      const captured = connectionLogs()
      return Effect.gen(function* () {
        let down = true
        const { server, probes } = yield* flakyServer(harness, () => down)
        const published: string[] = []
        const mcp = yield* open(pinned(server.url), { published })
        const failed = yield* until(status(mcp), (status) => status?.status === "failed")
        expect(failed).toEqual({ status: "failed", error: expect.stringContaining("pinned protocol version") })
        const changes = () => published.filter((type) => type === McpEvent.StatusChanged.type).length
        const announced = changes()

        for (const [index, wait] of [2_000, 10_000, 30_000, 120_000, 300_000, 300_000].entries()) {
          yield* TestClock.adjust(wait - 1)
          yield* settle
          expect(probes).toHaveLength(index + 1)
          yield* TestClock.adjust(1)
          yield* until(
            Effect.sync(() => captured.count("mcp reconnect failed")),
            (count) => count === index + 1,
          )
          expect(probes).toHaveLength(index + 2)
        }
        // A retry keeps reporting the failure while it runs, so nothing waits on it and no status change goes out.
        expect(yield* status(mcp)).toEqual(failed)
        expect(changes()).toBe(announced)

        down = false
        yield* TestClock.adjust("5 minutes")
        yield* until(status(mcp), (status) => status?.status === "connected")
        expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["echo"])
        expect(captured.count("mcp connect failed")).toBe(1)
        expect(captured.logs.filter(([message]) => message === "mcp reconnect failed").map(([, log]) => log)).toEqual(
          ["10s", "30s", "2m", "5m", "5m", "5m"].map((retryIn, index) => ({
            server: "resources",
            retry: index + 1,
            error: expect.stringContaining("pinned protocol version"),
            retryIn,
          })),
        )
        expect(captured.logs.filter(([message]) => message === "mcp reconnected").map(([, log]) => log.retry)).toEqual([
          7,
        ])
        expect(captured.count("mcp connected")).toBe(0)
      }).pipe(Effect.provide(captured.layer))
    })

    it.effect("starts the delays over on a manual connect and stops retrying on disconnect", () =>
      Effect.gen(function* () {
        const { server, probes } = yield* flakyServer(harness, () => true)
        const mcp = yield* open(pinned(server.url))
        yield* until(status(mcp), (status) => status?.status === "failed")
        yield* TestClock.adjust("2 seconds")
        yield* until(
          Effect.sync(() => probes.length),
          (count) => count === 2,
        )

        // The next retry was 10 s away; a manual connect fails again and retries 2 s after that.
        yield* mcp.connect("resources")
        expect(probes).toHaveLength(3)
        yield* TestClock.adjust(1_999)
        yield* settle
        expect(probes).toHaveLength(3)
        yield* TestClock.adjust(1)
        yield* until(
          Effect.sync(() => probes.length),
          (count) => count === 4,
        )

        yield* mcp.disconnect("resources")
        expect(yield* status(mcp)).toEqual({ status: "disabled" })
        yield* TestClock.adjust("1 hour")
        yield* settle
        expect(probes).toHaveLength(4)
      }),
    )

    it.effect("drops the pending retry when the server's config changes", () =>
      Effect.gen(function* () {
        const { server, probes } = yield* flakyServer(harness, () => true)
        const mcp = yield* open(pinned(server.url))
        yield* until(status(mcp), (status) => status?.status === "failed")
        yield* TestClock.adjust("1 second")
        yield* mcp.add("resources", pinned(server.url, { headers: { "x-revision": "2" } }))
        yield* until(
          Effect.sync(() => probes.length),
          (count) => count === 2,
        )
        yield* until(status(mcp), (status) => status?.status === "failed")
        // The replaced server's retry was due now; only the new one's, 2 s after its own failure, runs.
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(probes).toHaveLength(2)
        yield* TestClock.adjust("1 second")
        yield* until(
          Effect.sync(() => probes.length),
          (count) => count === 3,
        )
      }),
    )

    for (const [oauth, expected] of [
      [{ client_id: "client" }, "needs_auth"],
      [false, "failed"],
    ] as const)
      it.effect(
        `doesn't retry a server that ${expected === "needs_auth" ? "needs a sign-in" : "refuses the credentials"}`,
        () =>
          Effect.gen(function* () {
            let requests = 0
            const server = yield* harness.resourceServer({
              modern: true,
              resources: false,
              respond: async (request) => {
                if (new URL(request.url).pathname !== "/") return new Response(null, { status: 404 })
                requests += 1
                return new Response(null, { status: 401 })
              },
            })
            const mcp = yield* open(pinned(server.url, { oauth }))
            expect((yield* until(status(mcp), (status) => status?.status !== "pending"))?.status).toBe(expected)
            const attempted = requests
            yield* TestClock.adjust("1 hour")
            yield* settle
            expect(requests).toBe(attempted)
          }),
      )

    it.effect("retries a connection that closed on its own, from the first delay each time", () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const pids = path.join(tmp.path, "pids")
        const started = () =>
          Effect.promise(() => fs.readFile(pids, "utf8").catch(() => "")).pipe(
            Effect.map((text) => text.trim().split("\n").filter(Boolean).map(Number)),
          )
        const mcp = yield* open(
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "../../fixture/mcp-modern-stdio.ts")],
            environment: { MCP_PID_FILE: pids },
            protocol: "2026-07-28",
          }),
        )
        for (const round of [1, 2]) {
          yield* until(status(mcp), (status) => status?.status === "connected")
          process.kill((yield* started()).at(-1)!, "SIGKILL")
          yield* until(status(mcp), (status) => status?.status === "failed")
          yield* TestClock.adjust(1_999)
          yield* settle
          expect(yield* started()).toHaveLength(round)
          yield* TestClock.adjust(1)
          yield* until(started(), (started) => started.length === round + 1)
        }
        yield* until(status(mcp), (status) => status?.status === "connected")
      }),
    )

    it.effect("retries a failed shared connection once for all its Locations, not once per Location", () => {
      const captured = connectionLogs()
      return Effect.gen(function* () {
        let down = true
        let release = () => {}
        const { server, probes } = yield* flakyServer(
          harness,
          () => down,
          new Promise<void>((resolve) => (release = resolve)),
        )
        const pool = yield* makePool
        const config = pinned(server.url, { pool: true })
        const locations = [yield* open(config, { pool }), yield* open(config, { pool }), yield* open(config, { pool })]
        // The first probe is held, so the Locations booting meanwhile join its attempt.
        yield* until(
          Effect.sync(() => probes.length),
          (count) => count === 1,
        )
        yield* settle
        release()
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "failed")
        // Each shared attempt, then one connection with roots, which shows the refusal isn't about sharing. No
        // Location falls back to a connection of its own, which would probe with roots once per Location.
        const paired = () => probes.length % 2 === 0 && probes.every((roots, index) => roots === (index % 2 === 1))
        expect(paired()).toBe(true)
        expect(captured.count("mcp pool ignored: server refused the shared connection")).toBe(0)

        // However many Locations hold it, the shared connection makes one retry.
        const before = probes.length
        yield* TestClock.adjust("2 seconds")
        yield* until(
          Effect.sync(() => captured.count("mcp reconnect failed")),
          (count) => count === 1,
        )
        expect(probes).toHaveLength(before + 2)
        expect(paired()).toBe(true)
        for (const mcp of locations) expect((yield* status(mcp))?.status).toBe("failed")

        down = false
        yield* TestClock.adjust("10 seconds")
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "connected")
        expect(probes).toHaveLength(before + 3)
        // One connection lists the tools for every Location.
        expect(server.state.toolLists).toBe(1)
        expect(captured.count("mcp reconnect failed")).toBe(1)
        expect(captured.count("mcp reconnected")).toBe(1)
        expect(captured.count("mcp connected")).toBe(0)
        yield* TestClock.adjust("1 hour")
        yield* settle
        expect(probes).toHaveLength(before + 3)
      }).pipe(Effect.provide(captured.layer))
    })

    it.effect("connects each Location on its own when only a connection with roots gets through", () => {
      const captured = connectionLogs()
      return Effect.gen(function* () {
        const { server, probes } = yield* flakyServer(harness, (roots) => !roots)
        const pool = yield* makePool
        const config = pinned(server.url, { pool: true })
        const locations = [yield* open(config, { pool }), yield* open(config, { pool })]
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "connected")
        // The shared attempt and the check with roots, then each Location's own connection.
        expect(probes).toEqual([false, true, true, true])
        expect(server.state.toolLists).toBe(3)
        expect(captured.logs.filter(([message]) => message.startsWith("mcp pool ignored"))).toEqual([
          [
            "mcp pool ignored: server refused the shared connection",
            expect.objectContaining({ server: "resources", error: expect.stringContaining("pinned protocol version") }),
          ],
        ])
        yield* TestClock.adjust("1 hour")
        yield* settle
        expect(probes).toHaveLength(4)
      }).pipe(Effect.provide(captured.layer))
    })

    it.effect("retries a shared connection that closed for all its Locations at once", () => {
      const captured = connectionLogs()
      return Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const pids = path.join(tmp.path, "pids")
        const started = () =>
          Effect.promise(() => fs.readFile(pids, "utf8").catch(() => "")).pipe(
            Effect.map((text) => text.trim().split("\n").filter(Boolean).map(Number)),
          )
        const pool = yield* makePool
        const config = new ConfigMCP.Local({
          type: "local",
          command: [process.execPath, path.join(import.meta.dir, "../../fixture/mcp-modern-stdio.ts")],
          environment: { MCP_PID_FILE: pids },
          cwd: tmp.path,
          protocol: "2026-07-28",
          pool: true,
        })
        const locations = [yield* open(config, { pool }), yield* open(config, { pool })]
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "connected")
        expect(yield* started()).toHaveLength(1)

        process.kill((yield* started())[0]!, "SIGKILL")
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "failed")
        yield* TestClock.adjust("2 seconds")
        for (const mcp of locations) yield* until(status(mcp), (status) => status?.status === "connected")
        expect(yield* started()).toHaveLength(2)
        expect(captured.count("mcp connection closed")).toBe(1)
        expect(captured.count("mcp reconnected")).toBe(1)
      }).pipe(Effect.provide(captured.layer))
    })
  })
