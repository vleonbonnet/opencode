import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../../src/solid"
import { OpenCode, type OpenCodeEvent } from "../../src/promise"

const sessionID = "ses_compact"
const event = { id: "evt_compact", created: 10, durable: { aggregateID: sessionID, seq: 1, version: 1 } }

// Session data fed only by events: any request is unexpected.
function setup() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      throw new Error(`Unexpected request: ${(input instanceof Request ? input : new Request(input, init)).url}`)
    },
  })
  const root = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  return {
    data: root.data,
    [Symbol.dispose]: root.dispose,
    emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
  }
}

test("keeps the estimated prompt of the next request a summary compaction reports", () => {
  using fixture = setup()
  fixture.emit({ ...event, type: "session.compaction.started", data: { sessionID, reason: "auto" } })
  fixture.emit({
    ...event,
    id: "evt_compact_ended",
    type: "session.compaction.ended",
    data: { sessionID, reason: "auto", text: "Summary", context: 4_200 },
  })
  // A reloaded session reads the same size from the stored message.
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([
    { type: "compaction", status: "completed", summary: "Summary", context: 4_200 },
  ])
})
