export * as Permission from "./permission.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartingWith("per")).pipe(
  Schema.brand("Permission.ID"),
  Schema.annotate({ identifier: "Permission.ID" }),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    id: Schema.String,
  }),
]).annotate({ identifier: "Permission.Source" })
export type Source = typeof Source.Type

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "Permission.Effect" })
export type Effect = typeof Effect.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
}).annotate({ identifier: "Permission.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "Permission.Ruleset" })
export type Ruleset = typeof Ruleset.Type

// Why a request asks for a resource: the rule that asks for it, absent when no rule matches it and asking is the
// default, and the spelling of the resource that rule matched, absent when it is the resource itself.
export interface Reason extends Schema.Schema.Type<typeof Reason> {}
export const Reason = Schema.Struct({
  resource: Schema.String,
  spelling: Schema.String.pipe(optional),
  rule: Rule.pipe(optional),
}).annotate({ identifier: "Permission.Reason" })

const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  // For each resource, by its index, the other spellings of the same thing, which the rules are checked against
  // together with it: a shell command unquoted and decoded, or with its option clusters split. A rule that denies any
  // spelling denies the resource; otherwise the latest rule matching any spelling decides it. Absent, or shorter than
  // `resources`, when a resource has no other spelling.
  alternates: Schema.Array(Schema.Array(Schema.String)).pipe(optional),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
  message: Schema.String.pipe(optional),
  // The resources the rules ask approval for, in order, each with the rule that asks for it; absent when the rules
  // allow every resource and a plugin asks.
  reasons: Schema.Array(Reason).pipe(optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "Permission.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "Permission.Reply" })
export type Reply = typeof Reply.Type

const Asked = ephemeral({ type: "permission.asked", schema: Request.fields })
const Replied = ephemeral({
  type: "permission.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    reply: Reply,
  },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }
