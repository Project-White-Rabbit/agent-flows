import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  actionOf,
  checkPlan,
  type Plan,
  parentsFirst,
  recordFiled,
  renderTable,
  summaryLine,
} from "./tickets.ts"

const TODAY = "2026-10-24"

const plan: Plan = {
  source: { title: "Planning, Oct 24" },
  items: [
    {
      key: "bot",
      title: "Answer ticket questions in chat",
      parent: "sync",
      blockedBy: ["sync"],
      cycle: "next",
    },
    {
      key: "sync",
      title: "Sync planning with the dev workflow",
      priority: "high",
      assignee: "Sam",
      defaults: ["cycle"],
      cycle: "current",
    },
    {
      key: "docs",
      match: "ENG-12",
      priority: "urgent",
      existing: { title: "Write the docs", priority: "high", project: "Web" },
    },
    {
      key: "same",
      match: "ENG-13",
      priority: "low",
      existing: { title: "Already right", priority: "low" },
    },
  ],
}

describe("checkPlan", () => {
  it("orders parents before their sub-issues and counts each action", () => {
    const checked = checkPlan(plan, TODAY)
    expect(checked.problems).toEqual([])
    expect(checked.rows.map((r) => [r.item.key, r.action])).toEqual([
      ["sync", "file"],
      ["bot", "file"],
      ["docs", "update"],
      ["same", "unchanged"],
    ])
    expect(summaryLine(checked.rows)).toBe(
      "SUMMARY 2 to file, 1 to update, 1 unchanged",
    )
  })

  it("renders rows, field changes, and defaults in the table", () => {
    const table = renderTable(checkPlan(plan, TODAY).rows)
    expect(table.split("\n")).toEqual([
      "| # | Action | Issue | Title | Parent | Priority | Cycle | Due | Assignee | Project | Blocked by |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      "| 1 | file | new | Sync planning with the dev workflow |  | high | current (default) |  | Sam |  |  |",
      "| 2 | file | new | Answer ticket questions in chat | row 1 |  | next |  |  |  | row 1 |",
      "| 3 | update | ENG-12 | Write the docs |  | high → urgent |  |  |  | Web |  |",
      "| 4 | unchanged | ENG-13 | Already right |  | low |  |  |  |  |  |",
    ])
  })

  it("refers to a filed item by its issue once it has one", () => {
    const filed = recordFiled(structuredClone(plan), "sync", "ENG-40")
    const table = renderTable(checkPlan(filed, TODAY).rows)
    expect(table).toContain(
      "| 2 | file | new | Answer ticket questions in chat | ENG-40 |",
    )
  })

  it("blocks filing on a malformed plan", () => {
    const bad: Plan = {
      items: [
        { key: "a", priority: "P0" },
        { key: "a", title: "Twice", dueDate: "Monday", cycle: "soon" },
        { key: "b", title: "Self", blockedBy: ["b"] },
        { key: "c", match: "ENG-1", existing: { closed: true } },
        { key: "d", match: "OPS-1", existing: { readOnly: true } },
        {
          key: "e",
          match: "ENG-5",
          parent: "ENG-9",
          existing: { parent: "ENG-1" },
        },
      ],
    }
    expect(checkPlan(bad, TODAY).problems).toEqual([
      "a: a new issue needs a title",
      "a: priority must be one of urgent, high, medium, low",
      "a: key used twice",
      "a: dueDate must be YYYY-MM-DD, or null to clear it",
      "a: cycle must be current, next, a number, or a YYYY-MM-DD date",
      "b: an item can't block itself",
      'c: ENG-1 is closed, so its work is done: drop the item, or set "match": "new" if the notes describe new work',
      'd: OPS-1 is in a tracker the team only links to, so it can\'t be updated: drop the item, or set "match": "new"',
      'e: ENG-5 is an existing issue, so it keeps its parent: leave "parent" out',
    ])
    expect(checkPlan({ items: [] }, TODAY).problems).toEqual([
      "the plan has no items",
    ])
  })

  it("finds parent loops", () => {
    const looped: Plan = {
      items: [
        { key: "a", title: "A", parent: "b" },
        { key: "b", title: "B", parent: "a" },
        { key: "c", title: "C" },
      ],
    }
    expect(parentsFirst(looped.items).looped).toEqual(["a", "b"])
    expect(checkPlan(looped, TODAY).problems).toEqual([
      "a: parent chain loops back on itself",
      "b: parent chain loops back on itself",
    ])
  })

  it("asks about overdue dates without blocking", () => {
    const due: Plan = {
      items: [
        { key: "late", match: "ENG-2", existing: { dueDate: "2026-10-01" } },
        {
          key: "cleared",
          match: "ENG-3",
          dueDate: null,
          existing: { dueDate: "2026-10-01" },
        },
        { key: "past", title: "Past", dueDate: "2026-10-20" },
      ],
    }
    const checked = checkPlan(due, TODAY)
    expect(checked.problems).toEqual([])
    expect(checked.checks).toEqual([
      'ENG-2 is due 2026-10-01, before today (2026-10-24): set a new "dueDate", or null to clear it',
      'past: the plan sets it due 2026-10-20, before today (2026-10-24): set a later "dueDate"',
    ])
  })
})

describe("actionOf", () => {
  it("updates a match only for what the plan changes", () => {
    const existing = { priority: "high", parent: "ENG-1" }
    expect(
      actionOf({ key: "a", match: "ENG-2", priority: "high", existing }),
    ).toBe("unchanged")
    expect(
      actionOf({ key: "a", match: "ENG-2", parent: "ENG-1", existing }),
    ).toBe("unchanged")
    expect(
      actionOf({ key: "a", match: "ENG-2", blockedBy: ["b"], existing }),
    ).toBe("update")
    expect(
      actionOf({
        key: "a",
        match: "ENG-2",
        dueDate: null,
        existing: { dueDate: "2026-01-01" },
      }),
    ).toBe("update")
    expect(actionOf({ key: "a", match: "new" })).toBe("file")
  })
})

describe("tickets.ts", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function cli(args: string[]) {
    const script = path.join(import.meta.dirname, "tickets.ts")
    return spawnSync("node", [script, ...args], { encoding: "utf8" })
  }

  it("checks a plan, then records a filed issue so a re-run updates it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tickets-"))
    dirs.push(dir)
    const file = path.join(dir, "plan.json")
    fs.writeFileSync(file, JSON.stringify(plan))

    const checked = cli(["check", "--plan", file, "--today", TODAY])
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain(
      "SUMMARY 2 to file, 1 to update, 1 unchanged",
    )

    const recorded = cli([
      "record",
      "--plan",
      file,
      "--key",
      "sync",
      "--id",
      "ENG-40",
      "--url",
      "https://t/ENG-40",
    ])
    expect(recorded.status).toBe(0)
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Plan
    expect(saved.items[1]).toMatchObject({
      match: "ENG-40",
      url: "https://t/ENG-40",
    })
    expect(cli(["check", "--plan", file, "--today", TODAY]).stdout).toContain(
      "SUMMARY 1 to file",
    )
  })

  it("exits 1 with PROBLEM lines for a plan it can't file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tickets-"))
    dirs.push(dir)
    const file = path.join(dir, "plan.json")
    fs.writeFileSync(file, JSON.stringify({ items: [] }))
    const result = cli(["check", "--plan", file])
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe("PROBLEM the plan has no items")
  })
})
