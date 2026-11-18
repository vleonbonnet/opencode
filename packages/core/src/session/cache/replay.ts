export * as CacheReplay from "./replay.js"

// Thinking a provider no longer accepts stays out of every later request. Dropped with consent, it was converted
// before the request that dropped it, so that request and every later one carry the same text; dropped by the
// provider, the thinking produced since is bound to a prompt without it. Anthropic refuses requests that replay
// reasoning text (`reasoning_extraction`), so Claude turns leave consented blocks out, while other models read them
// as `<earlier-reasoning>` text.
//
// The conversion runs on the stored messages before they become a request, so the request builder stays upstream's.

import type { Model } from "../../model.js"
import type { SessionMessage } from "../message.js"
import { CacheModel } from "./model.js"

/**
 * Reasoning replayed as plain text when its signed form cannot be: its signature no longer matches the conversation
 * and the user consented to drop it. The tag keeps the model from reading it as something it told the user.
 */
export const earlierReasoning = (text: string) => `<earlier-reasoning>\n${text}\n</earlier-reasoning>`

/** A reasoning block later requests leave out, named by its assistant message and reasoning ordinal. */
export interface DroppedReasoning {
  readonly messageID: string
  readonly ordinal: number
  /** Replay its text as `<earlier-reasoning>`; otherwise omit it. */
  readonly asText: boolean
  readonly reason?: string
}

const key = (messageID: string, ordinal: number) => `${messageID}#${ordinal}`

/** MESSAGES with each dropped reasoning block left out, or replayed as text where MODEL may read it. */
export const apply = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Model.Ref,
  dropped: ReadonlyArray<DroppedReasoning> | undefined,
): ReadonlyArray<SessionMessage.Info> => {
  if (dropped === undefined || dropped.length === 0) return messages
  const markers = new Map(dropped.map((block) => [key(block.messageID, block.ordinal), block]))
  return messages.map((message) => (message.type === "assistant" ? assistant(message, model, markers) : message))
}

const assistant = (
  message: SessionMessage.Assistant,
  model: Model.Ref,
  markers: ReadonlyMap<string, DroppedReasoning>,
): SessionMessage.Assistant => {
  // A dropped block is named by its ordinal among the message's reasoning, whatever a cut stream leaves out.
  let ordinal = 0
  const marks = message.content.map((item) =>
    item.type === "reasoning" ? markers.get(key(message.id, ordinal++)) : undefined,
  )
  if (!marks.some((mark) => mark !== undefined)) return message
  const cut = message.error !== undefined || message.finish === undefined
  const content = message.content.flatMap((item, index): Array<SessionMessage.AssistantContent> => {
    const mark = marks[index]
    if (mark !== undefined && item.type === "reasoning") {
      const replayAsText =
        !CacheModel.isClaudeModel(model.id) && (mark.asText || Boolean(mark.reason?.startsWith("dropped with consent")))
      return replayAsText && item.text.trim().length > 0 ? [{ type: "text", text: earlierReasoning(item.text) }] : []
    }
    // In a cut stream the request builder replays reasoning only once the model moved on to output. A dropped block's
    // text is no such output, so reasoning that only it follows is left out here, as the builder leaves it out.
    if (cut && item.type === "reasoning" && !movedOn(message, index)) return []
    return [item]
  })
  return { ...message, content }
}

// Mirrors the request builder (`assistant` in runner/to-llm-message.ts): a failed stream keeps what came before its
// last local call that ran, and a cut one keeps the calls that ran and those whose input failed to decode.
const ranTool = (item: SessionMessage.AssistantContent) =>
  item.type === "tool" && (item.time.ran !== undefined || item.state.status === "completed")

const movedOn = (message: SessionMessage.Assistant, index: number) => {
  const end =
    message.error === undefined || message.error.type === "aborted"
      ? message.content.length
      : message.content.findLastIndex((item) => item.type === "tool" && item.executed !== true && ranTool(item)) + 1
  return message.content
    .slice(index + 1, end)
    .some(
      (after) =>
        (after.type === "text" && after.text.trim() !== "") ||
        (after.type === "tool" &&
          (ranTool(after) || (after.state.status === "error" && after.state.error.type.startsWith("tool.input")))),
    )
}
