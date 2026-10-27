---
description: File issues from notes and open a workspace with a coding agent on each, or start work on issues already filed. Not for syncing a branch.
argument-hint: "[issue ids | notes URL | pasted notes] [--start-only] [--reuse [--no-ticket]] [--confirm] [--section <name> | --section-by-rank | --no-section] [--in <integration>] [--yes] [help]"
---

# /dev-flows:start-work

Starts work on issues: one new workspace per issue, on its own branch, with a coding agent already working from the issue's title, link, and description. Give it planning notes and it files them first with `/dev-flows:create-tickets`, then starts work on every issue that run filed or updated. Give it issue ids and it starts work on those. `--start-only` files nothing: it starts the ids given, the open issues the notes already match, or, with neither, the issues the last `/dev-flows:create-tickets` run filed. To only file, run `/dev-flows:create-tickets` instead.

`--reuse` works on one issue in this workspace instead of opening a new one: it renames this workspace and its branch after the issue, and this session goes on to do the work. `--no-ticket` does the same with no issue at all, naming the workspace and branch after a short title for the work.

Workspaces open through the repo's configured workspaces integration (`/dev-flows:configure workspaces`): a workspace app that starts the agent itself, or plain git worktrees, where you hand the person the command that starts it. Issues are read and moved through the configured issue tracker.

