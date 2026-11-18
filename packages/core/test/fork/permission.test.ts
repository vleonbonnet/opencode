import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// The permission service of the upstream Permission tests, with plugin hooks for the rules a plugin evaluates.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
    ]),
    [Location.node.replace(current)],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  it.effect("reports the rule that asks for each resource that needs approval", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "shell", resource: "*", effect: "allow" },
        { action: "shell", resource: "*secret*", effect: "ask" },
        { action: "shell", resource: "git *", effect: "ask" },
        { action: "shell", resource: "git push", effect: "allow" },
        { action: "edit", resource: "*", effect: "ask" },
      ])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({
        projectID: Project.ID.global,
        sessionID: Session.ID.make("ses_test"),
        action: "shell",
        resources: ["git status"],
      })
      const { service, fiber, request } = yield* waitForRequest({
        action: "shell",
        resources: ["cat secret", "ls", "git push", "git status", "git log"],
      })
      const reasons: Permission.Reason[] = [
        { resource: "cat secret", rule: { action: "shell", resource: "*secret*", effect: "ask" } },
        { resource: "git log", rule: { action: "shell", resource: "git *", effect: "ask" } },
      ]
      expect(request.reasons).toEqual(reasons)
      expect((yield* service.list()).map((item) => item.reasons)).toEqual([reasons])
      expect((yield* service.forSession(request.sessionID)).map((item) => item.reasons)).toEqual([reasons])
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("reports a resource no rule matches without a rule", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "edit", resource: "*", effect: "allow" }])
      const { service, fiber, request } = yield* waitForRequest({ action: "shell", resources: ["ls", "pwd"] })
      expect(request.reasons).toEqual([{ resource: "ls" }, { resource: "pwd" }])
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("leaves reasons out when the rules allow every resource and a plugin asks", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "shell", resource: "*", effect: "allow" }])
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          event.effect = "ask"
        }),
      )
      const { service, fiber, request } = yield* waitForRequest({ action: "shell", resources: ["ls"] })
      expect(request).not.toHaveProperty("reasons")
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("decides a resource by the last matching rule, or by none", () =>
    Effect.sync(() => {
      const rules: Permission.Ruleset = [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "shell", resource: "git *", effect: "allow" },
      ]
      expect(Permission.deciding("shell", "git status", rules)).toEqual(rules[1])
      expect(Permission.deciding("shell", "ls", rules)).toEqual(rules[0])
      expect(Permission.deciding("edit", "ls", rules)).toBeUndefined()
      expect(Permission.evaluate("edit", "ls", rules)).toEqual({ action: "edit", resource: "*", effect: "ask" })
    }),
  )
})

