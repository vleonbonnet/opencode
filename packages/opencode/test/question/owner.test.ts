import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import { Effect } from "effect"
import { QuestionOwner } from "../../src/question/owner"

const orphaned = (owner: QuestionOwner.Owner | undefined) => Effect.runPromise(QuestionOwner.orphaned(owner))

const children: Bun.Subprocess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

function spawnIdle() {
  const start = Date.now()
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  children.push(child)
  const owner: QuestionOwner.Owner = { pid: child.pid, start, host: os.hostname() }
  return owner
}

describe("QuestionOwner.parseElapsed", () => {
  test("reads every POSIX elapsed time form", () => {
    expect(QuestionOwner.parseElapsed("00:07")).toBe(7_000)
    expect(QuestionOwner.parseElapsed("  12:34\n")).toBe((12 * 60 + 34) * 1000)
    expect(QuestionOwner.parseElapsed("01:02:03")).toBe((3600 + 2 * 60 + 3) * 1000)
    expect(QuestionOwner.parseElapsed("2-01:02:03")).toBe(((2 * 24 + 1) * 3600 + 2 * 60 + 3) * 1000)
  })

  test("rejects anything else", () => {
    expect(QuestionOwner.parseElapsed("")).toBeUndefined()
    expect(QuestionOwner.parseElapsed("Fri Oct  2 09:09:18 2026")).toBeUndefined()
  })
})

describe("QuestionOwner.fromMetadata", () => {
  test("decodes a persisted owner", () => {
    expect(QuestionOwner.fromMetadata({ requestID: "que_x", owner: QuestionOwner.current })).toEqual(
      QuestionOwner.current,
    )
  })

  test("ignores a missing or malformed owner", () => {
    expect(QuestionOwner.fromMetadata(undefined)).toBeUndefined()
    expect(QuestionOwner.fromMetadata({ requestID: "que_x" })).toBeUndefined()
    expect(QuestionOwner.fromMetadata({ owner: { pid: "1" } })).toBeUndefined()
  })
})

describe("QuestionOwner.orphaned", () => {
  test("a question asked before owners were recorded is orphaned", async () => {
    expect(await orphaned(undefined)).toBe(true)
  })

  test("this process's own questions are orphaned, their instance being gone", async () => {
    expect(await orphaned(QuestionOwner.current)).toBe(true)
  })

  test("a live process keeps its question", async () => {
    expect(await orphaned(spawnIdle())).toBe(false)
  })

  test("a dead process's question is orphaned", async () => {
    const owner = spawnIdle()
    const child = children.pop()!
    child.kill()
    await child.exited
    expect(await orphaned(owner)).toBe(true)
  })

  test("a reused PID does not keep the question alive", async () => {
    const owner = spawnIdle()
    expect(await orphaned({ ...owner, start: owner.start - 3_600_000 })).toBe(true)
  })

  test("a process of another user cannot hold our question", async () => {
    expect(await orphaned({ pid: 1, start: 0, host: os.hostname() })).toBe(true)
  })

  test("a process on another host is presumed alive", async () => {
    expect(await orphaned({ ...QuestionOwner.current, host: `${os.hostname()}-elsewhere` })).toBe(false)
  })
})