Invoking it is the go-ahead, so it asks nothing before filing or starting, except what only the person can answer (create-tickets' open questions). `--confirm` brings the question back: one look at what will be filed and started, and one yes for all of it. The `work.ts` command decides which issues to start and on which branch; you read the issues and workspaces, run the ops, and report.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `configure.ts <subcommand>` | `get <path>...` prints configured values; `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `work.ts <subcommand>` | `plan` decides which tickets to start, on which branch, and writes each agent's prompt; `branch-line` adds a `> Branch:` line to a description |
| `tickets.ts <subcommand>` | `ids` lists the issues a create-tickets plan filed or matched |

## Invariants

- **Act through the integrations' ops.** Issues are read and updated, and workspaces listed and opened, only through the ops `configure.ts integrations` returns, run as given.
- **Never start an issue twice.** An issue with a workspace on its branch, in any workspaces integration or any git worktree of this repo, gets no new one.
- **Change only an issue's branch line and state.** Its title, the rest of its description, and its fields stay as they are.

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and stop.

```
/dev-flows:start-work  [issue ids | notes URL | pasted notes]
                         [--start-only] [--reuse [--no-ticket]] [--confirm]
                         [--section <name> | --section-by-rank | --no-section]
                         [--in <integration>] [--yes] [help]

Opens one workspace per issue, each on its own branch with a coding agent
already working on it, without asking first.
  - notes, a link to them, or a sentence: files them with
    /dev-flows:create-tickets, then starts work on every issue it filed or updated
  - issue ids (ENG-12 ENG-15): starts work on those issues
  - --start-only: files nothing; starts the ids given, the open issues the
    notes already match, or with neither, the issues the last
    /dev-flows:create-tickets run filed
  - --reuse: works on one issue in this workspace instead of opening a new
    one: renames this branch and workspace after the issue, starts no new
    agent, and this session goes on to do it. Refused when this branch is
    already pushed
  - --no-ticket: like --reuse (and turns it on), but files no issue and
    changes nothing in the tracker: renames this branch and workspace after
    a short title for the work, then this session does it
  - --confirm: shows what it will file and start, and asks once first
  - --section <name>: puts the workspaces in that sidebar section; without
    it they go in this workspace's section, or none when it has none
  - --section-by-rank: puts each in the section named after its issue's
    priority (Urgent, High, …, or the repo's own names), making it if needed
  - --no-section: puts the workspaces in no section
  - --in <integration>: opens them with that workspaces integration, when the
    repo configured more than one
  - --yes: the caller already has the go-ahead; never asks, even with
    --confirm
Skips closed issues and issues that already have a workspace. Adds a
"> Branch:" line to each issue so sync finds it, and moves each issue not
started yet to in progress. Workspaces open through the repo's workspaces
integration (a workspace app, or plain git worktrees); set it up with
/dev-flows:configure workspaces.
```

## 1. Find the issues

1. **Flags.** Take `--start-only`, `--reuse`, `--no-ticket`, `--confirm`, `--section <name>`, `--section-by-rank`, `--no-section`, `--in <integration>`, and `--yes` out of `$ARGUMENTS`, and keep them for the later steps. Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag. Read plain words the same way: "don't file anything" or "only start them" is `--start-only`; "ask me first" is `--confirm`; "do it here", "in this workspace", or "reuse this worktree" is `--reuse`; "no ticket" or "just rename this" is `--no-ticket`, which turns on `--reuse`; "put them in Bugs" is `--section Bugs`; "sort them into sections by priority" is `--section-by-rank`. "Just file them" means this isn't the command: run `/dev-flows:create-tickets` with the notes instead, and stop. When more than one of the three section flags is there, say only one can be given, and stop. `--no-ticket` can't be combined with issue ids, `--start-only`, or `--section-by-rank` (there's no issue to rank): say so and stop. `--yes` means the caller (such as `/dev-flows:tickets-to-work`) already has the person's go-ahead: ignore `--confirm` and ask nothing.
2. **Integrations.** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations workspaces issueTracker` (with `--reuse`, also `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations stacking --optional`: its first entry, if any, renames the branch) and `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - New workspaces open with the `workspaces` entry `--in` names (by `instance` or `integration`), else the first one. Every `workspaces` entry is read for workspaces already open.
   - An issue belongs to the `issueTracker` entry whose `issueRef` it matches. Only an entry at `level` `track` gets its issues' branch line and state changed; at `link` they are only read.
3. **Where its files go:** `<dir>` is `git rev-parse --absolute-git-dir` plus `/agent-flows/start-work` (create it), and create-tickets' plans are in `git rev-parse --absolute-git-dir` plus `/agent-flows/create-tickets`.
4. **The issues**, from what is left of the arguments:
   - **Issue ids** (any case), and nothing else: use them as given. There is nothing to file.
   - **Notes, a link to them, or a sentence,** without `--start-only`: run the `/dev-flows:create-tickets` skill with the text and `--yes`, so it files without its confirmation question and asks only what only the person can answer. With `--confirm` (and no `--yes`), leave `--yes` off and put its question as "file these and start a workspace on each?", so one yes covers both. If the person stops before filing, stop here too. Once it has filed, `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" ids --plan <create-tickets dir>/plan.json` lists every issue it filed, updated, or left as is: those are the issues.
   - **Notes, a link, or a sentence, with `--start-only`:** file nothing. Run the `/dev-flows:create-tickets` skill with `match` and the text: it finds the open issues the notes already describe, and files and changes nothing. Then `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" ids --plan <create-tickets dir>/match.json` lists the issues it matched (its `<key>: match <ID>` lines): those are the issues. List each `new` or `sub-issue of` item as not started, and say `/dev-flows:start-work` without `--start-only` files and starts them.
   - **Nothing, with `--start-only`:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" ids --plan <create-tickets dir>/plan.json`, the issues the last create-tickets run filed. When the file is missing or it prints `NONE`, ask for issue ids and stop.
   - **Nothing:** ask for issue ids or notes, and stop.

   **With `--reuse`,** this workspace takes exactly one issue. Issue ids: there must be one. From notes: when create-tickets filed or matched more than one, ask which one this workspace takes (the rest stay filed, and `/dev-flows:start-work --start-only <ids>` opens workspaces on them). With `--confirm`, put create-tickets' question as "file this and work on it here?" instead.

   **With `--no-ticket`,** skip the issues above and never run create-tickets: write a short title for the work from the arguments, the way an issue title reads (one plain sentence, under about 70 characters), and keep the arguments as the notes for the work. With nothing to go on, ask what the work is and stop.

## 2. Decide what starts

1. **Read each issue** with its tracker entry's `getIssue` op, and **every open workspace** with each `workspaces` entry's `workspaces` op. Write them to `<dir>/start.json`:

   ```json
   {
     "tickets": [
       { "id": "<ID>", "title": "...", "url": "...", "description": "...", "stage": "todo", "priority": "high", "branchName": "<suggested branch, or null>" },
       { "id": "<ID>", "missing": true }
     ],
     "workspaces": [
       { "integration": "<integration or instance>", "id": "...", "name": "...", "branch": "...", "section": "<section, or null>", "current": false }
     ]
   }
   ```

   `stage` is its workflow state as one of `todo` (triage, backlog, and not started count), `in progress`, `in review`, `done`, or `canceled`; `priority` is `urgent`, `high`, `medium`, `low`, or `none`; `branchName` is the branch the tracker suggests for it, or `null`. An issue `getIssue` doesn't find is `"missing": true`. A workspace's `section` is `null` when it has none, and `current` is true for the one this session runs in. When no variant of a `workspaces` op works here, leave its workspaces out and say so: `work.ts` still checks this repo's git worktrees.
2. **Decide.** Run it with the section flag when one was given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" plan --input <dir>/start.json [--section "<name>" | --section-by-rank | --no-section] [--ranks <names>]
   ```

   When the repo's agent instructions (`AGENTS.md`, `CLAUDE.md`, and the docs they point to for ranking work) name the priorities their own way (P0, P1, …), pass `--ranks` with their names for `urgent`, `high`, `medium`, `low`, and no priority, in that order (`--ranks Urgent,P0,P1,P2,Audit`). It writes nothing to any tracker. Exit code 2 is bad input: fix `start.json` and run it again. It prints one line per issue:
   - `START`: a new workspace on `branch` (`exact=yes` when the issue's own `> Branch:` line named it; `no` lets the integration put it under its prefix), in `section`, with the agent's prompt in `prompt`. `state=move` means the issue hasn't started yet, so it moves to in progress.
   - `EXISTS`: a workspace is already on the issue's branch. `branch-line=add` means the issue has no `> Branch:` line yet, and `state=move` that it moves to in progress.
   - `SKIP`: done, canceled, or not found.
   **With `--reuse`,** run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" reuse --input <dir>/start.json [--section "<name>" | --section-by-rank | --no-section] [--ranks <names>]` instead, with the one issue. **With `--no-ticket`,** read only the workspaces (for the one this session runs in) and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" reuse --title "<title>" [--section "<name>" | --no-section]`. Neither changes anything yet. Each prints a `REUSE` line: this workspace's branch now and the one it becomes (`->`), its new `name`, its `section` (`keep` without a section flag), and for an issue, `branch-line` and `state` as for `EXISTS`. An issue may instead print `EXISTS` (another workspace is already on it: report it and stop) or `SKIP`.
3. **With `--confirm`** (and no `--yes`), unless create-tickets' "file these and start a workspace on each?" just covered it: show the lines as a short table (issue, title, branch, section) and ask once: start these? A `REUSE` line is asked as "work on this here?" (or, with `--no-ticket`, "rename this workspace and branch to that?"). Stop on a no. When there is no `START` or `REUSE` line and no `EXISTS` line with something to add or move, say so and stop.

## 3. Start and report

Go through the lines in order, without asking (with `--confirm`, after the yes). When an op fails, note it and carry on with the next issue.

1. **`START`:** the chosen `workspaces` entry's `createWorkspace` op, with `<name>` `<ID>: <title>`, `<branch>` and `<exact>` from the line, `<base>` the configured `repo.baseBranch`, `<section>` the line's (leave it out for `none`), and `<prompt-file>` the line's `prompt`. Note the branch it prints: that's the issue's branch from now on, prefix and all. When it prints a command that starts the agent instead of starting one, keep that command for the report.
2. **The issue** (a `START` that opened, or an `EXISTS` with `branch-line=add` or `state=move`), when its tracker entry is at `track`: write the description `getIssue` returned to `<dir>/<ID>.md`, then

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" branch-line --description <dir>/<ID>.md --branch <branch>
   ```

   with the workspace's branch. It prints `ADDED` when it added a `> Branch:` line, so sync finds the issue from the branch, or `UNCHANGED` when there was one. Then, when it added one or the line says `state=move`, the entry's `updateIssue` op with only what changes: the description from the file (when `ADDED`) and the state `in progress` (when `state=move`). Leave the title and every field out. At `link`, change nothing on the issue, and say so in the report.

3. **`REUSE`:** run the same `node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" reuse` command again with `--yes`, and with a stacking entry also `--rename '<its rename op's cli variant, with <name> left in>'`, so the stacking tool's record follows the branch. It renames this worktree's git branch and prints `RENAMED branch=<branch>`, or `KEPT branch=<branch>` when the branch already fits. Then the `renameWorkspace` op of the `workspaces` entry this session runs in, with `<id>` its id, `<name>` and `<section>` from the line (leave `<section>` out for `keep`); when no entry marks a workspace as this session's, skip it and say so. Then the issue as in 2, with the new branch. It starts no agent. `FAILED` (exit code 1) when the branch is already pushed means renaming it would leave its remote branch and pull request behind: report it, and say `/dev-flows:start-work --start-only <ID>` opens a new workspace on the issue instead (or, with `--no-ticket`, that a new workspace can take the work). After the rename, report it in one line (the issue's link, or the title, and the new branch), then start the work in this session: from the issue's title and description, or from the notes with `--no-ticket`.

**Report** a short table: one row per issue, with its link, title, what happened (started, already open, skipped and why, or failed and why), branch, section, and whether it moved to in progress. Failures go first. For each workspace the integration couldn't start an agent in, give the command that starts it. Running the same command again after fixing a failure starts only what didn't start, since the started ones now show as `EXISTS`, and fixes any issue whose workspace opened but whose update failed.
