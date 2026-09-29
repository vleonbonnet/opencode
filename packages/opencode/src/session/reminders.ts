import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  /** Store synthetic reminder parts. Preflight dry runs pass false. */
  persist?: boolean
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages
  const store = (part: SessionV1.TextPart) =>
    input.persist === false ? Effect.succeed(part) : sessions.updatePart(part)

  if (!flags.experimentalPlanMode) {
    // Reminders are stored on the user message they were first sent with.
    // Adding them in memory to whichever user message is newest rewrote the
    // previous user message on every turn: that breaks the provider prompt
    // cache from that message on, and invalidates thinking signatures bound
    // to the old prefix.
    const has = (text: string) =>
      userMessage.parts.some((part) => part.type === "text" && part.synthetic === true && part.text === text)
    const remind = (text: string) =>
      store({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text,
        synthetic: true,
      }).pipe(Effect.map((part) => userMessage.parts.push(part)))
    if (input.agent.name === "plan" && !has(PROMPT_PLAN)) yield* remind(PROMPT_PLAN)
    // Announce the switch once, on the first build turn after a plan turn.
    const previous = input.messages
      .slice(0, input.messages.indexOf(userMessage))
      .findLast((msg) => msg.info.role === "assistant")
    if (input.agent.name === "build" && previous?.info.agent === "plan" && !has(BUILD_SWITCH))
      yield* remind(BUILD_SWITCH)
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* store({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists && input.persist !== false) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* store({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
