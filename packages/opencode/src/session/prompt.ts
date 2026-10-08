import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { and, eq, isNull, sql } from "drizzle-orm"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { QuestionOwner } from "@/question/owner"
import { answerResult } from "@/tool/question"
import { isRecord } from "@/util/record"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { SystemBaseline } from "./system-baseline"
import { Wire } from "./cache/wire"
import { CacheLedger } from "./cache/ledger"
import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  /**
   * Predict how much of the provider's prompt cache the next turn reuses, by
   * dry-running the exact request that turn would send. Nothing is stored.
   */
  readonly preflight: (input: PreflightInput) => Effect.Effect<PreflightResult>
  /**
   * Re-ask questions orphaned by a previous server process and resume their
   * turns once answered.  Runs once per instance, before it serves requests.
   */
  readonly recover: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const question = yield* Question.Service
    const { db } = database
    // Sessions being cancelled by the user, as opposed to torn down with the instance.
    const cancelling = new Set<SessionID>()
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const applyReminders = (input: {
      messages: SessionV1.WithParts[]
      agent: Agent.Info
      session: Session.Info
      persist: boolean
    }) =>
      SessionReminders.apply(input).pipe(
        Effect.provideService(RuntimeFlags.Service, flags),
        Effect.provideService(FSUtil.Service, fsys),
        Effect.provideService(Session.Service, sessions),
      )

    // The frozen system prompt sections of the session and the history as the
    // model sees it, delivering changed sections at a turn boundary.
    const applySystemBaseline = Effect.fn("SessionPrompt.applySystemBaseline")(function* (input: {
      session: Session.Info
      messages: SessionV1.WithParts[]
      user: SessionV1.User
      agent: Agent.Info
      model: Provider.Model
      persist: boolean
    }) {
      const exposure = yield* agents.exposure(input.agent)
      return yield* SystemBaseline.prepare({
        db,
        sessionID: input.session.id,
        messages: input.messages,
        user: input.user,
        observe: Effect.all({
          environment: sys.environment(input.model),
          instructions: instruction.entries().pipe(Effect.orDie),
          mcp: sys
            .mcp(input.agent, input.session.permission, exposure)
            .pipe(Effect.map((text) => (text ? [text] : []))),
          skills: sys.skills(input.agent, exposure).pipe(Effect.map((text) => (text ? [text] : []))),
        }),
        store: (part) => sessions.updatePart(part),
        persist: input.persist,
      })
    })

    // Builds the LLM request for one loop step from the (reminder-applied)
    // history. The loop and preflight both use it, so a preflight dry run is
    // the exact request the next turn sends.
    const turnRequest = Effect.fn("SessionPrompt.turnRequest")(function* (input: {
      session: Session.Info
      msgs: SessionV1.WithParts[]
      lastUser: SessionV1.User
      agent: Agent.Info
      model: Provider.Model
      step: number
      processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
      /** The session's frozen system prompt sections (applySystemBaseline). */
      system: string[]
      onStructured: (output: unknown) => void
      /** The user accepted losing stale thinking on this request. */
      acceptThinkingLoss?: boolean
    }) {
      const { session, msgs, lastUser, agent, model } = input
      const isLastStep = input.step >= (agent.steps ?? Infinity)
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
      const promptOps = yield* ops()
      const exposure = yield* agents.exposure(agent)

      const tools = yield* SessionTools.resolve({
        agent,
        session,
        model,
        processor: input.processor,
        bypassAgentCheck,
        messages: msgs,
        promptOps,
        exposure,
      }).pipe(
        Effect.provideService(Plugin.Service, plugin),
        Effect.provideService(Permission.Service, permission),
        Effect.provideService(ToolRegistry.Service, registry),
        Effect.provideService(MCP.Service, mcp),
        Effect.provideService(Truncate.Service, truncate),
        Effect.provideService(RuntimeFlags.Service, flags),
      )

      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess: input.onStructured,
        })
      }

      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      const modelMsgs = yield* MessageV2.toModelMessagesEffect(msgs, model)
      const system = [...input.system]
      const format = lastUser.format ?? { type: "text" as const }
      if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      return {
        user: lastUser,
        agent,
        permission: session.permission,
        exposure,
        sessionID: session.id,
        parentSessionID: session.parentID,
        system,
        messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : [])],
        tools,
        model,
        toolChoice: format.type === "json_schema" ? ("required" as const) : undefined,
        ...(input.acceptThinkingLoss ? { acceptThinkingLoss: true } : {}),
      } satisfies LLM.StreamInput
    })

    // On the request the user consented to lose stale thinking on, mark the
    // blocks it would drop (CacheLedger.consentedThinking) before building it,
    // so that request already replays them as text, like every later one: the
    // provider caches one prompt, and the thinking it produces is bound to it.
    // drop_block still covers blocks the dry run could not foresee.
    const keepStaleThinkingAsText = Effect.fn("SessionPrompt.keepStaleThinkingAsText")(function* (
      input: Parameters<typeof turnRequest>[0],
    ) {
      // The dry run gets its own copy: plugins may transform messages in place.
      const request = yield* turnRequest({ ...input, msgs: structuredClone(input.msgs), onStructured: () => {} })
      const id = Wire.nextID()
      const exit = yield* llm.stream({ ...request, wire: { mode: "dryrun", id } }).pipe(Stream.runDrain, Effect.exit)
      const captured = Wire.take(id)
      if (!captured) {
        yield* Effect.logWarning("stale thinking dry run did not reach the network layer", {
          sessionID: input.session.id,
          cause: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "completed without fetch",
        })
        return input.msgs
      }
      const kept = CacheLedger.consentedThinking(input.session.id, captured)
      if (kept.length === 0) return input.msgs
      const reasons = new Map(kept.map((item) => [item.signature, item.reason]))
      const time = Date.now()
      const marked: string[] = []
      const msgs: SessionV1.WithParts[] = []
      for (const message of input.msgs) {
        const parts: SessionV1.Part[] = []
        for (const part of message.parts) {
          const signature = part.type === "reasoning" ? MessageV2.thinkingSignature(part) : undefined
          const reason = signature ? reasons.get(signature) : undefined
          if (part.type !== "reasoning" || part.metadata?.thinkingDropped || !signature || !reason) {
            parts.push(part)
            continue
          }
          const updated: SessionV1.ReasoningPart = {
            ...part,
            metadata: { ...part.metadata, thinkingDropped: { time, reason, asText: true } },
          }
          yield* sessions.updatePart(updated)
          parts.push(updated)
          marked.push(signature)
        }
        msgs.push({ ...message, parts })
      }
      CacheLedger.forgetThinking(input.session.id, marked)
      yield* Effect.logWarning("stale thinking kept as text", {
        sessionID: input.session.id,
        stale: kept.length,
        marked: marked.length,
      })
      return msgs
    })

    const preflight = Effect.fn("SessionPrompt.preflight")(function* (input: PreflightInput) {
      const sessionID = input.sessionID
      const unknown = (reason: string, extra?: { agent?: string; model?: { providerID: string; modelID: string } }) =>
        ({ ...CacheLedger.unknown(sessionID, reason), ...preflightTarget(extra) }) satisfies PreflightResult
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

      // Resolve the agent and model exactly as prompt() / command() would.
      let target: Pick<PromptInput, "agent" | "model" | "variant"> = {
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      }
      if (input.command) {
        const cmd = yield* commands.get(input.command)
        if (!cmd) return unknown(`command not found: ${input.command}`)
        const commandInput = {
          sessionID,
          agent: input.agent,
          model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
        }
        const agentName = cmd.agent ?? input.agent
        const taskModel = yield* commandTaskModel(cmd, commandInput)
        const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
        if (!agent) return unknown(`agent not found: ${agentName}`)
        const isSubtask = commandIsSubtask(cmd, agent)
        const { userAgent, userModel } = yield* commandUserTarget({ input: commandInput, agent, taskModel, isSubtask })
        target = { agent: userAgent, model: userModel, variant: input.variant }
      }
      const resolved = yield* resolveUserTarget({ sessionID, ...target })
      if (!resolved.ok) return unknown(resolved.error.message)
      const targetInfo = {
        agent: resolved.agent.name,
        model: { providerID: resolved.model.providerID, modelID: resolved.model.modelID },
      }

      // prompt() turns per-message tool toggles into session permissions.
      const toggles = Object.entries(input.tools ?? {}).map(
        ([t, enabled]): PermissionV1.Rule => ({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" }),
      )
      const view: Session.Info = toggles.length ? { ...session, permission: toggles } : session

      // History as the loop will load it, after prompt() applies a pending revert.
      const loaded = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: resolved.agent.name,
        model: { providerID: resolved.model.providerID, modelID: resolved.model.modelID, variant: resolved.variant },
        system: input.system,
        format: input.format,
      }
      // The new message's own content only affects the uncached tail.
      const placeholder: SessionV1.TextPart = {
        id: PartID.ascending(),
        messageID: info.id,
        sessionID,
        type: "text",
        text: "(preflight)",
      }
      let msgs: SessionV1.WithParts[] = [...revertView(loaded, session.revert), { info, parts: [placeholder] }]

      // Decisions the loop takes before its first request of a turn.
      const { finished: lastFinished, tasks } = MessageV2.latest(msgs)
      const modelExit = yield* provider.getModel(resolved.model.providerID, resolved.model.modelID).pipe(Effect.exit)
      if (Exit.isFailure(modelExit)) return unknown(`model not available: ${Cause.pretty(modelExit.cause)}`, targetInfo)
      const model = modelExit.value
      const pendingTask = tasks.at(-1)
      if (pendingTask?.type === "compaction")
        return unknown("a pending compaction runs before the next request", targetInfo)
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
      )
        return unknown("the context overflows the model window; the next turn starts with compaction", targetInfo)

      const agent = resolved.agent
      msgs = yield* applyReminders({ messages: msgs, agent, session: view, persist: false })
      const frozen = yield* applySystemBaseline({
        session: view,
        messages: msgs,
        user: info,
        agent,
        model,
        persist: false,
      })
      msgs = frozen.messages
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        parentID: info.id,
        role: "assistant",
        mode: agent.name,
        agent: agent.name,
        variant: info.model.variant,
        path: { cwd: (yield* InstanceState.context).directory, root: (yield* InstanceState.context).worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerID: model.providerID,
        time: { created: Date.now() },
        sessionID,
      }
      const request = yield* turnRequest({
        session: view,
        msgs,
        lastUser: info,
        agent,
        model,
        step: 1,
        system: frozen.system,
        processor: {
          message: assistant,
          updateToolCall: () => Effect.die(new Error("preflight never executes tools")),
          completeToolCall: () => Effect.die(new Error("preflight never executes tools")),
        },
        onStructured: () => {},
      })
      const id = Wire.nextID()
      const exit = yield* llm.stream({ ...request, wire: { mode: "dryrun", id } }).pipe(Stream.runDrain, Effect.exit)
      const captured = Wire.take(id)
      if (!captured) {
        const why = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the request completed without reaching fetch"
        return unknown(`dry run did not reach the network layer: ${why}`, targetInfo)
      }
      const report = CacheLedger.predict(sessionID, captured)
      const stale = CacheLedger.staleThinking(sessionID, captured)
      return {
        ...report,
        reasons: pendingTask?.type === "subtask" ? [...report.reasons, "a pending subtask runs first"] : report.reasons,
        ...(stale
          ? {
              staleThinking: {
                // What consent converts: the stale blocks and every block after the first.
                count: CacheLedger.consentedThinking(sessionID, captured).length,
                reason: stale.reason,
                ...(stale.path ? { path: stale.path } : {}),
              },
            }
          : {}),
        ...preflightTarget(targetInfo),
      } satisfies PreflightResult
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      cancelling.add(sessionID)
      yield* state.cancel(sessionID).pipe(Effect.ensuring(Effect.sync(() => cancelling.delete(sessionID))))
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    // Agent, model and variant a new user message runs with. Shared by
    // createUserMessage and preflight so a preflight predicts the same turn.
    const resolveUserTarget = Effect.fn("SessionPrompt.resolveUserTarget")(function* (
      input: Pick<PromptInput, "sessionID" | "agent" | "model" | "variant">,
    ) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        return {
          ok: false,
          error: new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` }),
        } as const
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)
      return { ok: true, agent: ag, model, variant } as const
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const target = yield* resolveUserTarget(input)
      if (!target.ok) {
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: target.error.toObject() })
        throw target.error
      }
      const { agent: ag, model, variant } = target

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
        ...(input.acceptThinkingLoss ? { acceptThinkingLoss: true } : {}),
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        // User messages whose thinking-loss consent this run already applied.
        const consentUsed = new Set<string>()
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          msgs = yield* applyReminders({ messages: msgs, agent, session, persist: true })
          const frozen = yield* applySystemBaseline({
            session,
            messages: msgs,
            user: lastUser,
            agent,
            model,
            persist: true,
          })
          msgs = frozen.messages

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const format = lastUser.format ?? { type: "text" as const }
            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            // Consent covers the first request answering that message: the
            // stale blocks are replayed as text from it on, and the provider
            // drops any stale block the ledger could not foresee.
            const consent = lastUser.acceptThinkingLoss === true && !consentUsed.has(lastUser.id)
            if (consent) consentUsed.add(lastUser.id)
            const turn = {
              session,
              msgs,
              lastUser,
              agent,
              model,
              step,
              processor: handle,
              system: frozen.system,
              onStructured(output: unknown) {
                structured = output
              },
              acceptThinkingLoss: consent,
            }
            if (consent) turn.msgs = yield* keepStaleThinkingAsText(turn)
            const result = yield* handle.process(yield* turnRequest(turn))

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const recover = Effect.fn("SessionPrompt.recover")(function* () {
      const ctx = yield* InstanceState.context
      // A question's answer lives in the process that asked it, so a restart
      // leaves the question tool part running in a turn that never finished.
      // Such a turn is the last message of its session: re-ask its questions.
      const rows = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .innerJoin(MessageTable, eq(MessageTable.session_id, SessionTable.id))
        .where(
          and(
            eq(SessionTable.directory, ctx.directory),
            isNull(SessionTable.parent_id),
            isNull(SessionTable.time_archived),
            sql`${MessageTable.id} = (select latest.id from ${MessageTable} latest where latest.session_id = ${SessionTable.id} order by latest.time_created desc, latest.id desc limit 1)`,
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.time.completed') is null`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, (row) => recoverQuestions(row.id), { discard: true })
    })

    const recoverQuestions = Effect.fnUntraced(function* (sessionID: SessionID) {
      const [turn] = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (turn?.info.role !== "assistant") return
      const info = turn.info
      // Other unfinished tools in the turn, and questions whose input never
      // finished streaming, are closed as interrupted once the turn resumes.
      const asked = turn.parts.flatMap((part) => {
        if (part.type !== "tool" || part.tool !== "question" || part.state.status !== "running") return []
        const questions = decodeQuestions(part.state.input.questions)
        return Option.isSome(questions) ? [{ part, state: part.state, questions: questions.value }] : []
      })
      if (asked.length === 0) return
      // Every process opened on this directory bootstraps it, including short
      // CLI commands, so a question still waiting in its asking process must
      // be left alone: re-asking it here would take over its answer.
      const orphaned = yield* Effect.forEach(asked, (item) =>
        QuestionOwner.orphaned(QuestionOwner.fromMetadata(item.state.metadata)),
      )
      if (orphaned.some((value) => !value)) {
        yield* Effect.logInfo("questions still pending in their asking process", { "session.id": sessionID })
        return
      }
      const busy = yield* state.assertNotBusy(sessionID).pipe(
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      )
      if (busy) return

      // Claim the questions, so that other processes leave them to this one.
      const claimed = yield* Effect.forEach(
        asked,
        Effect.fnUntraced(function* (item) {
          const metadata: Record<string, unknown> = { ...item.state.metadata, owner: QuestionOwner.current }
          const state = { ...item.state, metadata }
          const part = yield* sessions.updatePart({ ...item.part, state })
          return { ...item, part, state }
        }),
      )
      const pending = yield* Effect.forEach(claimed, (item) =>
        question
          .register({
            id: requestID(item.state.metadata?.requestID),
            sessionID,
            questions: item.questions,
            tool: { messageID: info.id, callID: item.part.callID },
            interruptOnDispose: true,
          })
          .pipe(Effect.map((registration) => ({ ...item, ...registration }))),
      )
      yield* Effect.logInfo("recovered questions", { "session.id": sessionID, count: pending.length })
      yield* status.set(sessionID, { type: "busy" })
      const withdraw = Effect.forEach(pending, (item) => item.withdraw, { discard: true })
      const started = yield* Deferred.make<void>()
      const done = yield* state.start(
        sessionID,
        lastAssistant(sessionID),
        Effect.gen(function* () {
          const outcomes = yield* Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.forEach(
              pending,
              (item) =>
                item.answer.pipe(
                  Effect.exit,
                  Effect.map((exit) => ({ ...item, exit })),
                ),
              { concurrency: "unbounded" },
            )
          }).pipe(
            // A user abort ends the turn; an instance teardown leaves it recoverable.
            Effect.onInterrupt(() => (cancelling.has(sessionID) ? finishTurn(info, { aborted: true }) : Effect.void)),
          )
          // The instance tore down while waiting: leave the turn as it is, for
          // the next process opened on this directory to recover.
          if (outcomes.some((item) => Exit.isFailure(item.exit) && Cause.hasInterruptsOnly(item.exit.cause))) {
            yield* Effect.logInfo("recovered questions left for the next process", { "session.id": sessionID })
            return yield* lastAssistant(sessionID)
          }
          yield* Effect.forEach(
            outcomes,
            Effect.fnUntraced(function* (item) {
              const end = Date.now()
              if (Exit.isFailure(item.exit)) {
                yield* sessions.updatePart({
                  ...item.part,
                  state: {
                    status: "error",
                    input: item.state.input,
                    error: new Question.RejectedError().message,
                    metadata: item.state.metadata,
                    time: { start: item.state.time.start, end },
                  },
                })
                return
              }
              const output = answerResult(item.questions, item.exit.value)
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.part.tool, sessionID, callID: item.part.callID, args: item.state.input },
                output,
              )
              yield* sessions.updatePart({
                ...item.part,
                state: {
                  status: "completed",
                  input: item.state.input,
                  output: output.output,
                  metadata: output.metadata,
                  title: output.title,
                  time: { start: item.state.time.start, end },
                },
              })
            }),
            { discard: true },
          )
          yield* finishTurn(info, { aborted: false })
          const dismissed = outcomes.some((item) => Exit.isFailure(item.exit))
          if (dismissed && (yield* config.get()).experimental?.continue_loop_on_deny !== true)
            return yield* lastAssistant(sessionID)
          return yield* runLoop(sessionID)
        }).pipe(Effect.ensuring(withdraw)),
      )
      const awaiting = yield* done.pipe(
        Effect.catchCause((cause) => Effect.logError("recovered turn failed", { "session.id": sessionID, cause })),
        // Also covers a run cancelled before it started, whose own cleanup never ran.
        Effect.ensuring(withdraw),
        Effect.forkIn(scope),
      )
      // Return once the run awaits the answers, so that cancelling it from now
      // on closes the turn, or once the run is over without having started.
      yield* Effect.raceFirst(Deferred.await(started), Fiber.await(awaiting))
    })

    // Close a turn whose stream died with the process that ran it, as the
    // processor's cleanup would have: unfinished tools become interrupted.
    const finishTurn = Effect.fnUntraced(function* (info: SessionV1.Assistant, input: { aborted: boolean }) {
      const turn = yield* MessageV2.get({ sessionID: info.sessionID, messageID: info.id }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      const end = Date.now()
      yield* Effect.forEach(
        turn.parts,
        (part) => {
          if (part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")) {
            const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
            return sessions.updatePart({
              ...part,
              state: {
                status: "error",
                input: part.state.input,
                error: "Tool execution aborted",
                metadata: { ...metadata, interrupted: true },
                time: { start: part.state.status === "running" ? part.state.time.start : end, end },
              },
            })
          }
          if ((part.type === "text" || part.type === "reasoning") && part.time && !part.time.end)
            return sessions.updatePart({ ...part, time: { ...part.time, end } })
          return Effect.void
        },
        { discard: true },
      )
      if (turn.info.role !== "assistant") return
      yield* sessions.updateMessage({
        ...turn.info,
        ...(input.aborted
          ? {
              error:
                turn.info.error ??
                MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
                  providerID: turn.info.providerID,
                  aborted: true,
                }),
            }
          : { finish: turn.info.finish ?? "tool-calls" }),
        time: { ...turn.info.time, completed: end },
      })
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    // Command target resolution, shared by command and preflight.
    const commandTaskModel = Effect.fn("SessionPrompt.commandTaskModel")(function* (
      cmd: Command.Info,
      input: Pick<CommandInput, "model" | "sessionID">,
    ) {
      if (cmd.model) return Provider.parseModel(cmd.model)
      if (cmd.agent) {
        const cmdAgent = yield* agents.get(cmd.agent)
        if (cmdAgent?.model) return cmdAgent.model
      }
      if (input.model) return Provider.parseModel(input.model)
      return yield* currentModel(input.sessionID)
    })

    const commandIsSubtask = (cmd: Command.Info, agent: Agent.Info) =>
      (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true

    const commandUserTarget = Effect.fn("SessionPrompt.commandUserTarget")(function* (target: {
      input: Pick<CommandInput, "agent" | "model" | "sessionID">
      agent: Agent.Info
      taskModel: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      isSubtask: boolean
    }) {
      const userAgent = target.isSubtask
        ? (target.input.agent ?? (yield* agents.defaultInfo()).name)
        : target.agent.name
      const userModel = target.isSubtask
        ? target.input.model
          ? Provider.parseModel(target.input.model)
          : yield* currentModel(target.input.sessionID)
        : target.taskModel
      return { userAgent, userModel }
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* commandTaskModel(cmd, input)

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = commandIsSubtask(cmd, agent)
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const { userAgent, userModel } = yield* commandUserTarget({ input, agent, taskModel, isSubtask })

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
        acceptThinkingLoss: input.acceptThinkingLoss,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
      preflight,
      recover,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

/** Messages as they remain after SessionRevert.cleanup applies REVERT. */
function revertView(msgs: SessionV1.WithParts[], revert: Session.Info["revert"]): SessionV1.WithParts[] {
  if (!revert) return msgs
  const index = msgs.findIndex((msg) => msg.info.id === revert.messageID)
  if (index < 0) return msgs
  if (!revert.partID) return msgs.slice(0, index)
  const target = msgs[index]
  const cut = target.parts.findIndex((part) => part.id === revert.partID)
  return [...msgs.slice(0, index), cut >= 0 ? { ...target, parts: target.parts.slice(0, cut) } : target]
}

function preflightTarget(target?: { agent?: string; model?: { providerID: string; modelID: string } }) {
  return {
    ...(target?.agent ? { agent: target.agent } : {}),
    ...(target?.model ? { providerID: target.model.providerID, modelID: target.model.modelID } : {}),
  }
}

export const PreflightInput = Schema.Struct({
  sessionID: SessionID,
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  /** Predict for a slash command instead of a plain prompt. */
  command: Schema.optional(Schema.String),
})
export type PreflightInput = Schema.Schema.Type<typeof PreflightInput>

const CacheVerification = Schema.Struct({
  time: Schema.Number,
  predicted: Schema.Number,
  actual: Schema.Number,
  written: Schema.Number,
  prompt: Schema.Number,
  ok: Schema.Boolean,
})

export const PreflightResult = Schema.Struct({
  status: Schema.Literals(["hit", "partial", "miss", "unknown"]),
  format: Schema.String,
  model: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  previous: Schema.optional(
    Schema.Struct({
      time: Schema.Number,
      promptTokens: Schema.Number,
      model: Schema.optional(Schema.String),
      ageMs: Schema.Number,
    }),
  ),
  reusableTokens: Schema.Number,
  reusableExact: Schema.Boolean,
  lostTokens: Schema.Number,
  reasons: Schema.Array(Schema.String),
  divergence: Schema.optional(
    Schema.Struct({
      index: Schema.Number,
      path: Schema.String,
      label: Schema.String,
      excerpt: Schema.String,
      previousPath: Schema.optional(Schema.String),
      previousLabel: Schema.optional(Schema.String),
      previousExcerpt: Schema.optional(Schema.String),
    }),
  ),
  verification: Schema.optional(Schema.Array(CacheVerification)),
  staleThinking: Schema.optional(
    Schema.Struct({
      count: Schema.Number,
      reason: Schema.String,
      path: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "SessionPreflight" })
export type PreflightResult = Schema.Schema.Type<typeof PreflightResult>

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  /** The user accepted dropping thinking blocks this turn invalidates. */
  acceptThinkingLoss: Schema.optional(Schema.Boolean),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  /** The user accepted dropping thinking blocks this turn invalidates. */
  acceptThinkingLoss: Schema.optional(Schema.Boolean),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    Question.node,
  ],
})

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(Question.Prompt))
const decodeQuestionID = Schema.decodeUnknownOption(QuestionID)

/** The persisted request ID of an orphaned question, so clients keep their pending copy. */
function requestID(value: unknown) {
  return Option.getOrUndefined(decodeQuestionID(value))
}

export * as SessionPrompt from "./prompt"
