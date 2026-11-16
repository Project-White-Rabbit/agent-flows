import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { contextLine, exportLine, readBaseInfo } from "./session-start.ts"

const packageDir = path.resolve(import.meta.dirname, "..", "..")
const script = path.join(packageDir, "src", "commands", "session-start.ts")

describe("session-start", () => {
  it("reads the installed base's version and flow contract", () => {
    const info = readBaseInfo(packageDir)
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(info.contract).toBeGreaterThan(0)
    expect(contextLine(info)).toContain(
      `installed at ${packageDir} (flow contract ${info.contract})`,
    )
  })

  it("quotes the root for the shell", () => {
    expect(exportLine("/a/it's here")).toBe(
      "export DEV_FLOWS_BASE='/a/it'\\''s here'\n",
    )
  })

  it("exports the root and tells the session where the base is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-"))
    const envFile = path.join(dir, "env")
    const result = spawnSync("node", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: packageDir,
        CLAUDE_ENV_FILE: envFile,
      },
    })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(output.hookSpecificOutput.additionalContext).toContain(packageDir)
    expect(fs.readFileSync(envFile, "utf8")).toBe(exportLine(packageDir))
  })

  it("says nothing and doesn't fail when the base can't be read", () => {
    const result = spawnSync("node", [script], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: os.tmpdir() },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })
})
