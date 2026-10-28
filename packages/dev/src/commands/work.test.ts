import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type Assigned,
  agentPrompt,
  branchFor,
  describeReuse,
  describeStart,
  describeTicket,
  gitWorktrees,
  main,
  namesTicket,
  parsePriorities,
  planRename,
  planReuse,
  planStart,
  queue,
  renameBranch,
  slugify,
  type Ticket,
  type Workspace,
} from "./work.ts"

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "ENG-12",
  title: "Fix the login redirect",
  url: "https://tracker/ENG-12",
  description: "Users land on a blank page.\n\n- [ ] Fix it",
  stage: "todo",
  priority: "high",
  branchName: "sam/eng-12-fix-the-login-redirect",
  ...overrides,
})

const assigned = (id: string, overrides: Partial<Assigned> = {}): Assigned => ({
  id,
  title: id,
  url: `https://tracker/${id}`,
  priority: "medium",
  ...overrides,
})

describe("planStart", () => {
  it("starts a ticket on the tracker's branch, unprefixed, and moves it", () => {
    const start = planStart(ticket(), [])
    expect(start).toMatchObject({
      action: "start",
      branch: "eng-12-fix-the-login-redirect",
      exact: false,
      section: null,
      move: true,
    })
    expect(describeStart(start, "/p/ENG-12.md")).toBe(
      'START ENG-12 "Fix the login redirect" branch=eng-12-fix-the-login-redirect exact=no section=none state=move prompt=/p/ENG-12.md',
    )
  })

  it("keeps a branch the ticket already names, exactly", () => {
    expect(
      branchFor(ticket({ description: "> Branch: `sam/login`\n\nBody" })),
    ).toEqual({ branch: "sam/login", exact: true })
    expect(
      branchFor(ticket({ branchName: null, title: "Fix: the login!" })),
    ).toEqual({ branch: "eng-12-fix-the-login", exact: false })
  })

  it("finds a workspace on its branch, or on a branch naming it", () => {
    const workspaces: Workspace[] = [
      { name: "other", branch: "sam/eng-120-other" },
      { name: "login", branch: "amy/ENG-12-login" },
    ]
    expect(planStart(ticket(), workspaces)).toMatchObject({
      action: "exists",
      workspace: { name: "login" },
      addLine: true,
      move: true,
    })
    const anchored = ticket({
      description: "> Branch: `custom`",
      stage: "in progress",
    })
    const start = planStart(anchored, [{ name: "c", branch: "custom" }])
    expect(describeStart(start)).toBe(
      'EXISTS ENG-12 workspace="c" branch=custom branch-line=keep state=keep',
    )
  })

  it("skips closed and missing tickets", () => {
    expect(describeStart(planStart(ticket({ stage: "done" }), []))).toBe(
      "SKIP ENG-12 done",
    )
    expect(describeStart(planStart({ id: "ENG-9", missing: true }, []))).toBe(
      "SKIP ENG-9 not found",
    )
  })

  it("places a workspace by flag, by rank, or beside the current one", () => {
    const current: Workspace[] = [
      { branch: "main", section: "P1", current: true },
    ]
    expect(planStart(ticket(), current)).toMatchObject({ section: "P1" })
    expect(planStart(ticket(), current, { section: null })).toMatchObject({
      section: null,
    })
    expect(planStart(ticket(), current, { section: "Bugs" })).toMatchObject({
      section: "Bugs",
    })
    expect(
      planStart(ticket(), current, {
        byRank: true,
        ranks: ["Urgent", "P0", "P1", "P2", "Audit"],
      }),
    ).toMatchObject({ section: "P0" })
    expect(
      planStart(ticket({ priority: "none" }), [], { byRank: true }),
    ).toMatchObject({ section: "No priority" })
  })

  it("puts a workspace in another project in no section unless a flag says", () => {
    const current: Workspace[] = [
      { branch: "main", section: "P1", current: true },
    ]
    expect(planStart(ticket(), current, { otherProject: true })).toMatchObject({
      section: null,
    })
    expect(
      planStart(ticket(), current, { otherProject: true, section: "Bugs" }),
    ).toMatchObject({ section: "Bugs" })
    expect(
      planStart(ticket(), current, { otherProject: true, byRank: true }),
    ).toMatchObject({ section: "High" })
  })
})

describe("agentPrompt", () => {
  it("leads with the issue and drops its link lines", () => {
    expect(
      agentPrompt(
        ticket({ description: "> Branch: `b`\n> Errors: X\n\nBody" }),
      ),
    ).toBe(
      "Work on issue ENG-12: Fix the login redirect\nhttps://tracker/ENG-12\n\nBody\n",
    )
  })
})

