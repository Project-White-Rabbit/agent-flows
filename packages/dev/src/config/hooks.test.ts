import { describe, expect, it } from "vitest"
import { DEV_FLOWS } from "../flows/index.ts"
import { CONFIG_VERSION, checkConfig, getAt } from "./config.ts"
import {
  checkHooks,
  FLOW_MODES,
  fillVars,
  globRegex,
  HOOK_FLOWS,
  HOOK_POINTS,
} from "./hooks.ts"
import { SECTIONS } from "./sections/index.ts"

function check(value: unknown, where = "ready.before") {
  const warnings: string[] = []
  return { issues: checkHooks(value, where, warnings), warnings }
}

describe("checkHooks", () => {
  it("accepts commands, commands with a fix, and prompts, narrowed or not", () => {
    expect(
      check([
        {
          name: "version-bump",
          run: "./check.sh {base}",
          fix: "bun run bump",
          timeout: 120,
        },
        { name: "migrations", run: "pnpm db:verify-migrations" },
        {
          name: "sdk-docs",
          paths: ["sdks/**"],
          modes: ["loop"],
          prompt: "Update the docs",
        },
      ]),
    ).toEqual({ issues: [], warnings: [] })
  })

  it("needs exactly one of run or prompt, and fix and timeout only with run", () => {
    expect(
      check([
        { name: "neither" },
        { name: "both", run: "x", prompt: "y" },
        { name: "orphan", prompt: "y", fix: "z", timeout: 5 },
        { name: "slow", run: "x", timeout: 1.5 },
      ]).issues,
    ).toEqual([
      "ready.before[neither] must have either run or prompt",
      "ready.before[both] must have either run or prompt",
      "ready.before[orphan].fix needs a run command to check it",
      "ready.before[orphan].timeout is only for a run command",
      "ready.before[slow].timeout must be a whole number of seconds",
    ])
  })

  it("names each hook once, in the instance alphabet", () => {
    expect(
      check([
        { name: "Bad Name", run: "x" },
        { name: "same", run: "x" },
        { name: "same", run: "y" },
      ]).issues,
    ).toEqual([
      'ready.before[0].name must be lowercase letters, digits, ".", "_", or "-"',
      'ready.before has two hooks named "same"',
    ])
  })

  it("rejects empty commands and path lists", () => {
    expect(
      check([
        { name: "a", run: " " },
        { name: "b", run: "x", paths: [] },
        { name: "c", run: "x", paths: ["ok", ""] },
      ]).issues,
    ).toEqual([
      "ready.before[a].run must be a non-empty string",
      "ready.before[b].paths must be a list of non-empty globs",
      "ready.before[c].paths must be a list of non-empty globs",
    ])
  })

  it("takes modes only at a flow's points, and only that flow's modes", () => {
    expect(check([{ name: "a", run: "x", modes: ["remote"] }]).issues).toEqual([
      "ready.before[a].modes must list modes of ready: default, loop, draft",
    ])
    expect(
      check([{ name: "a", run: "x", modes: ["loop"] }], "hooks.before").issues,
    ).toEqual([
      "hooks.before[a].modes at a general point needs flows, to say whose modes they are",
    ])
  })

  it("takes flows only at a general point, and modes there of those flows", () => {
    expect(
      check(
        [
          { name: "a", run: "x", flows: ["sync", "ready"] },
          { name: "b", run: "x", flows: ["sync", "ready"], modes: ["local"] },
          { name: "c", run: "x", flows: ["ready"], modes: ["draft", "loop"] },
        ],
        "hooks.after",
      ).issues,
    ).toEqual([])
    expect(
      check(
        [
          { name: "a", run: "x", flows: ["configure"] },
          { name: "b", run: "x", flows: [] },
          { name: "c", run: "x", flows: ["finish"], modes: ["loop"] },
          { name: "d", run: "x", flows: ["nope"], modes: ["loop"] },
        ],
        "hooks.before",
      ).issues,
    ).toEqual([
      "hooks.before[a].flows must list flows of cancel, create-tickets, evaluate, finish, ready, start-work, sync, tickets-to-work",
      "hooks.before[b].flows must list flows of cancel, create-tickets, evaluate, finish, ready, start-work, sync, tickets-to-work",
      "hooks.before[c].modes must list modes of finish: default",
      "hooks.before[d].flows must list flows of cancel, create-tickets, evaluate, finish, ready, start-work, sync, tickets-to-work",
    ])
    expect(check([{ name: "a", run: "x", flows: ["ready"] }]).issues).toEqual([
      "ready.before[a].flows is only for a general point: this one runs only in ready",
    ])
  })

  it("takes an outcome only at an after point, and merged only where merging is known", () => {
    expect(check([{ name: "a", run: "x", on: "success" }]).issues).toEqual([
      "ready.before[a].on is only for an after point, which knows the outcome",
    ])
    expect(
      check([{ name: "a", run: "x", on: "maybe" }], "finish.after").issues,
    ).toEqual(["finish.after[a].on must be success, failure, merged"])
    expect(
      check([{ name: "a", run: "x", on: "failure" }], "hooks.after").issues,
    ).toEqual([])
    for (const where of ["finish.after", "hooks.after"]) {
      expect(
        check([{ name: "a", run: "x", on: "merged" }], where).issues,
      ).toEqual([])
    }
    expect(
      check([{ name: "a", run: "x", on: "merged" }], "cancel.after").issues,
    ).toEqual([
      "cancel.after[a].on: merged is only for finish.after and hooks.after, which know whether the pull request merged",
    ])
  })

  it("takes recheck only on a command that can hand over a task", () => {
    expect(check([{ name: "a", run: "x", recheck: true }]).issues).toEqual([])
    expect(
      check([
        { name: "a", prompt: "x", recheck: true },
        { name: "b", run: "x", recheck: "yes" },
      ]).issues,
    ).toEqual([
      "ready.before[a].recheck is only for a run command",
      "ready.before[b].recheck must be true or false",
    ])
    expect(
      check([{ name: "a", run: "x", recheck: true }], "evaluate.scan").issues,
    ).toEqual([
      "evaluate.scan[a].recheck isn't for evaluate.scan: its commands only read, so an exit 2 there stops rather than hands over a task",
    ])
  })

  it("takes a findings regex only on a scan command", () => {
    expect(
      check(
        [{ name: "a", run: "x", findings: "^(FINDING|  CHECK|UNTESTED):" }],
        "evaluate.scan",
      ).issues,
    ).toEqual([])
    expect(
      check(
        [
          { name: "a", run: "x", findings: "(" },
          { name: "b", prompt: "x", findings: "^F" },
        ],
        "evaluate.scan",
      ).issues,
    ).toEqual([
      "evaluate.scan[a].findings must be a regular expression",
      "evaluate.scan[b].findings is only for a run command",
    ])
    expect(check([{ name: "a", run: "x", findings: "^F" }]).issues).toEqual([
      "ready.before[a].findings is only for a point whose output is findings (evaluate.scan)",
    ])
  })

  it("rejects what isn't a list of objects", () => {
    expect(check({ name: "a" }).issues).toEqual([
      "ready.before must be a list of hooks",
    ])
    expect(check(["x"]).issues).toEqual(["ready.before[0] must be an object"])
  })

  it("only warns about keys a newer plugin may have added", () => {
    expect(check([{ name: "a", run: "x", retries: 2 }])).toEqual({
      issues: [],
      warnings: [
        expect.stringContaining('unknown field "ready.before[a].retries"'),
      ],
    })
  })
})

