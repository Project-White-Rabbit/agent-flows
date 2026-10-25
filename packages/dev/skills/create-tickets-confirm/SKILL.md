---
name: create-tickets-confirm
description: Confirm phase of the /agent-flows:create-tickets flow. Invoked by the create-tickets flow; not run directly
user-invocable: false
---

# /agent-flows:create-tickets: Confirm

**Run only when mode is `default`.**

## 1. Show the table and confirm

`<dir>` and the tracker entries are from the `create-tickets-main` skill.

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/tickets.ts" check --plan <dir>/plan.json
```

It writes nothing. `PROBLEM` lines (exit 1) block filing: fix what you can in the plan and run it again, and put anything only the person can answer into the confirmation question. Otherwise it prints the table, one row per issue to file, update, or leave as is, in the order apply files them (`row N` points at an issue filed in the same run), then a `SUMMARY` line and any `CHECK` lines.

Show the table and its `SUMMARY` line exactly as printed, then:

- The fields marked `(default)` came from a default rather than the notes, so they get checked.
- Each item dropped because a closed issue already did the work, and each issue already tracked in an entry at `link`, by id and title.
- How you read any weekday deadline (for example: "Mon EOD" read as today, Monday, with its date).
- Each `CHECK` line as a row of a short table: the issue, what's wrong, and the fix you propose (a new date, or `null`). They don't block filing, but each needs an answer first.
- Anything else only the person can answer, such as a due date the agent instructions require.

Then ask once: file these, or what should change? For changes, edit the plan, run the same command, and show the new table. Fold the answers to `CHECK` lines into the plan the same way, so the table you file from has none left unanswered.

**With `--yes`,** skip the question when there are no `CHECK` lines and nothing only the person can answer: show the table and go straight to filing. Ask about just those lines when there are.

**Next:**

- Mode `default`: invoke the `create-tickets-apply` skill with mode `default`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
