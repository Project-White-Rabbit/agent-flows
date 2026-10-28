---
name: create-tickets-apply
description: Apply phase of the /dev-flows:create-tickets flow. Invoked by the create-tickets flow; not run directly
user-invocable: false
---

# /dev-flows:create-tickets: Apply

**Run only when mode is `default`.**

## 1. File and report

After a yes (or with `--yes` and nothing to ask). `<dir>` and the tracker entries are from the *Main* section of the `create-tickets` skill.

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" check --plan <dir>/plan.json` once more for the final row order, then go through the rows in order. An item files in its `tracker` entry, else the first entry at `track`. Each row's values are the ones the table shows: its title (with the blocker mark), its priority and cycle (with what came from sub-issues), and its project (with what came from its parent); a label `check` printed a `NAME` line for files under the full name it gives.

0. **The planning document,** when `tickets.planningDoc` is true: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" notes --plan <dir>/plan.json --notes <dir>/notes.md --out <dir>/section.md` prints the document's `title` and the section's `key`. Run the filing entry's `recordNotes` op with `<title>`, `<section-file>` `<dir>/section.md`, and `<key>`, and keep the document's title and URL it prints. It records the notes before anything is filed, so they're kept even if filing fails. When the op is `unsupported` or fails, carry on without the document and its links, and say so in the report.
1. **`file`:** the entry's `createIssue` op with the title, the description, `<parent>` (a parent key becomes the id that item was filed or matched as), `<state>` `todo`, and `<fields>` from the issue fields below. With the planning document, write the description to `<dir>/<key>.md` and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" planning-line --plan <dir>/plan.json --notes <dir>/notes.md --description <dir>/<key>.md --title <doc title> --url <doc URL>` first, and file the file's text: it puts a `> Planning:` line linking the document on top. Right after each one, before the next row, save it so a re-run updates it rather than filing it twice:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" record --plan <dir>/plan.json --key <key> --id <ID> --url <URL>
   ```

2. **`update`:** the entry's `updateIssue` op with only what the row changes: `<fields>` the plan changes, `<parent>` when the row's parent reads `<old> → <new>`, and `<title>` when it gains the blocker mark. With the planning document, also write the issue's description (from `getIssue`) to `<dir>/<key>.md` and run the same `planning-line` command on it; when it prints `CHANGED`, pass the file's text as `<description>`. Leave the state out, and the title and description otherwise: they stay as they are. A row for an issue outside the plan sets only its priority.
3. **`unchanged`:** nothing.
4. **Blocked by:** once every row is done, for each item's `blockedBy`, the entry's `linkBlocked` op with `<ID>` the item's issue and `<blocker>` the blocking one (a key becomes the id it was filed or matched as).
5. **The planning document's issues,** when step 0 recorded it: run the same `notes` command again (the plan now holds every issue filed), and the `recordNotes` op again with the new section, which replaces the one step 0 wrote.

When an op fails, carry on with the other rows and note it. A row that didn't file stays new in the plan, so running `/dev-flows:create-tickets` again on the same notes picks up where this left off.

#### Issue fields

Take each field from, in order: the notes and the user in this session, the repo's agent instructions (`AGENTS.md`, `CLAUDE.md`, and the docs they point to for ranking or filing work), then the entry's `values` of the same name; the plan already holds what you chose. A field the notes set counts as the user asking. Pass as `<fields>` only the fields that change.

- **Priority:** set it when filing, and on an update only when the issue has none. Never change a priority the issue already has, since a person may have set it, unless the user asks to in this session.
- **Labels:** when there's a set to pick from (the agent instructions' or `values.labels`), exactly one of it that fits the kind of work. Judge it again on each full update: keep the current one unless another fits strictly better, and never add or remove labels outside the set.
- **Estimate:** when the agent instructions or `values.estimate` ask for one, the size of the work on the team's scale, judged again on each full update.
- **Cycle:** the one the user names (`current`, `next`, or a date inside it); else, when the agent instructions or `values.cycle` ask for cycles, `current`. Set it when filing, or on an update when the issue has no cycle and isn't done or canceled. Never move an issue out of a cycle it's in unless the user asks.
- **Project:** the one the user or the agent instructions name, else a new sub-issue's parent's, else `values.project`: when filing, or on an update when the issue has none. Never move an issue out of a project it's in unless the user asks.
- **Assignee:** only the person the user names; left out, a new issue goes to the person running this. Never reassign an issue unless the user asks.
- **Due date:** only when the user gives one. Read a weekday deadline ("Friday", "Mon EOD") as today when today is that weekday, else the next one, and say which date you chose. Never clear one unless the user asks (`null`).

#### Report

Lead with anything that needs attention: a failed op (what failed and why), a skipped search, and items left unfiled. Then:

- Each issue filed, updated, or left unchanged, as a link: `[<ID>: <title>](<URL>)`, grouped by what happened.
- How many blocked-by links were made.
- The planning document, as a link, and whether it was created or updated; or why there's none.
- Items dropped because a closed issue did the work, and issues already tracked in an entry at `link`.
