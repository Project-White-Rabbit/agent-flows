---
description: Go through your open issues that have no pull request or workspace yet, most urgent first, and start, skip, or close each one.
argument-hint: "[--priority <ranks>] [--limit <n>] [--section <name> | --section-by-rank] [--in <integration>] [help]"
---

# /dev-flows:tickets-to-work

Walks through the open issues assigned to you that have no pull request, workspace, or git worktree yet, most urgent first, and decides each one with you: start it (through `/dev-flows:start-work`: a workspace with a coding agent on it, and the issue moved to in progress), skip it, or close it. One issue at a time, one question each. Issues are read and closed through the repo's configured issue tracker, and workspaces through its workspaces integration (`/dev-flows:configure`).

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Exits 2 when the repo isn't configured for it |
| `work.ts <subcommand>` | `list` puts the issues with no work started yet in the order to pick them up |

## Invariants

- **Act through the integrations' ops.** Issues are read and closed, and workspaces listed, only through the ops `configure.ts integrations` returns, run as given; workspaces open only through `/dev-flows:start-work`.
- **The person decides every issue.** One question per issue, never several in one, never skipped because the answer looks obvious.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow tickets-to-work --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow tickets-to-work --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and stop.

```
/dev-flows:tickets-to-work  [--priority <ranks>] [--limit <n>]
                              [--section <name> | --section-by-rank]
                              [--in <integration>] [help]

Goes through your open issues that have no pull request, workspace, or git
worktree yet, most urgent first (then the ones whose title has the team's
blocker mark, then the earliest due, then the ones blocking other work),
and asks about each one:
  - Start: opens a workspace with a coding agent on it and moves the issue
    to in progress (/dev-flows:start-work)
  - Skip: leaves it for later
  - Close: moves it to canceled (or done, if you say so)
  - Stop: ends the run
An issue with open sub-issues is left out: its sub-issues are the work.
--priority <ranks>: only these priorities: urgent, high, medium, low, none,
  or the names the repo's agent instructions give them (--priority urgent,p0)
--limit <n>: only the first n issues, after --priority
--section <name>: puts started workspaces in that sidebar section; without
  it they go in no section
--section-by-rank: puts each started workspace in the section named after
  its issue's priority, making it when there is none yet
--in <integration>: opens them with that workspaces integration, when the
  repo configured more than one
```

## 1. List the issues

1. **Flags.** Take `--priority <ranks>`, `--limit <n>`, `--section <name>`, `--section-by-rank`, and `--in <integration>` out of `$ARGUMENTS`. Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag. Read plain words the same way: "only urgent and P0" is `--priority urgent,p0`, "just 5" or "top 5" is `--limit 5`, "sort them into sections by priority" is `--section-by-rank`. When both `--section-by-rank` and `--section` are given, `--section-by-rank` wins: say once that `--section` is ignored.
2. **Integrations.** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations issueTracker workspaces`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them. Closing an issue needs its entry at `level` `track`; at `link`, its issues can be started or skipped, not closed.
3. **The issues.** `<dir>` is `git rev-parse --absolute-git-dir` plus `/agent-flows/tickets-to-work` (create it). Run every `issueTracker` entry's `assignedIssues` op and every `workspaces` entry's `workspaces` op, and write them to `<dir>/issues.json`:

   ```json
   {
     "issues": [
       { "id": "<ID>", "title": "...", "url": "...", "state": "<workflow state name>", "stage": "todo", "description": "...", "priority": "high", "dueDate": "<YYYY-MM-DD, or null>", "openSubIssues": false, "pullRequests": [], "blocks": false }
     ],
     "workspaces": [
       { "integration": "<integration or instance>", "id": "...", "name": "...", "branch": "...", "section": "<section, or null>", "current": false }
     ]
   }
   ```

   `stage` is its workflow state as one of `todo` (triage, backlog, and not started count), `in progress`, `in review`, `done`, or `canceled`; `priority` is `urgent`, `high`, `medium`, `low`, or `none`. A workspace's `section` is `null` when it has none. When no variant of a `workspaces` op works here, leave its workspaces out and say so: `work.ts` still checks this repo's git worktrees. Then, passing `--priority` and `--limit` only when given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/commands/work.ts" list --input <dir>/issues.json [--priority <ranks>] [--limit <n>] [--ranks <names>]
   ```

   When the repo's agent instructions (`AGENTS.md`, `CLAUDE.md`, and the docs they point to for ranking work) name the priorities their own way (P0, P1, …), pass `--ranks` with their names for `urgent`, `high`, `medium`, `low`, and no priority, in that order (`--ranks Urgent,P0,P1,P2,Audit`). It reads the config's `tickets.blockerMark` itself, and marks an issue whose title has it `blocker`. It prints one `TICKET` line per issue with no work started yet (no open sub-issues, no pull request, and no workspace or git worktree on its branch), already in the order to go through them, then `COUNT <n>` (the issues printed) and `TOTAL <n>` (before `--priority` and `--limit`). Exit code 2 is an unknown `--priority` rank (say which ones exist, and stop) or bad input (fix `issues.json` and run it again).

When `COUNT` is 0, say there is nothing waiting and stop; when `TOTAL` is above 0, say instead that the filters left out all `TOTAL` issues, and stop. Otherwise say how many issues there are, and when `COUNT` is less than `TOTAL`, how many the filters left out.

## 2. Decide each issue

Take the issues in the printed order, one at a time. Each gets its own question, asked with `AskUserQuestion` as one question per call: never several issues in one question, never an issue decided for the person, and never a question skipped because the answer looks obvious. The question names the issue: its id and title, then its priority, its due date (saying when it's past), its state, whether it stops a customer (`blocker`) or blocks other work, and its link. It offers all four options, Stop included, so the person can end the run from any issue:

- **Start:** open a workspace with a coding agent on it and move the issue to in progress.
- **Skip:** leave it and move on.
- **Close:** move it to canceled. Leave this option out when the issue's tracker entry is at `link`.
- **Stop:** end the run here.

Act on the answer before asking about the next issue:

- **Start:** run the `/dev-flows:start-work` skill with `<ID> --yes`, plus `--section-by-rank` when it was given, else `--section "<name>"` when that was, else `--no-section` (so the workspace lands in no section rather than this one's), plus `--in <integration>` when given, and follow it through. The answer is the go-ahead, which is what `--yes` tells it, so it doesn't ask again. Report its row for the issue; on a failure, say so and keep going.
- **Skip:** move on.
- **Close:** the entry's `updateIssue` op with only the state `canceled`, or `done` when the person says the work is already done. Leave the title, description, and fields out.
- **Stop:** go to the report.

## 3. Report

List what happened in three groups: started (issue link and branch, and the command to start the agent when the integration couldn't), closed (issue link and the state it moved to), and skipped. Then say how many issues weren't reached when the run stopped early. Anything that failed goes first.
