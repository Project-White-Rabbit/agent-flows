---
name: close-run
description: Run phase of the /dev-flows:close flow. Invoked by the close flow; not run directly
user-invocable: false
---

# /dev-flows:close: Run

**Mode:** you were dispatched with a mode (`default` or `force`); which steps apply and where they route below depend on it.

**Run only when mode is `default` or `force`.**

## 1. Survey and gates

Reads only, apart from one `git fetch` and the repo's `close.before` hooks. A gate that fails stops the command with nothing written.

### Survey

1. **Base branch:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints `{"values": {"repo.baseBranch": "<base>"}}`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead.
2. **Integrations:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations sourceControl stacking issueTracker --optional`. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - **Source control:** the entry whose repository (from its `values`) is this checkout's `origin` in `git remote -v`, if any. At `level` `read`, its pull request is only read: say it can't be closed here, and leave it.
   - **Stacking:** the first entry, if any.
   - **Issue tracker:** every entry is searched; only an issue in an entry at `level` `track` is changed.
3. **Branch:** `git branch --show-current` is `<branch>`.
4. **Pull request:** the source-control entry's `branchPr` op for `<branch>`: `<N>`, its URL, title, and state, or none.
5. **Remote branch:** `git ls-remote --heads origin <branch>`. Empty output means there's none; a failure stops the command.
6. **What's left behind:** `git status --porcelain` (changes left in the working tree), and, when the remote branch exists, `git fetch origin <branch>` then `git rev-list --count <branch>..origin/<branch>`: `<remoteAhead>`, commits on the remote that the local branch doesn't have, which deleting it throws away.
7. **Stacked branches:** with a stacking entry, its `downstack` op: `above` is how many branches sit on this one.
8. **The issue**, stopping at the first that loads with its entry's `getIssue` op (a ref is a string an issue-tracker entry's `issueRef` op matches):
   1. The issue a sync recorded for this branch: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" issue` prints `{"branch", "issue"}`.
   2. A ref in the branch name: the leftmost one only. When it doesn't load, don't try the others: cancelling the wrong issue is far worse than missing the right one.
   3. The pull request body's `> Issue:` line (or a `> ` line named for the tracker).

   The first that loads is `<issue>`, named by the branch. Its attached pull requests other than this branch's, open, merged, or closed, are `<otherPrs>`: any one means other work has used the issue.

   **When none of those finds one:** look for it, and keep what turns up as `<candidates>`, never `<issue>`: nothing the branch names ties it to this work, so it's never changed without the person's answer, in `force` mode too.
   1. Each entry's `findIssue` op with `<branch>`: open issues whose description has a `> Branch:` line for this branch. They come first, marked `anchored`.
   2. Each entry's `searchIssues` op with the pull request's title (else the branch name in words), then with each of up to three commit subjects (`git log --format=%s <base>..<branch>`): open issues that plausibly describe this branch's work, best first.

   Keep up to three in all, each with its id, title, URL, state, assignee, attached pull requests, and a one-sentence summary of its description.

### Gates

In order. 1 to 3 refuse; 4 and 5 drop one action and carry on; 6 ends a close with nothing to do.

1. **The base branch:** `<branch>` is `<base>`, or HEAD is detached: stop, `Refusing to close <base or a detached HEAD>.`
2. **Stacked branches:** `above` is more than 0: stop, `Refusing to close <branch>: <above> branch(es) are stacked on it. Closing it would leave their pull requests pointing at a deleted branch. Close or restack those first.`
3. **A merged pull request:** stop, `Pull request <N> merged. close is for abandoning work, not finishing it; /dev-flows:sync remote closes out its issue.`
4. **Already closed:** a closed pull request isn't closed again; an issue already done or canceled isn't changed. Note each for the report.
5. **Other work on the issue:** `<otherPrs>` isn't empty (a merged one counts: the issue may hold work that shipped): leave `<issue>` open, and say so.
6. **Nothing to do:** no open pull request to close, no remote branch, no issue to change, and no `<candidates>`: print `Nothing to close: no open pull request, no remote branch, and no issue to cancel.` and stop. Without them, the repo's teardown still runs: when `close.after` has hooks, carry on to run them rather than stopping.

