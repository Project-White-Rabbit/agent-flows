import { describe, expect, it } from "vitest"
import { knownPaths } from "../commands/configure.ts"
import { findCapability } from "../config/integrations.ts"
import { configureFlow } from "./configure.ts"
import { renderAllSkills } from "./index.ts"
import { devKit } from "./kit.ts"
import { syncFlow } from "./sync.ts"

describe("dev flows", () => {
  const files = renderAllSkills()

  it("renders each flow's Claude Code skills", () => {
    expect(files.map((f) => f.path)).toEqual([
      "skills/configure/SKILL.md",
      "skills/evaluate/SKILL.md",
      "skills/evaluate-run/SKILL.md",
      "skills/sync/SKILL.md",
      "skills/sync-local/SKILL.md",
      "skills/sync-remote/SKILL.md",
      "skills/sync-report/SKILL.md",
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
      ]),
    )
    for (const id of asks) {
      expect(findCapability(id), id).toBeDefined()
    }
    const vendorFree = files.filter((f) => !f.path.includes("configure"))
    for (const file of vendorFree) {
      expect(file.content, file.path).not.toMatch(
        /\b(gh|glab|gt) |GitHub|GitLab|Graphite|Linear|Jira|Sentry|Lore/,
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
      ].flatMap((id) => Object.keys(findCapability(id)?.ops ?? {})),
    )
    const sync = files.filter((f) => f.path.includes("sync"))
    const named = sync.flatMap((f) =>
      [...f.content.matchAll(/`(\w+)` op/g)].map((m) => m[1]),
    )
    expect(named).toEqual(
      expect.arrayContaining(["prCreate", "searchIssues", "shareSession"]),
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
