import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type Assigned,
  agentPrompt,
  branchFor,
  describeRefresh,
  describeRepository,
  describeReuse,
  describeStart,
  describeTicket,
  describeUntracked,
  followsTemplate,
  gitWorktrees,
  main,
  namedPaths,
  namesTicket,
  parsePriorities,
  pickRepository,
  planRename,
  planReuse,
  planStart,
  planUntracked,
  queue,
  type Repository,
  refreshName,
  releaseLock,
  renameBranch,
  slugify,
  type Ticket,
  takeLock,
  untrackedPrompt,
  type Workspace,
  workspaceName,
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
      'START ENG-12 "Fix the login redirect" name="ENG-12: Fix the login redirect" branch=eng-12-fix-the-login-redirect exact=no section=none state=move prompt=/p/ENG-12.md',
    )
  })

  it("names the workspace by the configured template", () => {
    expect(workspaceName(ticket())).toBe("ENG-12: Fix the login redirect")
    expect(workspaceName(ticket(), "[{id}] {title}")).toBe(
      "[ENG-12] Fix the login redirect",
    )
    expect(workspaceName(ticket(), "{title}")).toBe("Fix the login redirect")
    expect(workspaceName(ticket(), "{id}")).toBe("ENG-12")
    const ranks = ["Urgent", "P0", "P1", "P2", "Audit"]
    const template = "{priority}/{category}: {title}"
    expect(workspaceName(ticket({ category: "Bug" }), template, ranks)).toBe(
      "P0/Bug: Fix the login redirect",
    )
    expect(workspaceName(ticket(), template, ranks)).toBe(
      "P0: Fix the login redirect",
    )
    expect(
      workspaceName(ticket({ priority: "none", category: "Bug" }), template),
    ).toBe("Bug: Fix the login redirect")
    expect(workspaceName(ticket({ priority: "none" }), template)).toBe(
      "Fix the login redirect",
    )
    expect(
      workspaceName(ticket({ priority: "none" }), "[{priority}] {id} {title}"),
    ).toBe("ENG-12 Fix the login redirect")
    expect(
      workspaceName(
        ticket({ category: "Feature" }),
        "{id:short} {category:4}: {title:16}",
      ),
    ).toBe("12 Feat: Fix the login")
    expect(workspaceName(ticket({ id: "#7" }), "#{id:short} {title}")).toBe(
      "#7 Fix the login redirect",
    )
    expect(workspaceName(ticket(), "{id} {title:3}")).toBe("ENG-12 Fix")
    expect(
      workspaceName(ticket({ title: "Supercalifragilistic" }), "{title:5}"),
    ).toBe("Super")
    expect(workspaceName(ticket(), "{category:3}/{id:short}: {title}")).toBe(
      "12: Fix the login redirect",
    )
    expect(workspaceName(ticket(), "{id} ({category}) {title}")).toBe(
      "ENG-12 Fix the login redirect",
    )
    const due = ticket({ dueDate: "2026-03-07" })
    expect(workspaceName(due, "{id} {due}: {title}")).toBe(
      "ENG-12 2026-03-07: Fix the login redirect",
    )
    expect(workspaceName(due, "{title} [{due:MM/DD}]")).toBe(
      "Fix the login redirect [03/07]",
    )
    expect(workspaceName(due, "{id} ({due:MMM D, YYYY}) {title:3}")).toBe(
      "ENG-12 (Mar 7, 2026) Fix",
    )
    expect(workspaceName(due, "{due:D.M.YY} {id}")).toBe("7.3.26 ENG-12")
    expect(
      workspaceName(
        ticket({ dueDate: "2026-12-25T00:00:00.000Z" }),
        "{id} {due}",
      ),
    ).toBe("ENG-12 2026-12-25")
    expect(workspaceName(ticket(), "{title} [{due:MM/DD}]")).toBe(
      "Fix the login redirect",
    )
    expect(workspaceName(ticket(), "{due:D.M.YY} {id}")).toBe("ENG-12")
    expect(
      workspaceName(ticket({ dueDate: null }), "{id}/{due:MMM D}: {title}"),
    ).toBe("ENG-12: Fix the login redirect")
    expect(
      planStart(ticket(), [], { workspaceName: "{title} ({id})" }),
    ).toMatchObject({ name: "Fix the login redirect (ENG-12)" })
    expect(
      planReuse(ticket(), [], "sam/a", { workspaceName: "{id} {title}" }),
    ).toMatchObject({ name: "ENG-12 Fix the login redirect" })
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

  it("puts a workspace in another repository in no section unless a flag says", () => {
    const current: Workspace[] = [
      { branch: "main", section: "P1", current: true },
    ]
    expect(
      planStart(ticket(), current, { otherRepository: true }),
    ).toMatchObject({
      section: null,
    })
    expect(
      planStart(ticket(), current, { otherRepository: true, section: "Bugs" }),
    ).toMatchObject({ section: "Bugs" })
    expect(
      planStart(ticket(), current, { otherRepository: true, byRank: true }),
    ).toMatchObject({ section: "High" })
  })
})