describe("namesTicket", () => {
  it("matches the id as two words of the branch's last segment", () => {
    expect(namesTicket("sam/eng-12-login", "ENG-12")).toBe(true)
    expect(namesTicket("eng-12", "ENG-12")).toBe(true)
    expect(namesTicket("sam/eng-123-login", "ENG-12")).toBe(false)
    expect(namesTicket("eng-12/login", "ENG-12")).toBe(false)
  })
})

describe("queue", () => {
  it("orders by priority, then due date, then blocking other work", () => {
    const issues = [
      assigned("ENG-1", { priority: "low" }),
      assigned("ENG-2", { priority: "high", dueDate: "2026-11-02" }),
      assigned("ENG-3", { priority: "high", dueDate: "2026-11-01" }),
      assigned("ENG-4", { priority: "high", blocks: true }),
      assigned("ENG-5", { priority: "none" }),
      assigned("ENG-6", { priority: "urgent" }),
      assigned("ENG-7", { priority: "high" }),
      assigned("ENG-8", {
        priority: "high",
        dueDate: "2026-11-02",
        blocks: true,
      }),
    ]
    // A deadline orders work within a priority; blocking breaks a tie.
    expect(queue(issues, []).map((i) => i.id)).toEqual([
      "ENG-6",
      "ENG-3",
      "ENG-8",
      "ENG-2",
      "ENG-4",
      "ENG-7",
      "ENG-1",
      "ENG-5",
    ])
  })

  it("puts a blocker mark before an earlier due date", () => {
    const issues = [
      assigned("ENG-1", { priority: "high", dueDate: "2026-11-01" }),
      assigned("ENG-2", { priority: "high", title: "🛑 Acme can't log in" }),
    ]
    expect(queue(issues, [], "🛑").map((i) => i.id)).toEqual(["ENG-2", "ENG-1"])
  })

  it("puts issues with the blocker mark first within their priority", () => {
    const issues = [
      assigned("ENG-1", { priority: "high", blocks: true }),
      assigned("ENG-2", { priority: "high", title: "🛑 Acme can't log in" }),
      assigned("ENG-3", { priority: "urgent" }),
    ]
    expect(queue(issues, [], "🛑").map((i) => i.id)).toEqual([
      "ENG-3",
      "ENG-2",
      "ENG-1",
    ])
    expect(describeTicket(issues[1] as Assigned, undefined, "🛑")).toContain(
      " blocker ",
    )
  })

  it("leaves out work already started or split up", () => {
    const issues = [
      assigned("ENG-1", { openSubIssues: true }),
      assigned("ENG-2", { pullRequests: ["https://h/pull/3"] }),
      assigned("ENG-3"),
      assigned("ENG-4", { description: "> Branch: `custom`" }),
      assigned("ENG-5"),
    ]
    const workspaces = [{ branch: "sam/eng-3-x" }, { branch: "custom" }]
    expect(queue(issues, workspaces).map((i) => i.id)).toEqual(["ENG-5"])
  })

  it("describes a ticket with its rank", () => {
    expect(
      describeTicket(
        assigned("ENG-1", { priority: "urgent", state: "Todo", blocks: true }),
        ["Urgent", "P0", "P1", "P2", "Audit"],
      ),
    ).toBe(
      'TICKET ENG-1 "Urgent" due=none [Todo] blocks-other-work "ENG-1" https://tracker/ENG-1',
    )
  })
})

describe("parsePriorities", () => {
  it("takes priorities or rank names, in any case", () => {
    expect(
      parsePriorities("Urgent, p0", ["Urgent", "P0", "P1", "P2", "Audit"]),
    ).toEqual(["urgent", "high"])
    expect(parsePriorities("low,none")).toEqual(["low", "none"])
    expect(() => parsePriorities("p7")).toThrow(/unknown priority `p7`/)
  })
})

describe("git worktrees", () => {
  it("reads each branch checked out in a worktree", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /w/eng-12",
      "HEAD def",
      "branch refs/heads/sam/eng-12-x",
      "",
      "worktree /w/detached",
      "HEAD 123",
      "detached",
      "",
    ].join("\n")
    expect(gitWorktrees(porcelain).map((w) => w.branch)).toEqual([
      "main",
      "sam/eng-12-x",
    ])
  })
})

