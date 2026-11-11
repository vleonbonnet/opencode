import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../../src/promise"

// The remembered session and the wait helper of the upstream solid-data tests.
const session = (viewed: number): SessionInfo => ({
  id: "ses_refresh",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed },
  location: { directory: "/project" },
})

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("records each delegator of a remembered session once", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      throw new Error(`Unexpected request: ${(input instanceof Request ? input : new Request(input, init)).url}`)
    },
  })
  const setup = createRoot((dispose) => ({
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
  const delegated = (seq: number, agent: string): OpenCodeEvent => ({
    id: `evt_delegated_${seq}`,
    created: seq,
    type: "session.delegated",
    durable: { aggregateID: "ses_refresh", seq, version: 1 },
    data: { sessionID: "ses_refresh", delegator: { sessionID: "ses_parent", agent } },
  })

  try {
    setup.data.session.remember(session(1))
    for (const event of [delegated(1, "plan"), delegated(2, "plan"), delegated(3, "build")])
      listeners.forEach((listener) => listener({ name: event.type, details: event }))

    await wait(() => setup.data.session.get("ses_refresh")?.delegators?.length === 2)
    expect(setup.data.session.get("ses_refresh")?.delegators).toEqual([
      { sessionID: "ses_parent", agent: "plan" },
      { sessionID: "ses_parent", agent: "build" },
    ])
  } finally {
    setup.dispose()
  }
})
