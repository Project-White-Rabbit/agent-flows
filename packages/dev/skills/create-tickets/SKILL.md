---
description: File issues from planning notes, a page link, or a sentence, updating issues that already describe the same work. Not for syncing a branch.
argument-hint: "[match|help] [notes URL | pasted notes | sentence] [--yes]"
---

# /dev-flows:create-tickets

Turns planning notes into issues in the repo's issue tracker: each planned item becomes one issue, with its action items as a checklist in the description rather than sub-issues (the people doing the work split those out if they want them). Issues that already describe the same work are updated instead of filed twice, and the whole result is shown as one table and filed on one confirmation. Every tracker action goes through the repo's configured integrations (`/dev-flows:configure`), so it works with any issue tracker.

In default mode, `--yes` anywhere in the arguments skips the confirmation when nothing needs an answer; the rest is the notes. In `match` mode, `--branch <branch>` says the text describes that branch's work; the rest is the text.

The `tickets.ts` command checks the plan and draws the table; you turn the notes into a plan, match it, show the table, and apply it. Aim for three turns: draft, confirm, apply.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Exits 2 when the repo isn't configured for it |
| `tickets.ts <subcommand>` | `check` checks the plan and prints the table to confirm (or `PROBLEM` lines); `record` saves an issue apply just filed into the plan |

## Invariants

- **Act through the integrations' ops.** Issues are searched, filed, updated, and linked only through the ops `configure.ts integrations` returns, run as given.
- **File only what the notes describe.** Don't invent work, and don't split an item into sub-issues the notes don't ask for.
- **Existing issues keep their title, description, and parent.** An update sets only the fields the plan changes.
- **Nothing is written before the confirmation** (or `--yes`), and nothing at all in `match` mode.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow create-tickets --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow create-tickets --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Follow only the selected mode's path below.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Turn the notes into issues: draft a plan, match it against existing issues, confirm one table, and file it. |
| `match` | `match` | Only look: draft the plan and find the issues that already describe it. Files and changes nothing. Sync uses it with `--branch`. |
| `help` | `help` | Show usage and exit. |

## 0. Help shortcut

**Run only when mode is `help`.**

If mode is `help`, print the block below verbatim and exit. No reads, no writes.

> `/dev-flows:create-tickets` files issues from planning notes.
>
> Usage:
>   - `/dev-flows:create-tickets <notes URL | pasted notes | sentence> [--yes]` -- each planned item becomes one issue, its action items a checklist in the description. Issues that already describe the same work are updated instead, and work closed in the last 90 days is flagged, not filed again. Shows one table and files everything on one confirmation (`--yes` skips it when nothing needs an answer). Running it again on the same notes only updates.
>   - `/dev-flows:create-tickets match [--branch <branch>] <text>` -- only find the issues that already describe the work. Files and changes nothing. Sync uses it to find a branch's issue.
>   - `help` -- show this and exit
>
> Priority, labels, estimate, cycle, project, assignee, and due date come from the notes, then the repo's agent instructions, then the issue tracker's config. It needs an issue tracker (`/dev-flows:configure issueTracker`), at `track` to file.

## 1. Read the notes

**Run only when mode is `default` or `match`.**

1. **Issue tracker:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations issueTracker` prints every entry the repo configured. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - Every entry is searched. Only entries at `level` `track` get issues filed or updated: file in the first of those, unless the notes, the user, or the repo's agent instructions name another. An entry at `link` is read-only here.
   - In default mode with no entry at `track`, stop: `Every issue tracker here is linked only, so create-tickets can't file. Run /dev-flows:configure <integration> to track issues, or use /dev-flows:create-tickets match to look without filing.`
2. **The notes**, from the arguments (minus the mode keyword and flags):
   - **Flags:** `--yes` in default mode, `--branch <branch>` in `match` mode. Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag.
   - **A URL:** read the page with this session's tools for that site (an MCP server's fetch or read tool; search for deferred ones before deciding there are none), else a plain web fetch. When nothing can read it (it needs a sign-in no tool has), ask the person to paste the page and stop until they do.
   - **Pasted notes** (often a flat list with no headings, copied from a chat channel or a doc) **or a sentence:** use the text as given.
   - **Nothing:** ask for the notes or a link, and stop.
3. **Where the plan goes:** `<dir>` is `git rev-parse --absolute-git-dir` plus `/agent-flows/create-tickets` (create it), so the plan never lands in the tree. The plan is `<dir>/plan.json` in default mode and `<dir>/match.json` in `match` mode, so looking never overwrites a notes plan or the issues it recorded as filed.

## 2. Draft the plan

**Run only when mode is `default` or `match`.**

Read the repo's agent instructions (`AGENTS.md`, `CLAUDE.md`, and the docs they point to for ranking or filing work): its priority scale, labels, and what an issue should say. Then write the plan:

