export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PermissionDelegation } from "./permission/delegation.js"
import { PluginHooks } from "./plugin/hooks.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Reason, Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  alternates: Permission.Request.fields.alternates,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: Agent.ID.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Permission.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "Permission.AskResult" })
export type AskResult = typeof AskResult.Type

export { Event } from "@opencode/schema/permission"

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    deciding(action, resource, ...rulesets) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

// The rule that decides ACTION on RESOURCE, the last one matching; none when no rule matches, and asking is the
// default.
export function deciding(action: string, resource: string, ...rulesets: Permission.Ruleset[]) {
  return rulesets
    .flat()
    .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource))
}

// The spellings of the resource at INDEX of a request: the resource, then its alternates.
export function spellings(input: Pick<Request, "resources" | "alternates">, index: number) {
  return [input.resources[index], ...(input.alternates?.[index] ?? [])]
}

// The rule that decides ACTION on a resource written as SPELLINGS: the latest rule in the merged order that matches
// any of them, with the spelling it matched; none when no rule matches any, and asking is the default.
export function decidingAny(action: string, spellings: readonly string[], ...rulesets: Permission.Ruleset[]) {
  const rules = rulesets.flat()
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]
    if (!Wildcard.match(action, rule.action)) continue
    const spelling = spellings.find((item) => Wildcard.match(item, rule.resource))
    if (spelling !== undefined) return { rule, spelling }
  }
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export type Ceiling = PermissionDelegation.Ceiling

const strictness = { allow: 0, ask: 1, deny: 2 } as const satisfies Record<Permission.Effect, number>

/**
 * The decision under `rules` (an agent's merged with its Session's) and the Session's delegation ceilings, with `extra`
 * following each: deny when any of them denies, else ask when any asks.
 */
export function decide(
  action: string,
  resource: string,
  rules: Permission.Ruleset,
  ceilings: ReadonlyArray<Ceiling>,
  ...extra: Permission.Ruleset[]
): Permission.Effect {
  return ceilings.reduce<Permission.Effect>((effect, ceiling) => {
    const bound = evaluate(action, resource, ceiling.rules, ...extra).effect
    return strictness[bound] > strictness[effect] ? bound : effect
  }, evaluate(action, resource, rules, ...extra).effect)
}

const delegatedDenial = (action: string, ceiling: Ceiling) =>
  `Permission denied: ${action}. The ${ceiling.delegator.agent} agent that delegated this task does not permit it.`

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  /**
   * Ceilings the Session's delegators, and its ancestors', impose on every agent acting in it, from the delegating
   * agents' and Sessions' current rules.
   */
  readonly ceilings: (session: SessionSchema.Info) => Effect.Effect<ReadonlyArray<Ceiling>>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const pending = new Map<ID, Pending>()
    let closed = false

    const close = Effect.gen(function* () {
      closed = true
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        bus
          .publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError()))),
      )
      pending.clear()
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const ceilings = Effect.fn("Permission.ceilings")(function* (session: SessionSchema.Info) {
      // Descendants answer to every delegator recorded up their ancestry, including ones added after they started.
      const lineage = new Map<SessionSchema.ID, SessionSchema.Info>()
      const delegators: SessionSchema.Delegator[] = []
      let current: SessionSchema.Info | undefined = session
      while (current !== undefined && !lineage.has(current.id)) {
        lineage.set(current.id, current)
        delegators.push(...(current.delegators ?? []))
        current = current.parentID === undefined ? undefined : yield* sessions.get(current.parentID)
      }
      return yield* Effect.forEach(PermissionDelegation.distinct(delegators), (delegator) =>
        Effect.gen(function* () {
          return PermissionDelegation.ceiling({
            delegator,
            session: lineage.get(delegator.sessionID) ?? (yield* sessions.get(delegator.sessionID)),
            agent: delegator.agent === PermissionDelegation.plan ? yield* agents.get(delegator.agent) : undefined,
          })
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return {
        rules: merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? []),
        ceilings: yield* ceilings(session),
      }
    })

    // A resource is denied when the configured rule deciding any of its spellings denies it.
    function denied(input: Pick<Request, "action" | "resources" | "alternates">, rules: Permission.Ruleset) {
      return input.resources.some((_, index) =>
        spellings(input, index).some((spelling) => evaluate(input.action, spelling, rules).effect === "deny"),
      )
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const { rules, ceilings } = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules, reasons: [] }
      const ceiling = ceilings.find((item) => denied(input, item.rules))
      if (ceiling)
        return {
          effect: "deny" as const,
          rules: ceiling.rules,
          message: delegatedDenial(input.action, ceiling),
          reasons: [],
        }
      const saved = yield* savedRules()
      const all = [...rules, ...saved]
      // Saved approvals answer a delegator's ask as they answer the delegator's own; no deny remains to override. A
      // resource asks when, under its own rules or any ceiling, the rule deciding it across its spellings asks or no
      // rule does; the first ruleset that asks gives the reason.
      const rulesets = [all, ...ceilings.map((item) => [...item.rules, ...saved])]
      const reasons = input.resources.flatMap((resource, index): Permission.Reason[] => {
        for (const ruleset of rulesets) {
          const decided = decidingAny(input.action, spellings(input, index), ruleset)
          if (!decided) return [{ resource }]
          if (decided.rule.effect !== "ask") continue
          return [
            { resource, ...(decided.spelling !== resource ? { spelling: decided.spelling } : {}), rule: decided.rule },
          ]
        }
        return []
      })
      const effect: Permission.Effect = reasons.length > 0 ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        ...(input.alternates ? { alternates: input.alternates } : {}),
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      return { effect: event.effect, message: event.message, rules: all, reasons }
    })

    function request(input: AssertInput, result: { message?: string; reasons: Permission.Reason[] }): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        ...(input.alternates ? { alternates: input.alternates } : {}),
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        metadata:
          input.metadata &&
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        source: input.source,
        message: result.message,
        // None when the rules allow every resource and a plugin asks.
        ...(result.reasons.length > 0 ? { reasons: result.reasons } : {}),
      }
    }

    const create = (request: Request, agent?: Agent.ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            const item = yield* create(request(input, result), input.agent)
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* Deferred.fail(
                item.deferred,
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (!result) continue
            if (result.effect !== "allow") {
              // The approval may answer some of what the request asks for; it lists only what is left.
              const { reasons: _, ...rest } = item.request
              if (result.effect === "ask")
                item.request = result.reasons.length ? { ...rest, reasons: result.reasons } : rest
              continue
            }
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, ceilings, get, forSession, list, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Agent.node, SessionStore.node, PermissionSaved.node, PluginHooks.node],
})
