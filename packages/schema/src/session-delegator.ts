export * as SessionDelegator from "./session-delegator.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { SessionID } from "./session-id.js"

/** A Session, and the agent acting in it, that launched or continued a child Session through the subagent tool. */
export const Info = Schema.Struct({
  sessionID: SessionID,
  agent: Agent.ID,
}).annotate({ identifier: "Session.Delegator" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
