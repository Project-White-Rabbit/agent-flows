import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
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
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    ready: {
      description:
        "`ci start` and `ci wait` track the CI pass on the commit about to land: settled, timed out, and what failed",
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
          commandCalls: ["configure"],
          body: `Reads only, apart from the sync that opens a missing pull request. Any gate that fails stops the command with nothing written.

### 1a. Survey

1. **Arguments:** a scope (\`stack\`, \`branch\`, \`no-stack\`) and a method (\`squash\`, \`merge\`, \`no-squash\`, \`rebase\`), each at most once, in any order. Anything else: stop and show the usage, \`{{cmd}}merge [stack | branch] [squash | merge | rebase]\`.
2. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG}
3. **Integrations:** \`{{command:configure}} integrations sourceControl stacking --optional\`. ${USE_INTEGRATIONS}
   - **Source control:** keep the entry whose repository (from its \`values\`) is this checkout's \`origin\` in \`git remote -v\`. With none, stop: \`No configured source-control repository is this checkout's origin. Run {{cmd}}configure sourceControl, then re-run.\` At \`level\` \`read\`, stop too: \`The team uses <entry> read-only, so merge can't land pull requests. Run {{cmd}}configure <integration> to change that.\`
   - **Stacking:** the first entry, if any.
4. **Branch:** \`git branch --show-current\` is \`<branch>\`. Detached, or \`<branch>\` is \`<base>\`: stop, \`Refusing to merge from <base or a detached HEAD>. Check out the feature branch first.\`
5. **Pull request:** the source-control entry's \`currentPr\` op.

### 1b. Gates

1. **No pull request?** Say \`No pull request for <branch>. Running {{cmd}}sync to open one...\` and run the \`{{cmd}}sync\` skill with no arguments: it commits what's uncommitted, pushes, and opens the pull request and its issue. Then run \`currentPr\` again; still none: stop, \`Sync finished but there's still no pull request. Check its output, then re-run {{cmd}}merge.\` Note that sync ran, so the run phase doesn't run it again, and skip gate 2 (sync committed everything).
2. **Uncommitted changes?** \`git status --porcelain\` prints anything: stop, \`<branch> has uncommitted changes. Commit them (or run {{cmd}}sync), then re-run {{cmd}}merge.\` Don't commit them here: whether they ship is the user's call.
3. **Already merged or closed?** Merged: stop, \`Pull request <N> is already merged.\` (a \`{{cmd}}sync remote\` closes out its issue). Closed: stop, \`Pull request <N> is closed. Reopen it to merge it.\`

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

Drafts are fine: the merge step marks them ready.`,
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

Otherwise run the \`{{cmd}}sync\` skill with no arguments: invoke it, don't redo its steps. The tree is clean, so it commits nothing, but it catches the branch up to its base, pushes what's unpushed, and refreshes the pull request body and its issue. When it stops (a conflict it needs you for), stop too and pass its message on; nothing has merged.`,
          next: "run/merge",
        },
        {
          id: "merge",
          kind: "action",
          title: "Merge",
          refName: "merge",
          commandCalls: ["ready"],
          body: `The entries, \`<base>\`, \`<branch>\`, \`<N>\`, the chain, the scope, and the method are from {{skill-ref:main}}.

### Mark ready

When pull request <N> is a draft, the \`prReady\` op. For \`stack\`, the same for every other draft in the chain: a draft can't merge, so one left below would stop the chain partway.

### Wait for CI

\`git fetch origin <branch>\`. \`<sha>\` is \`git rev-parse HEAD\`; when it isn't \`git rev-parse origin/<branch>\`, stop: \`<branch> has commits that aren't pushed. Run {{cmd}}sync, then re-run {{cmd}}merge.\` What merges is the pushed head, so that's what CI must pass on.

Run \`{{command:ready}} ci start --sha <sha>\`, then wait for the checks: with a \`script\` variant of the \`checks\` op that runs here,

\`\`\`bash
{{command:ready}} ci wait --sha <sha> --timeout ${CI_TIMEOUT} --command '<the checks op's script variant, with <sha> filled in>'
\`\`\`

It polls every 30 seconds, prints \`[ready-ci]\` progress to stderr and the final report to stdout. Relay its progress in one line at least once a minute. When the host limits how long one command runs, add \`--max-wait <a bit under that limit>\` and run it again until it settles; the deadline stays the one \`ci start\` set. Without a \`script\` variant, every 30 seconds run the \`checks\` op for \`<sha>\`, write its JSON to a file, and run \`{{command:ready}} ci record --sha <sha> --file <file> --timeout ${CI_TIMEOUT}\`, until it says \`settled\` or \`timedOut\`.

The report's \`noChecks\` means the repo runs no CI on the commit: go on. \`timedOut\`: stop with the pull request open, listing \`pending\`. Settled with \`failures\` (failed or cancelled checks): go on to the merge state below, which says whether the host needs them; keep their names for the report.

### Merge state

The \`prMergeState\` op for <N>:

- \`ready\`: merge. Failed checks that it lets through are ones the base doesn't require: list them in the report.
- \`pending\`: wait 3 seconds and ask again, up to 3 times; still pending, stop.
- \`blocked\`: stop with its reasons. Failed checks: \`Fix them with {{cmd}}ready, then re-run {{cmd}}merge.\` A review or approval: the people who own it.
- \`conflicting\` or \`behind\`: stop, \`Run {{cmd}}sync to catch <branch> up to its base, then re-run {{cmd}}merge.\`

A stop here leaves the pull request open and unmerged. Push nothing from here to the merge.

### Merge one branch

For \`branch\`: the \`prMerge\` op with <N>, the method, and \`<sha>\`. When the host refuses (a moved head, a rule, a method the repository doesn't allow), stop and show its reason as given; for a method it doesn't allow, name the ones to pass instead when it says. Never retry with a bypass.

Then the \`prMetadata\` op for <N>: its state must be merged. If it isn't, stop: nothing after this runs for an unmerged pull request.

### Merge the chain

For \`stack\`, instead: the stacking entry's \`mergeStack\` op. It can take minutes; run it in the foreground. Then the \`branchPr\` op for every branch in the chain. All merged: go on. Otherwise stop and say plainly that **part of the chain is merged**: list which pull requests merged and which didn't, with the op's output. The usual next step is \`{{cmd}}sync\` to restack what's left, fix the blocked one, and re-run \`{{cmd}}merge\`. When it says local branches differ from their remotes, it refused rather than land unpushed work: \`{{cmd}}sync\`, then re-run.

### Close out

Run the \`{{cmd}}sync\` skill with the argument \`remote\`. With the pull request merged, it moves the issue to done and resolves the errors the pull request fixed, as far as each integration's \`level\` allows. A failure here goes in the report; the merge stands.

### Delete the remote branch

Only after the host said merged. When \`above\` is more than 0, keep it: the pull requests stacked on top target it until they're restacked; say so in the report. Otherwise \`git push origin --delete <branch>\`; one that says the remote ref doesn't exist was already deleted (the host may do it on merge), which counts as done. Never \`git branch -D\`, never switch branches, and never remove this worktree: the local branch stays for the user to clean up.`,
          next: "run/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `Lead with anything that needs the user's attention: a stop and its reason, a chain that merged partway, failed checks the host let through, a failed close-out. Then:

- **Merged:** the pull request's number and URL; for a chain, every pull request bottom first, the current branch marked.
- **Scope:** \`branch\` or \`stack\`, and how it was decided (an argument, the user's answer, or nothing below this branch). Branches still open above this one, and that \`{{cmd}}sync\` on each restacks them.
- **Method:** the method and why; for a chain, \`set by the stacking tool or the host\`, and a method argument that wasn't used.
- **CI:** the commit it passed on (short sha), how long it waited, and any failed checks the host didn't require.
- **Close-out:** the issue and its state, errors resolved, and any to resolve by hand, from the remote sync.
- **Remote branch:** deleted, already gone, or kept (and why).
- **Local:** still on \`<branch>\`; deleting it and its worktree is the user's call.`,
          next: null,
        },
      ],
    },
  ],
})
