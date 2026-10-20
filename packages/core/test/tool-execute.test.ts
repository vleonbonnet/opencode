import { expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const createCodeMode = (
  tools: ReadonlyMap<string, Info>,
  assert: (input: Permission.AssertInput) => Effect.Effect<void, unknown> = () => Effect.void,
) => CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context), assert)

/** A local server counting the requests it answers. */
const serve = () => {
  const received: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      received.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response("fetched")
    },
  })
  return { url: new URL("/data", server.url).href, received, [Symbol.dispose]: () => server.stop(true) }
}

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
      "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
    ].join("\n"),
  )
})

test("execute rejects filesystem fetches", async () => {
  const result = await Effect.runPromise(
    createCodeMode(new Map()).execute({ code: 'return await fetch("file:///blocked.txt")' }, context),
  )

  expect(result.output.error).toBe(true)
  expect(result.output.output).toContain("fetch cannot be used for filesystem access.")
})

test("execute asks for webfetch permission as the execute call before fetching", async () => {
  using server = serve()
  const asserted: Permission.AssertInput[] = []
  const result = await Effect.runPromise(
    createCodeMode(new Map(), (input) => Effect.sync(() => asserted.push(input))).execute(
      { code: `return await (await fetch(${JSON.stringify(server.url)}, { method: "post", body: "x" })).text()` },
      context,
    ),
  )

  expect(result.output.output).toBe("fetched")
  expect(asserted).toEqual([
    {
      action: "webfetch",
      resources: [server.url],
      save: ["*"],
      metadata: { method: "POST", url: server.url },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    },
  ])
  expect(server.received).toEqual(["POST /data"])
})

test("execute sends no request that webfetch permission denies", async () => {
  using server = serve()
  const result = await Effect.runPromise(
    createCodeMode(new Map(), (input) =>
      Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })),
    ).execute({ code: `return await fetch(${JSON.stringify(server.url)})` }, context),
  )

  expect(result.output.error).toBe(true)
  expect(result.output.output).toContain("Permission denied: webfetch")
  expect(result.metadata).toEqual({ toolCalls: [{ tool: "fetch", status: "error", input: { method: "GET", url: server.url } }], error: true })
  expect(server.received).toEqual([])
})

test("execute withdraws a fetch's pending permission request when the program ends", async () => {
  using server = serve()
  let withdrawn = false
  const result = await Effect.runPromise(
    createCodeMode(new Map(), () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            withdrawn = true
          }),
        ),
      ),
    ).execute({ code: `fetch(${JSON.stringify(server.url)}); return "done"` }, context),
  )

  expect(result.output.output).toContain("done")
  await Bun.sleep(10)
  expect(withdrawn).toBe(true)
  expect(server.received).toEqual([])
})

test("executions sharing an inventory's runtime ask for fetch permission as their own call", async () => {
  using server = serve()
  const inventory = { tools: new Map<string, Info>() }
  const asserted: Array<[string, string]> = []
  const run = (id: string) =>
    CodeModeTool.create(
      inventory,
      (_, tool, input, context) => execute(tool, input, context),
      (input) => Effect.sync(() => asserted.push([id, input.source?.type === "tool" ? input.source.id : ""])),
    ).execute(
      { code: `return await (await fetch(${JSON.stringify(server.url)})).text()` },
      { ...context, id: Tool.CallID.make(id) },
    )

  const results = await Effect.runPromise(Effect.all([run("first"), run("second")], { concurrency: "unbounded" }))
  expect(results.map((result) => result.output.output)).toEqual(["fetched", "fetched"])
  expect(asserted.toSorted()).toEqual([
    ["first", "first"],
    ["second", "second"],
  ])
  expect(server.received).toEqual(["GET /data", "GET /data"])
})

test("canonical execution distinguishes declared, model-only, and raw schema outputs", async () => {
  const declared: Info = {
    name: "declared",
    description: "Declared",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: ({ value }) => Effect.succeed({ output: { value } }),
  }
  const modelOnlyInput = Schema.Struct({})
  const modelOnly = {
    name: "model_only",
    description: "Model only",
    input: modelOnlyInput,
    execute: () => Effect.succeed({ content: "visible only", metadata: { kind: "model" } }),
  } satisfies Info<typeof modelOnlyInput, undefined>
  const raw: Info = {
    name: "raw",
    description: "Raw",
    input: {},
    output: {},
    execute: (input) => Effect.succeed({ output: input, content: "raw" }),
  }

  expect(await Effect.runPromise(execute(declared, { value: "encoded" }, context))).toEqual({
    output: { value: "encoded" },
    content: [{ type: "text", text: '{"value":"encoded"}' }],
  })
  expect(await Effect.runPromise(execute(modelOnly, {}, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: "visible only" }],
    metadata: { kind: "model" },
  })
  expect(await Effect.runPromise(execute(raw, { unchecked: true }, context))).toEqual({
    output: { unchecked: true },
    content: [{ type: "text", text: "raw" }],
  })
})

