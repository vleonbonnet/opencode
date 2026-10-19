import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionCache } from "@opencode/schema/session-cache"
import { Effect, Schema } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const PreflightResponse = Schema.Struct({ data: SessionCache.PreflightReport })
const ThinkingResponse = Schema.Struct({ data: Schema.Struct({ dropped: Schema.Array(SessionCache.DroppedThinking) }) })

const serve = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, method: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
    })
})

it.live("serves the preflight and dropped-thinking routes", () =>
  Effect.gen(function* () {
    const request = yield* serve
    // A directory without project configuration, so the location loads nothing from this repository.
    const directory = (yield* tmpdirScoped("opencode-preflight-")).path
    const created = yield* request("/api/session", "POST", { location: { directory } })
    expect(created.status).toBe(200)
    const sessionID = Schema.decodeUnknownSync(SessionResponse)(created.body).data.id

    const thinking = yield* request(`/api/experimental/session/${sessionID}/thinking`, "GET")
    expect(thinking.status).toBe(200)
    expect(Schema.decodeUnknownSync(ThinkingResponse)(thinking.body)).toEqual({ data: { dropped: [] } })

    // Nothing was sent in this session yet: the report says why nothing could be predicted.
    const preflight = yield* request(`/api/experimental/session/${sessionID}/preflight`, "POST", { text: "hello" })
    expect(preflight.status).toBe(200)
    const report = Schema.decodeUnknownSync(PreflightResponse)(preflight.body).data
    expect(report).toMatchObject({ status: "unknown", reusableTokens: 0, lostTokens: 0 })
    expect(report.reasons).toHaveLength(1)
    expect(report.reasons[0]).not.toContain("\n")
  }).pipe(Effect.scoped),
  // Each test boots a whole server.
  30_000,
)

it.live("rejects unknown sessions and invalid preflight bodies", () =>
  Effect.gen(function* () {
    const request = yield* serve
    const missing = "ses_0000000000000000000000000000000000000000000000000000000000000000"
    expect((yield* request(`/api/experimental/session/${missing}/thinking`, "GET")).status).toBe(404)
    expect((yield* request(`/api/experimental/session/${missing}/preflight`, "POST", { text: "x" })).status).toBe(404)

    const directory = (yield* tmpdirScoped("opencode-preflight-")).path
    const created = yield* request("/api/session", "POST", { location: { directory } })
    const sessionID = Schema.decodeUnknownSync(SessionResponse)(created.body).data.id
    expect(
      (yield* request(`/api/experimental/session/${sessionID}/preflight`, "POST", { command: { arguments: "x" } }))
        .status,
    ).toBe(400)
    // A command or agent that does not exist is the client's mistake, not an unpredictable turn.
    const command = yield* request(`/api/experimental/session/${sessionID}/preflight`, "POST", {
      command: { name: "nope", arguments: "x" },
    })
    expect(command.status).toBe(400)
    expect(command.body).toMatchObject({ message: "Command not found: nope", field: "command" })
    const agent = yield* request(`/api/experimental/session/${sessionID}/preflight`, "POST", {
      text: "x",
      agent: "nope",
    })
    expect(agent.status).toBe(400)
    expect(agent.body).toMatchObject({ field: "agent" })
    // So is metadata that names a thinkingLoss nothing understands.
    const prompt = yield* request(`/api/session/${sessionID}/prompt`, "POST", {
      text: "x",
      metadata: { thinkingLoss: true },
      resume: false,
    })
    expect(prompt.status).toBe(400)
  }).pipe(Effect.scoped),
  30_000,
)
