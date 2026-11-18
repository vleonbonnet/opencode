import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { Service } from "../../src/effect/service"
import { serviceFixture, stoppedExitCode } from "../fixture/service-fixture"
import { accelerate } from "../fixture/service-timing"

const ensure = accelerate(Service.ensure)

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}

test("reports a service that fails again once restarted, without restarting it twice", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const failed = fixture.spawn("failed-owner")
  await fixture.waitForFile()

  await expect(
    run(ensure({ file: registration, version: "test", command: fixture.command("failed-owner") })),
  ).rejects.toThrow("Background service failed to start")
  const replacement = await Bun.file(registration).json()
  fixture.track(replacement.pid)

  expect(await failed.exited).toBe(stoppedExitCode)
  expect(replacement.pid).not.toBe(failed.pid)
  expect(process.kill(replacement.pid, 0)).toBe(true)
})