describe("workspaceName with parts missing", () => {
  const plain = ticket({ title: "Fix login" })

  it("drops a bracketed part whose placeholders are empty, words and all", () => {
    expect(workspaceName(plain, "{id}: {title} (due {due})")).toBe(
      "ENG-12: Fix login",
    )
    expect(workspaceName(plain, "{id}: {title} [due {due:MMM D}]")).toBe(
      "ENG-12: Fix login",
    )
    expect(workspaceName(plain, "{id} - (due {due}) - {title}")).toBe(
      "ENG-12 - Fix login",
    )
    expect(workspaceName(plain, "(due {due}) {id}: {title}")).toBe(
      "ENG-12: Fix login",
    )
    expect(
      workspaceName(
        ticket({ title: "Fix login", dueDate: "2026-11-30" }),
        "{id}: {title} (due {due:MMM D})",
      ),
    ).toBe("ENG-12: Fix login (due Nov 30)")
  })

  it("keeps a bracketed part with something filled in", () => {
    expect(
      workspaceName(
        ticket({ title: "Fix login", priority: "high" }),
        "{id} ({priority}, {due}) {title}",
      ),
    ).toBe("ENG-12 (High) Fix login")
    expect(workspaceName(plain, "{title} (by {id})")).toBe(
      "Fix login (by ENG-12)",
    )
  })

  it("takes dashes and tildes as separators", () => {
    expect(workspaceName(plain, "{id} \u2014 {due}")).toBe("ENG-12")
    expect(workspaceName(plain, "{id} \u2013 {due} \u2013 {title}")).toBe(
      "ENG-12 \u2013 Fix login",
    )
    expect(workspaceName(plain, "{due} ~ {id}")).toBe("ENG-12")
    expect(
      workspaceName(ticket({ title: "Fix it \u2014 now" }), "{title:7}"),
    ).toBe("Fix it")
  })
})

describe("followsTemplate", () => {
  it("matches a name the template gave, whatever the parts were", () => {
    const template = "{id} [{priority}] {title} (due {due:MM/DD})"
    expect(
      followsTemplate(
        "ENG-12 [High] Old title (due 11/30)",
        "ENG-12",
        template,
      ),
    ).toBe(true)
    expect(followsTemplate("ENG-12 Old title", "ENG-12", template)).toBe(true)
    expect(followsTemplate("ENG-12 [Low] Old title", "ENG-12", template)).toBe(
      true,
    )
    expect(followsTemplate("ENG-12: Fix it", "ENG-12", "{id}: {title}")).toBe(
      true,
    )
    expect(followsTemplate("ENG-12", "ENG-12", "{id}: {title}")).toBe(true)
    expect(followsTemplate("#7 Fix", "#7", "#{id:short} {title}")).toBe(true)
  })

  it("doesn't match a name given by hand, or another issue's", () => {
    expect(followsTemplate("Login spike", "ENG-12", "{id}: {title}")).toBe(
      false,
    )
    expect(followsTemplate("ENG-13: Fix it", "ENG-12", "{id}: {title}")).toBe(
      false,
    )
    expect(followsTemplate("Fix it (ENG-12)", "ENG-12", "{id}: {title}")).toBe(
      false,
    )
    expect(followsTemplate("ENG-12: Fix it", "ENG-12", "{title}")).toBe(false)
    expect(followsTemplate("ENG-1.: x", "ENG-12", "{id}: {title}")).toBe(false)
  })
})

