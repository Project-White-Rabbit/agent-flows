import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  actionOf,
  checkPlan,
  matchPlan,
  type Plan,
  parentsFirst,
  planIds,
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
      ],
    }
    expect(checkPlan(bad, TODAY).problems).toEqual([
      "a: a new issue needs a title",
      "a: priority must be one of urgent, high, medium, low, none",
      "a: key used twice",
      "a: dueDate must be YYYY-MM-DD, or null to clear it",
      "a: cycle must be current, next, a number, or a YYYY-MM-DD date",
      "b: an item can't block itself",
      'c: ENG-1 is closed, so its work is done: drop the item, or set "match": "new" if the notes describe new work',
      'd: OPS-1 is in a tracker the team only links to, so it can\'t be updated: drop the item, or set "match": "new"',
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

describe("the team's rules", () => {
  const cycles = [
    { id: "40", startsAt: "2026-10-19", endsAt: "2026-10-26", current: true },
    { id: "41", startsAt: "2026-10-26", endsAt: "2026-11-02" },
  ]

  it("refuses a due date the rules require, or one before the cycle starts", () => {
    const due: Plan = {
      options: { linear: { cycles } },
      items: [
        { key: "p0", title: "Fix the outage", priority: "high" },
        { key: "audit", title: "Audit logs", priority: "none" },
        {
          key: "early",
          title: "Ship it",
          priority: "medium",
          cycle: "next",
          dueDate: "2026-10-25",
        },
        { key: "parent", title: "Epic", priority: "high" },
        {
          key: "child",
          title: "Piece",
          parent: "parent",
          dueDate: "2026-10-30",
        },
      ],
    }
    expect(
      checkPlan(due, TODAY, { dueDateRequired: ["high"] }).problems,
    ).toEqual([
      'p0: every high issue needs a due date (tickets.dueDateRequired): set "dueDate", or ask for one',
      "early: due 2026-10-25 is before its cycle next starts (2026-10-26): move the date or the cycle",
    ])
  })

  it("raises a parent to its most urgent sub-issue and gives it the earliest cycle", () => {
    const tree: Plan = {
      options: { linear: { cycles } },
      items: [
        { key: "epic", title: "Epic", priority: "low" },
        {
          key: "a",
          title: "A",
          parent: "epic",
          priority: "high",
          cycle: "next",
        },
        {
          key: "match",
          match: "ENG-5",
          priority: "medium",
          existing: {
            title: "Old work",
            priority: "medium",
            project: "Web",
            subIssues: [
              { id: "ENG-6", priority: "urgent", dueDate: "2026-10-01" },
            ],
          },
        },
        { key: "under", title: "Under", parent: "ENG-9", priority: "urgent" },
      ],
      refs: { "ENG-9": { found: true, title: "Outside", priority: "low" } },
    }
    const checked = checkPlan(tree, TODAY, { parentFollowsSubIssues: true })
    expect(checked.problems).toEqual([])
    const table = renderTable(checked.rows).split("\n").slice(2)
    expect(table).toEqual([
      "| 1 | file | new | Epic |  | high (sub-issues) | next (sub-issues) |  |  |  |  |",
      "| 2 | file | new | A | row 1 | high | next |  |  |  |  |",
      "| 3 | update | ENG-5 | Old work |  | medium → urgent (sub-issues) |  |  |  | Web |  |",
      "| 4 | file | new | Under | ENG-9 | urgent |  |  |  |  |  |",
      "| 5 | update | ENG-9 | Outside |  | low → urgent (sub-issues) |  |  |  |  |  |",
    ])
    expect(checked.checks).toEqual([
      'epic: the plan sets low, but open sub-issues a (high) force it to high: lower those (add each to the plan with "match" and "priority"), or keep high on purpose',
      'ENG-5: the plan sets medium, but open sub-issues ENG-6 (urgent) force it to urgent: lower those (add each to the plan with "match" and "priority"), or keep urgent on purpose',
      'ENG-6, a sub-issue of ENG-5, is due 2026-10-01, before today (2026-10-24): add it to the plan with "match": "ENG-6" and a new "dueDate", or null to clear it',
    ])
  })

  it("marks blockers and flags a match with no project", () => {
    const marked: Plan = {
      items: [
        { key: "new", title: "Unblock Acme", blocker: true },
        {
          key: "old",
          match: "ENG-2",
          blocker: true,
          existing: { title: "Login fails", project: null },
        },
      ],
    }
    const checked = checkPlan(marked, TODAY, { blockerMark: "🛑" })
    expect(
      checked.rows.map((r) => [r.item.title ?? r.item.retitle, r.action]),
    ).toEqual([
      ["🛑 Unblock Acme", "file"],
      ["🛑 Login fails", "update"],
    ])
    expect(checked.checks).toEqual([
      'ENG-2 has no project and the notes name none: set "project"',
    ])
    expect(checkPlan(marked, TODAY).problems[0]).toContain(
      "needs tickets.blockerMark",
    )
  })

  it("reports names, parents, and blockers the tracker doesn't have", () => {
    const named: Plan = {
      options: {
        linear: {
          people: [
            { name: "Sam Lee", email: "sam@x.co" },
            { name: "Ana Diaz" },
          ],
          projects: ["Web", "Dev tools"],
          labels: ["Bug"],
          cycles,
        },
      },
      items: [
        {
          key: "ok",
          title: "A",
          assignee: "sam",
          project: "dev tools",
          cycle: "current",
        },
        {
          key: "bad",
          title: "B",
          assignee: "Bo",
          project: "Mobile",
          label: "Chore",
          cycle: "50",
        },
        {
          key: "refs",
          title: "C",
          parent: "ENG-1",
          blockedBy: ["ENG-2", "ENG-3"],
        },
      ],
      refs: {
        "ENG-1": { found: false },
        "ENG-2": { found: true, closed: true },
      },
    }
    expect(checkPlan(named, TODAY).problems).toEqual([
      "refs: parent ENG-1 is neither a plan item nor an issue the tracker has",
      'refs: ENG-2 is closed, so it blocks nothing: drop it from "blockedBy"',
      "refs: blocked-by ENG-3 isn't a plan key, and the plan hasn't loaded it: load it with getIssue and record it in \"refs\"",
      'bad: assignee "Bo" matches 0 people (people: Sam Lee | Ana Diaz)',
      'bad: project "Mobile" matches 0 projects (projects: Web | Dev tools)',
      'bad: label "Chore" matches 0 labels (labels: Bug)',
      'bad: cycle "50" matches no current or upcoming cycle (cycles: 40 (2026-10-19) | 41 (2026-10-26))',
    ])
  })

  it("files a new sub-issue in its parent's project unless the notes name one", () => {
    const tree: Plan = {
      options: { linear: { projects: ["Web", "Dev tools", "Mobile"] } },
      items: [
        { key: "epic", title: "Epic", project: "Web" },
        { key: "a", title: "A", parent: "epic" },
        { key: "b", title: "B", parent: "a" },
        {
          key: "c",
          title: "C",
          parent: "epic",
          project: "Dev tools",
          defaults: ["project"],
        },
        { key: "d", title: "D", parent: "epic", project: "Mobile" },
        {
          key: "old",
          match: "ENG-5",
          existing: { title: "Old", project: "Dev tools" },
        },
        { key: "e", title: "E", parent: "old" },
        { key: "f", title: "F", parent: "ENG-9" },
      ],
      refs: { "ENG-9": { found: true, title: "Outside", project: "Mobile" } },
    }
    const checked = checkPlan(tree, TODAY)
    expect(checked.problems).toEqual([])
    const project = (key: string) =>
      renderTable(checked.rows.filter((r) => r.item.key === key))
        .split("\n")[2]
        ?.split(" | ")[9]
    expect(["a", "b", "c", "d", "e", "f"].map(project)).toEqual([
      "Web (parent)",
      "Web (parent)",
      "Web (parent)",
      "Mobile",
      "Dev tools (parent)",
      "Mobile (parent)",
    ])
  })

  it("raises a parent outside the plan when the plan raises a sub-issue already under it", () => {
    const raised: Plan = {
      items: [
        {
          key: "m",
          match: "ENG-5",
          priority: "urgent",
          existing: { title: "Piece", priority: "low", parent: "ENG-9" },
        },
      ],
      refs: {
        "ENG-9": {
          found: true,
          title: "Epic",
          priority: "medium",
          subIssues: [{ id: "ENG-5", priority: "low" }],
        },
      },
    }
    const rules = { parentFollowsSubIssues: true }
    const checked = checkPlan(raised, TODAY, rules)
    expect(checked.problems).toEqual([])
    expect(renderTable(checked.rows).split("\n").slice(2)).toEqual([
      "| 1 | update | ENG-5 | Piece | ENG-9 | low → urgent |  |  |  |  |  |",
      "| 2 | update | ENG-9 | Epic |  | medium → urgent (sub-issues) |  |  |  |  |  |",
    ])
    const unloaded = { ...raised, refs: undefined }
    expect(checkPlan(unloaded, TODAY, rules).problems).toEqual([
      'm: the plan raises ENG-5, which may move its parent ENG-9 up (tickets.parentFollowsSubIssues), and the plan hasn\'t loaded it: load it with getIssue and record it in "refs"',
    ])
    // Lowering it needs nothing loaded: a parent only moves up.
    const lowered = structuredClone(unloaded)
    ;(lowered.items[0] as { priority: string }).priority = "none"
    expect(checkPlan(lowered, TODAY, rules).problems).toEqual([])
  })

  it("gives a parent only the cycle of a sub-issue whose cycle hasn't ended", () => {
    const tree: Plan = {
      options: { linear: { cycles } },
      items: [
        {
          key: "epic",
          match: "ENG-1",
          existing: {
            title: "Epic",
            subIssues: [
              {
                id: "ENG-2",
                cycle: "39",
                cycleStart: "2026-10-12",
                cycleEnd: "2026-10-19",
              },
              { id: "ENG-3", cycle: "38", cycleStart: "2026-10-05" },
              { id: "ENG-4", cycle: "41", cycleStart: "2026-10-26" },
            ],
          },
        },
      ],
    }
    const checked = checkPlan(tree, TODAY, { parentFollowsSubIssues: true })
    expect(checked.rows[0]?.item.cycle).toBe("41")
    const ended: Plan = structuredClone(tree)
    const subs = ended.items[0]?.existing?.subIssues ?? []
    ended.items[0] = {
      ...(ended.items[0] as Plan["items"][number]),
      existing: { title: "Epic", subIssues: subs.slice(0, 2) },
    }
    expect(
      checkPlan(ended, TODAY, { parentFollowsSubIssues: true }).rows[0]?.item
        .cycle,
    ).toBeUndefined()
  })

  it("takes a project or label named by a unique part of its name", () => {
    const named: Plan = {
      options: {
        linear: {
          projects: ["Web app", "Dev tools", "Dev ops"],
          labels: ["Bug", "Feature request"],
        },
      },
      items: [
        { key: "a", title: "A", project: "web", label: "feature" },
        { key: "b", title: "B", project: "dev tools", label: "bug" },
        { key: "c", title: "C", project: "dev" },
      ],
    }
    expect(checkPlan(named, TODAY).problems).toEqual([
      'c: project "dev" matches 2 projects (projects: Web app | Dev tools | Dev ops)',
    ])
    named.items.pop()
    const checked = checkPlan(named, TODAY)
    expect(checked.names).toEqual([
      'a: project "web" is "Web app"',
      'a: label "feature" is "Feature request"',
      'b: project "dev tools" is "Dev tools"',
      'b: label "bug" is "Bug"',
    ])
    expect(renderTable(checked.rows)).toContain("|  | Web app |  |")
  })

  it("moves a matched issue under another parent", () => {
    const moved: Plan = {
      items: [
        {
          key: "m",
          match: "ENG-5",
          parent: "ENG-9",
          existing: { title: "T", parent: "ENG-1" },
        },
      ],
      refs: { "ENG-9": { found: true, title: "New home" } },
    }
    const checked = checkPlan(moved, TODAY)
    expect(checked.rows[0]?.action).toBe("update")
    expect(renderTable(checked.rows)).toContain("| ENG-1 → ENG-9 |")
  })
})

describe("matchPlan", () => {
  const issue = (identifier: string, title: string, extra: object = {}) => ({
    identifier,
    title,
    url: `https://t/${identifier}`,
    state: "Todo",
    open: true,
    description: "",
    ...extra,
  })

  it("matches the only open issue with the same title, and ranks the rest by shared words and search", () => {
    const planned: Plan = {
      items: [
        {
          key: "login",
          title: "🛑 Fix the login redirect",
          description: "- [ ] Send users back to the page they asked for",
        },
        { key: "cache", title: "Cache the dashboard queries" },
        { key: "none", title: "Write the quarterly letter" },
      ],
    }
    const lines = matchPlan(
      planned,
      {
        linear: {
          issues: [
            issue("ENG-1", "Fix the login redirect!"),
            issue("ENG-2", "Dashboard is slow", {
              description: "Cache the queries the dashboard runs",
            }),
            issue("ENG-3", "Speed up the dashboard"),
            issue("ENG-4", "Login page redirect loops", {
              open: false,
              state: "Done",
            }),
          ],
          hits: { cache: ["ENG-3"] },
        },
        heynoah: {
          link: true,
          issues: [issue("HEY-1", "Cache the dashboard queries")],
        },
      },
      { mark: "🛑" },
    )
    expect(planned.items.map((i) => i.match)).toEqual([
      "ENG-1",
      undefined,
      undefined,
    ])
    expect(lines).toEqual([
      'ITEM login "🛑 Fix the login redirect"',
      '  MATCH exact title ENG-1 "Fix the login redirect!" [Todo] https://t/ENG-1 (linear)',
      '  CANDIDATE 0.57, closed ENG-4 "Login page redirect loops" [Done] https://t/ENG-4 (linear)',
      'ITEM cache "Cache the dashboard queries"',
      '  CANDIDATE 0.64 ENG-2 "Dashboard is slow" [Todo] https://t/ENG-2 (linear)',
      '  CANDIDATE 0.33, search #1 ENG-3 "Speed up the dashboard" [Todo] https://t/ENG-3 (linear)',
      '  CANDIDATE 1.00, exact title HEY-1 "Cache the dashboard queries" [Todo] https://t/HEY-1 (heynoah)',
      'ITEM none "Write the quarterly letter"',
      "  NEW",
    ])
  })

  it("matches an issue filed from the same notes when it clearly leads", () => {
    const key = "1a2b3c4d5e6f708192a3b4c5d6e7f809"
    const filed = `> Planning: [Planning, week of 2026-10-19](https://t/doc), from [Notes](https://n/Notes-${key})`
    const planned: Plan = {
      items: [{ key: "sync", title: "Sync planning with the dev workflow" }],
    }
    matchPlan(
      planned,
      {
        linear: {
          issues: [
            issue("ENG-7", "Planning sync for dev workflow", {
              description: filed,
            }),
            issue("ENG-8", "Dev workflow docs"),
          ],
        },
      },
      { key },
    )
    expect(planned.items[0]?.match).toBe("ENG-7")
  })

  it("leaves two items that would claim one issue, a closed one, and a branch's taken issue to the agent", () => {
    const planned: Plan = {
      items: [
        { key: "a", title: "Ship it" },
        { key: "b", title: "Ship it" },
        { key: "c", title: "Old work" },
        { key: "d", title: "Branch work" },
        { key: "e", title: "Kept", match: "new" },
      ],
    }
    const lines = matchPlan(
      planned,
      {
        linear: {
          issues: [
            issue("ENG-1", "Ship it"),
            issue("ENG-2", "Old work", { open: false }),
            issue("ENG-3", "Branch work", {
              description: "> Branch: `sam/other`",
            }),
            issue("ENG-4", "Kept"),
          ],
        },
      },
      { branch: "sam/mine" },
    )
    expect(planned.items.map((i) => i.match)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "new",
    ])
    expect(lines).toContain("  NEW (forced)")
    // Both items still see the issue they couldn't both have.
    expect(
      lines.filter((l) =>
        l.includes('CANDIDATE 1.00, exact title ENG-1 "Ship it"'),
      ),
    ).toHaveLength(2)
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
      actionOf({ key: "a", match: "ENG-2", parent: "ENG-3", existing }),
    ).toBe("update")
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

  it("shapes the planning document's section and each issue's link to it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tickets-"))
    dirs.push(dir)
    const file = path.join(dir, "plan.json")
    const notes = path.join(dir, "notes.md")
    const description = path.join(dir, "ENG-1.md")
    fs.writeFileSync(
      file,
      JSON.stringify({
        source: { title: "Sync", url: "https://n/p" },
        items: [
          {
            key: "a",
            match: "ENG-1",
            filed: true,
            title: "A",
            url: "https://t/1",
          },
        ],
        options: {
          linear: {
            cycles: [
              {
                id: "40",
                startsAt: "2026-10-19",
                endsAt: "2026-10-26",
                current: true,
              },
            ],
          },
        },
      }),
    )
    fs.writeFileSync(notes, "- A")
    fs.writeFileSync(description, "Work")
    const out = cli([
      "notes",
      "--plan",
      file,
      "--notes",
      notes,
      "--today",
      TODAY,
    ])
    expect(JSON.parse(out.stdout)).toEqual({
      title: "Planning, week of 2026-10-19",
      key: "https://n/p",
      section: [
        "## 2026-10-24: Sync",
        "Source: [Sync](https://n/p)",
        "### Notes",
        "- A",
        "### Issues",
        "- [ENG-1](https://t/1): A (filed)",
      ].join("\n\n"),
    })
    const args = [
      "planning-line",
      "--plan",
      file,
      "--notes",
      notes,
      "--description",
      description,
      "--title",
      "Planning, week of 2026-10-19",
      "--url",
      "https://d",
    ]
    expect(cli(args).stdout.trim()).toBe("CHANGED")
    expect(fs.readFileSync(description, "utf8")).toBe(
      "> Planning: [Planning, week of 2026-10-19](https://d), from [Sync](https://n/p)\n\nWork\n",
    )
    expect(cli(args).stdout.trim()).toBe("UNCHANGED")
  })

  it("sets certain matches in the plan and prints what's left to judge", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tickets-"))
    dirs.push(dir)
    const file = path.join(dir, "plan.json")
    const issues = path.join(dir, "issues.json")
    const notes = path.join(dir, "notes.md")
    fs.writeFileSync(
      file,
      JSON.stringify({
        items: [{ key: "a", title: "Ship the login page" }],
      }),
    )
    fs.writeFileSync(notes, "- Ship the login page\n")
    fs.writeFileSync(
      issues,
      JSON.stringify({
        linear: {
          issues: [
            {
              identifier: "ENG-3",
              title: "Ship the login page",
              open: true,
              description: "",
            },
          ],
        },
      }),
    )
    const out = cli([
      "match",
      "--plan",
      file,
      "--issues",
      issues,
      "--notes",
      notes,
    ])
    expect(out.status).toBe(0)
    expect(out.stdout).toContain(
      'MATCH exact title ENG-3 "Ship the login page"',
    )
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items[0].match).toBe(
      "ENG-3",
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

describe("planIds", () => {
  it("lists each issue a plan matched or filed, once", () => {
    expect(
      planIds({
        items: [
          { key: "a", match: "ENG-1" },
          { key: "b", match: "new" },
          { key: "c" },
          { key: "d", match: "ENG-1" },
        ],
      }),
    ).toEqual(["ENG-1"])
  })
})
