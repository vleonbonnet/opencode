import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionSearch } from "@opencode/schema/session-search"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SearchResponse = Schema.toEncoded(SessionSearch.Response)

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: response.status, body: (await response.json()) as unknown }
    })
})

it.live(
  "serves full-text session search with paging and rejects malformed requests",
  () =>
    Effect.gen(function* () {
      const request = yield* setup
      const template = Schema.decodeUnknownSync(SessionResponse)((yield* request("/api/session", {})).body)
      const id = Session.ID.create()
      const imported = yield* request("/api/experimental/session/import", {
        info: { ...template.data, id, title: "Searchable" },
        messages: [
          { id: "msg_user", type: "user", text: "Where is the walrus?", time: { created: 1 } },
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "provider", id: "model" },
            content: [
              { type: "reasoning", text: "walrus reasoning" },
              { type: "text", text: "The walrus is   on the\nbeach." },
            ],
            time: { created: 2, completed: 3 },
          },
        ],
      })
      expect(imported.status).toBe(200)

      const first = yield* request("/api/experimental/session/search?q=walrus&limit=1")
      expect(first.status).toBe(200)
      const page = Schema.decodeUnknownSync(SearchResponse)(first.body)
      expect(page.index).toEqual({ complete: true })
      expect(page.data).toHaveLength(1)
      expect(page.cursor.next).toBeDefined()
      const second = Schema.decodeUnknownSync(SearchResponse)(
        (yield* request(`/api/experimental/session/search?q=walrus&limit=1&cursor=${page.cursor.next}`)).body,
      )
      expect(second.cursor.next).toBeUndefined()
      expect([...page.data, ...second.data].toSorted((a, b) => a.time.created - b.time.created)).toEqual([
        {
          sessionID: id,
          title: "Searchable",
          messageID: "msg_user",
          role: "user",
          time: { created: 1 },
          snippet: { text: "Where is the walrus?", matches: [{ start: 13, end: 19 }] },
        },
        {
          sessionID: id,
          title: "Searchable",
          messageID: "msg_assistant",
          role: "assistant",
          time: { created: 2 },
          snippet: { text: "The walrus is on the beach.", matches: [{ start: 4, end: 10 }] },
        },
      ])

      const phrase = Schema.decodeUnknownSync(SearchResponse)(
        (yield* request(`/api/experimental/session/search?q=${encodeURIComponent('"on the beach"')}`)).body,
      )
      expect(phrase.data.map((match) => match.messageID)).toEqual(["msg_assistant"])
      const archived = Schema.decodeUnknownSync(SearchResponse)(
        (yield* request("/api/experimental/session/search?q=walrus&archived=true")).body,
      )
      expect(archived.data).toEqual([])

      for (const query of ["", "q=", "q=walrus&limit=101", "q=walrus&limit=0", "q=walrus&cursor=bogus"])
        expect((yield* request(`/api/experimental/session/search?${query}`)).status).toBe(400)
      expect(
        (yield* request(`/api/experimental/session/search?q=${"x".repeat(SessionSearch.MAX_QUERY_LENGTH + 1)}`)).status,
      ).toBe(400)
    }).pipe(Effect.scoped),
  // Each test boots a whole server.
  30_000,
)
