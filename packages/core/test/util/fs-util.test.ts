import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const failure = (tag: "PermissionDenied" | "Unknown", code: string, method: string, path: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause: Object.assign(new Error(code), { code }),
  })

const denied = (tag: "PermissionDenied" | "Unknown", code: string) =>
  FSUtil.layer.pipe(
    Layer.provide(
      FileSystem.layerNoop({
        realPath: (path) => Effect.fail(failure(tag, code, "realPath", path)),
        readFileString: (path) => Effect.fail(failure(tag, code, "readFile", path)),
      }),
    ),
  )

describe("FSUtil", () => {
  for (const input of [
    { tag: "PermissionDenied", code: "EACCES" },
    // macOS sandbox and privacy denials arrive as Unknown with an EPERM cause.
    { tag: "Unknown", code: "EPERM" },
  ] as const) {
    it.effect(`treats ${input.code} as an unresolvable, unreadable path`, () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        expect(yield* fs.resolve("/denied/.agents")).toBe(path.resolve("/denied/.agents"))
        expect(yield* fs.readFileStringSafe("/denied/AGENTS.md")).toBeUndefined()
      }).pipe(Effect.provide(denied(input.tag, input.code))),
    )
  }

  it.effect("keeps other realPath failures fatal", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const exit = yield* fs.resolve("/broken").pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(denied("Unknown", "EIO"))),
  )
})

describe("FSUtil.throughDrive", () => {
  const drives: Record<string, string> = { "Z:\\": "\\\\CARRIER\\Interceptor", "X:\\": "C:\\work" }
  const through = (value: string, reference: string, lookups: string[] = []) =>
    FSUtil.throughDrive(value, reference, {
      platform: "win32",
      target: (drive) => {
        lookups.push(drive)
        return drives[drive.toUpperCase()]
      },
    })

  test("names a path on a mapped share through the drive of the reference", () => {
    expect(through("\\\\CARRIER\\Interceptor\\Tech\\devops", "Z:\\Tech\\devops")).toBe("Z:\\Tech\\devops")
    expect(through("\\\\carrier\\interceptor\\Tech", "z:\\Tech")).toBe("z:\\Tech")
    expect(through("\\\\CARRIER\\Interceptor", "Z:\\Tech")).toBe("Z:\\")
  })

  test("names a path under a subst target through the drive of the reference", () => {
    expect(through("C:\\work\\repo\\.git", "X:\\repo")).toBe("X:\\repo\\.git")
  })

  test("keeps a path outside what the reference drive maps to", () => {
    expect(through("\\\\CARRIER\\Beam\\music", "Z:\\Tech")).toBe("\\\\CARRIER\\Beam\\music")
    expect(through("\\\\CARRIER\\Interceptor2\\x", "Z:\\Tech")).toBe("\\\\CARRIER\\Interceptor2\\x")
    expect(through("C:\\elsewhere", "X:\\repo")).toBe("C:\\elsewhere")
    expect(through("\\\\CARRIER\\Interceptor\\Tech", "Y:\\Tech")).toBe("\\\\CARRIER\\Interceptor\\Tech")
  })

  test("looks up a drive only for a path on another root", () => {
    const lookups: string[] = []
    expect(through("Z:\\Tech\\devops", "Z:\\Tech", lookups)).toBe("Z:\\Tech\\devops")
    expect(through("\\\\CARRIER\\Interceptor\\Tech", "\\\\CARRIER\\Interceptor\\Tech", lookups)).toBe(
      "\\\\CARRIER\\Interceptor\\Tech",
    )
    expect(lookups).toEqual([])
  })

  test("keeps every path off Windows", () => {
    expect(
      FSUtil.throughDrive("\\\\CARRIER\\Interceptor\\Tech", "Z:\\Tech", {
        platform: "linux",
        target: () => "\\\\CARRIER\\Interceptor",
      }),
    ).toBe("\\\\CARRIER\\Interceptor\\Tech")
  })
})
