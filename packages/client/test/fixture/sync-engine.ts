import type { SessionInfo, SessionMessageInfo } from "../../src/promise"
import { Engine } from "../../src/solid/engine/engine"
import type { DurableSessionEvent, SessionFoldState, SessionSnapshot } from "../../src/solid/engine/fold"
import { SessionFold } from "../../src/solid/engine/fold"

export class FakeSessionServer implements Engine.SessionTransport {
  readonly events: Array<DurableSessionEvent> = []
  readonly admitted: Array<string> = []
  readonly faults = {
    loseRequests: 0,
    loseResponses: 0,
    reject: 0,
    latency: 0,
  }

  private folded: SessionFoldState
  private readonly tails = new Set<AsyncQueue<Engine.SessionStreamItem>>()
  private eventCounter = 0

  constructor(
    readonly sessionID: string,
    readonly time = 1_717_171_717_000,
  ) {
    this.folded = SessionFold.fromSnapshot(emptySnapshot(sessionID))
  }

  async snapshot(sessionID: string) {
    await this.pause()
    this.assertSession(sessionID)
    return this.snapshotValue()
  }

  async *stream(sessionID: string, after: number): AsyncIterable<Engine.SessionStreamItem> {
    await this.pause()
    this.assertSession(sessionID)
    if (after > this.folded.seq) throw new Engine.SeqUnavailable()
    const queue = new AsyncQueue<Engine.SessionStreamItem>()
    this.tails.add(queue)
    try {
      for (const event of this.events.filter((event) => event.durable.seq > after)) yield event
      yield { type: "log.synced", aggregateID: sessionID, seq: this.folded.seq }
      while (true) yield await queue.take()
    } finally {
      this.tails.delete(queue)
    }
  }

  async submit(input: Engine.SubmitInput) {
    await this.pause()
    this.assertSession(input.sessionID)
    const existing = this.events.find(
      (event) => event.type === "session.inbox.enqueued" && event.data.inboxID === input.id,
    )
    if (existing) return
    if (this.faults.loseRequests > 0) {
      this.faults.loseRequests--
      throw new Error("request lost")
    }
    if (this.faults.reject > 0) {
      this.faults.reject--
      throw new Engine.SubmitRejected("rejected")
    }
    this.admitted.push(input.id)
    this.publish({
      id: `evt_${String(++this.eventCounter).padStart(8, "0")}`,
      created: this.time,
      type: "session.inbox.enqueued",
      durable: { aggregateID: this.sessionID, seq: this.folded.seq + 1, version: 1 },
      data: {
        sessionID: this.sessionID,
        inboxID: input.id,
        item: {
          type: "user",
          delivery: input.request.delivery ?? "steer",
          payload: {
            text: input.request.text,
            agents: input.request.agents?.map((agent) => ({ ...agent })),
            metadata: input.request.metadata,
          },
        },
      },
    })
    if (this.faults.loseResponses > 0) {
      this.faults.loseResponses--
      throw new Error("response lost")
    }
  }

  cutConnections() {
    this.tails.forEach((tail) => tail.fail(new Error("connection cut")))
  }

  truth() {
    return Engine.render({ folded: this.folded, outbox: [], overlay: new Map() })
  }

  snapshotValue(): SessionSnapshot {
    return {
      session: this.folded.session,
      children: this.folded.children,
      inbox: this.folded.inbox,
      messages: this.folded.messages,
      seq: this.folded.seq,
      active: this.folded.active,
    }
  }

  private publish(event: DurableSessionEvent) {
    this.events.push(event)
    this.folded = SessionFold.apply(this.folded, event)
    this.tails.forEach((tail) => tail.offer(event))
  }

  private assertSession(sessionID: string) {
    if (sessionID !== this.sessionID) throw new Error(`unknown session: ${sessionID}`)
  }

  private async pause() {
    for (let step = 0; step < this.faults.latency; step++) await Promise.resolve()
  }
}

export async function until(check: () => boolean, message = "condition did not become true") {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await Bun.sleep(1)
  }
  throw new Error(message)
}

export function userMessages(messages: ReadonlyArray<SessionMessageInfo>) {
  return messages.filter(
    (message): message is Extract<SessionMessageInfo, { readonly type: "user" }> => message.type === "user",
  )
}

function emptySnapshot(sessionID: string): SessionSnapshot {
  const session: SessionInfo = {
    id: sessionID,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_717_171_717_000, updated: 1_717_171_717_000 },
    location: { directory: "/workspace" },
  }
  return { session, children: [], inbox: [], messages: [], seq: 0 }
}

class AsyncQueue<Value> {
  private readonly values: Array<Value> = []
  private readonly waiting: Array<{
    readonly resolve: (value: Value) => void
    readonly reject: (error: Error) => void
  }> = []
  private error?: Error

  offer(value: Value) {
    const waiter = this.waiting.shift()
    if (waiter) {
      waiter.resolve(value)
      return
    }
    this.values.push(value)
  }

  fail(error: Error) {
    this.error = error
    this.waiting.splice(0).forEach((waiter) => waiter.reject(error))
  }

  take() {
    const value = this.values.shift()
    if (value) return Promise.resolve(value)
    if (this.error) return Promise.reject(this.error)
    return new Promise<Value>((resolve, reject) => this.waiting.push({ resolve, reject }))
  }
}
