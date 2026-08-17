import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Engine } from "../src/solid/engine/engine"
import { FakeSessionServer, until, userMessages } from "./fixture/sync-engine"

describe("session sync engine laws", () => {
  test("1. idempotency: lost responses converge to one admitted message", async () => {
    const server = new FakeSessionServer("session-idempotency")
    server.faults.loseResponses = 1
    const engine = await Engine.createSessionEngine(server.sessionID, server.transport, {
      now: () => server.time,
      reconnect: async () => {},
    })

    engine.submit({ id: "msg_1", text: "hello" })
    await until(() => engine.view().seq === 1)
    server.cutConnections()
    await engine.settled()

    expect(server.admitted).toEqual(["msg_1"])
    expect(userMessages(engine.view().messages)).toHaveLength(1)
    engine.stop()
  })

  test("2. echo determinism: folding the echo does not change rendered messages", async () => {
    const server = new FakeSessionServer("session-echo")
    const engine = await Engine.createSessionEngine(server.sessionID, server.transport, { now: () => server.time })
    await until(() => server.admitted.length === 0 && engine.view().seq === 0)

    engine.submit({ id: "msg_1", text: "instant" })
    const before = engine.view().messages
    await engine.settled()

    expect(engine.view().messages).toEqual(before)
    engine.stop()
  })

  test("3. sync opacity: the fold cannot see intents or the engine", () => {
    const source = readFileSync(new URL("../src/solid/engine/fold.ts", import.meta.url), "utf8")
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")

    expect(code).not.toContain("outbox")
    expect(code).not.toContain("./engine")
    expect(code).not.toContain("intent")
  })

  test("4. ordering: a burst admits in submission order", async () => {
    const server = new FakeSessionServer("session-ordering")
    const engine = await Engine.createSessionEngine(server.sessionID, server.transport)

    for (const value of [1, 2, 3, 4, 5]) engine.submit({ id: `msg_${value}`, text: `m${value}` })
    await engine.settled()

    expect(server.admitted).toEqual(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"])
    engine.stop()
  })

  test("5. convergence: drained clients equal the server fold", async () => {
    const server = new FakeSessionServer("session-convergence")
    const a = await Engine.createSessionEngine(server.sessionID, server.transport, { makeID: () => "msg_a" })
    const b = await Engine.createSessionEngine(server.sessionID, server.transport, { makeID: () => "msg_b" })

    a.submit({ text: "from a" })
    b.submit({ text: "from b" })
    await Promise.all([a.settled(), b.settled()])
    await until(() => a.view().seq === server.events.length && b.view().seq === server.events.length)

    expect(a.view()).toEqual(server.truth())
    expect(b.view()).toEqual(server.truth())
    a.stop()
    b.stop()
  })

  test("6. failure atomicity: typed rejection removes and surfaces the intent", async () => {
    const server = new FakeSessionServer("session-failure")
    server.faults.reject = 1
    const engine = await Engine.createSessionEngine(server.sessionID, server.transport)
    const failures: Array<Engine.IntentFailure> = []
    engine.subscribeFailures((failure) => failures.push(failure))
    const before = engine.view()

    const intent = engine.submit({ id: "msg_1", text: "doomed" })
    expect(userMessages(engine.view().messages)).toHaveLength(1)
    await until(() => failures.length === 1)

    expect(engine.view()).toEqual(before)
    expect(failures).toEqual([{ intent, reason: "rejected" }])
    engine.stop()
  })
})
