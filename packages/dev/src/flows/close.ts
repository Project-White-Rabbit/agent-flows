import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOK_RESULTS,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  USE_INTEGRATIONS,
} from "./kit.ts"

export const closeFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "close",
  title: "{{cmd}}close",
  frontmatter: {
    description:
      "Abandon the current branch's work: close its pull request, delete its remote branch, cancel its issue, and run the repo's teardown. Invoking it authorizes the cleanup. Only for scrapping work without merging, never for landing it.",
    argumentHint: { deriveFromModes: true },
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    sync: {
      description:
        "`issue` prints the issue a sync recorded for the current branch, reading only",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // Help stays inline; the survey and the destructive writes load only once
    // a real close begins.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "run/survey",
    force: "run/survey",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Close the pull request, delete the remote branch, cancel the issue, and run the repo's teardown. Invoking it is the confirmation, except for an issue found only by search, which it asks about.",
    force:
      "The same, unattended (a workspace teardown script): it asks nothing, so an issue found only by search is listed and left open.",
    help: "Show usage and exit without closing anything.",
  },
  intro:
    "Winds down a branch whose work is being abandoned: the destructive sibling of `{{cmd}}sync`. It closes the pull request, deletes the remote branch, cancels the issue, and runs the repo's own teardown (`close.after` hooks: a database branch, dev servers, a marker a worktree setup script reads). Every vendor-specific action goes through the repo's configured integrations (`{{cmd}}configure`). The local branch and working tree are left alone, for the person (or their workspace app's teardown) to remove.",
  invariants: [
    "**Invoking this command is the authorization for the cleanup.** Don't ask for a second confirmation. The one question it asks is which issue, if any, belongs to the branch when the branch never named one, and in `force` mode it asks nothing.",
    "**Act through the integrations' ops.** Pull requests and issues are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for the remote branch and everything local.",
    '**A failed read is not an absence.** A lookup that errors (sign-in, rate limit, network) stops the command before any write: mistaking it for "no pull request" could delete a branch out from under an open one.',
    "**Never touch the local branch or working tree:** no `git branch -D`, no switching branches, no reset or stash. Only what's remote, and what the repo's own hooks tear down.",
    "**Change only the issue the branch names,** or one the person picks. An issue another pull request is attached to (open or merged) stays open, and one found only by its `> Branch:` line or a search is asked about, never changed in `force` mode.",
    hooksInvariant("close", {
      afterPoint: true,
      extra: "--branch <branch> --pr <N>",
    }),
  ],
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If mode is \`help\`, print the block below verbatim and exit. No reads, no writes.

> \`{{cmd}}close\` winds down a branch whose work is being abandoned. Invoking it is the confirmation.
>
> Modes:
>   - (no arg) -- close what applies, below
>   - \`force\` -- the same, unattended (a workspace teardown script): asks nothing
>   - \`help\` -- show this and exit
>
> What it does, each only when it applies:
>   - closes the pull request
>   - deletes the remote branch
>   - cancels the issue the branch names (left open when another pull request, open or merged, is attached to it)
>   - when the branch names no issue, looks for one (a \`> Branch:\` line naming the branch, then a search) and asks which, if any, to cancel or mark done; \`force\` changes none of them
>   - runs the repo's teardown (\`close.after\` hooks)
>
> It never deletes the local branch, switches branches, or touches the working tree. It refuses on the base branch, on a branch other branches are stacked on, and on a pull request that merged.`,
          next: null,
        },
      ],
    },
    {
      id: "run",
      title: "Run",
      stepStyle: "headers",
      steps: [
        {
          id: "survey",
          kind: "action",
          title: "Survey and gates",
          refName: "survey",
          commandCalls: ["configure", "sync", "hooks"],
          body: `Reads only, apart from one \`git fetch\` and the repo's \`close.before\` hooks. A gate that fails stops the command with nothing written.

### Survey

1. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG}
2. **Integrations:** \`{{command:configure}} integrations sourceControl stacking issueTracker --optional\`. ${USE_INTEGRATIONS}
   - **Source control:** the entry whose repository (from its \`values\`) is this checkout's \`origin\` in \`git remote -v\`, if any. At \`level\` \`read\`, its pull request is only read: say it can't be closed here, and leave it.
   - **Stacking:** the first entry, if any.
   - **Issue tracker:** every entry is searched; only an issue in an entry at \`level\` \`track\` is changed.
3. **Branch:** \`git branch --show-current\` is \`<branch>\`.
4. **Pull request:** the source-control entry's \`branchPr\` op for \`<branch>\`: \`<N>\`, its URL, title, and state, or none.
5. **Remote branch:** \`git ls-remote --heads origin <branch>\`. Empty output means there's none; a failure stops the command.
6. **What's left behind:** \`git status --porcelain\` (changes left in the working tree), and, when the remote branch exists, \`git fetch origin <branch>\` then \`git rev-list --count <branch>..origin/<branch>\`: \`<remoteAhead>\`, commits on the remote that the local branch doesn't have, which deleting it throws away.
7. **Stacked branches:** with a stacking entry, its \`downstack\` op: \`above\` is how many branches sit on this one.
8. **The issue**, stopping at the first that loads with its entry's \`getIssue\` op (a ref is a string an issue-tracker entry's \`issueRef\` op matches):
   1. The issue a sync recorded for this branch: \`{{command:sync}} issue\` prints \`{"branch", "issue"}\`.
   2. A ref in the branch name: the leftmost one only. When it doesn't load, don't try the others: cancelling the wrong issue is far worse than missing the right one.
   3. The pull request body's \`> Issue:\` line (or a \`> \` line named for the tracker).

   The first that loads is \`<issue>\`, named by the branch. Its attached pull requests other than this branch's, open, merged, or closed, are \`<otherPrs>\`: any one means other work has used the issue.

   **When none of those finds one:** look for it, and keep what turns up as \`<candidates>\`, never \`<issue>\`: nothing the branch names ties it to this work, so it's never changed without the person's answer, in \`force\` mode too.
   1. Each entry's \`findIssue\` op with \`<branch>\`: open issues whose description has a \`> Branch:\` line for this branch. They come first, marked \`anchored\`.
   2. Each entry's \`searchIssues\` op with the pull request's title (else the branch name in words), then with each of up to three commit subjects (\`git log --format=%s <base>..<branch>\`): open issues that plausibly describe this branch's work, best first.

   Keep up to three in all, each with its id, title, URL, state, assignee, attached pull requests, and a one-sentence summary of its description.

### Gates

In order. 1 to 3 refuse; 4 and 5 drop one action and carry on; 6 ends a close with nothing to do.

1. **The base branch:** \`<branch>\` is \`<base>\`, or HEAD is detached: stop, \`Refusing to close <base or a detached HEAD>.\`
2. **Stacked branches:** \`above\` is more than 0: stop, \`Refusing to close <branch>: <above> branch(es) are stacked on it. Closing it would leave their pull requests pointing at a deleted branch. Close or restack those first.\`
3. **A merged pull request:** stop, \`Pull request <N> merged. close is for abandoning work, not finishing it; {{cmd}}sync remote closes out its issue.\`
4. **Already closed:** a closed pull request isn't closed again; an issue already done or canceled isn't changed. Note each for the report.
5. **Other work on the issue:** \`<otherPrs>\` isn't empty (a merged one counts: the issue may hold work that shipped): leave \`<issue>\` open, and say so.
6. **Nothing to do:** no open pull request to close, no remote branch, no issue to change, and no \`<candidates>\`: print \`Nothing to close: no open pull request, no remote branch, and no issue to cancel.\` and stop. Without them, the repo's teardown still runs: when \`close.after\` has hooks, carry on to run them rather than stopping.

A close whose only action is deleting an orphaned remote branch is still a close.

### The repo's \`before\` hooks

\`{{command:hooks}} run close.before --flow close --mode <mode> --branch <branch> --pr <N>\` (leave \`--pr\` out with no pull request). ${HOOK_RESULTS}`,
          next: "run/confirm",
        },
        {
          id: "confirm",
          kind: "action",
          title: "Summary and the searched issue",
          refName: "confirm",
          body: `Show what will run, then go on without asking, except about a searched issue.

**Actions**, only those the gates left:

- \`Close pull request #<N> ("<title>")\`
- \`Delete remote branch origin/<branch>\`
- \`Cancel issue <ID> ("<title>")\`
- \`Run the repo's teardown: <the close.after hooks' names>\`

**Warnings**, below them, the first one first:

- \`<remoteAhead>\` above 0: \`origin/<branch> has <remoteAhead> commit(s) the local branch doesn't. Deleting it throws them away.\`
- \`<issue> is attached to other pull requests (<URLs>), so it stays open. Cancel it by hand if all of that work is abandoned too.\`
- No issue found and no \`<candidates>\`: \`The branch names no issue, and none matched it. Cancel one by hand if there is one.\`
- Uncommitted changes: \`<n> uncommitted change(s) stay in the working tree.\`

### The searched issue

Only with \`<candidates>\`. Invoking close doesn't authorize changing an issue the branch never named (one whose \`> Branch:\` line names it included: that line can be stale or copied), so the person picks it.

**In \`force\` mode,** nobody can answer: change none, and list each as \`Possible issue, left open: [<ID>: <title>](<URL>)\`.

**Otherwise,** show each as a short block: \`[<ID>: <title>](<URL>)\`, its state and assignee, the one-sentence summary, \`Its description names this branch.\` when it's \`anchored\`, and \`Also attached to <URLs>.\` when other pull requests are. Then ask both at once {{askUser}}:

- \`The branch names no issue. Is one of these its issue?\`: one option per candidate (\`<ID>\`, with its title and summary), and \`None of these\`.
- \`What should happen to it?\`: \`Cancel it\` (the work is abandoned) or \`Mark it done\` (the work was finished elsewhere).

\`None of these\` changes no issue. A picked issue in an entry at \`link\` can't be changed here: say so.`,
          next: "run/writes",
        },
        {
          id: "writes",
          kind: "action",
          title: "Writes",
          refName: "writes",
          body: `Each is independent: one that fails (someone closed the pull request in the meantime) is noted and the rest still run.

1. **Close the pull request:** the source-control entry's \`prClose\` op with \`<N>\`. It deletes no branch, local or remote.
2. **Delete the remote branch:** \`git push origin --delete <branch>\`. One that says the remote ref doesn't exist was already gone, which counts as done. The local branch and its unpushed commits stay.
3. **The issue:** for \`<issue>\` (when the gates left it) its entry's \`updateIssue\` op with only \`<state>\` \`canceled\`; for the issue the person picked, \`canceled\` or \`done\` as they said. Leave the title, description, and fields out. Only in an entry at \`track\`.

Never delete the local branch, switch branches, or touch the working tree: that's the person's, or their workspace app's teardown.`,
          next: "run/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `The repo's \`close.after\` hooks run just before this, as the hooks rule above says: that's where its own teardown happens (a database branch, dev servers, a closed marker).

Lead with anything that needs attention: a failed write, a failed teardown hook, commits on the remote branch that were thrown away (\`Discarded <remoteAhead> remote-only commit(s) on origin/<branch>.\`). Then one line per action, with its outcome:

- **Pull request:** closed, already closed, none, or failed (and why).
- **Remote branch:** deleted, already gone, none, or failed.
- **Issue:** canceled or marked done (as a link), already done or canceled, left open (other pull requests attached, or a tracker at \`link\`), no issue changed (with the candidates' links when the person picked none, or \`force\` mode skipped the question), or none found.
- **Teardown:** each \`close.after\` hook and how it went.
- **Local:** \`<branch>\` and its working tree are still here; deleting them is the person's call.`,
          next: null,
        },
      ],
    },
  ],
})
