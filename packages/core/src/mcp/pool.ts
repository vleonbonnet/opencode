export * as McpPool from "./pool.js"

import type { AuthProvider } from "@modelcontextprotocol/client"
import type { Mcp } from "@opencode/schema/mcp"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpFetch } from "@opencode/util/effect/app-node-platform"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Scope, Semaphore } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Environment } from "../environment/index.js"
import { SharedCache } from "../shared-cache.js"
import type { McpClient } from "./client.js"
import { McpConnection } from "./connection.js"

import { McpRetry } from "./retry.js"

export interface Input extends McpConnection.Input {
  /**
   * Run once per start: what tells this connection apart from every other one to the same server (see `key`),
   * and the OAuth provider to open it with. Both come from one credential selection, so a slot's key and the
   * account it connects as can't disagree.
   */
  readonly select: Effect.Effect<Selection>
}

export interface Selection {
  readonly key: string
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
}

export interface Interface {
  /**
   * A Location's connection to a server that may be shared. Each start joins the connection other
   * Locations hold under the same key, or opens it, and each stop lets go of it; the last to let go
   * closes it. A server that negotiates the legacy protocol, or that answers but refuses or breaks the
   * pooled handshake, is never shared: the Location connects on its own, exactly as it would unpooled,
   * and every later start for that key skips straight to that.
   *
   * A refusal counts only when a connection like a Location's own gets through where the shared one did not.
   * Otherwise, and for any other failure or a close, the connection stays shared: it retries on McpRetry's delays
   * for every holder at once, and a start that finds it failed tries again right away.
   */
  readonly connection: (input: Input) => McpConnection.Connection
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpPool") {}

/**
 * Everything that could make two connections behave differently, so only identical ones are shared.
 * The server's name is left out; each Location keeps its own. Secrets appear only as fingerprints.
 */
export const key = (input: {
  readonly config: Mcp.ServerConfig
  /** Local only: the directory the server runs in, as `McpStdio.resolveCwd` resolves it for the spawn. */
  readonly cwd?: string
  /** The active OAuth credential's ID, which a token refresh keeps and a sign-in replaces. */
  readonly credential?: string
  readonly clientInfo?: { readonly name: string; readonly version: string }
}) => {
  const config = input.config
  const common = [config.protocol, config.timeout ?? null, input.clientInfo ?? null]
  if (config.type === "remote")
    return JSON.stringify([
      "remote",
      config.url,
      fingerprint(config.headers),
      config.oauth ? { ...config.oauth, client_secret: fingerprint(config.oauth.client_secret) } : config.oauth,
      // A remote server's URL gains ?codemode=false unless Code Mode is off.
      config.codemode !== false,
      input.credential ?? null,
      ...common,
    ])
  // Only Locations on this host share local servers, so the execution plane is always the host.
  return JSON.stringify([
    "local",
    "host",
    config.command,
    input.cwd ?? null,
    fingerprint(config.environment),
    ...common,
  ])
}

function fingerprint(secret: string | Record<string, string> | undefined) {
  if (secret === undefined) return null
  return SharedCache.fingerprint(
    typeof secret === "string"
      ? secret
      : JSON.stringify(Object.entries(secret).toSorted(([a], [b]) => a.localeCompare(b))),
  )
}

// A Location holding a shared connection. The pool reaches Locations only through the holders
// registered right now, never through the one that opened the connection.
interface Holder {
  readonly authProvider: Effect.Effect<AuthProvider | undefined>
  readonly elicitation: McpClient.ElicitationHandler["create"]
  readonly changed: (kind: McpConnection.Kind) => void
  // Fork: how the slot's later attempts went, told to a holder once it has seen how the one it joined went.
  readonly connected: (connection: McpConnection.Connection) => void
  readonly failed: (failed: Failed) => void
  /** The server turned out not to be shareable, so the holder connects on its own. */
  readonly unshared: () => void
  observing: boolean
}

// Fork: a failure of the shared connection, which it retries for all its holders when `retryable`.
interface Failed {
  readonly failure: McpConnection.Failure
  readonly retryable: boolean
}

// What the slot keeps of the Location that opened it.
type Opening = Pick<Input, "name" | "config" | "directory" | "clientInfo">

interface Slot {
  readonly connection: McpConnection.Connection
  readonly holders: Set<Holder>
  readonly lock: Semaphore.Semaphore
  readonly input: Opening
  readonly retry: McpRetry.Retrier
  // The attempt in flight, settled when it ends however it ends.
  attempt?: Deferred.Deferred<void>
  start?: Fiber.Fiber<void>
  connected: boolean
  // Why the last attempt failed, until one connects.
  failed?: Failed
  // The server can't be shared after all; its holders connect on their own.
  unshared: boolean
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const run = yield* FiberSet.makeRuntime<never, void, never>()
    const host = Environment.local(yield* ChildProcessSpawner)
    const fetch = yield* FetchHttpClient.Fetch
    const slots = new Map<string, Slot>()
    // Keys whose server negotiated legacy or refused the pooled handshake. Kept for the life of the process.
    const unpoolable = new Set<string>()
    // The subset that negotiated legacy. Their private connections skip the 2026-07-28 probe; a refusal
    // proves nothing about the protocol, so those keep the configured one.
    const legacy = new Set<string>()
    // Names of local servers already warned about for having no cwd, which keeps each project's folder in the key.
    const unfixed = new Set<string>()

