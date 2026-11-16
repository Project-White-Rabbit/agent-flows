import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { installPathCommand } from "./front-end.ts"

describe("installPathCommand", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
  })

  function run(plugins: object, cwd: string): string {
    const config = mkdtempSync(path.join(tmpdir(), "claude-config-"))
    dirs.push(config)
    mkdirSync(path.join(config, "plugins"))
    writeFileSync(
      path.join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins }),
    )
    return execSync(installPathCommand(), {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      encoding: "utf8",
    }).trim()
  }

  it("prints this project's install, else the user's", () => {
    const project = mkdtempSync(path.join(tmpdir(), "project-"))
    dirs.push(project)
    mkdirSync(path.join(project, "sub"))
    const plugins = {
      "dev-flows@mkt": [{ scope: "user", installPath: "/front" }],
      "dev-flows-base@mkt": [
        { scope: "user", installPath: "/user-base" },
        { scope: "local", projectPath: project, installPath: "/local-base" },
      ],
    }
    expect(run(plugins, path.join(project, "sub"))).toBe("/local-base")
    expect(run(plugins, tmpdir())).toBe("/user-base")
  })

  it("prints nothing when the base isn't installed", () => {
    expect(
      run(
        { "dev-flows@mkt": [{ scope: "user", installPath: "/f" }] },
        tmpdir(),
      ),
    ).toBe("")
  })
})