describe("refreshName", () => {
  const template = "{id} [{priority}] {title} (due {due:MMM D})"
  const now = ticket({
    title: "Fix login",
    priority: "urgent",
    dueDate: "2026-12-01",
  })

  it("renames a name the template gave when the issue changed", () => {
    expect(
      refreshName(
        now,
        { name: "ENG-12 [High] Fix logins (due Nov 30)" },
        template,
      ),
    ).toEqual({
      action: "rename",
      name: "ENG-12 [Urgent] Fix login (due Dec 1)",
      from: "ENG-12 [High] Fix logins (due Nov 30)",
    })
    expect(
      describeRefresh(
        refreshName(
          ticket({ title: "Fix login" }),
          { name: "ENG-12 Fix it (due Nov 30)" },
          template,
        ),
      ),
    ).toBe(
      'RENAME name="ENG-12 [High] Fix login" from="ENG-12 Fix it (due Nov 30)" section=keep',
    )
  })

  it("keeps a name that fits and leaves one given by hand", () => {
    expect(
      refreshName(
        now,
        { name: "ENG-12 [Urgent] Fix login (due Dec 1)" },
        template,
      ),
    ).toEqual({ action: "keep", name: "ENG-12 [Urgent] Fix login (due Dec 1)" })
    expect(refreshName(now, { name: "Login spike" }, template)).toEqual({
      action: "leave",
      name: "Login spike",
      reason: "named by hand",
    })
    expect(describeRefresh(refreshName(now, { name: "Old" }, "{title}"))).toBe(
      'LEAVE name="Old" reason="tickets.workspaceName has no {id}"',
    )
  })

  it("moves a workspace filed by rank to its priority's section", () => {
    expect(
      refreshName(
        now,
        { name: "ENG-12 [Urgent] Fix login (due Dec 1)", section: "High" },
        template,
      ),
    ).toMatchObject({ action: "rename", section: "Urgent" })
    expect(
      refreshName(
        now,
        { name: "ENG-12 [Urgent] Fix login (due Dec 1)", section: "Bugs" },
        template,
      ),
    ).toMatchObject({ action: "keep" })
    expect(
      refreshName(now, { name: "Mine", section: "High" }, template),
    ).toMatchObject({ action: "leave" })
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

  it("leaves out a read-only tracker's issues only when asked to", () => {
    const issues = [
      assigned("ENG-1", { priority: "high" }),
      assigned("NOAH-2", { priority: "urgent", link: true }),
    ]
    expect(queue(issues, []).map((i) => i.id)).toEqual(["NOAH-2", "ENG-1"])
    expect(
      queue(issues, [], undefined, { linked: false }).map((i) => i.id),
    ).toEqual(["ENG-1"])
  })

  it("counts a workspace in another project of the workspace app as started", () => {
    const issues = [assigned("ENG-1"), assigned("ENG-2")]
    const elsewhere = [
      { integration: "superset", id: "w1", branch: "sam/eng-1-fix-login" },
    ]
    expect(queue(issues, elsewhere).map((i) => i.id)).toEqual(["ENG-2"])
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
      'TICKET ENG-1 "Urgent" due=none filed=unknown [Todo] blocks-other-work "ENG-1" https://tracker/ENG-1',
    )
  })

  it("says when a ticket was filed and who filed it", () => {
    expect(
      describeTicket(
        assigned("ENG-1", {
          createdAt: "2026-10-30T14:02:11.000Z",
          creator: "Sam Lee",
          dueDate: "2026-11-20",
        }),
      ),
    ).toBe(
      'TICKET ENG-1 "Medium" due=2026-11-20 filed=2026-10-30 by="Sam Lee" "ENG-1" https://tracker/ENG-1',
    )
    // A date with no author still shows; an author with no date does too.
    expect(
      describeTicket(assigned("ENG-1", { createdAt: "2026-10-30" })),
    ).toContain(" filed=2026-10-30 ")
    expect(describeTicket(assigned("ENG-1", { creator: "Sam" }))).toContain(
      ' filed=unknown by="Sam" ',
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

describe("pickRepository", () => {
  const here: Repository = {
    name: "ai-assistant",
    remote: "github.com/bitfab/ai-assistant",
    path: "/code/ai-assistant",
    current: true,
  }
  const noah: Repository = {
    name: "Noah Server",
    remote: "github.com/bitfab/noah-server",
    path: "/code/noah-server",
  }
  const web: Repository = { name: "web", remote: null, path: null }
  const repositories = [here, noah, web]
  const issue = (title: string, description = "", project?: string) => ({
    title,
    description,
    project,
  })
  const none = () => false

  it("reads a name with regex characters as plain text", () => {
    const dotted: Repository = { name: "web.v2", remote: null, path: null }
    expect(
      pickRepository(issue("Lands in web.v2"), [here, dotted], new Map(), none),
    ).toMatchObject({ repository: dotted, from: "named" })
    expect(
      pickRepository(issue("Lands in webxv2"), [here, dotted], new Map(), none),
    ).toMatchObject({ from: "unsure" })
  })

  it("takes the only repository there is", () => {
    expect(pickRepository(issue("Anything"), [here], new Map(), none)).toEqual({
      repository: here,
      from: "only",
    })
  })

  it("takes the one repository the issue names, by name, folder, or remote", () => {
    for (const text of [
      "The scenarios live in noah-server",
      "See bitfab/noah-server#12",
      "In Noah Server, add a bottle",
    ]) {
      expect(
        pickRepository(issue("Bottle", text), repositories, new Map(), none),
      ).toEqual({ repository: noah, from: "named" })
    }
  })

  it("doesn't read a longer word or a link as the repository's name", () => {
    expect(
      pickRepository(
        issue(
          "Bottle",
          "Like noah-server-legacy did. https://github.com/bitfab/noah-server/pull/3",
        ),
        repositories,
        new Map(),
        none,
      ),
    ).toEqual({ from: "unsure", candidates: [] })
  })

  it("leaves names under three letters and the branch line out", () => {
    expect(
      pickRepository(
        issue("Fix the web view", "> Branch: `ai-assistant-fix`\n\nIt breaks."),
        [here, noah, { name: "ui" }],
        new Map(),
        none,
      ),
    ).toEqual({ from: "unsure", candidates: [] })
  })

  it("maps the issue's tracker project when it names no one repository", () => {
    const mapping = new Map([["scenarios", "noah-server"]])
    expect(
      pickRepository(
        issue("Create a bottle", "", "Scenarios"),
        repositories,
        mapping,
        none,
      ),
    ).toEqual({ repository: noah, from: "project" })
    // A repository the issue names wins over its project's.
    expect(
      pickRepository(
        issue("Create a bottle in ai-assistant", "", "Scenarios"),
        repositories,
        mapping,
        none,
      ),
    ).toEqual({ repository: here, from: "named" })
    // A mapping to a repository the integration doesn't list is no answer.
    expect(
      pickRepository(
        issue("Create a bottle", "", "Scenarios"),
        [here, web],
        mapping,
        none,
      ),
    ).toEqual({ from: "unsure", candidates: [] })
  })

  it("takes the checkout that holds the paths the issue names", () => {
    const exists = (file: string) =>
      file === "/code/noah-server/src/scenarios/generate.ts"
    expect(
      pickRepository(
        issue(
          "Bottle",
          "Change `src/scenarios/generate.ts` and src/bottle.ts.",
        ),
        repositories,
        new Map(),
        exists,
      ),
    ).toEqual({ repository: noah, from: "code" })
    // Among the repositories it names, when it names several.
    expect(
      pickRepository(
        issue(
          "Bottle",
          "Opened in ai-assistant, but src/scenarios/generate.ts is in noah-server.",
        ),
        repositories,
        new Map(),
        exists,
      ),
    ).toEqual({ repository: noah, from: "code" })
  })

  it("is unsure when two checkouts hold as many of its paths, never defaulting to this one", () => {
    expect(
      pickRepository(
        issue("Bottle", "Change src/index.ts"),
        repositories,
        new Map(),
        () => true,
      ),
    ).toEqual({ from: "unsure", candidates: [] })
    expect(
      pickRepository(
        issue("ai-assistant and noah-server both"),
        repositories,
        new Map(),
        none,
      ),
    ).toEqual({ from: "unsure", candidates: [here, noah] })
  })

  it("describes the pick for the TICKET line", () => {
    expect(describeRepository({ repository: here, from: "named" })).toBe(
      ' repo="ai-assistant" from=named here',
    )
    expect(describeRepository({ repository: noah, from: "project" })).toBe(
      ' repo="Noah Server" from=project',
    )
    expect(describeRepository({ from: "unsure", candidates: [] })).toBe(
      " repo=?",
    )
    expect(
      describeRepository({ from: "unsure", candidates: [here, noah] }),
    ).toBe(' repo=? candidates="ai-assistant,Noah Server"')
  })
})

describe("namedPaths", () => {
  it("reads repo-relative paths and leaves links and absolute paths out", () => {
    expect(
      namedPaths(
        "Change `src/a.ts`, ./lib/b.ts. and packages/dev/flows. See https://x.dev/src/c.ts and /etc/hosts.",
      ),
    ).toEqual(["src/a.ts", "lib/b.ts", "packages/dev/flows"])
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

describe("untracked work in a new workspace", () => {
  it("names it after its title, on a branch from it, in this one's section", () => {
    const start = planUntracked("Move the hooks into bridges/", [
      { branch: "main", section: "Refactors", current: true },
    ])
    expect(describeUntracked(start, "p.md")).toBe(
      'START "Move the hooks into bridges/" name="Move the hooks into bridges/" branch=move-the-hooks-into-bridges exact=no section="Refactors" state=keep prompt=p.md',
    )
    expect(
      planUntracked("x", [{ current: true, section: "A" }], { section: null }),
    ).toMatchObject({ section: null })
    expect(
      planUntracked("x", [{ current: true, section: "A" }], {
        otherRepository: true,
      }),
    ).toMatchObject({ section: null })
    expect(() => planUntracked("!!", [])).toThrow(/no letters or digits/)
  })

  it("starts nothing when a workspace is already on its branch", () => {
    expect(
      describeUntracked(
        planUntracked("Try the cache", [
          { name: "cache", branch: "sam/try-the-cache" },
        ]),
      ),
    ).toBe('EXISTS "Try the cache" workspace="cache" branch=sam/try-the-cache')
  })

  it("hands the agent the title and the notes", () => {
    expect(untrackedPrompt("Try the cache", "Use redis.\n")).toBe(
      "Work on: Try the cache\n\nUse redis.\n",
    )
    expect(untrackedPrompt("Try the cache", "Try the cache")).toBe(
      "Work on: Try the cache\n",
    )
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

  it("plans untracked work from --title and --notes", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const input = path.join(dir, "start.json")
    const notes = path.join(dir, "notes.md")
    fs.writeFileSync(input, JSON.stringify({ workspaces: [] }))
    fs.writeFileSync(notes, "Keep the behaviour the same.")
    const out = capture([
      "plan",
      "--input",
      input,
      "--title",
      "Try the cache",
      "--notes",
      notes,
      "--no-section",
    ])
    const prompt = path.join(dir, "prompts", "try-the-cache.md")
    expect(out).toBe(
      `START "Try the cache" name="Try the cache" branch=try-the-cache exact=no section=none state=keep prompt=${prompt}`,
    )
    expect(fs.readFileSync(prompt, "utf8")).toBe(
      "Work on: Try the cache\n\nKeep the behaviour the same.\n",
    )
    fs.writeFileSync(input, JSON.stringify({ tickets: [ticket()] }))
    capture(["plan", "--input", input, "--title", "x"])
    expect(process.exitCode).toBe(2)
  })

  it("takes --workspaces-repository as no section in the other repository", () => {
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
    expect(
      capture(["plan", "--input", input, "--workspaces-repository"]),
    ).toContain("section=none")
  })

  it("says what a workspace's name becomes from its issue", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const input = path.join(dir, "name.json")
    fs.writeFileSync(
      input,
      JSON.stringify({
        ticket: ticket({ title: "Fix login" }),
        workspace: { name: "ENG-12: Fix it", section: null },
      }),
    )
    expect(capture(["name", "--input", input])).toBe(
      'RENAME name="ENG-12: Fix login" from="ENG-12: Fix it" section=keep',
    )
    fs.writeFileSync(input, JSON.stringify({ ticket: ticket() }))
    capture(["name", "--input", input])
    expect(process.exitCode).toBe(2)
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

  it("writes a document link the MCP showed as a tag back as the link", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    const file = path.join(dir, "description.md")
    fs.writeFileSync(
      file,
      '> Planning: <document id="d1" label="Plan" href="https://l/d/1" />\n\nThe work.',
    )
    capture(["branch-line", "--description", file, "--branch", "b"])
    expect(fs.readFileSync(file, "utf8")).toBe(
      "> Branch: `b`\n> Planning: [Plan](https://l/d/1)\n\nThe work.\n",
    )
  })

  it("names sections and TICKET lines after the config's tickets.ranks", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
    fs.mkdirSync(path.join(dir, ".agent-flows"))
    fs.writeFileSync(
      path.join(dir, ".agent-flows", "config.json"),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        tickets: { ranks: ["Urgent", "P0", "P1", "P2", "Audit"] },
      }),
    )
    const issue = (id: string, priority: string) => ({
      id,
      title: id,
      url: `https://tracker/${id}`,
      priority,
    })
    fs.writeFileSync(
      path.join(dir, "issues.json"),
      JSON.stringify({
        issues: [issue("ENG-1", "high"), issue("ENG-2", "medium")],
      }),
    )
    fs.writeFileSync(
      path.join(dir, "start.json"),
      JSON.stringify({ tickets: [ticket({ priority: "high" })] }),
    )
    const cli = (args: string[]) =>
      execFileSync(
        "node",
        [path.join(import.meta.dirname, "work.ts"), ...args],
        { cwd: dir, encoding: "utf8" },
      )
    expect(cli(["list", "--input", "issues.json", "--priority", "p1"])).toBe(
      'TICKET ENG-2 "P1" due=none filed=unknown "ENG-2" https://tracker/ENG-2\nCOUNT 1\nTOTAL 2\n',
    )
    expect(
      cli(["plan", "--input", "start.json", "--section-by-rank"]),
    ).toContain('section="P0"')
    // --ranks still wins over the config.
    expect(
      cli([
        "plan",
        "--input",
        "start.json",
        "--section-by-rank",
        "--ranks",
        "Now,Next,Soon,Later,Someday",
      ]),
    ).toContain('section="Next"')
  })

  it("ends each TICKET line with the repository its work lands in", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-"))
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
    fs.mkdirSync(path.join(dir, ".agent-flows"))
    fs.writeFileSync(
      path.join(dir, ".agent-flows", "config.json"),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        tickets: { repositories: ["Scenarios=noah-server"] },
      }),
    )
    const issue = (id: string, extra: object = {}) => ({
      id,
      title: id,
      url: `https://tracker/${id}`,
      priority: "high",
      ...extra,
    })
    fs.writeFileSync(
      path.join(dir, "issues.json"),
      JSON.stringify({
        issues: [
          issue("ENG-1", { project: "Scenarios" }),
          issue("ENG-2", { description: "Lives in ai-assistant." }),
          issue("ENG-3"),
        ],
        repositories: [
          { name: "ai-assistant", path: null, current: true },
          { name: "noah-server", path: null },
        ],
      }),
    )
    const out = execFileSync(
      "node",
      [
        path.join(import.meta.dirname, "work.ts"),
        "list",
        "--input",
        "issues.json",
      ],
      { cwd: dir, encoding: "utf8" },
    )
    expect(out.split("\n").slice(0, 3)).toEqual([
      'TICKET ENG-1 "High" due=none filed=unknown "ENG-1" https://tracker/ENG-1 repo="noah-server" from=project',
      'TICKET ENG-2 "High" due=none filed=unknown "ENG-2" https://tracker/ENG-2 repo="ai-assistant" from=named here',
      'TICKET ENG-3 "High" due=none filed=unknown "ENG-3" https://tracker/ENG-3 repo=?',
    ])
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

describe("the open lock", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it("lets one holder in at a time, and the next in once it's released", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
    const lock = path.join(dir, "locks", "open.lock")
    const first = takeLock(lock, 0)
    expect(first).toBeDefined()
    expect(takeLock(lock, 0)).toBeUndefined()
    expect(releaseLock(lock, "someone else")).toBe(false)
    expect(releaseLock(lock, first as string)).toBe(true)
    expect(takeLock(lock, 0)).toBeDefined()
  })

  it("takes over a lock left by a run that died", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
    const lock = path.join(dir, "open.lock")
    expect(takeLock(lock, 0)).toBeDefined()
    const later = () => Date.now() + 11 * 60 * 1000
    expect(takeLock(lock, 0, { now: later })).toBeDefined()
  })

  it("never lets two starts running side by side hold it at once", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const log = path.join(dir, "log")
    const work = path.join(import.meta.dirname, "work.ts")
    // Each holds the lock for a moment, logging when it goes in and out.
    const script = `
      set -e
      token=$(node "${work}" lock --wait 30 | sed 's/^LOCKED //')
      echo in >> "${log}"
      sleep 0.2
      echo out >> "${log}"
      node "${work}" unlock --token "$token"
    `
    const runs = Array.from(
      { length: 4 },
      () =>
        new Promise<number | null>((resolve) =>
          spawn("sh", ["-c", script], { cwd: dir }).on("exit", resolve),
        ),
    )
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0])
    expect(fs.readFileSync(log, "utf8")).toBe("in\nout\n".repeat(4))
  }, 30000)

  it("prints BUSY when it's held past --wait, and NOT-HELD for a stale token", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const cli = (args: string[]) => {
      try {
        return execFileSync(
          "node",
          [path.join(import.meta.dirname, "work.ts"), ...args],
          { cwd: dir, encoding: "utf8" },
        )
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        return `${failed.status} ${failed.stdout}`
      }
    }
    const token = cli(["lock"])
      .trim()
      .replace(/^LOCKED /, "")
    expect(cli(["lock", "--wait", "0"])).toBe("1 BUSY after 0s\n")
    expect(cli(["unlock", "--token", "nope"])).toBe("NOT-HELD\n")
    expect(cli(["unlock", "--token", token])).toBe("UNLOCKED\n")
    expect(cli(["unlock", "--token", token])).toBe("NOT-HELD\n")
  })
})