```json
{
  "source": { "title": "Planning, Oct 24", "url": "<the notes' URL; omit for pasted notes>" },
  "items": [
    { "key": "sync", "title": "Sync planning with the dev workflow", "priority": "high", "assignee": "Sam", "project": "Dev tools",
      "description": "What the work is and when it's done.\n\n- [ ] Pick the next task from a coding agent\n- [ ] Post issue changes to chat",
      "label": "Feature", "defaults": ["project"] },
    { "key": "bot", "title": "Answer issue questions in chat", "cycle": "next", "blockedBy": ["sync"] }
  ]
}
```

| Field | Rule |
|---|---|
| `key` | Short and unique. `parent` and `blockedBy` refer to keys, or to an existing issue's id. |
| `title` | Plain words saying what the work does, never an issue id. |
| `description` | What the work is and when it's done, then its action items as a checklist (`- [ ] ...`). |
| `parent` | Usually left out: each planned item is one issue however many pull requests it takes, and its action items go in its checklist, never into sub-issues. In flat notes with no headings, fold lines into one item when they're clearly parts of the same work; otherwise each line is its own item. Set it only when the notes name an existing issue the work belongs under (matching may add one too). |
| `priority` | `urgent`, `high`, `medium`, or `low`, from how the notes rank the work, read through the agent instructions' scale (a team's P0 might be `urgent`). On a new item the notes don't rank, the tracker entry's `values.priority` or the agent instructions' default, listed in `defaults`; with neither, leave it out. |
| `cycle` | When the work happens: `current`, `next`, a cycle number, or a `YYYY-MM-DD` date inside it, from the notes ("this week", "next week", "after the launch"). Otherwise as the issue fields below say, listed in `defaults`. |
| `dueDate` | `YYYY-MM-DD`, only from the notes (or the agent instructions, when they require one for some work: ask for it at the confirmation). `null` clears a matched issue's date; leaving it out keeps it. |
| `assignee` | The person the notes name (a first name is enough). Leave it out for the person running this. One person per issue. |
| `project` | The one the notes name for the area, else the entry's `values.project`, listed in `defaults`. |
| `label` | One label from the set the agent instructions or the entry's `values.labels` give, by the kind of work. Leave it out with no set. |
| `estimate` | Only when the agent instructions or the entry's `values.estimate` ask for one. |
| `blockedBy` | Only when the notes say one piece of work waits on another. Work that holds up a teammate is not a reason on its own. |
| `tracker` | The entry to file in (its `instance` or `integration`), only when it isn't the first at `track`. |
| `defaults` | The fields set from a default rather than read from the notes, so the table marks them for checking. |
| `match`, `existing` | Leave them out: matching sets them. |

Don't invent work the notes don't mention.

**Running again on the same notes:** when the plan file already exists with the same `source`, start from it. Its items with a `match` are issues filed or matched last time; keep those matches, so a re-run only updates.

**In `match` mode** the text is usually one item: draft it as one, unless it plainly lists several pieces of work. With `--branch`, it's that branch's work: judge it against this session and the branch's commits too.

## 3. Find matches

**Run only when mode is `default` or `match`.**

For each item, run every entry's `searchIssues` op: once with the title, then once with each checklist line or sentence that names a distinct piece of the work (up to three), since an issue filed under another name may match on one line alone. Judge each candidate against the whole item (its description and checklist, and with `--branch`, the branch's work), not the title alone. Decide without asking:

- **The same work, open:** set `"match": "<ID>"`, then load it with the entry's `getIssue` op and set `existing` from it: `title`, `priority`, `cycle`, `dueDate`, `assignee`, `project`, `parent`, and `closed: false`. With `--branch`, it's a match only when no pull request is attached and its description has no `> Branch:` line naming another branch; otherwise it's someone else's piece of the same work: the next case.
- **Part of a larger open issue** (it covers the work as a whole, like a project's main issue), or with `--branch`, the same work under another pull request or branch: set `"parent": "<ID>"` and leave `match` out, so the item is filed as a sub-issue of it rather than beside it.
- **Closed** (done or canceled in the last 90 days) **and the same work:** it's already done. Drop the item from the plan, and name the issue in the confirmation. With `--branch`, keep the item new and name the closed issue in the result: a closed issue is never a branch's issue.
- **In an entry at `link`:** never a match, since it can't be updated here. When it's the same work, drop the item and name the issue in the confirmation as already tracked there. With `--branch`, keep the item and list the issue as `also tracked`.
- **A loose overlap, or nothing fits:** leave the item new. Take a match only when it's clearly the same work.

Two items that match the same issue are one piece of work: merge them into one item. When no variant of `searchIssues` works here, leave every item new and say the search was skipped.

**In `match` mode, stop here.** Write nothing to the tracker. Print one line per item, then stop:

```
<key>: match <ID> (<title>, <URL>)        the same open work
<key>: sub-issue of <ID> (<title>, <URL>)  part of a larger issue
<key>: new                                 nothing describes it yet
  closed: <ID> (<title>, <URL>)            a closed issue that did the same work (one line each)
  also tracked: <ID> (<title>, <URL>)      the same work in an entry at link (one line each)
search skipped: <why>                      only when no variant of searchIssues worked
```

**Next:**

- Mode `default`: invoke the `create-tickets-confirm` skill with mode `default`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- Mode `match`: stop here.
