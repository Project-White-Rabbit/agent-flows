import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOK_RESULTS,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  STACK_PARENT,
  USE_INTEGRATIONS,
} from "./kit.ts"

// How long merge waits for CI on the commit it lands, in seconds.
const CI_TIMEOUT = 1800

export const mergeFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "merge",
  title: "{{cmd}}merge",
  frontmatter: {
    description:
      "Land the current branch's pull request (or its stack): wait for CI on the commit that lands, merge it through the repo's source-control or stacking integration, then close out its issue and errors. Only when the user explicitly asks to land or merge the PR, never for a git merge.",
    argumentHint: "[stack | branch] [squash | merge | rebase]",
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    ready: {
      description:
        "`ci start` and `ci wait` track the CI pass on the commit about to land: settled, timed out, and what failed",
      args: "<subcommand>",
    },
    evaluate: {
      description:
        "`gate --base <ref>` says whether `merge.requireEvaluation` lets the branch's recorded evaluation through: `off`, `pass`, `ask`, or `stop` (with `rerun` when a fresh evaluation can settle it)",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // The gates stay inline; the merge loads only once they pass.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "main/preflight",
  },
  defaultMode: "default",
  intro:
    "Take the current branch from \"in flight\" to \"merged\" in one command: the last step of the dev workflow. It picks up where `{{cmd}}sync` and `{{cmd}}ready` left off, and runs `{{cmd}}sync` itself when the branch has no pull request yet. It waits for CI on the exact commit that lands, merges it, deletes the remote branch, and runs `{{cmd}}sync remote` so the issue moves to done and linked errors resolve. Every vendor-specific action goes through the repo's configured integrations (`{{cmd}}configure`): the source-control host merges a single branch, and a stacking tool, when there is one, lands a whole stack.\n\n**Arguments**, in any order:\n\n- `stack` lands every branch from the base up to and including this one; `branch` (or `no-stack`) lands only this one. Neither: when branches sit below this one in its stack, ask; otherwise only this one lands. Branches above this one are never touched.\n- `squash`, `merge` (or `no-squash`), or `rebase` picks the merge method for a single branch. Neither: `squash`, or `merge` when the branch is part of a stack of more than one, so each stacked pull request keeps its own boundary in the base's history. A stack lands by the stacking tool's or the host's own method, so a method passed with `stack` isn't used: say so in the report.",
  invariants: [
    "**Invoking this command is the authorization to merge.** Don't ask for a second confirmation. The one question it asks is how much of a stack to land, and only when nothing said.",
    "**Act through the integrations' ops.** Pull requests, checks, merges, and stacks are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.",
    "**Never bypass the host:** no admin merge, no auto-merge, no skipping a required check or review, no rerunning someone's CI to get past it.",
    "**Nothing is pushed between the CI pass and the merge.** The merge is pinned to the commit CI passed on; a head that moved since stops it.",
    "**Clean up only after the host says merged.** No branch deletion, issue update, or error resolution for a pull request that isn't merged.",
    hooksInvariant("merge", {
      afterPoint: true,
      extra:
        "--branch <branch> --pr <N> --prs '<the numbers of every pull request it lands, bottom first, space-separated>'",
    }),
  ],
  phases: [
    {
      id: "main",
      title: "Pre-flight",
      stepStyle: "headers",
      steps: [
        {
          id: "preflight",
          kind: "action",
          title: "Pre-flight",
          refName: "pre-flight",
          commandCalls: ["configure", "hooks"],
          body: `Reads only, apart from the sync that opens a missing pull request and the repo's own hooks. Any gate that fails stops the command with nothing written.

### 1a. Survey

1. **Arguments:** a scope (\`stack\`, \`branch\`, \`no-stack\`) and a method (\`squash\`, \`merge\`, \`no-squash\`, \`rebase\`), each at most once, in any order. Anything else: stop and show the usage, \`{{cmd}}merge [stack | branch] [squash | merge | rebase]\`.
2. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG} Then \`{{command:configure}} get ready.ignoreChecks merge.issueOnMerge merge.requireAllChecks merge.unresolvedThreads merge.watchDeploy merge.deployTimeout merge.deployLogLines merge.sync --optional\`: \`<ignoreChecks>\`, the CI check patterns the team never waits on (\`null\` for none); \`<issueOnMerge>\`, what happens to the issue on merge: \`close\` (merge moves it to done; \`null\` reads as \`close\`), \`tracker\` (the tracker's own integration moves it), or \`leave\` (nothing moves it); \`<requireAllChecks>\` (\`true\`: every check must pass, not only the required ones; \`null\` reads as false); \`<unresolvedThreads>\`, which unresolved review threads stop the merge (\`bots\`, \`all\`, or \`allow\`; \`null\` reads as \`allow\`); \`<watchDeploy>\` (\`true\`: watch the deployment of what landed; \`null\` reads as false), with \`<deployTimeout>\` (minutes the watch waits; \`null\` reads as 30) and \`<deployLogLines>\` (lines of each failed step's log the report leads with; \`null\`: none); and \`<syncMode>\` from \`merge.sync\` (\`remote\`: the run phase refreshes only the pull request and its issue, and pushes nothing; \`null\` reads as \`full\`).
3. **Integrations:** \`{{command:configure}} integrations sourceControl stacking deployments --optional\`. ${USE_INTEGRATIONS}
   - **Source control:** keep the entry whose repository (from its \`values\`) is this checkout's \`origin\` in \`git remote -v\`. With none, stop: \`No configured source-control repository is this checkout's origin. Run {{cmd}}configure sourceControl, then re-run.\` At \`level\` \`read\`, stop too: \`The team uses <entry> read-only, so merge can't land pull requests. Run {{cmd}}configure <integration> to change that.\`
   - **Stacking:** the first entry, if any.
   - **Deployments:** every entry, used only when \`<watchDeploy>\` is true.
4. **Branch:** \`git branch --show-current\` is \`<branch>\`. Detached, or \`<branch>\` is \`<base>\`: stop, \`Refusing to merge from <base or a detached HEAD>. Check out the feature branch first.\`
5. **Pull request:** the source-control entry's \`currentPr\` op.

### 1b. Gates

1. **No pull request?** Say \`No pull request for <branch>. Running {{cmd}}sync to open one...\` and run the \`{{cmd}}sync\` skill with no arguments: it commits what's uncommitted, pushes, and opens the pull request and its issue. Then run \`currentPr\` again; still none: stop, \`Sync finished but there's still no pull request. Check its output, then re-run {{cmd}}merge.\` Note that sync ran, so the run phase doesn't run it again, and skip gate 2 (sync committed everything).
2. **Uncommitted changes?** \`git status --porcelain\` prints anything: stop, \`<branch> has uncommitted changes. Commit them (or run {{cmd}}sync), then re-run {{cmd}}merge.\` Don't commit them here: whether they ship is the user's call.
3. **Already merged or closed?** Merged: stop, \`Pull request <N> is already merged.\` (a \`{{cmd}}sync remote\` closes out its issue). Closed: stop, \`Pull request <N> is closed. Reopen it to merge it.\`
4. **Targets the base?** The pull request's base branch must be \`<base>\`, or, with a stacking entry, the branch's parent in its stack (its \`parent\` op; 1c checks that parent further). Anything else: stop, \`Pull request <N> targets <its base>, not <base>. Retarget it to <base>, then re-run {{cmd}}merge.\` A pull request opened by hand often targets the host's default branch, and landing it there can deploy what the base exists to hold back.

Keep the pull request's number \`<N>\`, URL, title, draft state, and base branch.

### 1c. Stack and method

**Parent:** ${STACK_PARENT} With a \`<landed>\`, stop: \`<branch> still sits on <landed>, which already merged. Run {{cmd}}sync to move it onto <parent>, then re-run {{cmd}}merge.\` Merging now would land it into a branch that's already gone.

With a stacking entry, run its \`downstack\` op: \`chain\`, \`above\`, and \`size\`. Without one, the chain is \`[<branch>]\`, with \`above\` 0 and \`size\` 1.

**Scope:** \`stack\` or \`branch\` from the arguments. Neither, and the chain has more than one branch: show the chain bottom first, one line per branch (\`#<number> <title>\`, \`(draft)\` for a draft, the current branch marked; each branch's pull request from the \`branchPr\` op), then ask: \`<branch> sits on <chain length - 1> other stacked branch(es). Land the whole chain, or just this branch?\`, with the options \`Land the whole chain\` (every pull request in it merges bottom first) and \`Just this branch\` (only #<N> merges, into its base <the pull request's base>; the branches below stay open). Otherwise \`branch\`. \`stack\` with a chain of one is \`branch\`. \`stack\` with no stacking entry: stop, \`Landing a stack needs a stacking integration. Run {{cmd}}configure stacking, or merge each pull request on its own.\`

**Method**, for \`branch\`: the argument (\`no-squash\` is \`merge\`), else \`merge\` when \`size\` is more than 1, else \`squash\`. Keep why (\`explicit\`, \`auto: stack of <size>\`, or \`auto: single branch\`).

### 1d. Chain gates

Only for \`stack\`, in order:

1. **Every branch has a pull request?** The \`branchPr\` op for each branch in the chain. Any without one: stop, \`Can't land the chain: <branches> have no pull request. Run {{cmd}}sync on each, then re-run {{cmd}}merge stack.\`
2. **Every one still open?** One merged or closed means the stack's record is out of date: stop, \`The stack is stale: <branch>'s pull request is <state>. Restack it ({{cmd}}sync), then re-run {{cmd}}merge.\`
3. **Any already failing?** \`git fetch origin <every branch in the chain>\`, then for each branch the \`checks\` op on \`git rev-parse origin/<branch>\`. Any \`fail\` or \`cancelled\`: stop, naming the branch and its pull request URL, \`Can't land the chain: #<number> has failing checks. Fix it with {{cmd}}ready, then re-run {{cmd}}merge stack.\` A chain that stops halfway leaves part of it merged, so this is checked before anything is written.

Drafts are fine: the merge step marks them ready.

### 1e. The repo's \`before\` hooks

\`{{command:hooks}} run merge.before --flow merge --mode default --branch <branch> --pr <N> --prs '<numbers>'\`, \`<numbers>\` every pull request it lands, bottom first (only \`<N>\` for \`branch\`). ${HOOK_RESULTS} Merge lands what's pushed, so hooks here check rather than change: when \`git status --porcelain\` prints anything after them, stop as gate 2 of 1b does.`,
          next: "run/sync",
        },
      ],
    },
    {
      id: "run",
      title: "Run",
      stepStyle: "headers",
      steps: [
        {
          id: "sync",
          kind: "action",
          title: "Sync",
          refName: "sync",
          body: `Skip this step when the pre-flight already ran sync.

Otherwise, by \`<syncMode>\` from {{skill-ref:main}}:

- **\`full\`:** run the \`{{cmd}}sync\` skill with no arguments: invoke it, don't redo its steps. The tree is clean, so it commits nothing, but it catches the branch up to its base, pushes what's unpushed, and refreshes the pull request body and its issue.
- **\`remote\`:** nothing in merge pushes, so first \`git fetch origin <branch>\`: when \`git rev-parse HEAD\` isn't \`git rev-parse origin/<branch>\`, stop, \`<branch> has commits that aren't pushed, and merge.sync is remote, so merge won't push them. Run {{cmd}}sync, then re-run {{cmd}}merge.\` Then run the \`{{cmd}}sync\` skill with the argument \`remote\`: it refreshes the pull request body and its issue, and never commits, catches up, or pushes. A branch that's behind its base or conflicting stops at the merge state below.

When it stops (a conflict it needs you for), stop too and pass its message on; nothing has merged.`,
          next: "run/merge",
        },
        {
          id: "merge",
          kind: "action",
          title: "Merge",
          refName: "merge",
          commandCalls: ["ready", "evaluate"],
          body: `The entries, \`<base>\`, \`<branch>\`, \`<N>\`, the chain, the scope, and the method are from {{skill-ref:main}}.

### Mark ready

When pull request <N> is a draft, the \`prReady\` op. For \`stack\`, the same for every other draft in the chain: a draft can't merge, so one left below would stop the chain partway.

### The repo's \`beforeCi\` hooks

\`{{command:hooks}} run merge.beforeCi --flow merge --mode default --branch <branch> --pr <N> --prs '<numbers>'\`. ${HOOK_RESULTS} These are for a commit that must land with the merge (a changelog entry): a hook may commit and push it, so CI below runs on it, and the repo's CI can check only what it adds. After them, \`git status --porcelain\` must print nothing (a hook that left changes uncommitted: stop, as gate 2 of 1b does).

### Wait for CI

\`git fetch origin <branch>\`. \`<sha>\` is \`git rev-parse HEAD\`; when it isn't \`git rev-parse origin/<branch>\`, stop: \`<branch> has commits that aren't pushed. Run {{cmd}}sync, then re-run {{cmd}}merge.\` What merges is the pushed head, so that's what CI must pass on.

### Recorded evaluation

\`{{command:evaluate}} gate --base origin/<the pull request's base>\` reads \`merge.requireEvaluation\` and the branch's recorded verdict, and prints \`gate\`, its \`reason\`, \`rerun\` (on a \`stop\` a fresh evaluation can settle), and the \`record\` (its \`verdict\`, \`summary\`, and \`sha\`):

- \`off\`: the repo doesn't gate on it. Go on.
- \`pass\`: go on. When \`carried\` is true, the verdict was on an earlier commit whose files changed the same way (the branch only took in its base), and now names \`<sha>\`: say so in the report.
- \`ask\`: show the \`summary\` lines and ask \`The evaluation of <short sha> flagged these. Merge anyway?\`; merge only on an explicit yes, and note it in the report. Anything else stops.
- \`stop\` with \`rerun\` true: no verdict is recorded, or it's on another commit, so evaluate it now. Say why (its \`reason\`), then run the \`{{cmd}}evaluate\` skill with the argument \`record\`: invoke it, don't redo its steps. It reviews the pushed head (only what moved, with \`evaluate.scope: delta\`), records the verdict, and shows its report. Then run \`gate\` again, once, and act on what it prints by these same rules, except that a second \`stop\` with \`rerun\` stops: \`The evaluation of <short sha> wasn't recorded: <its Not recorded reason, else the gate's reason>. Fix that, then re-run {{cmd}}merge.\` Nothing has merged.
- \`stop\` otherwise (a \`stop\` verdict): stop with its \`reason\` and the \`summary\` lines, \`Address the evaluation's findings, then re-run {{cmd}}evaluate and {{cmd}}merge.\` Nothing has merged.

Merge waits only on the checks the base requires: the \`checks\` op given \`<base>\` (the pull request's base branch) says which, and \`--required-only\` waits on just those (all of them when the op can't say). With \`<requireAllChecks>\` true, leave \`--required-only\` off every \`ci wait\` and \`ci record\` below: it waits on every check. Checks matching \`<ignoreChecks>\` aren't waited on either: pass \`--ignore-check '<pattern>'\` for each, on every \`ci wait\` and \`ci record\` below. The host still refuses a merge a required check blocks, so the merge state below stays the authority.

Run \`{{command:ready}} ci start --sha <sha>\`, then wait for the checks: with a \`script\` variant of the \`checks\` op that runs here,

\`\`\`bash
{{command:ready}} ci wait --sha <sha> --timeout ${CI_TIMEOUT} --required-only [--ignore-check '<pattern>']... --command '<the checks op's script variant, with <sha> and <base> filled in>'
\`\`\`

It polls every 30 seconds, prints \`[ready-ci]\` progress to stderr and the final report to stdout. Relay its progress in one line at least once a minute. When the host limits how long one command runs, add \`--max-wait <a bit under that limit>\` and run it again until it settles; the deadline stays the one \`ci start\` set. Without a \`script\` variant, every 30 seconds run the \`checks\` op for \`<sha>\` and \`<base>\`, write its JSON to a file, and run \`{{command:ready}} ci record --sha <sha> --file <file> --timeout ${CI_TIMEOUT} --required-only\` (with the \`--ignore-check\` flags), until it says \`settled\` or \`timedOut\`.

The report's \`noChecks\` means nothing it waits on runs on the commit (no CI, or every check reported is optional or ignored): go on. Keep \`optional\` and \`ignored\` for the report. \`timedOut\`: stop with the pull request open, listing \`pending\`. Settled with \`failures\` (failed or cancelled checks): with \`<requireAllChecks>\` true, stop, \`<names> failed or were cancelled, and merge.requireAllChecks needs every check to pass. Fix them with {{cmd}}ready, then re-run {{cmd}}merge.\` Otherwise go on to the merge state below, which says whether the host needs them; keep their names for the report.

### Review threads

**Skip when \`<unresolvedThreads>\` is \`allow\`.** Otherwise the \`reviewThreads\` op for <N> (for \`stack\`, for every pull request in the chain). A thread is an automated reviewer's when its first comment's author is a bot, or is a reviewer the repo's agent instructions name as automated. With \`bots\`, any unresolved automated reviewer's thread stops the merge; with \`all\`, any unresolved thread does. Stop with each one's \`path:line\` and author: \`#<number> has unresolved review threads, and merge.unresolvedThreads is <value>: <threads>. Address them ({{cmd}}ready fixes an automated reviewer's mechanical ones), then re-run {{cmd}}merge.\` People's threads under \`bots\` don't stop it: list them in the report. An op that fails is a stop too: unread threads aren't no threads.

### Merge state

The \`prMergeState\` op for <N>:

- \`ready\`: merge. Failed checks that it lets through are ones the base doesn't require: list them in the report.
- \`pending\`: wait 3 seconds and ask again, up to 3 times; still pending, stop.
- \`blocked\`: stop with its reasons. Failed checks: \`Fix them with {{cmd}}ready, then re-run {{cmd}}merge.\` A review or approval: the people who own it.
- \`conflicting\` or \`behind\`: stop, \`Run {{cmd}}sync to catch <branch> up to its base, then re-run {{cmd}}merge.\` With \`<syncMode>\` \`remote\` this is the usual way a branch whose base moved stops: merge leaves the catch-up to sync, so a fresh CI run (and any review) covers it before it lands.

A stop here leaves the pull request open and unmerged. Push nothing from here to the merge.

### Merge one branch

For \`branch\`: the \`prMerge\` op with <N>, the method, and \`<sha>\`. When the host refuses (a moved head, a rule, a method the repository doesn't allow), stop and show its reason as given; for a method it doesn't allow, name the ones to pass instead when it says. Never retry with a bypass.

Then the \`prMetadata\` op for <N>: its state must be merged. If it isn't, stop: nothing after this runs for an unmerged pull request.

### Merge the chain

For \`stack\`, instead: the stacking entry's \`mergeStack\` op. It can take minutes; run it in the foreground. Then the \`branchPr\` op for every branch in the chain. All merged: go on. Otherwise stop and say plainly that **part of the chain is merged**: list which pull requests merged and which didn't, with the op's output. The usual next step is \`{{cmd}}sync\` to restack what's left, fix the blocked one, and re-run \`{{cmd}}merge\`. When it says local branches differ from their remotes, it refused rather than land unpushed work: \`{{cmd}}sync\`, then re-run.

### Close out

Run the \`{{cmd}}sync\` skill with the argument \`remote\` (and \`--leave-issue\` when \`<issueOnMerge>\` is \`tracker\` or \`leave\`: the tracker moves the issue itself, or nothing does, so sync leaves it as it is). With the pull request merged, it moves the issue to done and resolves the errors the pull request fixed, as far as each integration's \`level\` allows. A failure here goes in the report; the merge stands.

### Delete the remote branch

Only after the host said merged. When \`above\` is more than 0, keep it: the pull requests stacked on top target it until they're restacked; say so in the report. Otherwise \`git push origin --delete <branch>\`; one that says the remote ref doesn't exist was already deleted (the host may do it on merge), which counts as done. Never \`git branch -D\`, never switch branches, and never remove this worktree: the local branch stays for the user to clean up.

### Watch the deployment

**Only when \`<watchDeploy>\` is true.** With no deployments entry, say so in the report (\`merge.watchDeploy is on, but no deployments integration is configured: run {{cmd}}configure deployments\`) and skip this. Otherwise the source-control entry's \`mergeCommit\` op for <N> (for \`stack\`, the top of the chain) is \`<landed>\`; while it's null, ask again every 5 seconds, up to 3 times, then report that the merge commit couldn't be read and skip this.

For each deployments entry, its \`deployment\` op with \`<landed>\` as \`<sha>\`, every 30 seconds for the first 5 minutes and every 60 seconds after, until it's \`success\` or \`failed\` or \`<deployTimeout>\` minutes have gone by. Relay its state and steps in one line at least once a minute. \`none\` for 5 minutes: that entry deployed nothing for this commit (it may not deploy this branch); say so and stop watching it. Past \`<deployTimeout>\` minutes: report it still \`pending\`, with its \`url\` (\`merge.deployTimeout\` waits longer).

Read its \`steps\` by state: \`failed\` ones are what went wrong; \`skipped\` ones aren't failures (a deploy skips the parts the commit didn't need, a migration step when nothing changed the schema), so list them apart and never lead with them; \`pending\` ones at the end are what the timeout cut off.

A failed deployment doesn't undo the merge, and nothing here fixes it: never redeploy, roll back, re-run its workflow, or revert. Lead the report with it, its \`url\`, and its failed steps. With \`<deployLogLines>\`, for each failed step with a \`log\`, the source-control entry's \`checkLog\` op with that \`<log>\`, keeping only its last \`<deployLogLines>\` lines: they go under the step in the report, since a later step can fail after an earlier one already put the new code live, and only the log says how far it got.`,
          next: "run/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `Lead with anything that needs the user's attention: a stop and its reason, a chain that merged partway, failed checks the host let through, a failed close-out, a failed deployment with its failed steps and their log tails. Then:

- **Merged:** the pull request's number and URL; for a chain, every pull request bottom first, the current branch marked.
- **Scope:** \`branch\` or \`stack\`, and how it was decided (an argument, the user's answer, or nothing below this branch). Branches still open above this one, and that \`{{cmd}}sync\` on each restacks them.
- **Method:** the method and why; for a chain, \`set by the stacking tool or the host\`, and a method argument that wasn't used.
- **CI:** the commit it passed on (short sha), how long it waited, the checks it didn't wait on (not required by the base, or ignored by \`ready.ignoreChecks\`; with \`merge.requireAllChecks\`, only the ignored ones), and any failed checks the host didn't require.
- **Sync:** \`full\` (caught up and pushed, or nothing to do) or \`remote\` (only the pull request and issue refreshed, from \`merge.sync\`).
- **Hooks:** what the \`beforeCi\` hooks committed and pushed, if anything.
- **Evaluation:** with \`merge.requireEvaluation\`, the verdict it merged on and its commit, whether it carried over from an earlier commit or merge ran evaluate for it, and a flag the user accepted.
- **Close-out:** the issue and its state (or left to the tracker, or as it was, with \`merge.issueOnMerge\` \`tracker\` or \`leave\`), errors resolved, and any to resolve by hand, from the remote sync.
- **Review threads:** with \`merge.unresolvedThreads\` set, the unresolved threads it checked, and people's threads still open.
- **Remote branch:** deleted, already gone, or kept (and why).
- **Deployment:** with \`merge.watchDeploy\`, each entry's result for \`<landed>\` (short sha): \`success\`, \`failed\`, still \`pending\`, or nothing deployed, with its \`url\` and how long it took; its failed steps (each with its log tail, with \`merge.deployLogLines\`), then, apart, the steps it skipped, and the ones still pending when the watch timed out.
- **Local:** still on \`<branch>\`; deleting it and its worktree is the user's call.`,
          next: null,
        },
      ],
    },
  ],
})