A close whose only action is deleting an orphaned remote branch is still a close.

### The repo's `before` hooks

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run close.before --flow close --mode <mode> --branch <branch> --pr <N>` (leave `--pr` out with no pull request). It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop.

## 2. Summary and the searched issue

Show what will run, then go on without asking, except about a searched issue.

**Actions**, only those the gates left:

- `Close pull request #<N> ("<title>")`
- `Delete remote branch origin/<branch>`
- `Cancel issue <ID> ("<title>")`
- `Run the repo's teardown: <the close.after hooks' names>`

**Warnings**, below them, the first one first:

- `<remoteAhead>` above 0: `origin/<branch> has <remoteAhead> commit(s) the local branch doesn't. Deleting it throws them away.`
- `<issue> is attached to other pull requests (<URLs>), so it stays open. Cancel it by hand if all of that work is abandoned too.`
- No issue found and no `<candidates>`: `The branch names no issue, and none matched it. Cancel one by hand if there is one.`
- Uncommitted changes: `<n> uncommitted change(s) stay in the working tree.`

### The searched issue

Only with `<candidates>`. Invoking close doesn't authorize changing an issue the branch never named (one whose `> Branch:` line names it included: that line can be stale or copied), so the person picks it.

**In `force` mode,** nobody can answer: change none, and list each as `Possible issue, left open: [<ID>: <title>](<URL>)`.

**Otherwise,** show each as a short block: `[<ID>: <title>](<URL>)`, its state and assignee, the one-sentence summary, `Its description names this branch.` when it's `anchored`, and `Also attached to <URLs>.` when other pull requests are. Then ask both at once with `AskUserQuestion` :

- `The branch names no issue. Is one of these its issue?`: one option per candidate (`<ID>`, with its title and summary), and `None of these`.
- `What should happen to it?`: `Cancel it` (the work is abandoned) or `Mark it done` (the work was finished elsewhere).

`None of these` changes no issue. A picked issue in an entry at `link` can't be changed here: say so.

## 3. Writes

Each is independent: one that fails (someone closed the pull request in the meantime) is noted and the rest still run.

1. **Close the pull request:** the source-control entry's `prClose` op with `<N>`. It deletes no branch, local or remote.
2. **Delete the remote branch:** `git push origin --delete <branch>`. One that says the remote ref doesn't exist was already gone, which counts as done. The local branch and its unpushed commits stay.
3. **The issue:** for `<issue>` (when the gates left it) its entry's `updateIssue` op with only `<state>` `canceled`; for the issue the person picked, `canceled` or `done` as they said. Leave the title, description, and fields out. Only in an entry at `track`.

Never delete the local branch, switch branches, or touch the working tree: that's the person's, or their workspace app's teardown.

## 4. Report

The repo's `close.after` hooks run just before this, as the hooks rule above says: that's where its own teardown happens (a database branch, dev servers, a closed marker).

Lead with anything that needs attention: a failed write, a failed teardown hook, commits on the remote branch that were thrown away (`Discarded <remoteAhead> remote-only commit(s) on origin/<branch>.`). Then one line per action, with its outcome:

- **Pull request:** closed, already closed, none, or failed (and why).
- **Remote branch:** deleted, already gone, none, or failed.
- **Issue:** canceled or marked done (as a link), already done or canceled, left open (other pull requests attached, or a tracker at `link`), no issue changed (with the candidates' links when the person picked none, or `force` mode skipped the question), or none found.
- **Teardown:** each `close.after` hook and how it went.
- **Local:** `<branch>` and its working tree are still here; deleting them is the person's call.
