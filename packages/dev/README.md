# @agent-flows/dev

Dev workflow commands for any repository, written as [agent-flows](../core) flows and shipped as the `agent-flows` Claude Code plugin.

## Install

```
/plugin install agent-flows --marketplace Project-White-Rabbit/agent-flows
```

On Claude Code before 2.1.275, add the marketplace first: `/plugin marketplace add Project-White-Rabbit/agent-flows`, then `/plugin install agent-flows@agent-flows`.

Commands run with the `node` already on the machine (22.18+, which runs TypeScript directly). The plugin has no dependencies and no build step.

### Updates

Claude Code doesn't auto-update plugins from this marketplace unless you turn it on: `/plugin` → **Marketplaces** → `agent-flows` → **Enable auto-update**. Otherwise update by hand with `/plugin marketplace update agent-flows`. Either way, a new version takes effect in the next session or after `/reload-plugins`.

## Commands

| Command | What it does |
|---|---|
| `/agent-flows:configure [auto \| manual] [section \| capability ...]` | Detects the base branch and the integrations the repo uses (GitHub, GitLab, Graphite, Linear, Jira, Vercel, Neon, Sentry, PostHog, Slack, Lore, Superset, Conductor, git worktrees), fills in their ids from MCP servers, CLIs, or you, writes `.agent-flows/config.json` after you confirm, and prints the resulting config. `auto` settles everything with one clear answer and asks only about what's ambiguous; `manual` goes through every section one at a time, skipped ones included; with neither, it asks which. Name sections or capabilities (`/agent-flows:configure linear vercel`, `/agent-flows:configure issueTracker`) to walk just those. Idempotent: re-running keeps existing values, remembers declined integrations, and changes nothing when nothing new turns up. |
| `/agent-flows:create-tickets [notes URL \| pasted notes \| sentence] [--yes]` | Turns planning notes into issues in the configured issue tracker: each planned item becomes one issue with its action items as a checklist, and issues that already describe the same work (found with `searchIssues`, open or closed in the last 90 days) are updated instead of filed twice. Priority, labels, estimate, cycle, project, assignee, due date, and blocked-by links come from the notes, then the repo's agent instructions, then the tracker's config. It shows one table (drawn by `tickets.ts check`) and files on one confirmation; `--yes` skips it when nothing needs an answer. The plan lives in the worktree's git dir and records each filed issue, so a re-run only updates. `match [--branch <branch>] <text>` only looks and writes nothing: sync uses it to find a branch's issue. Emulates bitfab-dev's `notes-to-tickets`, without its planning document. |
| `/agent-flows:evaluate [PR number or URL]` | Read-only shippability review of the current branch (committed, uncommitted, and untracked work) or a PR: what it does in plain English, prioritized risks, and a verdict. Diffs against `repo.baseBranch`, or a stacked branch's parent (through the stacking integration) so the review covers only its own work, and reads PRs through whichever source-control integrations are configured. |
| `/agent-flows:merge [stack \| branch] [squash \| merge \| rebase]` | Lands the current branch's pull request. Pre-flight refuses on the base branch, uncommitted changes, or a merged or closed PR, and runs `/agent-flows:sync` first when there's no PR yet. With a stacking integration it reads the branch's chain (`downstack`) and, when branches sit below it, asks whether to land the whole chain or just this branch (`stack` and `branch` skip the question); a chain must have an open PR on every branch and no failing checks before anything merges. Then sync, mark ready (`prReady`, every draft in the chain), wait up to 30 minutes for CI on the pushed head (`ready.ts ci`), and ask the host whether it would merge (`prMergeState`): failed checks the base doesn't require don't block, required checks, reviews, conflicts, and a stale base do. One branch merges through the source-control host's `prMerge`, pinned to the commit CI passed on (squash by default, a merge commit for a branch in a stack of more than one); a chain merges through the stacking integration's `mergeStack`. Only once the host says merged: `/agent-flows:sync remote` (the issue moves to done, linked errors resolve at `resolve` level) and the remote branch is deleted, unless branches stacked above still target it. Never bypasses the host (no admin or auto-merge) and never deletes the local branch or worktree. Emulates bitfab-dev's `merge`, without its changelog, release, and per-worktree server and database cleanup. |
| `/agent-flows:ready [loop \| draft \| help]` | Takes finished branch work to a ready, green PR. Local cleanup first, scoped to what the branch touches (`ready.ts plan`: the merge base, changed files, the package each belongs to with its check scripts, and the agent instructions above them): what must change with the branch (docs, mirrored files, generated output, a version bump), tests for new behavior, then the config's `ready` commands or each touched package's fix and check scripts, with only the relevant tests and output kept out of context. Then `/agent-flows:sync local`, the push (opening the PR when there's none), marking the PR ready (`prReady`), and `/agent-flows:sync remote`, so the issue moves to in review. Last, a CI pass on the pushed commit: it waits for the `checks` op to settle (`ready.ts ci wait`, up to 15 minutes), reads failed logs (`checkLog`) and automated reviewers' threads (`reviewThreads`), fixes only what's high-confidence in one push, and resolves the threads it fixed (`resolveThread`); anything needing judgment (source logic, migrations, dependency versions, cancellations, flaky or unrelated failures) is handed back. `loop` repeats until a pushed commit goes green, stopping when a fix doesn't work (the stall guard); `draft` leaves the PR a draft. Needs a source-control integration at `write`. Emulates bitfab-dev's `ready`, and works on branches bitfab-dev's sync started. |
| `/agent-flows:start-work [issue ids \| notes] [--start-only] [--reuse [--no-ticket]] [--confirm] [--section <name> \| --section-by-rank \| --no-section] [--in <integration>]` | Opens one workspace per issue, each on its own branch with a coding agent already working from the issue. Given notes, it files them first with `/agent-flows:create-tickets` and starts every issue that run filed or updated; given issue ids, it starts those. `--start-only` files nothing (it starts the open issues the notes already match, or the last create-tickets run's). Skips closed issues and issues that already have a workspace or git worktree on their branch, adds a `> Branch:` line so sync finds each issue, and moves issues not started yet to in progress. `--reuse` takes one issue in the current workspace instead, renaming its branch (unless pushed; through the stacking integration's `rename` when there is one, so its record follows) and the workspace after the issue (the `renameWorkspace` op); `--no-ticket` does the same for work with no issue, named after a short title. Workspaces open through the `workspaces` capability: Superset (local workspaces, agent started for you), Conductor (cloud workspaces; its CLI can't open local ones), or plain git worktrees (you get the command that starts the agent). The `work.ts` command decides what starts, on which branch, and in which sidebar section (`--section-by-rank` names them after the priority, or the repo's own names for it). |
| `/agent-flows:sync [local \| remote] [issue id]` | Keeps the branch, its draft PR, and its issue in step with the work. `local` commits and catches up to `repo.baseBranch` (restacking through the stacking integration when there is one, else `git merge`; a stacked branch whose parent already merged is moved onto that parent's base with the stacking integration's `reparent`, keeping only its own commits); `remote` refreshes the PR body and the issue (state follows the PR, but a done or canceled issue stays closed unless you say to reopen it) and resolves linked errors once the PR merges; the default does both and pushes. Before filing an issue it searches open and recently closed ones for the same work (through `/agent-flows:create-tickets match`), reusing a match or filing a sub-issue; it sets priority (once, then leaves it to people), labels, estimate, cycle, and project from the tracker's config and the repo's agent instructions. A re-run with nothing changed stops at a no-op gate, using per-branch state kept in the repo's git common dir, so it follows a branch from worktree to worktree. Needs a source-control integration outside `local` mode; stacking, issue tracking, error tracking, and session sharing (a `> Lore:` link to the session in the PR and issue) are used when configured. Takes over branches bitfab-dev's sync synced: it reads its issue and error refs from `.bitfab-dev/state.json`, finds issues by its bare `> Branch:` line, and replaces its PR body sections instead of adding a second Summary and Test plan. It keeps writing such a branch in bitfab-dev's format, and with the config's `sync` section set to that format, the two can take turns on any PR. |
| `/agent-flows:tickets-to-work [--priority <ranks>] [--limit <n>] [--section <name> \| --section-by-rank] [--in <integration>]` | Goes through your open issues that have no pull request, workspace, or git worktree yet (and no open sub-issues), most urgent first, then blockers, then earliest due, and asks about each one: start it (through `/agent-flows:start-work`), skip it, close it, or stop. Lists them with the issue tracker's `assignedIssues` op. |

## `.agent-flows/config.json`

The repo's shared dev configuration, committed so the whole team uses the same values. It holds configuration only (ids, slugs, branch names): no secrets, and nothing that points at one. Credentials stay with each integration's own CLI, MCP server, or environment.

```json
{
  "version": 2,
  "repo": { "baseBranch": "main" },
  "integrations": {
    "github": { "owner": "acme", "repo": "web" },
    "linear": { "teamKey": "ENG", "project": "Web app" },
    "jira": { "site": "acme.atlassian.net", "projectKey": "SUP" },
    "vercel": [
      { "name": "web", "project": "prj_web", "directory": "apps/web" },
      { "name": "docs", "project": "prj_docs", "directory": "apps/docs" }
    ],
    "sentry": { "org": "acme", "project": "web" }
  },
  "skipped": ["integrations.posthog"]
}
```

### Capabilities and integrations

Skills never name a vendor. They ask for a **capability** (`sourceControl`, `issueTracker`, `workspaces`, `deployments`, `database`, `errorTracking`, `analytics`, `featureFlags`, `chat`, `stacking`, `sessions`; see [`src/config/capabilities.ts`](src/config/capabilities.ts)) and use **every** integration the repo configured for it. A repo can have none, one, or several (Linear and Jira above are both issue trackers), and an integration can provide more than one capability (PostHog provides `analytics` and `featureFlags`).

Most integrations can also be configured **more than once**, like one Vercel project per app in a monorepo (`multiple: true` on the spec). The entry is then a list of instances, each with a unique `name`. Skills see one entry per instance, and `get integrations.vercel.directory` reads as one `{name, value}` per instance. Detection proposes a list when it finds several (one linked `.vercel/` per app). For an integration already configured, it fills only the instance it matches by required fields (a different project id is another instance, not a conflict), offers the rest as `plan.moreInstances`, and never edits a list. Instance names use lowercase letters, digits, `.`, `_`, and `-`.

A capability declares the **ops** skills call through it: for `sourceControl`, things like `prDiff` and `currentPr`, each with the contract a provider must meet. Each integration implements those ops, as a command or prose, once per way it can be reached: its MCP server (`mcp`), its CLI (`cli`), or its HTTP API with a token from an environment variable (`api`). An op that doesn't depend on that (a URL shape) is a single string. Skills read them when they run, since the shipped skill is the same for every repo:

```
configure.ts integrations sourceControl [--optional]
→ {"integrations": {"sourceControl": [{
    "integration": "github", "values": {...},
    "access": {"mcp": {"server": "GitHub"}, "cli": {"bin": "gh", "installed": true, "ready": true, ...}, "api": {"token": "GITHUB_TOKEN", "ready": false, ...}},
    "ops": {"prDiff": {"mcp": "The GitHub MCP's ...", "cli": "`gh pr diff <N> --repo acme/web`", "api": "`curl ... $GITHUB_TOKEN ...`"}, ...}
  }]}}
```

**Adapters** run an op as code instead of prose, for lookups that need exact filtering, paging, or several calls (Linear's `findIssue`: the MCP's search is fuzzy and paginated, the API's filter is exact; its `searchIssues` ranks with the API's own search; GitHub's and GitLab's `checks` read every page of a commit's checks into the one shape `ready.ts ci` reads; Graphite's `downstack` reads the parents Graphite records rather than parsing `gt log`). An adapter is TypeScript, Node built-ins only, run by `src/commands/adapter.ts`:

```ts
// .agent-flows/adapters/linear.ts in your repo: adds ops, or replaces the plugin's
export const adapters = {
  findIssue: {
    needs: "api",          // runs only when the API token is set ("cli": the CLI is signed in)
    args: ["branch"],      // passed as --branch <value>
    async run({ values, args, token, fetch }) {
      // values: the entry's config; token: from its token variable
      return { issues: [] } // printed as JSON
    },
  },
}
```

Built-in adapters live in `src/config/adapters/` and are listed on the integration's spec (`adapters: { findIssue }`); a repo's file replaces them op by op. An op with an adapter gets a `script` variant first, `node ".../adapter.ts" run <integration> <op> --<arg> <value>`, which exits 3 when it can't run on the machine (no token, no CLI) so the skill moves on to the next variant, 2 when the integration isn't configured or `use` leaves the op's capability out. A repo adapter that fails to load, or names an op its integration doesn't have, is reported as a warning and skipped.

**What the team uses an integration for is in the config**, under `use`: per capability the integration provides, a level, or `true` for a capability without levels. Levels go least first, each including the ones before: `sourceControl` is `read` (evaluate) or `write` (sync pushes and edits draft PRs; ready also marks them ready and resolves review threads; merge lands them), `issueTracker` is `link` (link a branch's existing issue) or `track` (also file one per branch and keep it in step), `errorTracking` is `link` or `resolve` (also resolve on merge). A capability left out isn't used (`"posthog": {"projectId": "1", "use": {"featureFlags": true}}`). Flows never go past the level, and `integrations` returns it as each entry's `level`. Without `use`, flows assume each capability's `defaultLevel` (`write`, `link`, `link`), and configure asks, except for a capability an integration provides only on opt-in: GitHub's `issueTracker` is used only when `use` names it (`"use": {"sourceControl": "write", "issueTracker": "track"}`), since most repos on GitHub track issues in Linear or Jira. It's a new key, not a format change: an older plugin warns about it and keeps it.

**Access is decided per machine, at run time, never in the config.** The script checks each configured integration's CLI (on `PATH`, and signed in by its `auth` command) and API token variable (set or not; it never reads the value into its output). Only the agent can see its MCP servers, so it checks those itself. For each op a skill uses the first variant that works here: MCP, then CLI, then API. When none does, it says what would fix it instead of improvising. An API variant writes the token as `{token}`, filled in as a shell expression for wherever it lives, so the secret never passes through the agent.

**Where a token lives is per machine too**, so configure asks rather than guessing: an environment variable, a file holding just the token, or a command that prints it (a password manager). `configure.ts token linear --file ~/.config/linear-key` records the answer (`--env NAME`, `--command '...'`, `--clear`) in `<git common dir>/agent-flows/local.json`, shared by the repo's worktrees and never committed. It holds where the token is, never the token. Without a recorded source, flows fall back to the integration's usual variables (`LINEAR_API_KEY`). `access.api` reports the `source` (`file /home/me/.config/linear-key`), whether configure recorded it, and the `expression` ops splice in (`$(cat '/home/me/.config/linear-key')`); adapters get the token itself. `configure.ts detect` reports the same `access` for every integration, and configure offers the ones this machine can already reach (MCP connected, CLI signed in, token set), even with no sign of them in the repo; the ones you decline are skipped so they aren't offered again.

`{field}` in an op is filled from the integration's config (`{field:encoded}` URL-encodes it), and `<N>`-style placeholders are left for the skill. Since each instance gets its own filled-in ops, an op has to name the repo or project it acts on (`gh … --repo {owner}/{repo}`, `glab … -R {project}`) rather than rely on the current directory. With no integration for a capability, it exits 2 with `{"configured": false}` and the skill sends you to `/agent-flows:configure <capability>`. With `--optional`, it returns an empty list instead, for skills that can carry on without that capability.

### Sync's format

The optional `sync` section changes how sync writes, for a team whose PRs another tool also syncs. Each field it sets wins; for the rest, a branch keeps the format sync last wrote it in (recorded with its state, or bitfab-dev's for a branch that tool synced), and a new branch gets sync's own. Configure proposes bitfab-dev's when the checkout shows it in use (`bitfab-internal/bitfab-dev` tracked, `.bitfab-dev/` ignored, or a `.bitfab-dev/state.json`):

```json
"sync": {
  "linkLabels": "integration",
  "errorVerb": "Fixes",
  "prTitle": "{issueId}: {title}",
  "blockMarkers": false
}
```

- `linkLabels`: `capability` (the default: `> Issue:`, `> Errors:`) or `integration` (each line named for its integration: `> Linear:`, `> Sentry:`).
- `errorVerb`: a word that starts each error line (`> Sentry: Fixes WEB-4P (...)`).
- `prTitle`: a title template, with `{issueId}` and `{title}` the issue's. Unset, the title follows the repo's convention.
- `blockMarkers`: `false` writes sync's part of the PR body without its `<!-- agent-flows:sync -->` markers, bounded instead by the link lines on top and the `_Last synced_` line, which is how bitfab-dev's sync finds its own.

### Ready's checks

The optional `ready` section names the commands ready's local cleanup runs, from the repo root, for a repo whose check is one command or its own script. Unset, ready runs each touched package's own scripts (fix scripts, then lint and type checks, the relevant tests, and a build), as the repo's agent instructions say:

```json
"ready": {
  "fix": ["bun run lint:fix"],
  "checks": ["bun run validate", "./scripts/affected-tests.sh {base}"]
}
```

- `fix`: commands that fix the tree in place (formatters, lint autofixes, generators), run before any check.
- `checks`: commands that verify the branch, in order. None may deploy, publish, migrate, or write to a shared service.
- `{base}` in either is the branch's merge base, for a script that picks the checks a branch needs.

`ready.ts plan` reads the section itself, like `sync`, and prints it as `commands`.

### Sections

The file is made of **sections**: objects of fields at a dotted path (`repo`, `integrations.github`). Every section follows the same rules:

- **Configure is idempotent.** Configured values win over detected ones, `skipped` remembers sections the team declined, and writes are normalized (registry order) and skipped when nothing changed. A second run with nothing new reports "up to date" and touches nothing.
- **Reads go through one door.** Flows read with `configure.ts get <path>...` (`get repo.baseBranch`) or `configure.ts integrations <capability>...`. When the file is missing, invalid, or doesn't set what's asked, it exits 2 with `{"configured": false}` and the skill sends you to `/agent-flows:configure` instead of guessing. An unknown path or capability is a hard error, and tests check every `get` and `integrations` call in the generated skills against the registries. The exceptions are `sync` and `ready`, whose fields all have defaults: `sync.ts` reads `sync` itself, over the format recorded for the branch, and the survey prints the result as `format`; `ready.ts plan` reads `ready` and prints it as `commands`.
- **Forward compatible.** `version` is the format: older files are migrated forward on read (`MIGRATIONS` in `src/config/config.ts`), and a file from a newer plugin is rejected with "upgrade the plugin" rather than misread. Sections and fields this plugin doesn't know are warnings, never errors, and writes keep them, so teammates on different plugin versions don't break each other. The exception is a format change itself: once anyone writes the new `version`, teammates on an older plugin get "upgrade the plugin" until they update. Version 2 (`services` renamed to `integrations`, with instance lists) is one, so update the whole team to 0.2 together.
- **Strict where it's known.** Known fields are type-checked (`string`, `boolean`, `string[]`), required fields are enforced, and a write can only touch sections in the registry.

### Adding an integration

Write an `IntegrationSpec` in `src/config/sections/` and list it in `INTEGRATIONS` in [`src/config/sections/index.ts`](src/config/sections/index.ts):

```ts
export const bitbucket: IntegrationSpec = {
  path: "integrations.bitbucket",
  name: "Bitbucket",
  purpose: "Pull requests, pipelines, code review",
  fields: [
    { key: "workspace", description: "Workspace slug", example: "acme", required: true },
    { key: "repo", description: "Repository slug", example: "web", required: true },
  ],
  lookup: "`bb repo view`, or ask",
  access: {
    cli: { bin: "bb", auth: ["bb", "auth", "status"] },
    api: { base: "https://api.bitbucket.org/2.0", token: ["BITBUCKET_TOKEN"] },
  },
  provides: {
    sourceControl: {
      prRef: "A bare number, or `https://bitbucket.org/{workspace}/{repo}/pull-requests/<N>`",
      prDiff: {
        cli: "`bb pr diff <N> --repo {workspace}/{repo}`",
        api: '`curl -fsSL -H "Authorization: Bearer {token}" "https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/pullrequests/<N>/diff"`',
      },
      // ...every op sourceControl declares
    },
  },
  detect: (ctx) => { /* from the origin remote */ },
}
```

That's all. Validation, detection, the plan, `get`, `integrations`, and the configure skill's tables come from the registries; `bun run build` regenerates the skills. The registry tests check every section against the shared contract (well-formed path, unique fields, examples that match their types), and every integration against the capabilities it claims: each op implemented, every variant's way of reaching it declared in `access`, `{token}` only in API variants, and `{field}` only for required fields.

A new **capability** goes in `CAPABILITIES`, with at least one provider. Give it ops only when a skill needs them: adding an op means every provider has to implement it. `required: true` makes a section always configured (like `repo`), for settings every flow can rely on. Changing the *shape* of existing data, rather than adding to it, means bumping `CONFIG_VERSION` and adding a migration.

## Releasing

The version lives in one place, `.claude-plugin/plugin.json`, because that's what Claude Code compares: an installed plugin updates only when the version changes, so a change merged without a bump never reaches anyone.

- **Bump it in every PR that changes the plugin:** `bun run bump patch` (or `minor`, `major`) in `packages/dev`. Patch for fixes and wording, minor for new commands, sections, or fields, major when a change breaks existing configs or habits. It bumps from the latest of `main` and the released versions, not from the file, so re-running it (say, after another PR took the next version and you rebased) lands on the right number.
- **CI rejects a PR whose version won't ship.** The `plugin-version` check fails when `packages/dev` changed (test files aside) and the version isn't past `main`'s current one, or is already released, e.g. two PRs that both bumped to the same version. Run it locally with `bun run check-version origin/main`.
- **Merging releases it.** Users pull from `main` through the marketplace. On each push to `main` with a new version, the release workflow tags the commit `agent-flows--vX.Y.Z` and creates a GitHub release with generated notes. If the version was already released but the plugin changed since (a PR merged without re-running the check against the latest `main`), the release job fails, so it can't go unnoticed; bump and merge to fix it.
- **The config format has its own version** (`CONFIG_VERSION`), separate from the plugin's. Bump it only when the shape of `.agent-flows/config.json` changes, with a migration.

## Layout

| Path | Contents |
|---|---|
| `src/flows/` | Flow definitions (build time only) |
| `src/commands/` | Scripts the skills run (`configure.ts`, `sync.ts` for sync's git state and no-op gate, `ready.ts` for ready's scope and its CI passes (settled, timed out, stalled), `tickets.ts` for create-tickets' plan checks and table, and `work.ts` for what start-work starts and the order tickets-to-work goes in). Node built-ins only, since nothing is installed at runtime |
| `src/config/` | The config format: capability registry (`capabilities.ts`), integration and section registry (`sections/`), capability resolution (`integrations.ts`), validation, patching, planning, detection. Runtime code, same rules |
| `skills/` | Generated skill files. Don't edit them; run `bun run build` |
| `scripts/` | `build-skills.ts` renders `skills/`; `version.ts` bumps the version and backs the CI version checks |
| `.claude-plugin/plugin.json` | Plugin manifest and the plugin's version. The repo-root `.claude-plugin/marketplace.json` points here |

`bun run validate` typechecks, tests, and fails when `skills/` is stale.
