export * as Agent from "./agent.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import { Bus } from "./bus.js"
import { State } from "./state.js"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const Name = Agent.Name
export type Name = Agent.Name
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export { Event } from "@opencode/schema/agent"

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

/** Agents a user switches between within one Session. */
export const isSelectable = (agent: Pick<Info, "mode" | "hidden">) => agent.mode !== "subagent" && !agent.hidden

/**
 * Rulesets deciding what a request from `agent` in `session` shows the model: tools, the Code Mode catalog, skills, MCP
 * instructions, and subagents. In a root Session, selectable agents share one exposure, so switching between them
 * keeps the request prefix and the provider's prompt cache, while each agent's own rules still decide its calls. An
 * agent running as a subagent in a child Session, whatever its mode, and a hidden agent keep their own.
 */
export const exposure = (
  agent: Info,
  agents: ReadonlyArray<Info>,
  session: Pick<Session.Info, "parentID">,
): ReadonlyArray<Info["permissions"]> =>
  session.parentID === undefined && isSelectable(agent)
    ? [
        agent.permissions,
        ...agents.filter((item) => item.id !== agent.id && isSelectable(item)).map((item) => item.permissions),
      ]
    : [agent.permissions]

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Editor = {
  list: () => readonly Types.DeepMutable<Info>[]
  get: (id: ID) => Types.DeepMutable<Info> | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID) => Effect.Effect<Selection>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = State.create<Data, Editor>({
      name: "agent",
      initial: () => ({ agents: new Map() }),
      editor: (editor) => ({
        list: () => Array.fromIterable(editor.agents.values()),
        get: (id) => editor.agents.get(id),
        default: (id) => {
          editor.default = id
        },
        update: (id, fn) => {
          const current = editor.agents.get(id) ?? (Info.default(id) as Types.DeepMutable<Info>)
          if (!editor.agents.has(id)) editor.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          editor.agents.delete(id)
        },
      }),
      notify: () => bus.publish(Agent.Event.Updated, {}).pipe(Effect.asVoid),
    })
    const selectable = (agent: Info | undefined) => (agent && isSelectable(agent) ? agent : undefined)
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(defaultID))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("Agent.select")(function* (id) {
        if (id !== undefined) return { id, info: state.get().agents.get(id) }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      list: Effect.fn("Agent.list")(function* () {
        const agents = Array.fromIterable(state.get().agents.values())
        const selected = selectedDefault()
        if (!selected) return agents
        return [selected, ...agents.filter((agent) => agent.id !== selected.id)]
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node] })
