import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { installPathCommand, locateBaseCommand } from "./front-end.ts"

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

describe("locateBaseCommand", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
  })

  function base(dir: string, version: string, hosts: string[]): void {
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true })
    mkdirSync(path.join(dir, "flows"), { recursive: true })
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version }),
    )
    writeFileSync(
      path.join(dir, "flows", "manifest.json"),
      JSON.stringify({
        contract: 1,
        hosts: Object.fromEntries(hosts.map((h) => [h, ["sync"]])),
      }),
    )
  }

  function locate(host: "claude" | "cursor" | "codex" | "amp", home: string) {
    return execSync(locateBaseCommand(host), {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
      encoding: "utf8",
    }).trim()
  }

  function home(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "home-"))
    dirs.push(dir)
    return dir
  }

  it("prints the newest install for the host that lists its flows", () => {
    const h = home()
    const cache = path.join(
      h,
      ".codex",
      "plugins",
      "cache",
      "agent-flows",
      "dev-flows-base",
    )
    base(path.join(cache, "0.9.0"), "0.9.0", ["claude", "codex"])
    base(path.join(cache, "0.10.0"), "0.10.0", ["claude", "codex"])
    base(path.join(cache, "0.11.0"), "0.11.0", ["claude"])
    expect(locate("codex", h)).toBe(path.join(cache, "0.10.0"))
  })

  it("prefers the host's own installs, then any other host's, then a clone", () => {
    const h = home()
    const claude = path.join(
      h,
      ".claude",
      "plugins",
      "cache",
      "agent-flows",
      "dev-flows-base",
      "0.50.0",
    )
    const clone = path.join(
      h,
      ".config",
      "agent-flows",
      "dev-flows-base",
      "packages",
      "dev",
    )
    base(claude, "0.50.0", ["claude", "cursor", "amp"])
    base(clone, "0.60.0", ["amp"])
    expect(locate("cursor", h)).toBe(claude)
    const local = path.join(h, ".cursor", "plugins", "local", "dev-flows-base")
    base(local, "0.40.0", ["cursor"])
    expect(locate("cursor", h)).toBe(local)
    expect(locate("amp", h)).toBe(claude)
  })

  it("prints nothing when no base is installed", () => {
    expect(locate("amp", home())).toBe("")
  })
})
