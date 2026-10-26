---
description: Set up or update .agent-flows/config.json, the repo's shared dev configuration: base branch and the integrations it uses for each capability (source control, issue tracker, deployments, error tracking, …).
argument-hint: "[section | capability ...]"
---

# /agent-flows:configure

Record this repository's dev configuration in `.agent-flows/config.json` at the repo root: settings every flow relies on (like the base branch) and the integrations the repo uses, with the ids flows need to reach them. Other agent-flows commands read it instead of guessing or asking every time. The file is committed and shared with the team, so it holds **configuration only**: ids, slugs, branch names. No secrets, and nothing that points at one.

Flows never ask for a vendor. They ask for a **capability**, and use every integration the repo configured for it:

| Capability | Name | Used for | Integrations | Levels (`use`) |
|---|---|---|---|---|
| `sourceControl` | Source control | The hosted repository: pull requests, CI checks, code review | GitHub, GitLab | `read`: Read pull requests (evaluate); `write` (default): Also push branches and open and edit draft pull requests (sync) |
| `stacking` | Stacked PRs | Stacked branches and pull requests on top of source control | Graphite | used or not |
| `issueTracker` | Issue tracker | Tickets: link branches and PRs, file and close issues | GitHub, Linear, Jira | `link` (default): Find a branch's existing issue and link it from the PR; `track`: Also file an issue for every branch, and keep its status and state in step (sync) |
| `workspaces` | Workspaces | Open a branch in a workspace of its own, with a coding agent already working on it | Superset, Conductor, Git worktrees | used or not |
| `deployments` | Deployments | Preview and production deployments, runtime logs | Vercel | used or not |
| `database` | Database | Database branches per worktree, migrations | Neon | used or not |
| `errorTracking` | Error tracking | Production errors behind a bug | Sentry | `link` (default): Link the errors a branch fixes from its PR; `resolve`: Also resolve them when the PR merges (sync) |
| `sessions` | Session sharing | Share the agent session behind a change, linked from its PR and issue | Lore | used or not |
| `analytics` | Product analytics | Usage events, funnels, session replay | PostHog | used or not |
| `featureFlags` | Feature flags | Gated rollouts and experiments | PostHog | used or not |
| `chat` | Team chat | Where dev flows post announcements and alerts | Slack | used or not |

A repo can configure any number of integrations for a capability (none, one, or several, like Linear for product work and Jira for support tickets), and flows use all of them. An integration can provide more than one capability, and most can be configured more than once (one Vercel project per app in a monorepo): the entry is then a list of instances, each with a unique `name`:

```json
"vercel": [
  { "name": "web", "project": "prj_web", "directory": "apps/web" },
  { "name": "docs", "project": "prj_docs", "directory": "apps/docs" }
]
```

The file is made of **sections**, each an object of fields at a dotted path. Every section but `repo` and `sync` is an integration:

