import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Check } from "../config/adapters/checks.ts"
import {
  instructionFiles,
  matchesCheck,
  NO_CHECKS_GRACE,
  parseChecks,
  progressLine,
  type ReadyState,
  readyCommands,
  readySkips,
  recordChecks,
  startPass,
  touchedPackages,
} from "./ready.ts"

const dirs: string[] = []

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ready-"))
  dirs.push(root)
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("touchedPackages", () => {
  it("gives each changed file its nearest package, with its check scripts", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { lint: "biome check" } }),
      "bun.lock": "",
      "apps/web/package.json": JSON.stringify({
        scripts: {
          dev: "next dev",
          test: "vitest run",
          "lint:fix": "biome check --write",
          build: "next build",
          deploy: "vercel deploy",
        },
      }),
      "services/api/pyproject.toml": "[project]\nname = 'api'\n",
    })
    expect(
      touchedPackages(root, [
        "apps/web/src/page.tsx",
        "apps/web/src/page.test.tsx",
        "services/api/app/main.py",
        "README.md",
      ]),
    ).toEqual([
      {
        dir: ".",
        manifest: "package.json",
        run: "bun run",
        scripts: { lint: "biome check" },
        changed: 1,
      },
      {
        dir: "apps/web",
        manifest: "package.json",
        run: "bun run",
        scripts: {
          test: "vitest run",
          "lint:fix": "biome check --write",
          build: "next build",
        },
        changed: 2,
      },
      { dir: "services/api", manifest: "pyproject.toml", changed: 1 },
    ])
  })

  it("finds the package manager from the nearest lockfile, else the manifest", () => {
    const root = repo({
      "a/package.json": JSON.stringify({ scripts: {} }),
      "a/pnpm-lock.yaml": "",
      "b/package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }),
    })
    expect(
      touchedPackages(root, ["a/x.ts", "b/y.ts"]).map((p) => p.run),
    ).toEqual(["pnpm run", "yarn run"])
  })

  it("leaves out files under no package", () => {
    const root = repo({ "docs/guide.md": "" })
    expect(touchedPackages(root, ["docs/guide.md"])).toEqual([])
  })
})

describe("instructionFiles", () => {
  it("lists the root's and every changed file's ancestors', root first", () => {
    const root = repo({
      "AGENTS.md": "",
      "CLAUDE.md": "",
      "apps/web/AGENTS.md": "",
      "apps/api/AGENTS.md": "",
    })
    expect(instructionFiles(root, ["apps/web/src/a.ts"])).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "apps/web/AGENTS.md",
    ])
  })
})

describe("readyCommands", () => {
  it("fills {base} into the config's commands", () => {
    expect(
      readyCommands(
        { ready: { fix: ["bun run lint:fix"], checks: ["./check.sh {base}"] } },
        "abc123",
      ),
    ).toEqual({
      configured: true,
      fix: ["bun run lint:fix"],
      checks: ["./check.sh abc123"],
    })
  })

  it("isn't configured without a ready section", () => {
    expect(readyCommands({}, "abc")).toEqual({
      configured: false,
      fix: [],
      checks: [],
    })
  })
})

describe("readySkips", () => {
  it("adds the run's skips and ignores to the config's, in step order", () => {
    expect(
      readySkips(
        { ready: { skip: ["ci"], ignoreChecks: ["Vercel*"] } },
        { skip: ["tests,Fix"], ignoreChecks: ["codecov/*", "Vercel*"] },
      ),
    ).toEqual({
      skip: ["tests", "fix", "ci"],
      ignoreChecks: ["Vercel*", "codecov/*"],
    })
  })

  it("reads local as every local step", () => {
    expect(readySkips({}, { skip: ["local"] }).skip).toEqual([
      "cleanup",
      "tests",
      "fix",
      "checks",
    ])
  })

  it("reads all as every step", () => {
    expect(readySkips({ ready: { skip: ["all"] } }).skip).toEqual([
      "cleanup",
      "tests",
      "fix",
      "checks",
      "ci",
      "reviews",
    ])
  })

  it("skips nothing without a ready section or flags", () => {
    expect(readySkips(undefined)).toEqual({ skip: [], ignoreChecks: [] })
  })

  it("rejects a step it doesn't know, from the config or the run", () => {
    expect(() => readySkips({ ready: { skip: ["lint"] } })).toThrow(
      "ready can't skip `lint`",
    )
    expect(() => readySkips({}, { skip: ["ci,revews"] })).toThrow(
      "ready can't skip `revews`",
    )
  })
})

describe("matchesCheck", () => {
  it("matches the whole name, with * for any run of characters, case aside", () => {
    expect(matchesCheck("Vercel – Preview", "vercel*")).toBe(true)
    expect(matchesCheck("codecov/patch", "codecov/*")).toBe(true)
    expect(matchesCheck("lint", "lint")).toBe(true)
    expect(matchesCheck("lint (node 22)", "lint")).toBe(false)
    expect(matchesCheck("a.b", "a?b")).toBe(false)
  })
})

const start = new Date("2026-10-26T12:00:00Z")
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000)

const check = (name: string, state: Check["state"]): Check => ({ name, state })

