import { expect, test } from "bun:test"
import { Service } from "../../src/promise/service"
import { serviceFixture, stoppedExitCode } from "../fixture/service-fixture"
import { accelerate } from "../fixture/service-timing"

const ensure = accelerate(Service.ensure)

test("reports a service that fails again once restarted, without restarting it twice", async () => {
  await using fixture = await serviceFixture()
  const registration = fixture.registration
  const failed = fixture.spawn("failed-owner")
  await fixture.waitForFile()

  await expect(
    ensure({ file: registration, version: "test", command: fixture.command("failed-owner") }),
  ).rejects.toThrow("Background service failed to start")
  const replacement = await Bun.file(registration).json()
  fixture.track(replacement.pid)

  expect(await failed.exited).toBe(stoppedExitCode)
  expect(replacement.pid).not.toBe(failed.pid)
  expect(process.kill(replacement.pid, 0)).toBe(true)
})