| Section | Name | Provides | Used for | Fields | Reached through | Look up with |
|---|---|---|---|---|---|---|
| `repo` | Repository (always) |  | The branch work merges into, for diffs, reviews, and PRs | `baseBranch` (required): Branch feature work merges into |  | `git symbolic-ref --short refs/remotes/origin/HEAD`, or ask |
| `sync` | Sync format |  | How sync writes the PR body, its title, and the issue's link lines; unset, it uses its own format | `linkLabels`: Label link lines by capability (`> Issue:`, `> Errors:`, the default) or by integration name (`> Linear:`, `> Sentry:`); `errorVerb`: Word that starts each error line (`Fixes`); `prTitle`: PR title template, with `{issueId}` and `{title}` the issue's; unset, the repo's convention; `blockMarkers` [boolean]: Wrap sync's part of the PR body in HTML comment markers (default true); false bounds it by the link lines and the last-synced line instead |  | Leave it out for sync's own format. A team that also runs bitfab-dev's sync uses its format, so the two don't duplicate each other's lines |
| `integrations.github` | GitHub | `sourceControl`, `issueTracker` (opt-in) | Pull requests, CI checks, code review | `owner` (required): Org or user; `repo` (required): Repository name; `labels` [string[]]: Labels sync picks one of for each issue, by the kind of work, when GitHub tracks the repo's issues; `project`: GitHub project new issues go in (its title), when GitHub tracks the repo's issues | MCP (`GitHub`), CLI (`gh`), API (token in `GITHUB_TOKEN` or `GH_TOKEN`, or where configure records it) | `gh repo view --json owner,name`, or the GitHub MCP's repository search |
| `integrations.gitlab` | GitLab | `sourceControl` | Merge requests, CI pipelines, code review | `project` (required): Project path, including groups; `host`: Self-managed host name | MCP (`GitLab`), CLI (`glab`), API (token in `GITLAB_TOKEN`, or where configure records it) | `glab repo view`, or the GitLab MCP |
| `integrations.graphite` | Graphite | `stacking` | Stacked branches and PRs | `trunk` (required): Trunk branch stacks build on | CLI (`gt`) | The `trunk` in `.graphite_repo_config` in the git common dir, else ask. Never run `gt` to look it up: on a repo Graphite hasn't set up, it initializes it |
| `integrations.linear` | Linear | `issueTracker` | Tickets: link branches and PRs, file and close issues | `teamKey` (required): Issue key prefix; `workspace`: URL slug in linear.app/<slug>; `project`: Project new issues go in (its name); `priority`: Priority for new issues (urgent, high, medium, low), unless the repo's agent instructions rank work otherwise; `labels` [string[]]: Labels sync picks one of for each issue, by the kind of work; `estimate` [boolean]: Estimate each issue on the team's scale; `cycle` [boolean]: Put new issues in the current cycle | MCP (`Linear`), API (token in `LINEAR_API_KEY`, or where configure records it), adapters (`findIssue`, `searchIssues`, `assignedIssues`) | Linear MCP (`list_teams`; `list_projects` for the team's projects), or the API's `teams` and `projects` queries |
| `integrations.jira` | Jira | `issueTracker` | Tickets: link branches and PRs, file and close issues | `site` (required): Atlassian site host; `projectKey` (required): Issue key prefix; `priority`: Priority for new issues (urgent, high, medium, low), unless the repo's agent instructions rank work otherwise; `labels` [string[]]: Labels sync picks one of for each issue, by the kind of work; `estimate` [boolean]: Estimate each issue in story points; `cycle` [boolean]: Put new issues in the board's active sprint | MCP (`Atlassian`), API (token in `JIRA_API_TOKEN`, or where configure records it) | Atlassian MCP (list projects), the API's `project/search`, or ask |
| `integrations.vercel` | Vercel | `deployments` | Preview and production deployments, runtime logs | `team`: Team id or slug; `project` (required): Project id or name; `directory`: App directory it deploys, in a monorepo | MCP (`Vercel`), CLI (`vercel`), API (token in `VERCEL_TOKEN`, or where configure records it) | Vercel MCP, or `vercel project ls` |
| `integrations.neon` | Neon | `database` | Postgres branches per worktree, migrations | `projectId` (required): Neon project id; `parentBranch`: Branch new dev branches fork from; `database`: Database name | MCP (`Neon`), CLI (`neonctl`), API (token in `NEON_API_KEY`, or where configure records it) | Neon MCP (list projects), or `neonctl projects list` |
| `integrations.sentry` | Sentry | `errorTracking` | Production errors behind a bug | `org` (required): Organization slug; `project` (required): Project slug; `url`: Self-hosted base URL | MCP (`Sentry`), CLI (`sentry-cli`), API (token in `SENTRY_AUTH_TOKEN`, or where configure records it) | Sentry MCP (find projects), or `sentry-cli projects list` |
| `integrations.posthog` | PostHog | `analytics`, `featureFlags` | Product analytics, feature flags, session replay | `projectId` (required): Numeric project id; `host`: App host | MCP (`PostHog`), API (token in `POSTHOG_PERSONAL_API_KEY`, or where configure records it) | PostHog MCP (list projects) |
| `integrations.slack` | Slack | `chat` | Where dev flows post announcements and alerts | `channel` (required): Channel name or id | MCP (`Slack`), API (token in `SLACK_BOT_TOKEN` or `SLACK_TOKEN`, or where configure records it) | Slack MCP (search channels), or ask |
| `integrations.lore` | Lore | `sessions` | Share the agent session behind a change, linked from its PR and issue | `visibility` (required): Who can open a shared session: private, workspace, or public | MCP (`lore-local`) | Ask; `workspace` lets everyone in the team's Lore workspace open it |
| `integrations.superset` | Superset | `workspaces` | Local workspaces, each a worktree with a coding agent working in it | `project` (required): Superset project id for this repository; `agent`: Agent preset new workspaces start (claude, codex, …) | CLI (`superset`) | `superset projects list --local --json`: the project whose `repo` is this repository's origin, or whose `path` is its main checkout |
| `integrations.conductor` | Conductor | `workspaces` | Cloud workspaces, each a sandbox with a coding agent working in it | `projectId` (required): Conductor project id for this repository; `agent`: Agent new workspaces start (claude, codex, cursor) | CLI (`conductor`) | `conductor project list --json`: the project for this repository. Outside a Conductor workspace the CLI may not be on PATH: the app keeps it at `~/Library/Application Support/com.conductor.app/bin/conductor` |
| `integrations.worktree` | Git worktrees | `workspaces` | Plain git worktrees, one per branch, for repos with no workspace app; the agent is started by hand | `directory` (required): Where new worktrees go: a path relative to the main checkout, or absolute; `agent`: Command that starts a coding agent on a prompt given as its argument | CLI (`git`) | The directory the repo's linked worktrees share (`git worktree list`), else ask; `../<repo>-worktrees` keeps them out of the checkout |

```json
{
  "version": 2,
  "repo": { "baseBranch": "main" },
  "integrations": {
    "github": { "owner": "acme", "repo": "web" },
    "linear": { "teamKey": "ENG" }
  },
  "skipped": ["integrations.sentry"]
}
```

`version` is the file format, set by `write`. An older file is upgraded when it's read (version 1 called the integrations `services`), and the next `write` saves it in the current format. `skipped` lists integrations the team chose not to configure. Sections and fields this plugin doesn't know (from a newer plugin, or added by hand) are reported as warnings and kept as they are.

To configure individual sections, name them ($ARGUMENTS): `/agent-flows:configure linear vercel`. A name is a section path or its last part (`integrations.linear` or `linear`), or a capability (`issueTracker`), which stands for every integration that provides it. Only the named sections are detected, shown, and changed, even ones that were skipped or are already configured; the rest of the file stays as it is. With no names, every section above is considered.

Each integration also records what the team **uses** it for, under `use`: per capability it provides, a level from the table above (`"use": {"issueTracker": "track"}`), or `true` for a capability without levels. A capability left out isn't used, even if the integration provides it (PostHog only for feature flags). Flows never go past the level, so this is where a team decides, say, that sync links issues but doesn't file them. Without `use`, flows assume each capability's default level, and configure asks.

An integration can be reached in up to three ways: its **MCP server**, its **CLI**, or its **HTTP API** directly, with a token from an environment variable. Which ones work depends on the machine, not the repo, so it's never written to the config: every flow checks at run time and uses the first that works, in that order. Configure uses the same check to offer integrations this machine can already reach, even when the repo shows no sign of them.

Re-running is safe: values already in the file are kept, skipped sections stay skipped, and when nothing new turns up the command says so and changes nothing.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `configure.ts <subcommand>` | `show` the config, `detect` what this checkout uses and plan changes, `get <path>...` values, `integrations <capability>...` for a capability's configured integrations, `write` a patch read from stdin (JSON), or `token <integration> --env|--file|--command <where>` to record where an API token is on this machine |

## Invariants

- Never write a token, key, password, or connection string into the config, and never read a real `.env` file to find one. If the user pastes a secret, don't save it, and tell them it doesn't belong in this file.
- Never call a service in a way that changes it. Lookups are read-only, and that includes local setup: don't run a CLI command that initializes or configures the tool in this repo (some do on first use), even to read a value. Read its files instead, or ask.
- Only change the config through `write`; never edit the file by hand to get past the validator.

## 1. Detect

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" detect [section | capability ...]
```

Pass the sections or capabilities the user named, if any, as they typed them. An unknown name fails with the list of known sections and capabilities: show it and ask which they meant.

The JSON has `configPath`, `exists`, the current `config` (when valid), its `issues`, `requested` (when you passed names: the section paths they resolved to, with each capability expanded to its integrations), `coverage` (per capability, the integrations configured for it), `detected` (per section path: guessed `values` and the `evidence` behind them, from local files and git metadata only), and a `plan`:

- `changes`: sections to `add`, and empty fields of configured sections to `fill`.
- `needs`: required fields still missing after those changes (per instance, with its `instance` name, for a list).
- `conflicts`: configured values that disagree with detection. Configured values always win; mention a conflict, never change it on your own.
- `moreInstances`: for an integration that's already configured, instances detected that match none of its configured ones (a second linked Vercel app). Detection only fills the instance it matches, and never edits a list. These are offered, not planned, and don't make the config out of date.
- With `requested` set, the plan covers only those sections, and proposes each even if it was skipped or nothing was detected, plus any section marked *always* that the config still lacks (the file isn't valid without it).
- `upToDate`: the config exists and there is nothing to add or fill. Sections listed in `skipped` were deliberately left out on an earlier run and are never proposed again.

`access` says, per integration, how this machine can reach it: `cli` (`installed`, and `ready` when it's also signed in), `api` (the token variable, and `ready` when it's set; never print its value), and `mcp.server`, which only you can check: it's available when your tools include ones from that MCP server (named for it, like `mcp__<server>__…`, or a connector of that name). An integration is **in reach** when it isn't configured, isn't in `skipped`, and one of those three works.

Route on the result:

- **`issues` is non-empty (the file is broken)**: show the issues and stop. For each issue, say what's wrong and the fix (a wrong type or a missing required field); with the user's OK, fix it with `write`, or by hand only when `write` refuses because the file is unreadable, then re-run this command. A version newer than the plugin means the user should upgrade the plugin instead
- **`plan.upToDate` is true, the user named no sections, and no integration is in reach**: say the config is already up to date (list its sections, any `skipped`, any `warnings`, and any `conflicts`) and stop. Change nothing. If `plan.moreInstances` isn't empty, add one line per integration naming the instances found, and that `/agent-flows:configure <integration>` adds them
- **the user named sections**: go to fill for exactly the `requested` sections. For each one already configured, show its current values (and any of its `plan.moreInstances`) and ask what to change; for the rest, fill them as usual → step 2
- **otherwise**: continue → step 2

## 2. Fill the gaps

**Offer what's in reach.** Unless the user named sections, take the integrations in reach that the plan doesn't already add, and use `AskUserQuestion` with multiple selection: which of them should the repo use? One option per integration, saying how it's reached (`Linear: MCP connected`, `Vercel: CLI signed in`, `Sentry: SENTRY_AUTH_TOKEN set`). Being reachable from this machine doesn't mean the repo uses it, so recommend none by default, only ones the repo shows signs of. With more than fit in one question, ask several. The ones picked join the plan as sections to add; the rest go in the write's `skip` list, so the next run doesn't offer them again.

**Ask what each is for.** For every integration being added, and every configured one `plan.needs` lists `use` for, use `AskUserQuestion` what the team uses it for: one question per capability it provides, with that capability's levels from the table above plus "Not for this", and its default level recommended. For a capability the sections table marks `(opt-in)`, recommend "Not for this" unless the repo shows it uses the integration for it (no other integration covers the capability, and the agent instructions or recent PRs point to it), since without `use` flows leave it out. A capability without levels is a yes or no. Several integrations can go in one call, up to its limit on questions. Record the answers as the entry's `use`, and leave out the capabilities answered "Not for this". If every capability is "Not for this", the integration isn't used: skip it instead.

**Ask where each token is.** For every integration being added or already configured that has an API, ask where its API token is on this machine when `access.api.configured` is false and either the table lists adapters for it (they need the token) or neither its MCP server nor its CLI works here. Don't look for the token yourself (no searching the disk, no reading files or variables to see what's there); the user says where it is. use `AskUserQuestion` with the options:

- **An environment variable**: its name (the integration's usual ones, from the table, are a good default).
- **A file**: the path of a file holding just the token.
- **A command**: one that prints it, like a password manager's (`op read op://<vault>/<item>/credential`).
- **None**: use its MCP server or CLI instead; adapters that need the token are skipped.

Record each answer: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" token <integration> --env <NAME>` (or `--file <path>`, `--command '<command>'`; `--clear` forgets it). It saves where the token is, never the token, in the repo's git dir: per machine, shared by the repo's worktrees, never committed, and not part of the confirm table below. Never print a token, and never pass one to the command.

Then work through `plan.changes` and `plan.needs` (other than `use`), plus the sections picked or named. Evidence that a service is used (a dependency) is not the same as its ids, so look up each missing required field read-only, in this order:

1. **The section's lookup** from the table above, through whichever way of reaching it works here: its MCP server, its signed-in CLI, or its API with the token variable (never print the token).
2. **The user**, for anything still missing or ambiguous (two Vercel projects, several Linear teams).

When detection finds several instances of one integration (`detected.<path>.instances`, like a linked Vercel project per app), the plan proposes them all as a list: confirm each, and drop the ones the team doesn't want. To add instances to an integration configured as a single object (the user asked, or accepted some of `plan.moreInstances`), turn its entry into a list: give the existing one a `name` and add the new ones. Names are unique within the list and use lowercase letters, digits, `.`, `_`, and `-` (`web`, `apps-docs`).

Several integrations can provide the same capability (Linear and Jira are both issue trackers). Don't make the user pick just one: when detection finds evidence for more than one, propose each, and when the user named a capability, ask which of its integrations the team uses. They can choose any number; configure those and skip the rest.

When the user named sections, touch only those (and any *always* section the plan adds because the config lacks it): don't propose, fill, or skip any other section.

A section whose required fields can't be found, or that the user doesn't want, goes in the write's `skip` list (sections marked *always* can't be skipped; ask for their values instead), so the next run doesn't propose it again. Never change a value the config already has unless the user asks.