describe("shell command spellings", () => {
  // Asks for COMMAND as the shell tool does: each command's resource, with its other spellings beside it.
  const ask = (command: string, id = "per_test") =>
    Effect.gen(function* () {
      const parsed = yield* ShellParse.scan(command, "bash", "/project")
      const service = yield* Permission.Service
      const input = {
        ...assertion({ id: Permission.ID.create(id), action: "shell" }),
        resources: parsed.commands.map((item) => item.resource),
        alternates: parsed.commands.map((item) => item.alternates ?? []),
        save: parsed.commands.flatMap((item) => (item.save === undefined ? [] : [item.save])),
      }
      const result = yield* service.ask(input)
      const request = yield* service.get(result.id)
      if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
      return { effect: result.effect, request }
    })
  const rule = (resource: string, effect: Permission.Rule["effect"]): Permission.Rule => ({
    action: "shell",
    resource,
    effect,
  })

  it.live("decides a command by the latest rule matching any of its spellings", () =>
    Effect.gen(function* () {
      yield* setup([
        rule("*", "ask"),
        rule("ls -la *", "allow"),
        rule("tar -xzf *", "allow"),
        rule("kubectl get *", "allow"),
        rule("kubectl * get *", "allow"),
      ])
      expect((yield* ask("ls -la src")).effect).toBe("allow")
      expect((yield* ask("tar -xzf a.tgz")).effect).toBe("allow")
      expect((yield* ask(`kubectl "get" pods`)).effect).toBe("allow")
      expect((yield* ask(`kubectl -n x 'get' pods`)).effect).toBe("allow")
      expect((yield* ask(`kubectl "delete" pod x`)).effect).toBe("ask")
      // Another file may run under a bare name, so its directory keeps the command asking.
      expect((yield* ask("./kubectl get pods")).effect).toBe("ask")
    }),
  )

  it.live("denies a command when a deny rule matches any of its spellings", () =>
    Effect.gen(function* () {
      yield* setup([
        rule("*", "allow"),
        rule("rm -r *", "deny"),
        rule("rm * -r *", "deny"),
        rule("rm -R *", "deny"),
        rule("rm * -R *", "deny"),
        rule("rm --r*", "deny"),
        rule("rm * --r*", "deny"),
      ])
      for (const command of ["rm -fr build", `rm "-rf" build`, "/bin/rm -rf build", "sudo X=1 rm -rf build"])
        expect((yield* ask(command)).effect, command).toBe("deny")
      expect((yield* ask("rm -f build")).effect).toBe("allow")
      expect((yield* ask("rm -- -rf")).effect).toBe("allow")
    }),
  )

  it.live("tells the agent the message of the rule that denies a command", () =>
    Effect.gen(function* () {
      const message = "Run `agent-cleanup -- PATH...` instead."
      yield* setup([rule("*", "allow"), { ...rule("rm -r *", "deny"), message }])
      const service = yield* Permission.Service
      const parsed = yield* ShellParse.scan("ls; rm -rf build", "bash", "/project")
      const request = {
        ...assertion({ action: "shell" }),
        resources: parsed.commands.map((item) => item.resource),
        alternates: parsed.commands.map((item) => item.alternates ?? []),
      }
      const blocked = yield* service.assert(request).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(blocked.message).toBe(`Permission denied: shell. ${message}`)
      yield* setRules([rule("*", "allow"), rule("rm -r *", "deny")])
      const plain = yield* service.assert(request).pipe(Effect.flip)
      expect(plain.message).toBe("Permission denied: shell")
    }),
  )

  it.live("names the spelling and the rule that asks", () =>
    Effect.gen(function* () {
      yield* setup([
        rule("*", "allow"),
        rule("kubectl *", "ask"),
        rule("kubectl get *", "allow"),
        rule("kubectl delete *", "ask"),
      ])
      const { effect, request } = yield* ask(`kubectl "delete" pod x`)
      expect(effect).toBe("ask")
      expect(request?.reasons).toEqual([
        {
          resource: `kubectl "delete" pod x`,
          spelling: "kubectl delete pod x",
          rule: rule("kubectl delete *", "ask"),
        },
      ])
    }),
  )

  it.live("an approval saved for one spelling does not allow another command", () =>
    Effect.gen(function* () {
      yield* setup([rule("*", "ask")])
      const service = yield* Permission.Service
      const parsed = yield* ShellParse.scan(`"kubectl" get pods`, "bash", "/project")
      const result = yield* service.ask({
        ...assertion({ action: "shell" }),
        resources: parsed.commands.map((item) => item.resource),
        alternates: parsed.commands.map((item) => item.alternates ?? []),
        save: parsed.commands.flatMap((item) => (item.save === undefined ? [] : [item.save])),
      })
      yield* service.reply({ requestID: result.id, reply: "always" })
      expect((yield* ask(`"kubectl" get pods -A`, "per_again")).effect).toBe("allow")
      expect((yield* ask(`"kubectl" delete pod x`, "per_other")).effect).toBe("ask")
    }),
  )

  it.effect("re-evaluates the reasons of a pending request after an always reply", () =>
    Effect.gen(function* () {
      yield* setup()
      const bus = yield* Bus.Service
      const asked: Permission.Request[] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type === Permission.Event.Asked.type) asked.push(event.data as Permission.Request)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const first = yield* waitForRequest({
        id: Permission.ID.create("per_first"),
        action: "shell",
        resources: ["git status", "npm test"],
        save: ["git status *", "npm test *"],
      })
      expect(first.request.reasons).toEqual([{ resource: "git status" }, { resource: "npm test" }])
      const second = yield* waitForRequest({
        id: Permission.ID.create("per_second"),
        action: "shell",
        resources: ["git status"],
        save: ["git status *"],
      })
      yield* second.service.reply({ requestID: second.request.id, reply: "always" })
      yield* Fiber.join(second.fiber)
      const pending = yield* first.service.get(first.request.id)
      expect(pending?.reasons).toEqual([{ resource: "npm test" }])
      expect((yield* first.service.list()).map((item) => item.reasons)).toEqual([[{ resource: "npm test" }]])
      // Clients show one prompt for each request asked, so the change is not asked again.
      expect(asked.filter((item) => item.id === first.request.id)).toHaveLength(1)
      yield* first.service.reply({ requestID: first.request.id, reply: "once" })
      yield* Fiber.join(first.fiber)
    }),
  )
})

