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
      "skills/close/SKILL.md",
      "skills/close-run/SKILL.md",
      "skills/configure/SKILL.md",
      "skills/create-tickets/SKILL.md",
      "skills/create-tickets-confirm/SKILL.md",
      "skills/create-tickets-apply/SKILL.md",
      "skills/evaluate/SKILL.md",
      "skills/evaluate-run/SKILL.md",
      "skills/merge/SKILL.md",
      "skills/merge-run/SKILL.md",
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
        "codeReview",
        "deployments",
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

  it("picks the PR's issue link form from merge.issueOnMerge", () => {
    const main =
      files.find((f) => f.path === "skills/sync/SKILL.md")?.content ?? ""
    const remote =
      files.find((f) => f.path === "skills/sync-remote/SKILL.md")?.content ?? ""
    expect(main).toMatch(/configure\.ts" get merge\.issueOnMerge --optional/)
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

  it("leaves the issue to sync's close-out only with merge.issueOnMerge close", () => {
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "`--leave-issue` when `<issueOnMerge>` is `tracker` or `leave`",
    )
  })

  it("never cancels an issue close only looked up, and keeps one other pull requests used", () => {
    const run =
      files.find((f) => f.path === "skills/close-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "keep what turns up as `<candidates>`, never `<issue>`",
    )
    expect(run).toContain("Each entry's `findIssue` op with `<branch>`")
    expect(run).toContain("in `force` mode too")
    expect(run).toContain("`<otherPrs>` isn't empty (a merged one counts")
    expect(run).toContain("open, merged, or closed, are `<otherPrs>`")
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
      "skills/merge/SKILL.md",
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

    it("finds the issue the way close does, reading only, and judges a gap as an observation", () => {
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

  it("runs evaluate when merge's gate has no current verdict, and gates again", () => {
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
    expect(run).toContain(
      "run the `/dev-flows:evaluate` skill with the argument `record`",
    )
    expect(run).toContain("Then run `gate` again, once")
    expect(run).toContain("`stop` otherwise (a `stop` verdict)")
    expect(run).not.toContain("Run /dev-flows:evaluate on <branch>")
  })

  it("merges only the commit CI passed on, and cleans up only after", () => {
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
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

  it("syncs only the pull request and issue with merge.sync remote", () => {
    const main =
      files.find((f) => f.path === "skills/merge/SKILL.md")?.content ?? ""
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
    expect(main).toMatch(/merge\.deployLogLines merge\.sync --optional/)
    const remote = run.indexOf("- **`remote`:** nothing in merge pushes")
    const unpushed = run.indexOf(
      "and merge.sync is remote, so merge won't push them",
    )
    const ci = run.indexOf('ready.ts" ci start --sha <sha>')
    expect(remote).toBeGreaterThan(-1)
    expect(unpushed).toBeGreaterThan(remote)
    expect(ci).toBeGreaterThan(unpushed)
  })

  it("waits merge.deployTimeout, tails failed steps' logs, and keeps skipped steps apart", () => {
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
    expect(run).toContain("or `<deployTimeout>` minutes have gone by")
    expect(run).not.toContain("or 30 minutes have gone by")
    expect(run).toContain(
      "for each failed step with a `log`, the source-control entry's `checkLog` op",
    )
    expect(run).toContain("`skipped` ones aren't failures")
    expect(run).not.toContain("each step that didn't succeed")
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

  it("tells sync's after hooks what the run did, and merge's whether it merged and on which commit", () => {
    const sync =
      files.find((f) => f.path === "skills/sync/SKILL.md")?.content ?? ""
    expect(sync).toContain(
      "run after --flow sync --mode <mode> --pr <the pull request's number> --issue <the branch's issue id> --result <result> [--issue-filed] --outcome",
    )
    expect(sync).toContain("`noop` (neither: the no-op gate, or nothing to do)")

    const merge =
      files.find((f) => f.path === "skills/merge/SKILL.md")?.content ?? ""
    expect(merge).toContain("[--merged --merge-commit <landed>] --outcome")
    const run =
      files.find((f) => f.path === "skills/merge-run/SKILL.md")?.content ?? ""
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