describe("recordChecks", () => {
  const started = startPass({ passes: [] }, "sha1", [], start)

  it("isn't settled while a check is pending, and reports each failure new once", () => {
    const first = recordChecks(
      started,
      "sha1",
      [check("lint", "fail"), check("test", "pending")],
      at(30),
    )
    expect(first.report).toMatchObject({
      pass: 1,
      elapsedSeconds: 30,
      settled: false,
      timedOut: false,
      green: false,
      pending: ["test"],
      newFailures: [check("lint", "fail")],
    })
    const second = recordChecks(
      first.state,
      "sha1",
      [check("lint", "fail"), check("test", "pass")],
      at(60),
    )
    expect(second.report).toMatchObject({
      settled: true,
      green: false,
      failures: [check("lint", "fail")],
      newFailures: [],
      counts: { pass: 1, fail: 1, pending: 0, skipping: 0, cancelled: 0 },
    })
    expect(second.state.passes[0].settled).toEqual(["lint"])
  })

  it("is green once every check passes or skips", () => {
    const { report } = recordChecks(
      started,
      "sha1",
      [check("lint", "pass"), check("e2e", "skipping")],
      at(60),
    )
    expect(report).toMatchObject({
      settled: true,
      green: true,
      noChecks: false,
    })
  })

  it("counts a cancelled check as a failure, never green", () => {
    const { report } = recordChecks(
      started,
      "sha1",
      [check("lint", "pass"), check("required", "cancelled")],
      at(60),
    )
    expect(report).toMatchObject({ settled: true, green: false })
    expect(report.failures).toEqual([check("required", "cancelled")])
  })

  it("times out a pass that hasn't settled within its timeout", () => {
    const { report } = recordChecks(
      started,
      "sha1",
      [check("slow", "pending")],
      at(901),
    )
    expect(report).toMatchObject({
      settled: false,
      timedOut: true,
      pending: ["slow"],
    })
  })

  it("waits for checks to show up, then takes it there are none", () => {
    expect(recordChecks(started, "sha1", [], at(30)).report).toMatchObject({
      settled: false,
      noChecks: false,
    })
    expect(
      recordChecks(started, "sha1", [], at(NO_CHECKS_GRACE)).report,
    ).toMatchObject({ settled: true, noChecks: true, green: false })
  })

  it("calls a check stalled when the push meant to fix it and it fails again", () => {
    const pushed = startPass(started, "sha2", ["lint"], at(120))
    const { report } = recordChecks(
      pushed,
      "sha2",
      [check("lint", "fail"), check("test", "fail")],
      at(150),
    )
    expect(report.pass).toBe(2)
    expect(report.elapsedSeconds).toBe(30)
    expect(report.stalled).toEqual(["lint"])
  })

  it("neither waits on nor fails a check an ignore pattern matches", () => {
    const { report } = recordChecks(
      started,
      "sha1",
      [
        check("lint", "pass"),
        check("Vercel – Preview", "pending"),
        check("codecov/patch", "fail"),
      ],
      at(60),
      900,
      ["vercel*", "codecov/*"],
    )
    expect(report).toMatchObject({
      settled: true,
      green: true,
      pending: [],
      failures: [],
      ignored: ["Vercel – Preview", "codecov/patch"],
      counts: { pass: 1, fail: 0, pending: 0, skipping: 0, cancelled: 0 },
    })
    expect(progressLine(report)).toContain("1 checks, 0 failed, 2 ignored")
  })

  it("has nothing to wait for when every check is ignored", () => {
    const { report } = recordChecks(
      started,
      "sha1",
      [check("Vercel", "pending")],
      at(5),
      900,
      ["Vercel"],
    )
    expect(report).toMatchObject({
      settled: true,
      noChecks: true,
      green: false,
    })
  })

  it("starts a pass for a commit it hasn't seen", () => {
    const { state, report } = recordChecks(started, "other", [], at(10))
    expect(report.pass).toBe(2)
    expect(report.elapsedSeconds).toBe(0)
    expect(state.passes.map((p) => p.sha)).toEqual(["sha1", "other"])
  })
})

describe("startPass", () => {
  it("restarts the clock for the same commit, keeping what it meant to fix", () => {
    const state: ReadyState = startPass({ passes: [] }, "sha1", ["lint"], start)
    const again = startPass(state, "sha1", ["test"], at(3600))
    expect(again.passes).toEqual([
      {
        sha: "sha1",
        startedAt: at(3600).toISOString(),
        fixed: ["lint", "test"],
        seen: [],
      },
    ])
  })

  it("keeps the last 20 passes", () => {
    let state: ReadyState = { passes: [] }
    for (let i = 0; i < 25; i++) {
      state = startPass(state, `sha${i}`, [], at(i))
    }
    expect(state.passes).toHaveLength(20)
    expect(state.passes[0].sha).toBe("sha5")
  })
})

describe("parseChecks", () => {
  it("reads the op's object or a bare list", () => {
    const list = [{ name: "lint", state: "fail", link: "https://x", log: 42 }]
    expect(parseChecks(JSON.stringify({ checks: list }))).toEqual([
      { name: "lint", state: "fail", link: "https://x", log: "42" },
    ])
    expect(parseChecks(JSON.stringify(list))).toHaveLength(1)
  })

  it("rejects a state it doesn't know", () => {
    expect(() =>
      parseChecks(JSON.stringify([{ name: "lint", state: "failure" }])),
    ).toThrow(/needs a `name` and a `state`/)
  })
})

describe("progressLine", () => {
  it("names the pending checks, five at most", () => {
    const pending = ["a", "b", "c", "d", "e", "f"].map((n) =>
      check(n, "pending"),
    )
    const { report } = recordChecks(
      startPass({ passes: [] }, "sha1", [], start),
      "sha1",
      [check("lint", "fail"), ...pending],
      at(75),
    )
    expect(progressLine(report)).toBe(
      "[ready-ci] pass 1, 1m15s of 15m00s: 7 checks, 1 failed, 6 pending (a, b, c, d, e, …)",
    )
  })
})