describe("reuse", () => {
  it("takes the issue's branch under this branch's owner", () => {
    const reuse = planReuse(ticket(), [], "sam/scratch")
    expect(describeReuse(reuse as never)).toBe(
      'REUSE ENG-12 "Fix the login redirect" branch=sam/scratch -> sam/eng-12-fix-the-login-redirect name="ENG-12: Fix the login redirect" section=keep branch-line=add state=move',
    )
    expect(planReuse(ticket(), [], "sam/eng-12-wip")).toMatchObject({
      branch: "sam/eng-12-wip",
    })
    expect(
      planReuse(ticket({ description: "> Branch: `amy/login`" }), [], "x"),
    ).toMatchObject({ branch: "amy/login", addLine: false })
  })

  it("leaves an issue another workspace has, and moves only when asked", () => {
    expect(
      planReuse(ticket(), [{ name: "other", branch: "amy/eng-12-x" }], "sam/a"),
    ).toMatchObject({ action: "exists" })
    expect(planReuse(ticket(), [], "sam/a", { section: null })).toMatchObject({
      section: null,
    })
    expect(planReuse(ticket(), [], "sam/a", { byRank: true })).toMatchObject({
      section: "High",
    })
  })

  it("names untracked work after its title", () => {
    const rename = planRename("Try the new cache!", "sam/scratch")
    expect(describeReuse(rename)).toBe(
      'REUSE "Try the new cache!" branch=sam/scratch -> sam/try-the-new-cache name="Try the new cache!" section=keep',
    )
    expect(() => planRename("!!", "main")).toThrow(/no letters or digits/)
    expect(slugify("a long title that goes on", 12)).toBe("a-long-title")
    expect(slugify("a long title that goes on", 13)).toBe("a-long-title")
  })

  it("renames the branch unless it's pushed or taken", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "work-git-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
    try {
      git("init", "-q", "-b", "sam/scratch")
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      )
      git("branch", "sam/taken")
      const to = (branch: string) =>
        ({ ...planRename("x", "sam/scratch"), branch }) as const
      expect(renameBranch(to("sam/taken"), repo)).toMatch(
        /^FAILED workspace a branch named sam\/taken/,
      )
      expect(renameBranch(to("sam/scratch"), repo)).toBe(
        "KEPT branch=sam/scratch",
      )
      expect(renameBranch(to("sam/new"), repo)).toBe("RENAMED branch=sam/new")
      expect(git("branch", "--show-current")).toBe("sam/new")
      git("config", "branch.sam/new.remote", ".")
      git("config", "branch.sam/new.merge", "refs/heads/sam/taken")
      expect(
        renameBranch({ ...to("sam/other"), from: "sam/new" }, repo),
      ).toMatch(/already pushed/)
      git("config", "--unset", "branch.sam/new.remote")
      git("config", "--unset", "branch.sam/new.merge")
      expect(
        renameBranch(
          { ...to("sam/it's"), from: "sam/new" },
          repo,
          "git branch -m <name> && echo renamed by the stack",
        ),
      ).toBe("RENAMED branch=sam/it's")
      expect(git("branch", "--show-current")).toBe("sam/it's")
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("work.ts", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  function capture(argv: string[]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    main(argv)
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n")
    vi.restoreAllMocks()
    return out
  }

  it("plans from an input file and writes each prompt", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const input = path.join(dir, "start.json")
    fs.writeFileSync(
      input,
      JSON.stringify({ tickets: [ticket(), { id: "ENG-9", missing: true }] }),
    )
    const out = capture(["plan", "--input", input, "--no-section"])
    const prompt = path.join(dir, "prompts", "ENG-12.md")
    expect(out).toContain(`section=none state=move prompt=${prompt}`)
    expect(out).toContain("SKIP ENG-9 not found")
    expect(fs.readFileSync(prompt, "utf8")).toMatch(/^Work on issue ENG-12/)
  })

  it("takes --project as no section in the other project", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const input = path.join(dir, "start.json")
    fs.writeFileSync(
      input,
      JSON.stringify({
        tickets: [ticket()],
        workspaces: [{ branch: "main", section: "P1", current: true }],
      }),
    )
    expect(capture(["plan", "--input", input])).toContain('section="P1"')
    expect(capture(["plan", "--input", input, "--project"])).toContain(
      "section=none",
    )
  })

  it("adds a branch line to a description file in place", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const file = path.join(dir, "description.md")
    fs.writeFileSync(file, "The work.")
    expect(
      capture(["branch-line", "--description", file, "--branch", "b"]),
    ).toBe(`ADDED ${file}`)
    expect(fs.readFileSync(file, "utf8")).toBe("> Branch: `b`\n\nThe work.\n")
    expect(
      capture(["branch-line", "--description", file, "--branch", "b"]),
    ).toBe("UNCHANGED")
  })

  it("exits 2 on bad arguments", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const input = path.join(dir, "issues.json")
    fs.writeFileSync(input, JSON.stringify({ issues: [] }))
    capture(["list", "--input", input, "--priority", "p9"])
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
    capture(["plan", "--input", input, "--section", "x", "--no-section"])
    expect(process.exitCode).toBe(2)
  })
})
