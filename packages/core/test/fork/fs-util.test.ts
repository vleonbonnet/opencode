import { describe, expect, test } from "bun:test"
import { FSUtil } from "@opencode/util/fs-util"

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
