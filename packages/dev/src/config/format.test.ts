import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { configuredFormatter, formatFile } from "./format.ts"

describe("formatFile", () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function repo(files: Record<string, string>): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-format-"))
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), content)
    }
  }

  // A formatter binary that records its arguments and runs `body`.
  function stub(name: string, body: string): void {
    const bin = path.join(dir, "node_modules", ".bin", name)
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${body}\n`,
      { mode: 0o755 },
    )
  }
  const args = () => fs.readFileSync(path.join(dir, "args"), "utf8")

  it("finds the formatter from the repo's config, Biome first", () => {
    repo({})
    expect(configuredFormatter(dir)).toBeUndefined()
    fs.writeFileSync(path.join(dir, "package.json"), '{"prettier": {}}')
    expect(configuredFormatter(dir)).toBe("prettier")
    fs.writeFileSync(path.join(dir, "biome.jsonc"), "{}")
    expect(configuredFormatter(dir)).toBe("biome")
  })

  it("runs the repo's own binary on that one file", () => {
    repo({ "biome.json": "{}", "a.json": "{}" })
    stub("biome", "exit 0")
    expect(formatFile(dir, "a.json")).toEqual({ formatted: "biome" })
    expect(args()).toBe("format\n--write\n--no-errors-on-unmatched\na.json\n")

    fs.rmSync(path.join(dir, "biome.json"))
    fs.writeFileSync(path.join(dir, ".prettierrc"), "{}")
    stub("prettier", "exit 0")
    expect(formatFile(dir, "a.json")).toEqual({ formatted: "prettier" })
    expect(args()).toBe("--write\na.json\n")
  })

  it("says why it didn't format, never throwing", () => {
    repo({ "a.json": "{}" })
    expect(formatFile(dir, "a.json")).toEqual({
      formatted: false,
      reason: "no formatter configured",
    })
    fs.writeFileSync(path.join(dir, "biome.json"), "{}")
    expect(formatFile(dir, "a.json")).toEqual({
      formatted: false,
      reason: "biome not installed",
    })
    stub("biome", "exit 1")
    expect(formatFile(dir, "a.json")).toEqual({
      formatted: false,
      reason: "biome exited 1",
    })
  })
})
