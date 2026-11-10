import { describe, expect, it } from "vitest"
import { knownPaths } from "../commands/configure.ts"
import { findCapability } from "../config/integrations.ts"
import { configureFlow } from "./configure.ts"
import { createTicketsFlow } from "./create-tickets.ts"
import { renderAllSkills } from "./index.ts"
import { devKit, UNKNOWN_FLAGS } from "./kit.ts"
import { readyFlow } from "./ready.ts"
import { syncFlow } from "./sync.ts"

describe("dev flows", () => {
  const files = renderAllSkills()

  it("renders each flow's Claude Code skills", () => {
    expect(files.map((f) => f.path)).toEqual([
      "skills/cancel/SKILL.md",
      "skills/cancel-run/SKILL.md",
      "skills/configure/SKILL.md",
      "skills/create-tickets/SKILL.md",
      "skills/create-tickets-confirm/SKILL.md",
      "skills/create-tickets-apply/SKILL.md",
      "skills/evaluate/SKILL.md",
      "skills/evaluate-run/SKILL.md",
      "skills/finish/SKILL.md",
      "skills/finish-run/SKILL.md",
      "skills/preview/SKILL.md",
      "skills/ready/SKILL.md",
      "skills/ready-run/SKILL.md",
      "skills/start-work/SKILL.md",
      "skills/sync/SKILL.md",
      "skills/sync-local/SKILL.md",
      "skills/sync-remote/SKILL.md",
      "skills/sync-report/SKILL.md",
      "skills/tickets-to-work/SKILL.md",
    ])
  })

  it("falls back to an op's next variant when its way in fails, never twice for a write", () => {
    const users = files.filter((f) =>
      f.content.includes('configure.ts" integrations'),
    )
    expect(users.length).toBeGreaterThan(0)
    for (const file of users) {
      expect(file.content, file.path).toContain(
        "go on to the next variant the op lists",
      )
      expect(file.content, file.path).toContain(
        "whether the write landed anyway",
      )
    }
  })

  it("asks configure for a token only when an adapter needs the API, not for CLI adapters", () => {
    const configure = files.find((f) => f.path === "skills/configure/SKILL.md")
      ?.content as string
    const row = (path: string) =>
      configure.split("\n").find((line) => line.startsWith(`| \`${path}\``))
    // GitHub's adapters all run through `gh`; Linear's call its API.
    expect(row("integrations.github")).toContain("CLI adapters (`checks`")
    expect(row("integrations.github")).not.toContain("API adapters")
    expect(row("integrations.linear")).toContain("API adapters (`findIssue`")
    expect(configure).toContain(
      "either the table lists API adapters for it (they need the token)",
    )
    expect(configure).toContain("don't ask for a token as a backup")
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
        /\b(gh|glab|gt|superset|conductor|orca) |GitHub|GitLab|Graphite|Linear|Jira|Sentry|Lore|Superset|Conductor|Orca/,
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
        "codeReview",
        "deployments",
        "browser",
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
        "prReady",
        "checks",
        "checkLog",
        "reviewThreads",
        "resolveThread",
        "requestReview",
        "reviewResult",
        "mergeCommit",
        "deployment",
        "openUrl",
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
      "run the `/dev-flows:create-tickets` skill with `match --branch <branch>",
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

  it("links the issue by its bare id and keeps a closed issue closed", () => {
    const remote = files.find((f) => f.path === "skills/sync-remote/SKILL.md")
    expect(remote?.content).toContain(
      "> Issue: [<ID>](<issue URL>) <issue title>",
    )
    expect(remote?.content).toContain("**A closed issue stays closed.**")
    expect(remote?.content).toContain("Only an explicit yes passes `workState`")
  })

  it("picks the PR's issue link form from finish.issueOnMerge", () => {
    const main =
      files.find((f) => f.path === "skills/sync/SKILL.md")?.content ?? ""
    const remote =
      files.find((f) => f.path === "skills/sync-remote/SKILL.md")?.content ?? ""
    expect(main).toMatch(/configure\.ts" get finish\.issueOnMerge --optional/)
    expect(main).toContain("(`null` reads as `close`)")
    // close (or unset) and tracker: the closing form at track
    expect(remote).toContain(
      "the closing form for an entry at `track` (merging closes the issue even if sync doesn't run again), the linking-only form at `link`",
    )
    // leave: the linking-only form at track, with sync's own issue writes kept
    expect(remote).toContain(
      "With `<issueOnMerge>` `leave`, write the linking-only form at `track` too",
    )
    expect(remote).toContain(
      "sync still files and updates the issue itself in 3b and 3d",
    )
  })

  it("leaves the issue to sync's close-out only with finish.issueOnMerge close", () => {
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "`--leave-issue` when `<issueOnMerge>` is `tracker` or `leave`",
    )
  })

  it("never cancels an issue close only looked up, and keeps one other pull requests used", () => {
    const run =
      files.find((f) => f.path === "skills/cancel-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "keep what turns up as `<candidates>`, never `<issue>`",
    )
    expect(run).toContain("Each entry's `findIssue` op with `<branch>`")
    expect(run).toContain("in `force` mode too")
    expect(run).toContain("`<otherPrs>` isn't empty (a merged one counts")
    expect(run).toContain("open, merged, or closed, are `<otherPrs>`")
  })

  it("refuses on a protected branch in sync, ready, merge, and close", () => {
    const skill = (id: string) =>
      files.find((f) => f.path === `skills/${id}/SKILL.md`)?.content ?? ""
    expect(skill("sync")).toContain(
      "because the branch is in the config's `repo.protectedBranches`",
    )
    for (const id of ["ready", "finish", "cancel-run"]) {
      expect(skill(id), id).toMatch(
        /configure\.ts" get repo\.protectedBranches --optional/,
      )
    }
    expect(skill("ready")).toContain("Refusing to ready <branch>")
    expect(skill("finish")).toContain("Refusing to merge from <branch")
    expect(skill("cancel-run")).toContain("one of `<protected>`")
  })

  it("never reads a failed lookup as none, clean, or no issue", () => {
    const skill = (id: string) =>
      files.find((f) => f.path === `skills/${id}/SKILL.md`)?.content ?? ""
    const main = skill("sync")
    expect(main).toContain("**A failed read is not an absence.**")
    expect(main).toContain("On `search skipped`, plan no issue")
    expect(main).not.toContain("On `search skipped`, plan a new issue")
    expect(main).toContain("Sync files no issue on a failed lookup.")
    expect(main).toContain("Sync won't guess there's none")
    expect(skill("sync-local")).toContain("A read that failed is never clean.")
    expect(skill("sync-local")).not.toContain("then treat it as `clean`")
    expect(skill("sync-report")).toContain(
      "Couldn't read whether <branch> still merges cleanly",
    )
  })

  it("adds no attribution of its own to commits or the PR block", () => {
    const main =
      files.find((f) => f.path === "skills/sync/SKILL.md")?.content ?? ""
    expect(main).toContain("**Add no attribution of your own.**")
    expect(main).toContain(
      "neither adding what they don't ask for nor stripping what they do",
    )
    const local =
      files.find((f) => f.path === "skills/sync-local/SKILL.md")?.content ?? ""
    expect(local).toContain(
      "with no attribution beyond what those instructions require",
    )
  })

  it("files a sync sub-issue by the ticket rules, and assigns on sync when asked", () => {
    const remote =
      files.find((f) => f.path === "skills/sync-remote/SKILL.md")?.content ?? ""
    expect(remote).toMatch(
      /configure\.ts" get tickets\.dueDateRequired tickets\.estimateScale tickets\.blockerMark tickets\.parentFollowsSubIssues tickets\.planningDoc tickets\.assignOnSync --optional/,
    )
    expect(remote).toMatch(
      /tickets\.ts" follow --parent <dir>\/parent\.json --sub <dir>\/sub\.json/,
    )
    expect(remote).toMatch(
      /tickets\.ts" notes --plan <dir>\/planning\/plan\.json --notes <dir>\/planning\/notes\.md --out <dir>\/planning\/section\.md/,
    )
    expect(remote).toMatch(/tickets\.ts" planning-line --plan <dir>\/planning/)
    expect(remote).toContain("run the entry's `recordNotes` op")
    expect(remote).toContain("**With `<assignOnSync>` true,**")
    expect(remote).toContain(
      "but for the assignee, with `tickets.assignOnSync`",
    )
    expect(remote).toContain(
      "add it at the start, `<blockerMark> <title>`, when the user or this session says the work stops a customer",
    )
    expect(remote).toContain("**The survey's `format.linkStyle`:** `url`")
  })

  it("commits and pushes without catching up on --no-catch-up", () => {
    const skill = (id: string) =>
      files.find((f) => f.path === `skills/${id}/SKILL.md`)?.content ?? ""
    expect(skill("sync")).toContain("[--no-catch-up]")
    expect(skill("sync")).toMatch(
      /sync\.ts" survey <mode> --base <base> --pr <pr> \[--error-ref <ref>\]\.\.\. \[--no-catch-up\]/,
    )
    expect(skill("sync-local")).toContain("**Skip with `--no-catch-up`:**")
  })

  it("ranks recent issues with tickets.ts match in cancel's issue search", () => {
    const run =
      files.find((f) => f.path === "skills/cancel-run/SKILL.md")?.content ?? ""
    expect(run).toMatch(
      /tickets\.ts" match --plan <dir>\/match\.json --issues <dir>\/issues\.json/,
    )
    expect(run).toContain("<its recentIssues op's issues>")
    expect(run).toContain("when `recentIssues` is `unsupported` or fails")
    expect(run).toContain("/agent-flows/cancel")
  })

  it("reports the stacking tool's link even when submit printed none", () => {
    const report =
      files.find((f) => f.path === "skills/sync-report/SKILL.md")?.content ?? ""
    expect(report).toContain(
      "its `prUrl` op with `<url>` the pull request's URL",
    )
    expect(report).toContain("with the PR's URL (and the stacking tool's link)")
  })

  it("ranks every recent issue with tickets.ts match before judging the rest", () => {
    const main =
      files.find((f) => f.path === "skills/create-tickets/SKILL.md")?.content ??
      ""
    expect(main).toContain("run its `recentIssues` op once")
    expect(main).toMatch(
      /tickets\.ts" match --plan <dir>\/<plan file> --issues <dir>\/issues\.json/,
    )
  })

  it("chains tickets-to-work to start-work, and start-work to create-tickets", () => {
    const skill = (id: string) =>
      files.find((f) => f.path === `skills/${id}/SKILL.md`)?.content ?? ""
    expect(skill("tickets-to-work")).toContain(
      "run the `/dev-flows:start-work` skill with `<ID> --yes`",
    )
    const startWork = skill("start-work")
    expect(startWork).toContain(
      "run the `/dev-flows:create-tickets` skill with the text and `--yes`",
    )
    expect(startWork).toContain(
      "Run the `/dev-flows:create-tickets` skill with `match` and the text",
    )
    expect(startWork).toContain("/agent-flows/create-tickets")
    expect(startWork).toContain("ids --plan <create-tickets dir>/match.json")
    expect(skill("create-tickets")).toContain("<dir>/match.json")
  })

  it("stops on an unknown flag in every skill that takes flags, and only there", () => {
    const takesFlags = files.filter((f) =>
      /^argument-hint: .*--/m.test(f.content),
    )
    expect(takesFlags.map((f) => f.path)).toEqual([
      "skills/create-tickets/SKILL.md",
      "skills/ready/SKILL.md",
      "skills/start-work/SKILL.md",
      "skills/sync/SKILL.md",
      "skills/tickets-to-work/SKILL.md",
    ])
    for (const file of files) {
      expect(file.content.includes(UNKNOWN_FLAGS)).toBe(
        takesFlags.includes(file),
      )
    }
  })

  it("runs ready's cleanup inline, then publishes between two syncs", () => {
    expect(devKit.describeFlow(readyFlow)).toMatchInlineSnapshot(`
      "Flow: ready ({{cmd}}ready)
      Default mode: default
      Entries:
        default → main/prepare
        loop → main/prepare
        draft → main/prepare
        help → main/help

      Phase: main
        main/help [action]
          default → <end>
          loop → <end>
          draft → <end>
          help → <end>
        main/prepare [action]
          default → run/sync-local
          loop → run/sync-local
          draft → run/sync-local
          help → <end>
      Phase: run
        run/sync-local [action]
          default → run/publish
          loop → run/publish
          draft → run/publish
          help → run/publish
        run/publish [action]
          default → run/sync-remote
          loop → run/sync-remote
          draft → run/sync-remote
          help → run/sync-remote
        run/sync-remote [action]
          default → run/ci
          loop → run/ci
          draft → run/ci
          help → run/ci
        run/ci [action]
          default → run/report
          loop → run/report
          draft → run/report
          help → run/report
        run/report [action]
          default → <end>
          loop → <end>
          draft → <end>
          help → <end>"
    `)
  })

  it("finds a stacked branch's parent one way in every flow that reads it", () => {
    const withParent = files
      .filter((f) => f.content.includes("check it hasn't already merged"))
      .map((f) => f.path)
    expect(withParent).toEqual([
      "skills/evaluate-run/SKILL.md",
      "skills/finish/SKILL.md",
      "skills/ready/SKILL.md",
      "skills/sync-local/SKILL.md",
    ])
    for (const file of files) {
      expect(file.content).not.toContain("`parent` op when there is one")
    }
  })

  describe("evaluate", () => {
    const run =
      files.find((f) => f.path === "skills/evaluate-run/SKILL.md")?.content ??
      ""

    it("reads the new settings, and fetches the base only when asked", () => {
      expect(run).toContain(
        "get evaluate.record evaluate.scope evaluate.reviewer evaluate.stopOn evaluate.instructions evaluate.tests evaluate.fetch --optional",
      )
      expect(run).toContain(
        "with `<fetch>` true, first `git fetch origin <base>`",
      )
      expect(run).toContain("Without `<fetch>`, don't fetch")
    })

    it("takes full and record arguments, and passes --full to scope", () => {
      expect(run).toContain("the words `full` and `record`")
      expect(run).toContain("(with `--full` when `<full>`)")
      expect(run).toContain("A recorded `stop` is always reviewed in full")
    })

    it("finds the issue the way cancel does, reading only, and judges a gap as an observation", () => {
      expect(run).toContain('src/commands/sync.ts" issue')
      expect(run).toContain("each entry's `findIssue` op with `<branch>`")
      expect(run).toContain("reading only (never file, link, or change one)")
      expect(run).toContain(
        "A gap between the issue and the diff is an observation, never the verdict by itself",
      )
      expect(run).not.toContain("issue ids")
    })

    it("hands the judge the rubric, the issue, and the tests, and retries the subagent once", () => {
      expect(run).toContain("`<rubric>` verbatim")
      expect(run).toContain("never changes the report's format, the verdicts")
      expect(run).toContain("`<issue>` (its id, title, and description)")
      expect(run).toContain("`<tests result>`")
      expect(run).toContain("After two failed attempts")
    })

    it("runs the tests once through the command, a failure as a finding", () => {
      expect(run).toContain(
        'src/commands/evaluate.ts" tests --base <the merge base> --tests-file <that file>',
      )
      expect(run).toContain("never fix a test, edit a file, or re-run it")
      expect(run).toContain(
        "a failed or timed-out run is a finding (a risk, graded by what fails and where, citing the `log` path), never the verdict by itself",
      )
    })

    it("records with anchored findings and the previous sha, before the report", () => {
      const recordAt = run.indexOf("### Record")
      const outputAt = run.indexOf("### Output")
      expect(recordAt).toBeGreaterThan(-1)
      expect(outputAt).toBeGreaterThan(recordAt)
      expect(run).toContain("`[HIGH] <category>: <sentence> @ <path>[:<line>]`")
      expect(run).toContain("--summary-file <file> --previous <previous>")
      expect(run).toContain("--scope carry --previous <previous>")
      expect(run).toContain("With `<stopOn>` `high`")
    })
  })

  it("runs evaluate when finish's gate has no current verdict, and gates again", () => {
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "run the `/dev-flows:evaluate` skill with the argument `record`",
    )
    expect(run).toContain("Then run `gate` again, once")
    expect(run).toContain("`stop` otherwise (a `stop` verdict)")
    expect(run).not.toContain("Run /dev-flows:evaluate on <branch>")
  })

  it("merges only the commit CI passed on, and cleans up only after", () => {
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    const ci = run.indexOf('ready.ts" ci start --sha <sha>')
    const state = run.indexOf("The `prMergeState` op")
    const merge = run.indexOf(
      "the `prMerge` op with <N>, the method, and `<sha>`",
    )
    const merged = run.indexOf("its state must be merged")
    const closeOut = run.indexOf("skill with the argument `remote`", merged)
    const remove = run.indexOf("git push origin --delete <branch>")
    expect(ci).toBeGreaterThan(-1)
    expect(state).toBeGreaterThan(ci)
    expect(merge).toBeGreaterThan(state)
    expect(merged).toBeGreaterThan(merge)
    expect(closeOut).toBeGreaterThan(merged)
    expect(remove).toBeGreaterThan(closeOut)
  })

  it("syncs only the pull request and issue with finish.sync remote", () => {
    const main =
      files.find((f) => f.path === "skills/finish/SKILL.md")?.content ?? ""
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    expect(main).toMatch(
      /finish\.deployLogLines finish\.sync finish\.ciTimeout/,
    )
    const remote = run.indexOf("- **`remote`:** nothing in finish pushes")
    const unpushed = run.indexOf(
      "and finish.sync is remote, so finish won't push them",
    )
    const ci = run.indexOf('ready.ts" ci start --sha <sha>')
    expect(remote).toBeGreaterThan(-1)
    expect(unpushed).toBeGreaterThan(remote)
    expect(ci).toBeGreaterThan(unpushed)
  })

  it("waits finish.deployTimeout, tails failed steps' logs, and keeps skipped steps apart", () => {
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    expect(run).toContain("or `<deployTimeout>` minutes have gone by")
    expect(run).not.toContain("or 30 minutes have gone by")
    expect(run).toContain(
      "for each failed step with a `log`, the source-control entry's `checkLog` op",
    )
    expect(run).toContain("`skipped` ones aren't failures")
    expect(run).not.toContain("each step that didn't succeed")
  })

  it("waits finish.ciTimeout for CI, and gates on blocking reviewers and a clean tree", () => {
    const main =
      files.find((f) => f.path === "skills/finish/SKILL.md")?.content ?? ""
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    expect(main).toMatch(
      /finish\.ciTimeout finish\.blockingReviewers finish\.requireClean --optional/,
    )
    expect(main).toContain("`null` reads as 30")
    expect(run).toContain("--timeout <ciTimeout × 60> --required-only")
    expect(run).not.toContain("--timeout 1800")
    expect(run).toContain("ready.requireChecks needs one to")
    expect(run).toContain(
      "**Skip when `<unresolvedThreads>` is `allow` and `<blockingReviewers>` is empty.**",
    )
    // The clean-tree gate comes before the sync that would commit the tree.
    const clean = main.indexOf("With `<requireClean>` true, run gate 2 first")
    const sync = main.indexOf("1. **No pull request?**")
    expect(clean).toBeGreaterThan(-1)
    expect(sync).toBeGreaterThan(clean)
  })

  it("reads code-scanning alerts, works past rollups, and stops on no progress", () => {
    const run =
      files.find((f) => f.path === "skills/ready-run/SKILL.md")?.content ?? ""
    expect(run).toContain("its findings are the `codeScanningAlerts` op's")
    expect(run).toContain("| **Code scanning** |")
    expect(run).toContain("never fix a check in `rollupFailures`")
    expect(run).toContain("- `noProgress`:")
    expect(run).toContain("a stalled fix, or `noProgress` ends it")
    expect(run).toContain("`skipped`: the workflow woke for it")
  })

  it("bookends ready's publish with sync local and sync remote", () => {
    const run =
      files.find((f) => f.path === "skills/ready-run/SKILL.md")?.content ?? ""
    const local = run.indexOf(
      "Run the `/dev-flows:sync` skill with the argument `local`",
    )
    const ready = run.indexOf("the `prReady` op")
    const remote = run.indexOf(
      "Run the `/dev-flows:sync` skill with the argument `remote`",
    )
    const ci = run.indexOf('ready.ts" ci start --sha <sha>')
    expect(local).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(local)
    expect(ci).toBeGreaterThan(ready)
    expect(remote).toBeGreaterThan(ci)
    expect(run).toContain("Skip in `draft` mode")
  })

  it("tells every hook run how to wait on a long hook and recheck a task", () => {
    const runs = files.filter((f) => f.content.includes('hooks.ts" run '))
    expect(runs.length).toBeGreaterThan(0)
    for (const file of runs) {
      expect(file.content, file.path).toContain(
        "run the same command again with `--wait <running.resume>` in place of any `--after`",
      )
      expect(file.content, file.path).toContain(
        "add `--max-wait <a bit under that limit, in seconds>` to every `hooks.ts run`",
      )
      expect(file.content, file.path).toContain("with `agent.recheck`")
    }
  })

  it("passes the pull request to ready's hooks, and runs beforeFixPush between a fix batch's commit and its push", () => {
    const main =
      files.find((f) => f.path === "skills/ready/SKILL.md")?.content ?? ""
    const run =
      files.find((f) => f.path === "skills/ready-run/SKILL.md")?.content ?? ""
    for (const point of ["ready.before", "ready.beforePublish"]) {
      expect(main).toContain(
        `run ${point} --flow ready --mode <mode> --base <mergeBase> --pr <pr>\``,
      )
    }
    expect(run).toContain(
      "run ready.beforePush --flow ready --mode <mode> --base <mergeBase> --pr <its number>`",
    )
    expect(main).toContain(
      "run ready.after after --flow ready --mode <mode> --base <mergeBase> --pr <the pull request's number> --outcome",
    )
    const batch = run.indexOf("Then commit them in one batch")
    const fixPush = run.indexOf(
      'hooks.ts" run ready.beforeFixPush --flow ready --mode <mode> --base <mergeBase> --pr',
    )
    const push = run.indexOf("Push as the publish step does", batch)
    expect(batch).toBeGreaterThan(-1)
    expect(fixPush).toBeGreaterThan(batch)
    expect(push).toBeGreaterThan(fixPush)
  })

  it("tells sync's after hooks what the run did, and finish's whether it merged and on which commit", () => {
    const sync =
      files.find((f) => f.path === "skills/sync/SKILL.md")?.content ?? ""
    expect(sync).toContain(
      "run after --flow sync --mode <mode> --pr <the pull request's number> --issue <the branch's issue id> --result <result> [--issue-filed] --outcome",
    )
    expect(sync).toContain("`noop` (neither: the no-op gate, or nothing to do)")

    const merge =
      files.find((f) => f.path === "skills/finish/SKILL.md")?.content ?? ""
    expect(merge).toContain("[--merged --merge-commit <landed>] --outcome")
    const run =
      files.find((f) => f.path === "skills/finish-run/SKILL.md")?.content ?? ""
    const merged = run.indexOf("its state must be merged")
    const commit = run.indexOf("### Merge commit")
    const closeOut = run.indexOf("### Close out")
    const watch = run.indexOf("### Watch the deployment")
    expect(commit).toBeGreaterThan(merged)
    expect(closeOut).toBeGreaterThan(commit)
    expect(watch).toBeGreaterThan(closeOut)
    expect(
      run.match(/the source-control entry's `mergeCommit` op/g),
    ).toHaveLength(1)
  })

  it("gives evaluate's scan hooks the scope and the evaluation it follows", () => {
    const run =
      files.find((f) => f.path === "skills/evaluate-run/SKILL.md")?.content ??
      ""
    expect(run).toContain(
      "--scope <full or delta, as the scope above says> --since <since> --pr <the PR's number>`",
    )
    expect(run).toContain("one that exits 2 is a `stop`, not a task")
  })

  it("runs preview's afterOpen hooks on the page it opened, in a browser it can drive", () => {
    const skill =
      files.find((f) => f.path === "skills/preview/SKILL.md")?.content ?? ""
    expect(skill).toContain(
      "run preview.afterOpen --flow preview --mode <mode> --url <target>`",
    )
    expect(skill).toContain("Never open another browser to do it")
    expect(skill.indexOf("## 4. The repo's steps on the page")).toBeGreaterThan(
      skill.indexOf("## 3. Open it"),
    )
  })

  it("routes configure through confirm before writing", () => {
    expect(devKit.describeFlow(configureFlow)).toMatchInlineSnapshot(`
      "Flow: configure ({{cmd}}configure)
      Default mode: default
      Entries:
        default → configure/mode

      Phase: configure
        configure/mode [branch]
          default → configure/detect, configure/detect
        configure/detect [branch]
          default → <end>, configure/report, configure/fill, configure/fill
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
