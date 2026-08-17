import { describe, expect, test } from "bun:test"
import { Engine } from "../src/solid/engine/engine"
import { createEngineTransport } from "../src/solid/engine-data"
import { FakeSessionServer } from "./fixture/sync-engine"

describe("engine data transport", () => {
  test("uses snapshot and ephemeral follow log contracts", async () => {
    const server = new FakeSessionServer("session-transport")
    const calls: Array<unknown> = []
    const transport = createEngineTransport(() => ({
      async snapshot(input) {
        calls.push(input)
        return server.snapshotValue()
      },
      async *log(input) {
        calls.push(input)
        yield { type: "log.synced" as const, aggregateID: input.sessionID, seq: 0 }
      },
      async prompt() {
        throw new Error("unused")
      },
    }))

    expect(await transport.snapshot(server.sessionID)).toEqual(server.snapshotValue())
    const items = []
    for await (const item of transport.stream(server.sessionID, 0)) items.push(item)

    expect(items).toEqual([{ type: "log.synced", aggregateID: server.sessionID, seq: 0 }])
    expect(calls).toEqual([
      { sessionID: server.sessionID, recent: 200 },
      { sessionID: server.sessionID, after: 0, follow: true, ephemeral: true },
    ])
  })

  test("preserves the prompt request and client-minted ID", async () => {
    const requests: Array<unknown> = []
    const transport = createEngineTransport(() => ({
      async snapshot() {
        throw new Error("unused")
      },
      async *log() {
        throw new Error("unused")
      },
      async prompt(input) {
        requests.push(input)
        return {
          id: input.id!,
          sessionID: input.sessionID,
          timeCreated: 1,
          type: "user",
          payload: { text: input.text },
          delivery: input.delivery ?? "steer",
        }
      },
    }))

    await transport.submit({
      id: "msg_client",
      sessionID: "session-submit",
      request: {
        id: undefined,
        sessionID: undefined,
        text: "hello",
        files: [{ uri: "file:///tmp/example.txt", name: "example.txt" }],
        delivery: "queue",
      },
    })

    expect(requests).toEqual([
      {
        id: "msg_client",
        sessionID: "session-submit",
        text: "hello",
        files: [{ uri: "file:///tmp/example.txt", name: "example.txt" }],
        delivery: "queue",
      },
    ])
  })

  test("translates generated typed failures", async () => {
    const transport = createEngineTransport(() => ({
      async snapshot() {
        throw new Error("unused")
      },
      async *log() {
        throw { _tag: "SeqUnavailableError", sessionID: "session", after: 2, head: 1, message: "gone" }
      },
      async prompt() {
        throw { _tag: "InvalidRequestError", message: "invalid" }
      },
    }))

    const streamError = await collectError(transport.stream("session", 2))
    expect(streamError).toBeInstanceOf(Engine.SeqUnavailable)
    await expect(
      transport.submit({ id: "msg_client", sessionID: "session", request: { text: "invalid" } }),
    ).rejects.toEqual(new Engine.SubmitRejected("invalid"))
  })
})

async function collectError(iterable: AsyncIterable<unknown>) {
  try {
    for await (const item of iterable) void item
  } catch (error) {
    return error
  }
  throw new Error("stream did not fail")
}
