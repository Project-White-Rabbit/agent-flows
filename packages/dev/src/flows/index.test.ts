import { describe, expect, it } from "vitest"
import { knownPaths } from "../commands/configure.ts"
import { findCapability } from "../config/integrations.ts"
import { configureFlow } from "./configure.ts"
import { createTicketsFlow } from "./create-tickets.ts"
import { renderAllSkills } from "./index.ts"
import { devKit } from "./kit.ts"
import { syncFlow } from "./sync.ts"

describe("dev flows", () => {
  const files = renderAllSkills()

  it("renders each flow's Claude Code skills", () => {
    expect(files.map((f) => f.path)).toEqual([
      "skills/configure/SKILL.md",
      "skills/create-tickets/SKILL.md",
      "skills/create-tickets-confirm/SKILL.md",
      "skills/create-tickets-apply/SKILL.md",
      "skills/evaluate/SKILL.md",
      "skills/evaluate-run/SKILL.md",
      "skills/start-work/SKILL.md",
      "skills/sync/SKILL.md",
      "skills/sync-local/SKILL.md",
      "skills/sync-remote/SKILL.md",
      "skills/sync-report/SKILL.md",
      "skills/tickets-to-work/SKILL.md",
    ])
  })

  it("runs commands from the installed plugin root", () => {
    for (const file of files.filter((f) => f.content.includes("node "))) {
      expect(file.content).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable in rendered markdown
        'node "${CLAUDE_PLUGIN_ROOT}/src/commands/',
      )
    }
  })

  it("only reads config paths that exist", () => {
    const known = knownPaths()
    const reads = files.flatMap((f) =>
      [...f.content.matchAll(/configure\.ts" get ((?:[\w.]+ ?)+)/g)].flatMap(
        (m) => m[1].trim().split(" "),
      ),
    )
    expect(reads).toContain("repo.baseBranch")
    for (const path of reads) {
      expect(known.has(path), path).toBe(true)
    }
  })

  it("only asks for capabilities that exist, never a vendor", () => {
    const asks = files.flatMap((f) =>
      [
        ...f.content.matchAll(/configure\.ts" integrations ((?:\w+ ?)+)/g),
      ].flatMap((m) => m[1].trim().split(" ")),
    )
    expect(asks).toEqual(
      expect.arrayContaining([
        "sourceControl",
        "stacking",
        "issueTracker",
        "errorTracking",
        "sessions",
        "workspaces",
      ]),
    )
    for (const id of asks) {
      expect(findCapability(id), id).toBeDefined()
    }
    const vendorFree = files.filter((f) => !f.path.includes("configure"))
    for (const file of vendorFree) {
      expect(file.content, file.path).not.toMatch(
        /\b(gh|glab|gt|superset|conductor) |GitHub|GitLab|Graphite|Linear|Jira|Sentry|Lore|Superset|Conductor/,
      )
    }
  })

  it("only calls ops the capabilities declare", () => {
    const ops = new Set(
      [
        "sourceControl",
        "stacking",
        "issueTracker",
        "errorTracking",
        "sessions",
        "workspaces",
      ].flatMap((id) => Object.keys(findCapability(id)?.ops ?? {})),
    )
    const flows = files.filter((f) => !f.path.includes("configure"))
    const named = flows.flatMap((f) =>
      [...f.content.matchAll(/`(\w+)` op/g)].map((m) => m[1]),
    )
    expect(named).toEqual(
      expect.arrayContaining([
        "prCreate",
        "searchIssues",
        "shareSession",
        "createIssue",
        "linkBlocked",
        "getIssue",
        "assignedIssues",
        "updateIssue",
        "workspaces",
        "createWorkspace",
      ]),
    )
    for (const op of named) {
      expect(ops.has(op), op).toBe(true)
    }
  })

  it("routes sync through the survey's gate to the report", () => {
    expect(devKit.describeFlow(syncFlow)).toMatchInlineSnapshot(`
      "Flow: sync ({{cmd}}sync)
      Default mode: default
      Entries:
        default → main/survey
        local → main/survey
        remote → main/survey
        help → main/help

      Phase: main
        main/help [action]
          default → <end>
          local → <end>
          remote → <end>
          help → <end>
        main/survey [action]
          default → local/local-git
          local → local/local-git
          remote → remote/remote-writes
          help → <end>
      Phase: local
        local/local-git [action]
          default → remote/remote-writes
          local → report/report
          remote → <end>
          help → <end>
      Phase: remote
        remote/remote-writes [action]
          default → report/report
          local → report/report
          remote → report/report
          help → report/report
      Phase: report
        report/report [action]
          default → <end>
          local → <end>
          remote → <end>
          help → <end>"
    `)
  })

  it("stops create-tickets' match mode before it can confirm or file", () => {
    expect(devKit.describeFlow(createTicketsFlow)).toMatchInlineSnapshot(`
      "Flow: create-tickets ({{cmd}}create-tickets)
      Default mode: default
      Entries:
        default → main/read
        match → main/read
        help → main/help

      Phase: main
        main/help [action]
          default → <end>
          match → <end>
          help → <end>
        main/read [action]
          default → main/draft
          match → main/draft
          help → main/draft
        main/draft [action]
          default → main/match
          match → main/match
          help → main/match
        main/match [action]
          default → confirm/confirm
          match → <end>
          help → <end>
      Phase: confirm
        confirm/confirm [action]
          default → apply/apply
          match → apply/apply
          help → apply/apply
      Phase: apply
        apply/apply [action]
          default → <end>
          match → <end>
          help → <end>"
    `)
  })

  it("finds sync's issue through create-tickets' match mode", () => {
    const sync = files.find((f) => f.path === "skills/sync/SKILL.md")
    expect(sync?.content).toContain(
      "run the `/agent-flows:create-tickets` skill with `match --branch <branch>",
    )
    const matched = files.find(
      (f) => f.path === "skills/create-tickets/SKILL.md",
    )
    for (const line of [
      "match <ID>",
      "sub-issue of <ID>",
      "new",
      "closed:",
      "also tracked:",
      "search skipped",
    ]) {
      expect(matched?.content).toContain(line)
    }
  })

  it("chains tickets-to-work to start-work, and start-work to create-tickets", () => {
    const skill = (id: string) =>
      files.find((f) => f.path === `skills/${id}/SKILL.md`)?.content ?? ""
    expect(skill("tickets-to-work")).toContain(
      "run the `/agent-flows:start-work` skill with `<ID> --yes`",
    )
    const startWork = skill("start-work")
    expect(startWork).toContain(
      "run the `/agent-flows:create-tickets` skill with the text and `--yes`",
    )
    expect(startWork).toContain(
      "Run the `/agent-flows:create-tickets` skill with `match` and the text",
    )
    expect(startWork).toContain("/agent-flows/create-tickets")
    expect(startWork).toContain("ids --plan <create-tickets dir>/match.json")
    expect(skill("create-tickets")).toContain("<dir>/match.json")
  })

  it("routes configure through confirm before writing", () => {
    expect(devKit.describeFlow(configureFlow)).toMatchInlineSnapshot(`
      "Flow: configure ({{cmd}}configure)
      Default mode: default
      Entries:
        default → configure/detect

      Phase: configure
        configure/detect [branch]
          default → <end>, <end>, configure/fill, configure/fill
        configure/fill [action]
          default → configure/confirm
        configure/confirm [branch]
          default → configure/write, configure/fill, <end>
        configure/write [action]
          default → configure/report
        configure/report [action]
          default → <end>"
    `)
  })
})