    // Takes only data from the Location that opens it: the connection outlives that Location's claim.
    const open = (key: string, input: Pick<Input, "name" | "config" | "directory" | "clientInfo">) => {
      const slot: Slot = {
        holders: new Set(),
        lock: Semaphore.makeUnsafe(1),
        input,
        retry: McpRetry.make({ server: input.name, scope, attempt: Effect.suspend(() => begin(key, slot)) }),
        connected: false,
        unshared: false,
        connection: McpConnection.make({
          name: input.name,
          config: input.config,
          directory: input.directory,
          shared: true,
          clientInfo: input.clientInfo,
          // Every holder of a key presents the same credential, so any of them can build the provider.
          authProvider: Effect.suspend(() => slot.holders.values().next().value?.authProvider ?? Effect.undefined),
          elicitation: {
            // Elicitations a request carries reach that request's Location. Any other one, which the
            // server could not tie to a request, goes to every holder and the first answer wins; the
            // others are interrupted, which cancels their forms.
            create: (request) =>
              Effect.suspend(() => {
                const holders = Array.from(slot.holders)
                if (holders.length === 0) return Effect.succeed({ action: "cancel" as const })
                return Effect.raceAll(holders.map((holder) => holder.elicitation(request)))
              }),
            complete: () => Effect.void,
          },
          environment: host,
          fetch,
          scope,
          lock: (effect) => slot.lock.withPermit(effect),
          callbacks: run,
          fork: run,
          events: {
            connecting: Effect.void,
            connected: Effect.suspend(() => {
              slot.connected = true
              slot.failed = undefined
              notify(slot, (holder) => holder.connected(slot.connection))
              return slot.retry.connected
            }),
            failed: (failure, answered, retryable) => fail(key, slot, { failure, retryable }, answered),
            legacy: (version) =>
              Effect.gen(function* () {
                detach(key, slot)
                unpoolable.add(key)
                legacy.add(key)
                yield* Effect.logWarning("mcp pool ignored: server speaks an older protocol", {
                  server: input.name,
                  version,
                })
                unshare(slot)
              }),
            settled: Effect.void,
            // Stopped while it still counts as connected, so every holder hears its catalogs emptied.
            closed: (reason) =>
              Effect.gen(function* () {
                yield* slot.connection.stop
                slot.connected = false
                const failed: Failed = { failure: { status: "failed", error: reason }, retryable: true }
                slot.failed = failed
                notify(slot, (holder) => holder.failed(failed))
                yield* slot.retry.closed(reason)
              }),
            changed: (kind) =>
              Effect.sync(() => {
                if (slot.connected) for (const holder of slot.holders) holder.changed(kind)
              }),
          },
        }),
      }
      slots.set(key, slot)
      return slot
    }

    // The attempt's events record how it went on the slot and tell the holders.
    const connect = (key: string, slot: Slot) =>
      slot.connection.start.pipe(
        slot.lock.withPermit,
        // An attempt that dies still fails every holder; one interrupted has no holder left to tell.
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : fail(key, slot, { failure: { status: "failed", error: String(Cause.squash(cause)) }, retryable: true }),
        ),
      )

