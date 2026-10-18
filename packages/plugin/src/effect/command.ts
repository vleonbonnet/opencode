import type { CommandApi } from "@opencode/client/effect/api"
import type { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { PromptMetadata } from "@opencode/schema/session-cache"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
  /** Client metadata for the prompt the command sends, such as `thinkingLoss`; forward it to that prompt. */
  readonly metadata?: PromptMetadata
}

/** Where a command sends its prompt, when that is known before it runs. Preflights predict the turn from it. */
export interface CommandTarget {
  /** The agent the command switches the session to. */
  readonly agent?: string
  /** The model the command switches the session to. */
  readonly model?: Model.Ref
  /** The command prompts a new subagent session instead of this one. */
  readonly subagent?: boolean
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly target?: CommandTarget
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Effect.Effect<void>
}
