---
description: Assess branch or PR shippability without edits. Use for readiness and risk assessment, not an audit/fix loop.
argument-hint: "[PR number or URL | help]"
---

# /dev-flows:evaluate

Read the diff and tell the user two things, in this order:

1. **What it does**, in plain English. Not a file list, not a section-by-section walkthrough, not a copy-paste of the PR body. A distillation: the change, the why, the surface it touches.
2. **Risks**, prioritized. Things that could break in production, on deploy, for existing users, or for the team's ability to roll back. Not style, not layer rules, not convention violations (those live in the user's head and in CI). This is a shippability lens.

The skill is read-only. It never writes to source control, the issue tracker, error tracking, or the working tree. It is safe to invoke at any point in a branch's life. With no argument it evaluates **everything in the working tree**: commits ahead of the base branch, uncommitted (staged and unstaged) changes, and untracked files. A PR, if one exists for the branch, supplies title/body context but never narrows the diff. With an explicit PR number or URL (including post-merge), it evaluates that PR's diff.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `configure.ts <subcommand>` | `get <path>...` prints configured values; `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Follow only the selected mode's path below.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Read the current branch (or a given PR) and assess shippability risks. Read-only. |
| `help` | `help` | Show usage and exit without evaluating. |

## Dispatch

- Mode `default`: invoke the `evaluate-run` skill with mode `default`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and exit. No reads.

> `/dev-flows:evaluate` reads a diff and reports (1) what it does in plain English and (2) prioritized shippability risks.
>
> Targets:
>   - no argument -> everything on the current branch: commits ahead of the base branch + uncommitted changes + untracked files. A PR, if one exists, supplies title/body context only.
>   - PR number (e.g. `1234`) or URL -> that PR's diff, for a PR of this checkout's repository
>
> What it never does: write to source control or any other service, modify files, run code, or push. Read-only.
>
> Risk lens: migration safety, blast radius, customer impact, cross-package sync, rollback difficulty, monitoring gaps, edge cases, code duplication/reuse, and necessary refactors. Style and layer-rule audits live in CI and in the reviewer's head; this skill skips them on purpose.