    // Marks an attempt in flight at once, so a start meanwhile waits for it rather than begin another.
    const begin = (key: string, slot: Slot) => {
      const settled = Deferred.makeUnsafe<void>()
      slot.attempt = settled
      return connect(key, slot).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (slot.attempt === settled) slot.attempt = undefined
            return Deferred.succeed(settled, undefined)
          }),
        ),
      )
    }

    // A server that answered but refused the pooled handshake, such as one that wants roots, may still accept the
    // Location's own connection. Only a connection like that getting through shows the refusal is about sharing.
    // Otherwise the server failed for everyone, as one that is unreachable does, and the slot retries for them all.
    const fail = (key: string, slot: Slot, failed: Failed, answered = false) =>
      Effect.gen(function* () {
        if (answered && (yield* acceptsOwn(slot))) {
          detach(key, slot)
          unpoolable.add(key)
          yield* Effect.logWarning("mcp pool ignored: server refused the shared connection", {
            server: slot.input.name,
            error: failed.failure.error,
          })
          return unshare(slot)
        }
        slot.failed = failed
        notify(slot, (holder) => holder.failed(failed))
        yield* slot.retry.failed(failed.failure.error, failed.retryable)
      })

    // Connects once the way a Location's own connection would, declaring roots, and lets go again.
    const acceptsOwn = (slot: Slot) =>
      Effect.suspend(() => {
        const own = McpConnection.make({
          name: slot.input.name,
          config: slot.input.config,
          directory: slot.input.directory,
          clientInfo: slot.input.clientInfo,
          authProvider: Effect.suspend(() => slot.holders.values().next().value?.authProvider ?? Effect.undefined),
          // No one asked for this connection, so no one is asked for input on it.
          elicitation: { create: () => Effect.succeed({ action: "cancel" as const }), complete: () => Effect.void },
          environment: host,
          fetch,
          scope,
          lock: Semaphore.makeUnsafe(1).withPermit,
          callbacks: run,
          fork: run,
          events: {
            connecting: Effect.void,
            connected: Effect.void,
            failed: () => Effect.void,
            settled: Effect.void,
            closed: () => Effect.void,
            changed: () => Effect.void,
          },
        })
        // Stopped however the attempt ends: an interrupted one would otherwise leave its process running.
        return own.start.pipe(
          Effect.map(() => own.client !== undefined),
          Effect.ensuring(own.stop),
        )
      })

    // Tells the holders that have seen how their own attempt went.
    const notify = (slot: Slot, tell: (holder: Holder) => void) => {
      for (const holder of slot.holders) if (holder.observing) tell(holder)
    }

    const unshare = (slot: Slot) => {
      slot.unshared = true
      notify(slot, (holder) => holder.unshared())
    }

    const detach = (key: string, slot: Slot) => {
      if (slots.get(key) === slot) slots.delete(key)
    }

    // Closes as soon as the last holder lets go, interrupting a start nobody waits for anymore.
    const release = (key: string, slot: Slot, holder: Holder) =>
      Effect.suspend(() => {
        slot.holders.delete(holder)
        if (slot.holders.size > 0) return Effect.void
        detach(key, slot)
        return Effect.gen(function* () {
          yield* slot.retry.reset
          if (slot.start) yield* Fiber.interrupt(slot.start)
          yield* slot.connection.stop.pipe(slot.lock.withPermit)
        })
      })

    const acquire = Effect.fnUntraced(function* (key: string, input: Input, holder: Holder) {
      if (unpoolable.has(key)) return "private" as const
      const slot =
        slots.get(key) ??
        open(key, {
          name: input.name,
          config: input.config,
          directory: input.directory,
          clientInfo: input.clientInfo,
        })
      yield* Effect.acquireRelease(
        Effect.sync(() => slot.holders.add(holder)),
        () => release(key, slot, holder),
      )
      // Started once a holder is registered: the attempt reads its OAuth provider from the holders. A start that
      // finds the shared connection failed tries again now, instead of waiting for its retry.
      if (!slot.connected && !slot.attempt) {
        slot.start = run(begin(key, slot))
        yield* slot.retry.reset
      }
      if (slot.attempt) yield* Deferred.await(slot.attempt)
      holder.observing = true
      if (slot.unshared) return "private" as const
      if (slot.connected) return slot.connection
      const stopped: Failed = {
        failure: { status: "failed", error: "The shared connection stopped" },
        retryable: false,
      }
      return slot.failed ?? stopped
    })

    const connection = (input: Input): McpConnection.Connection => {
      const state: {
        claim?: Scope.Closeable
        holder?: Holder
        shared?: McpConnection.Connection
        own?: McpConnection.Connection
        // This start's credential selection, which a private connection opens with as well.
        selected?: Selection
      } = {}
      // A private connection, used when the key can't be shared, with the configured protocol or plain legacy.
      const privately = (config: Mcp.ServerConfig) =>
        McpConnection.make({
          ...input,
          config,
          authProvider: Effect.suspend(() => state.selected?.authProvider ?? input.authProvider),
        })
      const configured = privately(input.config)
      const older = privately({ ...input.config, protocol: "legacy" })
      const live = () => state.shared ?? state.own ?? configured
      const alone = (key: string) =>
        Effect.suspend(() => {
          state.own = legacy.has(key) ? older : configured
          return state.own.start
        })
      // The shared connection carries the name of the Location that opened it; forms show this Location's.
      const elicit: McpClient.ElicitationHandler["create"] = (request) =>
        input.elicitation.create({ ...request, server: input.name })

      // Holder callbacks run in the Location's own callback runtime, under its lock, and only while the
      // claim they belong to is the current one.
      const current = (holder: Holder, effect: () => Effect.Effect<void>) =>
        input.callbacks(
          Effect.suspend(() => (state.holder === holder ? effect() : Effect.void)).pipe(input.lock, Effect.ignore),
        )

      const clear = Effect.suspend(() => {
        const claim = state.claim
        state.claim = undefined
        state.holder = undefined
        state.shared = undefined
        return claim ? Scope.close(claim, Exit.void) : Effect.void
      })

      // Resolves false when the key can't be shared, leaving the start to the Location's own connection.
      const join = (selected: Selection) =>
        Effect.gen(function* () {
          yield* input.events.connecting
          const claim = yield* Scope.fork(input.scope)
          const holder: Holder = {
            authProvider: selected.authProvider,
            elicitation: elicit,
            changed: (kind) => current(holder, () => input.events.changed(kind)),
            connected: (connection) =>
              current(holder, () =>
                Effect.suspend(() => {
                  state.shared = connection
                  return input.events.connected
                }),
              ),
            failed: (failed) =>
              current(holder, () =>
                Effect.suspend(() => {
                  state.shared = undefined
                  return input.events.failed(failed.failure, false, failed.retryable)
                }),
              ),
            unshared: () => current(holder, () => clear.pipe(Effect.andThen(alone(selected.key)))),
            observing: false,
          }
          state.claim = claim
          state.holder = holder
          const outcome = yield* acquire(selected.key, input, holder).pipe(
            Scope.provide(claim),
            Effect.onInterrupt(() => clear),
          )
          if (outcome === "private") {
            yield* clear
            return false
          }
          // The claim stays: the shared connection retries for every holder and tells each how it went.
          if ("failure" in outcome) {
            yield* input.events.failed(outcome.failure, false, outcome.retryable)
            return true
          }
          state.shared = outcome
          yield* input.events.connected
          return true
        }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) && !exit.value ? Effect.void : input.events.settled)))

      // Requests through a shared connection bring this Location's elicitation handler along.
      const bind = (client: McpClient.Connection): McpClient.Connection => ({
        ...client,
        callTool: (request) => client.callTool({ elicitation: elicit, ...request }),
        prompt: (request) => client.prompt({ elicitation: elicit, ...request }),
        readResource: (request) => client.readResource({ elicitation: elicit, ...request }),
      })

      return {
        get client() {
          return live().client
        },
        get tools() {
          return live().tools
        },
        get prompts() {
          return live().prompts
        },
        start: Effect.gen(function* () {
          if (input.config.type === "local" && input.config.cwd === undefined && !unfixed.has(input.name)) {
            unfixed.add(input.name)
            yield* Effect.logWarning(
              "mcp pool ignored: local server has no fixed cwd, so each directory runs its own",
              {
                server: input.name,
              },
            )
          }
          const selected = yield* input.select
          state.selected = selected
          if (!unpoolable.has(selected.key) && (yield* join(selected))) return
          yield* alone(selected.key)
        }),
        stop: Effect.gen(function* () {
          if (!state.claim) return yield* (state.own ?? configured).stop
          yield* clear
          yield* input.events.changed("tools")
          yield* input.events.changed("resources")
          yield* input.events.changed("prompts")
        }),
        recovering: (client, request) =>
          state.shared
            ? state.shared.recovering(client, (client) => request(bind(client)))
            : (state.own ?? configured).recovering(client, request),
        catalog: (client) => live().catalog(client),
      }
    }

    return Service.of({ connection })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [CrossSpawnSpawner.node, httpFetch] })
