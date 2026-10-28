---
name: create-tickets-confirm
description: Confirm phase of the /dev-flows:create-tickets flow. Invoked by the create-tickets flow; not run directly
user-invocable: false
---

# /dev-flows:create-tickets: Confirm

**Run only when mode is `default`.**

## 1. Show the table and confirm

`<dir>` and the tracker entries are from the *Main* section of the `create-tickets` skill.

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" check --plan <dir>/plan.json
```

It writes nothing. `PROBLEM` lines (exit 1) block filing: a name the tracker doesn't have (fix it with one it lists), an issue the plan names but hasn't loaded or that doesn't exist, a due date the team's rules require, a due date before its cycle starts, a parent loop. Fix what you can in the plan and run it again, and put anything only the person can answer (a due date) into the confirmation question. Otherwise it prints the table, one row per issue to file, update, or leave as is, in the order apply files them (`row N` points at an issue filed in the same run), then a `SUMMARY` line, any `NAME` lines (a project or label the plan named by part of its name, with the tracker's full name, which the table shows and apply files with), and any `CHECK` lines.

Show the table and its `SUMMARY` line exactly as printed, then:

- The fields marked `(default)` came from a default rather than the notes, so they get checked.
- Each item dropped because a closed issue already did the work, and each issue already tracked in an entry at `link`, by id and title.
- How you read any weekday deadline (for example: "Mon EOD" read as today, Monday, with its date).
- Each `CHECK` line as a row of a short table: the issue, what's wrong, and the fix you propose: a new date or `null` for an overdue date (the issue's own, or an open sub-issue's), a lower priority for each sub-issue that forces its parent above the rank the notes gave it (or keeping the higher rank on purpose), and a project for a matched issue with none. They don't block filing, but each needs an answer first. Urgent issues the notes don't mention aren't a problem: plenty of work comes up outside planning, so don't list or ask about them.
- A project marked `(parent)` is the one a new sub-issue takes from its parent, unless the notes name another.
- Values marked `(sub-issues)` came from the issue's sub-issues (`tickets.parentFollowsSubIssues`): a parent takes its most urgent sub-issue's priority and, with no cycle, the earliest cycle of a sub-issue whose cycle hasn't ended. A row for an issue outside the plan is a parent its sub-issue moves up: one filed or moved under it, or one already there that the plan raises.
- Names left unchecked, when `options` is out of the plan.
- Anything else only the person can answer, such as a due date the agent instructions require.

Then ask once: file these, or what should change? For changes, edit the plan, run the same command, and show the new table. Fold the answers to `CHECK` lines into the plan the same way, so the table you file from has none left unanswered.

**With `--yes`,** skip the question when there are no `CHECK` lines and nothing only the person can answer: show the table and go straight to filing. Ask about just those lines when there are.

**Next:**

- Mode `default`: invoke the `create-tickets-apply` skill with mode `default`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