## 3. Confirm

Show one table of what will change: section (with the instance name, for a list), field, new value, and where it came from (detected, looked up, or asked). Then the sections you'll mark skipped. Leave out everything that stays the same, and say how many sections are unchanged.

Then use `AskUserQuestion`:

> A) **Save it** *(recommended)* → step 4
> B) **Change something**: add, drop, or skip a section, or correct a value → step 2
> C) **Cancel** → stop

## 4. Write

Pass only what changes on stdin, keyed by section path. Each section you include **replaces** that section's whole entry (so include its existing fields too); `null` removes one; `skip` marks sections as deliberately not configured; everything you omit stays as it is.

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" write <<'JSON'
{"sections": {"repo": {"baseBranch": "main"}, "integrations.github": {"owner": "acme", "repo": "web"}, "integrations.linear": {"teamKey": "ENG"}}, "skip": ["integrations.sentry"]}
JSON
```

A list entry replaces the whole list, so include every instance you're keeping: `"integrations.vercel": [{"name": "web", ...}, {"name": "docs", ...}]`.

It validates the whole result and writes only if the content changed, in a fixed order, so the same answers always produce the same file. On issues it prints them with `"written": false` and exits 1: fix each one and run it again. `warnings` (unknown sections or fields it kept) are worth mentioning but don't block.

## 5. Report

Say what changed in `.agent-flows/config.json`, or that nothing did (`"written": false` with no issues). Then, from `coverage`, say which integrations cover each capability, and which capabilities have none, so the user knows what flows can reach. For each configured integration, say how this machine reaches it (from `access`, plus your MCP check; for the API, `access.api.source`, which says where the token comes from, never what it is), and for any it can't reach at all, the fix: connect its MCP server, install or sign in to its CLI (`access.cli.auth`), or record where its token is (`token`). That part is about this machine only and never goes in the config. If the file changed, remind the user to commit it so the team shares it.
