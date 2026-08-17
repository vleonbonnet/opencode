import { describe, expect, test } from "bun:test"
import { Engine } from "../src/solid/engine/engine"
import { FakeSessionServer, until, userMessages } from "./fixture/sync-engine"

type Client = {
  readonly name: string
  readonly engine: Engine.SessionEngine
  readonly submitted: Array<string>
  readonly rejected: Set<string>
  readonly views: Array<Engine.SessionView>
}

describe("session sync engine simulation", () => {
  for (const seed of [1, 2, 3, 42, 1337, 90210]) {
    test(`seed ${seed}: two clients converge through chaotic transport faults`, async () => {
      const random = mulberry32(seed)
      const server = new FakeSessionServer(`session-sim-${seed}`)
      const clients = await Promise.all([makeClient("a", server), makeClient("b", server)])

      for (let step = 0; step < 80; step++) {
        const roll = random()
        if (roll < 0.45) {
          const client = pick(clients, random)
          const intent = client.engine.submit({ text: `step-${step}` })
          client.submitted.push(intent.id)
        } else if (roll < 0.55) {
          server.cutConnections()
        } else if (roll < 0.65) {
          server.faults.loseResponses++
        } else if (roll < 0.73) {
          server.faults.loseRequests += 1 + Math.floor(random() * 2)
        } else if (roll < 0.8) {
          server.faults.reject++
        } else {
          server.faults.latency = Math.floor(random() * 6)
        }
        await advance(2 + Math.floor(random() * 8))
      }

      server.faults.latency = 0
      server.faults.loseRequests = 0
      server.faults.loseResponses = 0
      server.faults.reject = 0
      for (let attempt = 0; attempt < 100; attempt++) {
        server.cutConnections()
        await advance(4)
        const accounted = clients.every(
          (client) =>
            client.submitted.filter((id) => server.admitted.includes(id) || client.rejected.has(id)).length ===
            client.submitted.length,
        )
        if (accounted) break
      }
      await until(
        () => clients.every((client) => client.engine.view().seq === server.events.length),
        `seed ${seed} did not converge`,
      )

      expect(new Set(server.admitted).size).toBe(server.admitted.length)
      for (const client of clients) {
        const expected = client.submitted.filter((id) => !client.rejected.has(id))
        const observed = server.admitted.filter((id) => client.submitted.includes(id))
        expect(observed).toEqual(expected)
        expect(client.engine.view()).toEqual(server.truth())
        assertNoFlicker(client.views, server.admitted, `${seed}/${client.name}`)
        client.engine.stop()
      }
    })
  }
})

async function makeClient(name: string, server: FakeSessionServer): Promise<Client> {
  let counter = 0
  const engine = await Engine.createSessionEngine(server.sessionID, server, {
    makeID: () => `msg_${name}${String(++counter).padStart(4, "0")}`,
    now: () => server.time,
    reconnect: async () => {},
  })
  const client: Client = { name, engine, submitted: [], rejected: new Set(), views: [engine.view()] }
  engine.subscribe((view) => client.views.push(view))
  engine.subscribeFailures((failure) => client.rejected.add(failure.intent.id))
  return client
}

function assertNoFlicker(views: ReadonlyArray<Engine.SessionView>, admitted: ReadonlyArray<string>, label: string) {
  for (const id of admitted) {
    const first = views.findIndex((view) => userMessages(view.messages).some((message) => message.id === id))
    expect(first, `${label}: ${id} never rendered`).toBeGreaterThanOrEqual(0)
    for (const view of views.slice(first)) {
      const rows = userMessages(view.messages).filter((message) => message.id === id)
      expect(rows, `${label}: ${id} disappeared or duplicated`).toHaveLength(1)
    }
  }
}

async function advance(steps: number) {
  for (let step = 0; step < steps; step++) await Promise.resolve()
  await Bun.sleep(0)
}

function pick<Value>(values: ReadonlyArray<Value>, random: () => number) {
  return values[Math.floor(random() * values.length)]!
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    const first = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    const second = (first + Math.imul(first ^ (first >>> 7), 61 | first)) ^ first
    return ((second ^ (second >>> 14)) >>> 0) / 4294967296
  }
}