test("declared outputs cannot bypass validation and raw outputs stay JSON-compatible", async () => {
  const missing: Info = {
    name: "missing",
    description: "Missing output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed({ content: "not an output" }),
  }
  const invalid: Info = {
    name: "invalid",
    description: "Invalid raw output",
    input: {},
    output: {},
    execute: () => Effect.succeed({ output: 1n, content: "not JSON" }),
  }

  expect((await Effect.runPromiseExit(execute(missing, {}, context))).toString()).toContain(
    "Tool did not return its declared output",
  )
  expect((await Effect.runPromiseExit(execute(invalid, {}, context))).toString()).toContain(
    "Tool returned a non-JSON value",
  )
})

test("foreign typed failures settle as Tool.Error at the untrusted boundary", async () => {
  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  const lying: Info = {
    name: "lying",
    description: "Fails with a non-Tool.Error typed failure",
    input: Schema.Struct({}),
    execute: () => new ForeignFailure({ message: "transport died" }) as never,
  }

  const error = await Effect.runPromise(execute(lying, {}, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe("transport died")
})

test("execute supports callable namespace tools", async () => {
  const callable: Info = {
    name: "admin",
    description: "Administer Slack",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack" },
    execute: () => Effect.succeed({ output: "admin" }),
  }
  const child: Info = {
    name: "create",
    description: "Create a Slack resource",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack.admin" },
    execute: () => Effect.succeed({ output: "created" }),
  }
  const codeMode = createCodeMode(
    new Map([
      ["slack_admin", callable],
      ["slack_admin_create", child],
    ]),
  )
  const result = await Effect.runPromise(
    codeMode.execute({ code: "return [await tools.slack.admin({}), await tools.slack.admin.create({})]" }, context),
  )

  expect(result.metadata).toEqual({
    toolCalls: [
      { tool: "slack.admin", status: "completed" },
      { tool: "slack.admin.create", status: "completed" },
    ],
  })
  expect(result.content).toEqual([{ type: "text", text: '[\n  "admin",\n  "created"\n]' }])
})

test("executions share the prepared runtime of an inventory while keeping per-call state", async () => {
  let conversions = 0
  const echo: Info = {
    name: "echo",
    description: "Echo a value",
    input: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => {
            conversions++
            return { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
          },
          output: () => ({}),
        },
      },
    },
    execute: (input, context) => Effect.succeed({ content: `${context.id}:${(input as { value: string }).value}` }),
  }
  const inventory = { tools: new Map([["echo", echo]]) }
  const codeMode = CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), () => Effect.void)
  const run = (id: string) => {
    const progress: Array<Tool.Metadata> = []
    return CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), () => Effect.void)
      .execute(
        { code: `return await tools.echo({ value: "${id}" })` },
        { ...context, id: Tool.CallID.make(id), progress: (update) => Effect.sync(() => progress.push(update)) },
      )
      .pipe(Effect.map((result) => ({ output: result.output.output, progress })))
  }

  expect(CodeModeTool.catalog(inventory).tools).toHaveLength(1)
  const results = await Effect.runPromise(Effect.all([run("first"), run("second")], { concurrency: "unbounded" }))
  expect<unknown>(results).toEqual(
    ["first", "second"].map((id) => ({
      output: `${id}:${id}`,
      progress: [
        { toolCalls: [{ tool: "echo", status: "running", input: { value: id } }] },
        { toolCalls: [{ tool: "echo", status: "completed", input: { value: id } }] },
      ],
    })),
  )
  expect(
    (await Effect.runPromise(codeMode.execute({ code: 'return await tools.echo({ value: "x" })' }, context))).output
      .output,
  ).toBe("call_execute:x")
  expect(conversions).toBe(1)

  await Effect.runPromise(
    createCodeMode(new Map(inventory.tools)).execute({ code: 'return await tools.echo({ value: "next" })' }, context),
  )
  expect(conversions).toBe(2)
})
