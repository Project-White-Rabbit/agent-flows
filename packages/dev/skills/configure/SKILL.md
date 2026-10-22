---
description: Set up or update .agent-flows/config.json, the repo's shared dev configuration: base branch and the third-party services it uses (GitHub, Linear, Vercel, Neon, Sentry, …).
argument-hint: "[section ...]"
---

# /agent-flows:configure

Record this repository's dev configuration in `.agent-flows/config.json` at the repo root: settings every flow relies on (like the base branch) and the third-party services the repo uses, with the ids flows need to reach them. Other agent-flows commands read it instead of guessing or asking every time. The file is committed and shared with the team, so it holds **configuration only**: ids, slugs, branch names. No secrets, and nothing that points at one.

The file is made of **sections**, each an object of fields at a dotted path:

| Section | Name | Used for | Fields | Look up with |
|---|---|---|---|---|
| `repo` | Repository (always) | The branch work merges into, for diffs, reviews, and PRs | `baseBranch` (required): Branch feature work merges into | `git symbolic-ref --short refs/remotes/origin/HEAD`, or ask |
| `services.github` | GitHub | Pull requests, CI checks, code review | `owner` (required): Org or user; `repo` (required): Repository name | `gh repo view --json owner,name` |
| `services.graphite` | Graphite | Stacked branches and PRs | `trunk` (required): Trunk branch stacks build on | `gt trunk` |
| `services.linear` | Linear | Tickets: link branches and PRs, file and close issues | `teamKey` (required): Issue key prefix; `workspace`: URL slug in linear.app/<slug> | Linear MCP (list teams) |
| `services.vercel` | Vercel | Preview and production deployments, runtime logs | `team`: Team id or slug; `project` (required): Project id or name | Vercel MCP, or `vercel project ls` |
| `services.neon` | Neon | Postgres branches per worktree, migrations | `projectId` (required): Neon project id; `parentBranch`: Branch new dev branches fork from; `database`: Database name | Neon MCP (list projects), or `neonctl projects list` |
| `services.sentry` | Sentry | Production errors behind a bug | `org` (required): Organization slug; `project` (required): Project slug; `url`: Self-hosted base URL | Sentry MCP (find projects), or `sentry-cli projects list` |
| `services.posthog` | PostHog | Product analytics, feature flags, session replay | `projectId` (required): Numeric project id; `host`: App host | PostHog MCP (list projects) |
| `services.slack` | Slack | Where dev flows post announcements and alerts | `channel` (required): Channel name or id | Slack MCP (search channels), or ask |

```json
{
  "version": 1,
  "repo": { "baseBranch": "main" },
  "services": { "github": { "owner": "acme", "repo": "web" } },
  "skipped": ["services.sentry"]
}
```

`version` is the file format, set by `write`. `skipped` lists sections the team chose not to configure. Sections and fields this plugin doesn't know (from a newer plugin, or added by hand) are reported as warnings and kept as they are.

To configure individual sections, name them ($ARGUMENTS): `/agent-flows:configure linear vercel`. A name is a section path or its last part (`services.linear` or `linear`). Only the named sections are detected, shown, and changed, even ones that were skipped or are already configured; the rest of the file stays as it is. With no names, every section above is considered.

Re-running is safe: values already in the file are kept, skipped sections stay skipped, and when nothing new turns up the command says so and changes nothing.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `configure.ts <subcommand>` | `show` the config, `detect` what this checkout uses and plan changes, `get <path>...` values, or `write` a patch read from stdin (JSON) |

## Invariants

- Never write a token, key, password, or connection string into the config, and never read a real `.env` file to find one. If the user pastes a secret, don't save it, and tell them it doesn't belong in this file.
- Never call a service in a way that changes it. Lookups are read-only.
- Only change the config through `write`; never edit the file by hand to get past the validator.

## 1. Detect

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" detect [section ...]
```

Pass the sections the user named, if any, as they typed them. An unknown name fails with the list of known sections: show it and ask which they meant.

The JSON has `configPath`, `exists`, the current `config` (when valid), its `issues`, `detected` (per section path: guessed `values` and the `evidence` behind them, from local files and git metadata only), and a `plan`:

- `changes`: sections to `add`, and empty fields of configured sections to `fill`.
- `needs`: required fields still missing after those changes.
- `conflicts`: configured values that disagree with detection. Configured values always win; mention a conflict, never change it on your own.
- `requested`: the section paths you passed. The plan then covers only those, and proposes each even if it was skipped or nothing was detected, plus any section marked *always* that the config still lacks (the file isn't valid without it).
- `upToDate`: the config exists and there is nothing to add or fill. Sections listed in `skipped` were deliberately left out on an earlier run and are never proposed again.

Route on the result:

- **`issues` is non-empty (the file is broken)**: show the issues and stop. For each issue, say what's wrong and the fix (a wrong type or a missing required field); with the user's OK, fix it with `write`, or by hand only when `write` refuses because the file is unreadable, then re-run this command. A version newer than the plugin means the user should upgrade the plugin instead
- **`plan.upToDate` is true and the user named no sections**: say the config is already up to date (list its sections, any `skipped`, any `warnings`, and any `conflicts`) and stop. Change nothing
- **the user named sections**: go to fill for exactly the `requested` sections. For each one already configured, show its current values and ask what to change; for the rest, fill them as usual → step 2
- **otherwise**: continue → step 2

## 2. Fill the gaps

Work through `plan.changes` and `plan.needs`, plus any sections the user named. Evidence that a service is used (a dependency) is not the same as its ids, so look up each missing required field read-only, in this order:

1. **The section's lookup** from the table above: a connected MCP server or a signed-in CLI.
2. **The user**, for anything still missing or ambiguous (two Vercel projects, several Linear teams).

When the user named sections, touch only those (and any *always* section the plan adds because the config lacks it): don't propose, fill, or skip any other section.

A section whose required fields can't be found, or that the user doesn't want, goes in the write's `skip` list (sections marked *always* can't be skipped; ask for their values instead), so the next run doesn't propose it again. Never change a value the config already has unless the user asks.

## 3. Confirm

Show one table of what will change: section, field, new value, and where it came from (detected, looked up, or asked). Then the sections you'll mark skipped. Leave out everything that stays the same, and say how many sections are unchanged.

Then use `AskUserQuestion`:

> A) **Save it** *(recommended)* → step 4
> B) **Change something**: add, drop, or skip a section, or correct a value → step 2
> C) **Cancel** → stop

## 4. Write

Pass only what changes on stdin, keyed by section path. Each section you include **replaces** that section's whole entry (so include its existing fields too); `null` removes one; `skip` marks sections as deliberately not configured; everything you omit stays as it is.

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" write <<'JSON'
{"sections": {"repo": {"baseBranch": "main"}, "services.github": {"owner": "acme", "repo": "web"}, "services.linear": {"teamKey": "ENG"}}, "skip": ["services.sentry"]}
JSON
```

It validates the whole result and writes only if the content changed, in a fixed order, so the same answers always produce the same file. On issues it prints them with `"written": false` and exits 1: fix each one and run it again. `warnings` (unknown sections or fields it kept) are worth mentioning but don't block.

## 5. Report

Say what changed in `.agent-flows/config.json`, or that nothing did (`"written": false` with no issues). If it changed, remind the user to commit it so the team shares it.