describe("Session-scoped approvals", () => {
  const parent = Session.ID.make("ses_test")
  const child = Session.ID.make("ses_child")
  const sibling = Session.ID.make("ses_sibling")
  const rules: Permission.Ruleset = [{ action: "shell", resource: "*", effect: "ask" }]
  // Adds a Session of the test project, started by PARENT when given.
  const addSession = (id: Session.ID, parentID?: Session.ID) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id,
          project_id: Project.ID.global,
          ...(parentID ? { parent_id: parentID } : {}),
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          agent: Agent.ID.make("test"),
        })
        .run()
        .pipe(Effect.orDie)
    })
  const ask = (sessionID: Session.ID, id: string) =>
    Effect.gen(function* () {
      const service = yield* Permission.Service
      return yield* service.ask(
        assertion({ id: Permission.ID.create(id), sessionID, action: "shell", resources: ["ls"], save: ["ls *"] }),
      )
    })

  it.effect("an always reply allows the request again in its Session and its descendants only", () =>
    Effect.gen(function* () {
      yield* setup(rules)
      yield* addSession(child, parent)
      yield* addSession(sibling)
      const service = yield* Permission.Service
      const first = yield* ask(parent, "per_first")
      expect(first.effect).toBe("ask")
      yield* service.reply({ requestID: first.id, reply: "always" })
      const saved = yield* PermissionSaved.Service
      expect(yield* saved.list()).toMatchObject([{ sessionID: parent, action: "shell", resource: "ls *" }])
      expect((yield* ask(parent, "per_again")).effect).toBe("allow")
      expect((yield* ask(child, "per_child")).effect).toBe("allow")
      const other = yield* ask(sibling, "per_sibling")
      expect(other.effect).toBe("ask")
      yield* service.reply({ requestID: other.id, reply: "once" })
    }),
  )

  it.effect("a descendant's always reply does not answer the Session that started it", () =>
    Effect.gen(function* () {
      yield* setup(rules)
      yield* addSession(child, parent)
      const service = yield* Permission.Service
      const first = yield* ask(child, "per_child")
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect((yield* ask(child, "per_child_again")).effect).toBe("allow")
      const asked = yield* ask(parent, "per_parent")
      expect(asked.effect).toBe("ask")
      yield* service.reply({ requestID: asked.id, reply: "once" })
    }),
  )

  it.effect("an always reply leaves another Session's pending request asking", () =>
    Effect.gen(function* () {
      yield* setup(rules)
      yield* addSession(sibling)
      const service = yield* Permission.Service
      const waiting = yield* ask(sibling, "per_sibling")
      const first = yield* ask(parent, "per_first")
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect((yield* service.list()).map((item) => item.id)).toEqual([waiting.id])
      yield* service.reply({ requestID: waiting.id, reply: "once" })
    }),
  )

  it.effect("removing a Session removes its approvals", () =>
    Effect.gen(function* () {
      yield* setup(rules)
      yield* addSession(sibling)
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, sessionID: parent, action: "shell", resources: ["ls *"] })
      yield* saved.add({ projectID: Project.ID.global, sessionID: sibling, action: "shell", resources: ["pwd *"] })
      expect(yield* saved.list({ sessionIDs: [sibling] })).toMatchObject([{ sessionID: sibling, resource: "pwd *" }])
      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie)
      expect(yield* saved.list()).toMatchObject([{ sessionID: sibling, resource: "pwd *" }])
    }),
  )
})