describe("hook points", () => {
  const base = { version: CONFIG_VERSION, repo: { baseBranch: "main" } }

  it("each have a field in a section, at their path", () => {
    for (const point of HOOK_POINTS) {
      const [section, key] = [
        point.id.split(".").slice(0, -1).join("."),
        point.id.split(".").at(-1),
      ]
      const spec = SECTIONS.find((s) => s.path === section)
      expect(spec?.fields.find((f) => f.key === key)?.type, point.id).toBe(
        "hook[]",
      )
    }
  })

  it("are checked as hook lists in the config", () => {
    expect(
      checkConfig({
        ...base,
        hooks: { before: [{ name: "env", run: "x" }] },
        ready: { beforePublish: [{ name: "a", run: "x" }] },
        finish: { after: [{ name: "b", on: "success", prompt: "y" }] },
      }),
    ).toEqual({ issues: [], warnings: [] })
    expect(
      checkConfig({ ...base, finish: { after: "./teardown.sh" } }).issues,
    ).toEqual(["finish.after must be a list of hooks"])
    expect(getAt({ hooks: { before: [] } }, "hooks.before")).toEqual([])
  })

  it("run around every flow but configure, and filter on each flow's real modes", () => {
    const ids = DEV_FLOWS.map((flow) => flow.id).filter(
      (id) => id !== "configure",
    )
    expect([...HOOK_FLOWS].sort()).toEqual(ids.sort())
    expect(Object.keys(FLOW_MODES).sort()).toEqual([...HOOK_FLOWS].sort())
    for (const [id, modes] of Object.entries(FLOW_MODES)) {
      const flow = DEV_FLOWS.find((f) => f.id === id)
      expect(modes, id).toEqual(
        Object.keys(flow?.entries ?? {}).filter((m) => m !== "help"),
      )
    }
  })
})

describe("globRegex", () => {
  it("matches `*` within a directory and `**` across them", () => {
    expect(globRegex("src/*.ts").test("src/a.ts")).toBe(true)
    expect(globRegex("src/*.ts").test("src/lib/a.ts")).toBe(false)
    expect(globRegex("sdks/**").test("sdks/ts/src/a.ts")).toBe(true)
    expect(globRegex("**/*.md").test("README.md")).toBe(true)
    expect(globRegex("a/**/b").test("a/b")).toBe(true)
    expect(globRegex("a.b").test("axb")).toBe(false)
  })
})

describe("fillVars", () => {
  it("fills known values and leaves the rest", () => {
    expect(
      fillVars("{base} {branch} {other} {outcome}", {
        base: "abc",
        branch: "x",
      }),
    ).toBe("abc x {other} {outcome}")
    expect(fillVars("{pr} {prs}", { pr: "12", prs: "11 12" })).toBe("12 11 12")
    expect(
      fillVars("{issue} {result} {merge} {since} {scope}", {
        issue: "ENG-1",
        result: "full",
        merge: "abc",
        since: "def",
        scope: "delta",
      }),
    ).toBe("ENG-1 full abc def delta")
  })
})
