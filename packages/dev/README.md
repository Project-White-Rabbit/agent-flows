# @agent-flows/dev

Dev workflow commands for any repository, written as [agent-flows](../core) flows and shipped as the `dev-flows` Claude Code plugin.

## Install

```
/plugin install dev-flows --marketplace Project-White-Rabbit/agent-flows
```

On Claude Code before 2.1.275, add the marketplace first: `/plugin marketplace add Project-White-Rabbit/agent-flows`, then `/plugin install dev-flows@agent-flows`.

Before 0.10.0 the plugin was named `agent-flows`, so its commands were `/agent-flows:…`. To move over, run `/plugin uninstall agent-flows@agent-flows`, then install `dev-flows` as above. The repo's `.agent-flows/config.json` carries over unchanged.

Commands run with the `node` already on the machine (22.18+, which runs TypeScript directly). The plugin has no dependencies and no build step.

### Updates

Claude Code doesn't auto-update plugins from this marketplace unless you turn it on: `/plugin` → **Marketplaces** → `agent-flows` → **Enable auto-update**. Otherwise update by hand with `/plugin marketplace update agent-flows`. Either way, a new version takes effect in the next session or after `/reload-plugins`.

## Commands

| Command | What it does |
|---|---|
| `/dev-flows:configure [auto \| manual] [local \| replace] [section \| capability ...]` | Detects the base branch and the integrations the repo uses (GitHub, GitLab, Graphite, Claude Code's GitHub Action, Linear, Jira, Vercel, Neon, Sentry, PostHog, Slack, Lore, Superset, Conductor, git worktrees), fills in their ids from MCP servers, CLIs, or you, writes `.agent-flows/config.json` after you confirm, and prints the resulting config. `auto` settles everything with one clear answer and asks only about what's ambiguous; `manual` goes through every section one at a time, skipped ones included; with neither, it asks which. Name sections or capabilities (`/dev-flows:configure linear vercel`, `/dev-flows:configure issueTracker`) to walk just those. Idempotent: re-running keeps existing values, remembers declined integrations, and changes nothing when nothing new turns up. `local` writes to this machine's [override](#local-override) instead, for a repo whose config isn't yours to change, layered over the committed config; `replace` makes the override the whole config. |
| `/dev-flows:close [force]` | Abandons the current branch's work, the destructive sibling of sync: closes its pull request (`prClose`), deletes the remote branch, and cancels its issue, then runs the repo's own teardown as [hooks](#hooks) (`close.after`: a database branch, dev servers, a marker a worktree setup script reads). Invoking it is the confirmation. It finds the issue the branch names (the issue sync recorded for it, a ref in the branch name, the PR body); when there's none, it looks for one, issues whose `> Branch:` line names the branch (`findIssue`) first, then a search (`searchIssues`), and asks which one, if any, to cancel or mark done. An issue other pull requests are attached to, merged ones included, stays open. Refuses on the base branch, on a branch others are stacked on, and on a merged pull request, and stops on a failed lookup rather than reading it as absence. Never deletes the local branch or touches the working tree. `force` runs unattended (a workspace teardown script): it asks nothing, and an issue it only looked up is left open. Emulates bitfab-dev's `close`, with its Neon, dev-server, and closed-marker steps as the repo's hooks. |
| `/dev-flows:create-tickets [notes URL \| pasted notes \| sentence] [--yes] [--tracker <entry>] [--tracker-project <name>]` | Turns planning notes into issues in the configured issue tracker: each planned item becomes one issue with its action items as a checklist, and issues that already describe the same work are updated instead of filed twice. `tickets.ts match` scores every open issue and every one closed in the last 90 days (`recentIssues`) by the words it shares with each item, alongside the tracker's own search (`searchIssues`), and matches without asking on the same title or an issue already filed from the same notes. Priority, labels, estimate, cycle, project, assignee, due date, and blocked-by links come from the notes, then the repo's agent instructions, then the tracker's config. It shows one table (drawn by `tickets.ts check`) and files on one confirmation; `--yes` skips it when nothing needs an answer. The plan lives in the worktree's git dir and records each filed issue, so a re-run only updates. `match [--branch <branch>] <text>` only looks and writes nothing: sync uses it to find a branch's issue. Matching also weighs the open issues in each item's project (`projectIssues`) and each candidate's parent and open sub-issues; a matched issue can be moved under another parent. Before filing, `check` reports names the tracker doesn't have (people, projects, labels, and cycles from `fieldOptions`, and blocked-by issues), applies the config's [ticket rules](#ticket-rules), accepts a project or label named by a unique part of its name, gives a new sub-issue its parent's project, and asks about overdue sub-issues, sub-issues that force a parent's priority up, and matches with no project. New issues are filed in the todo state; `none` is a priority, for a team's lowest rank. Emulates bitfab-dev's `notes-to-tickets`. |
| `/dev-flows:evaluate [full] [record] [PR number or URL]` | Read-only shippability review of the current branch (committed, uncommitted, and untracked work) or a PR: what it does in plain English, prioritized risks, and a verdict. Diffs against `repo.baseBranch`, or a stacked branch's parent (through the stacking integration) so the review covers only its own work, and reads PRs through whichever source-control integrations are configured. With an issue tracker, the branch's issue (found the way close finds it, reading only) is what the judge reads the diff against, a gap being an observation, never the verdict. [Its record](#evaluates-record) is settings: keep the verdict on the pushed head for merge to gate on, review only the files that moved since (`evaluate.scope: delta`; `full` reviews everything), have a fresh subagent judge, record a confirmed HIGH risk as `stop` (`evaluate.stopOn: high`), give the judge the repo's own rubric (`evaluate.instructions`), run the tests the change touches (`evaluate.tests`) and the repo's own scan of the diff (`evaluate.scan`) first, both as findings the review verifies, and fetch the base first (`evaluate.fetch`). `record` records one run's verdict without the setting. |
| `/dev-flows:merge [stack \| branch] [squash \| merge \| rebase]` | Lands the current branch's pull request. Pre-flight refuses on the base branch, uncommitted changes, a merged or closed PR, or a PR that targets neither `repo.baseBranch` nor its stack parent (one opened by hand often targets the host's default branch), and runs `/dev-flows:sync` first when there's no PR yet. With a stacking integration it reads the branch's chain (`downstack`) and, when branches sit below it, asks whether to land the whole chain or just this branch (`stack` and `branch` skip the question); a chain must have an open PR on every branch and no failing checks before anything merges. Then sync (only the pull request and issue with `merge.sync: remote`, so nothing is pushed), mark ready (`prReady`, every draft in the chain), wait up to 30 minutes for CI on the pushed head (`ready.ts ci`), and ask the host whether it would merge (`prMergeState`): failed checks the base doesn't require don't block, required checks, reviews, conflicts, and a stale base do. One branch merges through the source-control host's `prMerge`, pinned to the commit CI passed on (squash by default, a merge commit for a branch in a stack of more than one); a chain merges through the stacking integration's `mergeStack`. Only once the host says merged: `/dev-flows:sync remote` (the issue moves to done, linked errors resolve at `resolve` level) and the remote branch is deleted, unless branches stacked above still target it. Never bypasses the host (no admin or auto-merge) and never deletes the local branch or worktree. [Its own gates and the deploy watch](#merges-gates-and-deploy-watch) are settings: every check passing, [a recorded evaluation](#evaluates-record) of the commit that lands (`merge.requireEvaluation`), unresolved review threads, how it syncs, and watching what the merge deployed (how long, and the failed steps' log tails). It waits only on the checks the base requires (the `checks` op, given the base, says which; all of them when it can't) and leaves out `ready.ignoreChecks`. `merge.issueOnMerge` says what happens to the issue: `close` (the default) moves it to done, `tracker` leaves that to the tracker's own integration with the host, and `leave` keeps its state as it is. The repo's own checks and teardown run as [hooks](#hooks) (`merge.before`, `merge.beforeCi`, `merge.after`), with the pull request numbers as `{pr}` and `{prs}`: a `merge.beforeCi` hook can commit a changelog entry the CI wait then covers. Emulates bitfab-dev's `merge`, without its changelog, release, and per-worktree server and database cleanup (hooks can do the repo's part). |
| `/dev-flows:ready [loop \| draft \| help] [--review \| --no-review] [--skip <steps>] [--ignore-check <pattern>]` | Takes finished branch work to a ready, green PR. Local cleanup first, scoped to what the branch touches (`ready.ts plan`: the merge base, changed files, the package each belongs to with its check scripts, and the agent instructions above them, with the path-scoped rule files in `.claude/rules/` and `.cursor/rules/` whose globs match): what must change with the branch (docs, mirrored files, generated output, a version bump), tests for new behavior, then the config's `ready` commands or each touched package's fix and check scripts, with only the relevant tests and output kept out of context. Then `/dev-flows:sync local`, the push (opening the PR when there's none), marking the PR ready (`prReady`), and `/dev-flows:sync remote`, so the issue moves to in review. Last, a CI pass on the pushed commit: it waits for the `checks` op, given the pull request's base so a required check that hasn't reported yet counts as pending, to settle (`ready.ts ci wait`, up to 15 minutes, or `ready.ciTimeout`; a check in `ready.requiredChecks` is held out for the same way), reads failed logs (`checkLog`) and automated reviewers' threads (`reviewThreads`), fixes only what's high-confidence, reruns the local fix and check commands on the batch, pushes it once, and resolves the threads it fixed (`resolveThread`); anything needing judgment (source logic, migrations, dependency versions, cancellations, flaky or unrelated failures) is handed back. With a [code reviewer](#code-review-on-request) configured, `--review` (or every run, at `every`) asks it to review the published commit and treats its findings like an automated reviewer's threads. `loop` repeats until a pushed commit goes green, stopping when a fix doesn't work (the stall guard) or, with `ready.maxPasses`, after that many passes; `draft` leaves the PR a draft. The report says whether sync created or updated the issue, and gives open and resolved counts per automated reviewer. When the stacking integration's `submit` fails, ready (and sync) push with `--force-with-lease` and say so. `--skip` turns off steps for one run (`cleanup`, `tests`, `fix`, `checks`, `local` for those four, `ci`, `reviews`, `all`), and `--ignore-check` leaves CI checks matching a pattern out of the wait and the fixes; the config's `ready.skip` and `ready.ignoreChecks` do the same for every run. The repo's own checks and steps run as [hooks](#hooks) at `ready.before`, `ready.beforePublish`, `ready.beforePush` (after the commit, before the push), and `ready.after`, whatever is skipped. Python repos' checks take the changed files and the tests ready picks (`{files:*.py}`, `ready.tests` with `{tests}`), and configure proposes them from Ruff, Black, Flake8, and pytest. Needs a source-control integration at `write`. Emulates bitfab-dev's `ready`, and works on branches bitfab-dev's sync started. |
| `/dev-flows:start-work [issue ids \| notes] [--start-only] [--reuse [--no-ticket]] [--confirm] [--section <name> \| --section-by-rank \| --no-section] [--workspaces <entry>] [--workspaces-repository <name>]` | Opens one workspace per issue, each on its own branch with a coding agent already working from the issue. Given notes, it files them first with `/dev-flows:create-tickets` and starts every issue that run filed or updated; given issue ids, it starts those. `--start-only` files nothing (it starts the open issues the notes already match, or the last create-tickets run's). Skips closed issues and issues that already have a workspace or git worktree on their branch, adds a `> Branch:` line so sync finds each issue, and moves issues not started yet to in progress. `--reuse` takes one issue in the current workspace instead, renaming its branch (unless pushed; through the stacking integration's `rename` when there is one, so its record follows) and the workspace after the issue (the `renameWorkspace` op); `--no-ticket` does the same for work with no issue, named after a short title. Workspaces open through the `workspaces` capability: Superset (local workspaces, agent started for you), Conductor (cloud workspaces; its CLI can't open local ones), or plain git worktrees (you get the command that starts the agent). `--project` opens the workspaces in another project of the workspaces integration (another repository it manages), for work tracked here that lands there, in no sidebar section unless a section flag names one. The `work.ts` command decides what starts, on which branch, and in which sidebar section (`--section-by-rank` names them after the priority, or the repo's own names for it in `tickets.ranks`). |
| `/dev-flows:sync [local \| remote] [issue id] [--tracker <entry>] [--tracker-project <name>]` | Keeps the branch, its draft PR, and its issue in step with the work. `local` commits and catches up to `repo.baseBranch` (restacking through the stacking integration when there is one, else `git merge`; a stacked branch whose parent already merged is moved onto that parent's base with the stacking integration's `reparent`, keeping only its own commits); `remote` refreshes the PR body and the issue (state follows the PR, but a done or canceled issue stays closed unless you say to reopen it) and resolves linked errors once the PR merges; the default does both and pushes. Before filing an issue it searches open and recently closed ones for the same work (through `/dev-flows:create-tickets match`), reusing a match or filing a sub-issue; it sets priority (once, then leaves it to people, asking for a due date when [`tickets.dueDateRequired`](#ticket-rules) covers it), labels, estimate (on `tickets.estimateScale`, when set), cycle, and project from the tracker's config and the repo's agent instructions. A re-run with nothing changed stops at a no-op gate (still saying when the base moved and the PR no longer merges cleanly), using per-branch state kept in the repo's git common dir, so it follows a branch from worktree to worktree. Needs a source-control integration outside `local` mode; stacking, issue tracking, error tracking, and session sharing (a `> Lore:` link to the session in the PR and issue) are used when configured. Takes over branches bitfab-dev's sync synced: it reads its issue and error refs from `.bitfab-dev/state.json`, finds issues by its bare `> Branch:` line, and replaces its PR body sections instead of adding a second Summary and Test plan. It keeps writing such a branch in bitfab-dev's format, and with the config's `sync` section set to that format, the two can take turns on any PR. A retitled issue keeps the blocker mark at its start; the report gives the stacking tool's URL for the PR (its `prUrl` op, when `submit` printed none); `--leave-issue` (merge passes it unless `merge.issueOnMerge` is `close`) links the issue without changing it. The PR links its issue with the tracker's closing form (`Fixes <ID>`) for an entry at `track` and the linking-only form (`Part of <ID>`) at `link`; with `merge.issueOnMerge: leave` it writes the linking-only form at `track` too, so the tracker's own integration doesn't move the issue to done on merge, while sync keeps filing and updating the issue itself. A team moving from another sync tool takes its branches over with `sync.adoptState` and `sync.adoptHeader`, and [the `sync` section's other fields](#syncs-format) set the PR body's link line, footer, an issue line when there's no issue, commit bodies for the summary, unverified links, and a base-branch gate. It stops when `origin/<base>` is missing after the fetch, and doesn't trust a remote-tracking ref for a branch origin no longer has. |
| `/dev-flows:tickets-to-work [--priority <ranks>] [--limit <n>] [--section <name> \| --section-by-rank] [--workspaces <entry>]` | Goes through your open issues that have no pull request, workspace, or git worktree yet (and no open sub-issues), most urgent first, then the ones whose title has the blocker mark (`tickets.blockerMark`), then earliest due, then the ones blocking other work, and asks about each one: start it (through `/dev-flows:start-work`), skip it, close it, or stop. Lists them with the issue tracker's `assignedIssues` op. |

## `.agent-flows/config.json`

The repo's shared dev configuration, committed so the whole team uses the same values. It holds configuration only (ids, slugs, branch names): no secrets, and nothing that points at one. Credentials stay with each integration's own CLI, MCP server, or environment.

Configure writes it only when its content changes; a different layout or key order doesn't count. After a write it formats just that file with the repo's installed Biome (`biome.json`) or Prettier (`.prettierrc*`, `prettier.config.*`, or a `prettier` key in `package.json`), so a lint fix that formats JSON doesn't undo it. Without one, or when the formatter isn't installed or fails, the file keeps the plain two-space layout.

```json
{
  "version": 3,
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

### Several tracker projects

A Linear or GitHub entry's `project` is the default project new issues go in. `projects` lists the others the repo's work goes in, each a name or a name with the paths whose changes belong to it:

```json
"linear": {
  "teamKey": "ENG",
  "project": "Platform",
  "projects": ["Infra", { "name": "Mobile", "paths": ["apps/mobile/**"] }]
}
```

Sync files a branch's new issue in the project whose `paths` match the most of the branch's changed files (the first listed on a tie), else in `project`. Name another one with `--tracker-project` (`/dev-flows:sync --tracker-project Infra`) or in words ("this is in Infra") and sync files the issue there, or moves it there when it's already in a project; after that, the issue keeps its project. create-tickets matches the project the notes name against these first, and looks for duplicates in all of them.

### Local override

For a repo whose config isn't yours to change (someone else's, or one without a config at all), or settings only you want, `/dev-flows:configure local` writes to this machine's override instead: `<git common dir>/agent-flows/config.json`, shared by the repo's worktrees and never committed. It's the same format, and its `"override"` key says how it applies:

- `"merge"` (the default, and left out of the file): layered over the committed file. Each section it sets replaces the committed one, and each in its `skipped` is dropped; everything else follows the committed file as the team changes it. `configure.ts show` lists the sections it changes as `overridden`.
- `"replace"` (`/dev-flows:configure replace`): the override is the whole config, and the committed file is ignored. Switching to it starts from the config as it reads at that moment, so you begin with a copy of the team's, but their later changes no longer reach you.

Every flow reads the result. The script form is `configure.ts write --local`, with the same patch on stdin as `write`; `null` there removes a section from the override (merged, the committed one applies again). `--replace` or `--merge` switches how it applies, and is remembered in the file; with no changes to make, pass `{}`. A write must leave a valid config once the override is applied, never touches the committed file, and isn't formatted (the override is outside the repo, in plain two-space JSON).

### Capabilities and integrations

Skills never name a vendor. They ask for a **capability** (`sourceControl`, `issueTracker`, `codeReview`, `workspaces`, `deployments`, `database`, `errorTracking`, `analytics`, `featureFlags`, `chat`, `stacking`, `sessions`; see [`src/config/capabilities.ts`](src/config/capabilities.ts)) and use **every** integration the repo configured for it. A repo can have none, one, or several (Linear and Jira above are both issue trackers), and an integration can provide more than one capability (PostHog provides `analytics` and `featureFlags`).

Most integrations can also be configured **more than once**, like one Vercel project per app in a monorepo (`multiple: true` on the spec). The entry is then a list of instances, each with a unique `name`. Skills see one entry per instance, and `get integrations.vercel.directory` reads as one `{name, value}` per instance. Detection proposes a list when it finds several (one linked `.vercel/` per app). For an integration already configured, it fills only the instance it matches by required fields (a different project id is another instance, not a conflict), offers the rest as `plan.moreInstances`, and never edits a list. Instance names use lowercase letters, digits, `.`, `_`, and `-`.

A capability declares the **ops** skills call through it: for `sourceControl`, things like `prDiff` and `currentPr`, each with the contract a provider must meet. Each integration implements those ops, as a command or prose, once per way it can be reached: its MCP server (`mcp`), its CLI (`cli`), or its HTTP API with a token from an environment variable (`api`). An op that doesn't depend on that (a URL shape) is a single string, and one the tool has nothing for is `{ unsupported: "<why>" }`, so skills skip what needs it and say why rather than improvise (Jira and GitHub have no planning document for `recordNotes`). Skills read them when they run, since the shipped skill is the same for every repo:

```
configure.ts integrations sourceControl [--optional]
→ {"integrations": {"sourceControl": [{
    "integration": "github", "values": {...},
    "access": {"mcp": {"server": "GitHub"}, "cli": {"bin": "gh", "installed": true, "ready": true, ...}, "api": {"token": "GITHUB_TOKEN", "ready": false, ...}},
    "ops": {"prDiff": {"mcp": "The GitHub MCP's ...", "cli": "`gh pr diff <N> --repo acme/web`", "api": "`curl ... $GITHUB_TOKEN ...`"}, ...}
  }]}}
```

**Adapters** run an op as code instead of prose, for lookups that need exact filtering, paging, or several calls (Linear's `findIssue`: the MCP's search is fuzzy and paginated, the API's filter is exact; its `searchIssues` ranks with the API's own search, and `recentIssues` reads every open and recently closed issue in one call; with `mention` set, a shared workspace's searches cover every team and its `assignedIssues` only the issues that name the product; GitHub's and GitLab's `checks` read every page of a commit's checks into the one shape `ready.ts ci` reads; Graphite's `downstack` reads the parents Graphite records rather than parsing `gt log`, and its `prUrl` builds the Graphite link from the host's). An adapter is TypeScript, Node built-ins only, run by `src/commands/adapter.ts`:

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

**Where a token lives is per machine too**, so configure asks rather than guessing: an environment variable, a file holding just the token, or a command that prints it (a password manager). `configure.ts token linear --file ~/.config/linear-key` records the answer (`--env NAME`, `--command '...'`, `--clear`) in `<git common dir>/agent-flows/local.json`, shared by the repo's worktrees and never committed. It holds where the token is, never the token. Without a recorded source, flows fall back to the integration's usual variables (`LINEAR_API_KEY`). An integration configured more than once on separate accounts (a second Linear workspace searched read-only, at `use` `link`, with `mention` narrowing it to issues that name the product) records each instance's own: `configure.ts token linear:<instance> --env OTHER_KEY`. An instance without its own uses the integration's. `access.api` reports the `source` (`file /home/me/.config/linear-key`), whether configure recorded it, and the `expression` ops splice in (`$(cat '/home/me/.config/linear-key')`); adapters get the token itself. `configure.ts detect` reports the same `access` for every integration, and configure offers the ones this machine can already reach (MCP connected, CLI signed in, token set), even with no sign of them in the repo; the ones you decline are skipped so they aren't offered again.

`{field}` in an op is filled from the integration's config (`{field:encoded}` URL-encodes it), and `<N>`-style placeholders are left for the skill. Since each instance gets its own filled-in ops, an op has to name the repo or project it acts on (`gh … --repo {owner}/{repo}`, `glab … -R {project}`) rather than rely on the current directory. With no integration for a capability, it exits 2 with `{"configured": false}` and the skill sends you to `/dev-flows:configure <capability>`. With `--optional`, it returns an empty list instead, for skills that can carry on without that capability.

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
- `prTitle`: a title template, with `{issueId}` and `{title}` the issue's, and `{summary}` a summary of the change in the repo's title convention: `"{summary} ({issueId})"` gives `fix(auth): keep the session on refresh (ENG-42)`. A branch with no issue gets just the summary. Unset, the title follows the repo's convention.
- `quoteLinks`: `false` writes the PR body's link lines plain (`Issue: …`) instead of quoted (`> Issue: …`). The issue's own lines stay quoted, since sync finds a branch's issue by its `> Branch:` line.
- `prSections`: the headings of sync's sections in the PR body, in order (`["Summary", "Verification"]`), in place of the repo's PR template or Summary and Test plan. Sync fills a summary heading with the summary, a test or verification heading with what proves the change works (the commands run and what they showed), and any other with what its name asks for.
- `blockMarkers`: `false` writes sync's part of the PR body without its `<!-- agent-flows:sync -->` markers, bounded instead by the link lines on top and the `_Last synced_` line, which is how bitfab-dev's sync finds its own.
- `prLinkLine`: `false` leaves out the tracker's `Fixes <ID>` or `Part of <ID>` line, for a tracker that links through the issue line or the title alone.
- `noIssueLine`: with no issue, still write the issue line with this text after its label (`"none"` gives `Linear: none`); unset leaves the line out.
- `footer`: `false` leaves out the `_Last synced_` line. Only with `blockMarkers` on: without markers that line is where sync's part ends, so sync writes it anyway.
- `commitBodies`: `true` hands sync each commit's whole message, not only its subject, so a repo whose commits carry a `Verification:` section gets it in the PR (up to 20 commits and 8,000 characters).
- `linkUnverified`: `true` links an issue ref the branch, PR title, or argument names even when a tracker at `link` can't load it (a token for another workspace, an outage), marked unverified in the report, instead of linking none.
- `requireBase`: `true` stops sync on a pull request that targets neither `repo.baseBranch` nor its stack parent, as merge does, for a repo whose host default branch isn't the base.

Sync finds a branch's issue in the PR title wherever `prTitle` puts `{issueId}` (at the start, or at the end in `({issueId})`), and in the issue line in any form it writes it (quoted or plain, linked or a bare URL). It stops when `origin/<base>` is missing after its fetch, rather than reading the branch as synced, and asks origin whether the branch still exists before trusting its remote-tracking ref, so commits on a branch deleted on the host don't read as pushed.

**Moving from another sync tool.** `adoptState` and `adoptHeader` take over branches another tool synced, the way sync does bitfab-dev's on its own:

```json
"sync": {
  "linkLabels": "integration",
  "quoteLinks": false,
  "prSections": ["Summary", "Verification"],
  "prTitle": "{summary} ({issueId})",
  "adoptState": ["{gitDir}/other-tool/state.json"],
  "adoptHeader": "^Linear\\s*:"
}
```

- `adoptState`: that tool's per-branch state files, read once for a branch sync hasn't synced yet, for the issue it linked (JSON with `branch`, and `linearId` or `issueId`). `{gitDir}` and `{gitCommonDir}` are the worktree's git dirs; other paths are relative to the worktree root. Unlike bitfab-dev's file, finding one doesn't switch the branch to bitfab-dev's format: the fields above say how this repo writes.
- `adoptHeader`: a regular expression for the link lines that tool puts on top of a PR body. A body whose first line matches is that tool's: sync replaces those lines, and its sections with the same headings as sync's, instead of adding a second copy above them. Other sections stay.

### Merge's gates and deploy watch

The optional `merge` section, beside `issueOnMerge` and its hooks, sets how strict merge is, how it syncs, and whether it watches what it deployed:

```json
"merge": {
  "requireAllChecks": true,
  "unresolvedThreads": "bots",
  "sync": "remote",
  "watchDeploy": true,
  "deployTimeout": 40,
  "deployLogLines": 120
}
```

- `requireAllChecks`: wait on every CI check and refuse while any failed or was cancelled. By default merge waits on the checks the base requires and lets the host decide which failures block. `ready.ignoreChecks` still leaves its checks out.
- `unresolvedThreads`: `allow` (the default) leaves review threads to the host's rules; `bots` refuses while an automated reviewer's thread is open (people's are listed, not blocking); `all` refuses while any thread is open.
- `watchDeploy`: after the merge, read the commit it landed (the source-control `mergeCommit` op) and follow each `deployments` integration's `deployment` of it until it succeeds or fails, reporting its steps. A failed deploy leads the report; merge never redeploys, rolls back, or reverts. Vercel deploys through its own integration; for a repo GitHub Actions deploys, opt GitHub in and name the workflow: `"github": {"owner": "acme", "repo": "web", "deployWorkflow": "deploy.yml", "use": {"sourceControl": "write", "deployments": true}}`. Skipped steps (a migration job when nothing changed the schema) are listed apart from failed ones.
- `deployTimeout`: minutes the deploy watch waits before reporting the deployment still pending (default 30). It polls every 30 seconds for the first 5 minutes, then every minute.
- `deployLogLines`: when the deployment fails, the last this many lines of each failed step's log (the source-control `checkLog` op, reading GitHub Actions jobs) lead the report. Unset, the report gives the failed steps and the run's link only.
- `sync`: `full` (the default) runs the whole sync before the CI wait, catching the branch up to its base and pushing. `remote` refreshes only the pull request and its issue, so merge pushes nothing: unpushed commits stop it, and a branch that's behind or conflicting stops at the host's merge state, for you to run sync (and CI, and any review) first. Use it when a catch-up push inside merge would start a long CI run or move the commit a review recorded.
- `requireEvaluation`: `pass` or `flag`, the verdict [evaluate's record](#evaluates-record) must hold for the commit that lands. With none recorded for that commit, merge runs `/dev-flows:evaluate record` and gates on its verdict.

### Ready's checks

The optional `ready` section names the commands ready's local cleanup runs, from the repo root, for a repo whose check is one command or its own script, the steps ready skips, the CI checks it ignores or holds out for, and how long and how often it waits on CI. Unset, ready runs each touched package's own scripts (fix scripts, then lint and type checks, the relevant tests, and a build), as the repo's agent instructions say, runs every step, and waits on every CI check:

```json
"ready": {
  "fix": ["bun run lint:fix"],
  "checks": ["bun run validate", "./scripts/affected-tests.sh {base}"],
  "skip": ["tests"],
  "ignoreChecks": ["Vercel*", "codecov/*"]
}
```

A Python repo, whose tools take files:

```json
"ready": {
  "fix": ["uv run black {files:*.py}"],
  "checks": ["uv run flake8 --select=F821 {files:*.py}"],
  "tests": "uv run pytest {tests}",
  "requiredChecks": ["tests-passed"],
  "ciTimeout": 25,
  "maxPasses": 5
}
```

- `fix`: commands that fix the tree in place (formatters, lint autofixes, generators), run before any check.
- `checks`: commands that verify the branch, in order. None may deploy, publish, migrate, or write to a shared service. Ready runs `fix` and `checks` before its first push, and again before every CI fix push, so a fix can't trade one failure for another.
- `tests`: a command for the tests the branch touches, run after `checks`. Ready picks the relevant test files (the ones that changed, the ones next to changed files, the ones importing them) and puts them in place of `{tests}`, shell-quoted; with none, it skips the command. It runs even with `checks` set, which otherwise replace ready's related-tests step.
- `{base}` in any of them is the branch's merge base, for a script that picks the checks a branch needs. `{files}` is the changed files that still exist (committed, uncommitted, and untracked), shell-quoted, and `{files:<glob>}` the ones matching a glob, where a glob without a `/` matches the file name (`{files:*.py}`). A command whose `{files}` matches none is left out of the run, and the report says so.
- `skip`: steps ready skips on every run: `cleanup` (what must change with the branch), `tests` (writing tests for new behavior), `fix` and `checks` (the local commands), `local` (all four), `ci` (waiting on CI and fixing it), `reviews` (automated reviewers' threads), `all` (every step, so ready only commits, publishes, and syncs). A step it doesn't know stops the run, so a typo can't quietly run what it meant to skip.
- `ignoreChecks`: CI check names ready neither waits on nor fixes, such as a preview deploy or optional coverage. `*` matches any run of characters, case aside. With every check ignored, ready treats the commit as having no CI.
- `requiredChecks`: CI check names ready and merge hold out for: one named here and not on the commit yet counts as pending, so a quick check settling before a slow workflow registers can't read as green. Ready also gives the `checks` op the pull request's base, so a check the host's branch rules require is held out for the same way; this is for a check those rules don't name, or a repo without them. `*` works as in `ignoreChecks`. `ready.ts ci` reads it from the config, so merge's CI wait honors it too.
- `ciTimeout`: minutes a CI pass waits for the checks to settle (default 15).
- `maxPasses`: the most CI passes one `loop` run makes. On the last, ready waits and reports but pushes no more fixes. Unset, `loop` ends only on green, a stop, or a fix that didn't work.

Configure proposes `fix` and `checks` when the root `package.json` has one script that runs the whole check: a `validate`, `check`, `verify`, or `ci` that chains others, preferring one that doesn't run the full suite (`validate` over a `check-all` that adds `test`). It reads that script one level down, through the scripts it calls, and proposes nothing when a step deploys, publishes, migrates, or seeds. `fix` gets the fix scripts it calls (`lint:fix`), else the repo's own, so fixes land before any check reads the tree. Since `checks` replaces ready's own related-tests step, a check that runs no tests gets the runner's changed-tests command (`bunx vitest run --changed {base}`, `jest --changedSince={base}`). The runner is the one the root depends on, else the one its `test` scripts run (through the scripts they call), else the one a tracked `vitest.config.*` or `jest.config.*` sets up, so a runner a shared stack package brings in is still found. When one of those names both vitest and jest, configure asks. A monorepo without such a root script keeps the per-package default. A Python repo with no such script (its dependencies in `pyproject.toml` or a `requirements*.txt`) gets its own tools: Ruff (`ruff format` and `ruff check --fix` as `fix`, `ruff check` as `checks`), else Black as `fix` and Flake8 as `checks`, each on `{files:*.py}`, and `pytest {tests}` as `tests`, run through `uv run`, `poetry run`, or `pdm run` when that lockfile is tracked.

A run's `--skip` and `--ignore-check` add to both lists; they never remove from them. `ready.ts plan` reads the section itself, like `sync`, and prints it as `commands`, `skip`, `ignoreChecks`, and `ci`; ready passes each pattern to `ready.ts ci` as `--ignore-check`, so merge's own CI wait still sees every check.

### Code review on request

The `codeReview` capability is an automated reviewer that reviews a pull request when asked, rather than on every push. Its integration is Claude Code's GitHub Action (`integrations.claude`): a workflow that runs `anthropics/claude-code-action` when a comment mentions `@claude`. Configure detects it from `.github/workflows`:

```json
"claude": {
  "owner": "acme",
  "repo": "web",
  "workflow": "claude.yml",
  "use": { "codeReview": "request" }
}
```

- `mention`: what wakes the workflow (its `trigger_phrase`), default `@claude`. `bot`: the login its replies come from, default `claude[bot]`.
- `use.codeReview`: `request` (the default) reviews only when a ready run passes `--review`; `every` reviews on every ready run, unless it passes `--no-review`. A review posts a comment on the pull request and costs a run, so it's never on by default.

Ready requests the review once per run, right after publishing, for the commit it pushed (`requestReview`), and reads it alongside the CI pass (`reviewResult`): the adapter finds the workflow run the comment started (the earliest one since the request on this pull request that didn't skip, since the workflow wakes on every comment and skips the ones without the mention), waits for it, and returns what the bot posted since. Mechanical findings are fixed in the same push as the CI fixes; judgment calls are handed back. Inline comments come through as review threads, like any bot's. A review that hasn't finished within the pass, failed, or never started (`missing`: check the workflow's trigger and the mention) is reported with its run, not a stop. `--skip reviews` turns it off with the rest of the review handling.

### Ticket rules

The optional `tickets` section holds how the team files and ranks work, for create-tickets, sync, start-work, and tickets-to-work:

```json
"tickets": {
  "planningDoc": true,
  "blockerMark": "🛑",
  "dueDateRequired": ["high"],
  "ranks": ["Urgent", "P0", "P1", "P2", "Audit"],
  "parentFollowsSubIssues": true,
  "estimateScale": [1, 2, 4, 8]
}
```

- `planningDoc`: each create-tickets run records the notes as written, and the issues filed from them, in a "Planning, week of <date>" document for the current cycle (the tracker's `recordNotes` op; one section per set of notes, replaced on a re-run), and every issue it files or updates gets a `> Planning:` line linking back. Trackers with no such document mark the op `unsupported`, and create-tickets says so.
- `blockerMark`: the mark on the title of an issue that stops a customer. A plan item with `blocker: true` gets it, sync keeps it when it retitles, and tickets-to-work takes marked issues first within each priority.
- `dueDateRequired`: priorities (on the tracker's scale: `urgent`, `high`, `medium`, `low`, `none`) whose issues need a due date. create-tickets won't file one without, unless it's a parent whose sub-issues carry the dates, and sync asks for one when it files the branch's issue at one of them or sets its priority to one (it never changes a priority people set, so it doesn't ask again later); an unattended sync writes the rest and reports the missing date. A due date before the issue's cycle starts is refused whatever this says.
- `ranks`: the team's names for the tracker's priorities, one each for `urgent`, `high`, `medium`, `low`, and `none`, in that order (default `Urgent`, `High`, `Medium`, `Low`, `No priority`). start-work's `--section-by-rank` names sidebar sections after them, tickets-to-work shows them on each issue and takes them in `--priority` (`--priority urgent,p0`), and create-tickets takes one as an item's priority and shows both in its table (`high (P0)`). No two may be alike, and a tracker priority's own name (`High`) may only name that priority. configure reads them off a tracked prioritization doc (`TASK_PRIORITIZATION.md`, or any `*priorit*.md`) whose table maps each rank to a tracker priority (`| P0 | … | High (2) |`). `work.ts --ranks` still overrides them for one run.
- `parentFollowsSubIssues`: a parent takes its most urgent open sub-issue's priority, and with no cycle, its earliest sub-issue's cycle; a new sub-issue moves a parent outside the plan up too.
- `estimateScale`: the estimates the team sizes work in, smallest first (bitfab-dev's 1, 2, 4, 8). sync and create-tickets estimate every issue on it, and create-tickets refuses an estimate off it. Without it, they estimate only when the agent instructions or the tracker's `values.estimate` ask, on the agent instructions' scale.

`tickets.ts check` and `work.ts` read the section themselves; sync reads `dueDateRequired` and `estimateScale` with `configure get`.

### Evaluate's record

Unset, `/dev-flows:evaluate` is a read-only recommendation. The `evaluate` section makes its verdict something merge can gate on:

```json
"evaluate": {
  "record": true,
  "scope": "delta",
  "reviewer": "subagent",
  "stopOn": "high",
  "instructions": [".agent-flows/review.md"],
  "tests": "bun run test {tests}",
  "fetch": true,
  "scan": [{ "name": "rules", "run": "python3 scripts/review_scan.py --base {base}", "timeout": 300 }]
},
"merge": { "requireEvaluation": "pass" }
```

- **`record`**: after an evaluation of the current branch, and before its report is shown, `evaluate.ts record` keeps its verdict (`pass` for Ship, `flag` for Address first, `stop` for Rethink), its findings, and each changed file's patch-id in `<git common dir>/agent-flows/evaluate/<branch>.json`. It refuses a tree with uncommitted or untracked changes, a HEAD that isn't the remote branch's (the verdict must name the commit that lands), and a record that changed since `scope` read it (`--previous`, so a verdict another session recorded meanwhile isn't overwritten); the review is still given. The `record` argument (`/dev-flows:evaluate record`) records one run without the setting.
- **Findings and their anchors**: the summary's first line is the verdict's (`Address first: <reason>`); each finding after it ends in ` @ ` and the files it lives in, comma-separated, each with an optional line: `[HIGH] Migration: drops a column old code reads. @ db/schema.ts:12, api/routes.ts`. A finding without one is never cleared by a delta.
- **`scope: delta`**: `evaluate.ts scope` compares each file's change (its patch-id against the merge base, without context lines, so the base moving around it doesn't count) with the record's. Only the files that moved are reviewed, and the reviewer re-checks the earlier findings anchored in them. The record drops each earlier finding whose anchors all fall in files reviewed again (or ones the branch no longer changes), keeps the rest, and records the new verdict, made worse only by the earlier verdict when any of its findings still stand: a delta that fixed what was flagged can pass. When none moved (the branch only took in its base), the verdict carries to the new head with no review, and a carry onto the commit the record already names writes nothing. A recorded `stop` is always reviewed again in full, and so is `/dev-flows:evaluate full`, which replaces the record. `scope` prints `since`, the commit a delta or carry starts from.
- **`reviewer: subagent`**: a fresh subagent judges, given the gathered diff, the scope, the issue, the tests' result, the rubric, and the scan's findings, never the conversation that wrote the code. It gets two attempts; after that, evaluate gives no verdict and records nothing.
- **`stopOn: high`**: a confirmed HIGH risk, or a confirmed scan finding whose first word is `STOP`, records `stop`, which merge never lets through (the record escalates it itself). By default (`rethink`) only a Rethink does, and a HIGH risk records `flag`, which merge lets you accept at `pass`.
- **`instructions`**: repo-relative files with the repo's own review rules, pasted verbatim into the judging prompt (the subagent's too) as an extra lens. They add what to look for and how to grade it, and never change the report's format or the verdict rules.
- **`tests`**: before the judging, `evaluate.ts tests` runs the command with `{tests}` the test files relevant to the change (`{base}` and `{files}` as for `ready.fix`), once, its output in a log in the worktree's git dir. The judge gets whether it passed and the log's path; a failure is a finding, never the verdict by itself. Like a scan, it may write only a test runner's caches and build output.
- **`fetch`**: fetch `origin/<base>` before diffing against it. Unset, evaluate uses the remote-tracking ref as it is.
- **The issue**: with an issue tracker, evaluate finds the branch's issue the way close does (the issue sync recorded, a ref in the branch name, the pull request's issue line, then the `> Branch:` line), reading only, and gives the judge its title and description. A gap between the issue and the diff is an observation, never the verdict by itself.
- **`scan`**: hooks at `evaluate.scan` run before the judging; what a passing command prints is findings the review confirms or sets aside, one line each, never the verdict.
- **`merge.requireEvaluation`**: before its CI wait, merge runs `evaluate.ts gate`. With no record, or one on another commit (unless `scope: delta` carries it, as above), merge runs `/dev-flows:evaluate record` and gates on what it records; one it still can't record stops. A `stop` verdict stops. A `flag` passes at `flag` and needs your explicit go-ahead at `pass`.

### Hooks

Integrations cover what's the same for every repo on a vendor (Neon branches, Linear issues). **Hooks** cover what's this repo's own: steps at named points in the flows, each one a command or a prompt for the agent. A version-bump check CI enforces, a migration check, regenerated screenshots, a dev server to tear down after a merge, a rule for when the SDKs change.

```json
"hooks": {
  "before": [{ "name": "env", "run": "./scripts/sync-worktree-env.sh" }],
  "after": [
    { "name": "notify", "on": "failure", "run": "./scripts/notify.sh {outcome}" },
    { "name": "new-issue", "flows": ["sync"], "run": "test -z \"$AGENT_FLOWS_ISSUE_FILED\" || ./scripts/announce.sh {issue}" }
  ]
},
"ready": {
  "before": [
    { "name": "version-bump", "run": "./scripts/check-version.sh {base}", "fix": "bun run bump patch" },
    { "name": "migrations", "run": "pnpm db:verify-migrations", "timeout": 300 },
    { "name": "docs-match", "run": "./scripts/check-docs.sh", "recheck": true },
    { "name": "sdk-docs", "paths": ["sdks/**"], "prompt": "Update the SDK docs for what this branch changed" }
  ],
  "beforePublish": [{ "name": "screenshots", "paths": ["ui/**"], "run": "bun run screenshots" }]
},
"merge": {
  "after": [{ "name": "server-down", "on": "merged", "run": "./scripts/dev-server.sh down {branch}" }]
}
```

**Points.** Two levels: general points around every command but configure, and a flow's own points at its steps. They nest: `hooks.before`, the flow's steps with its points, the flow's `after`, then `hooks.after`.

| Point | When | Side effects | A failure |
|---|---|---|---|
| `hooks.before` | Start of every command but configure, once its mode is known | Only in the checkout (it runs before ready too) | Stops the command |
| `ready.before` | Once ready has scoped the branch, before its cleanup | Only in the checkout | Stops ready |
| `ready.beforePublish` | After the local checks, before the commit and push; what hooks change is committed | Only in the checkout | Stops ready |
| `ready.beforePush` | After sync's local pass commits the branch, before the push: a check that reads the commits about to publish; ready commits what hooks change | Only in the checkout | Stops ready |
| `ready.beforeFixPush` | In ready's CI step, after each batch of CI fixes is committed, before it's pushed: the same kind of check, for the fix pushes `beforePush` doesn't see; ready commits what hooks change | Only in the checkout | Stops ready (nothing is pushed) |
| `evaluate.scan` | Once evaluate has its scope, before it judges: the repo's own scan of the diff. What a passing command prints goes to the reviewer as findings to verify | None: read only (an exit 2 stops too: a scan has no task to hand over) | Stops evaluate |
| `merge.before` | After merge's gates, before it syncs, waits, or merges; hooks here check, they don't change | Only in the checkout | Stops merge |
| `merge.beforeCi` | After merge syncs and marks the PR ready, before it waits for CI on the commit that lands: for a commit that must land with the merge (a changelog entry) | May commit and push the branch; nothing else shared | Stops merge |
| `close.before` | After close's survey and gates, before it closes or deletes anything | Only in the checkout | Stops close |
| `ready.after`, `merge.after`, `close.after` | End of the command, finished or stopped, before its report | Allowed: teardown is the point | Reported; the rest still run |
| `hooks.after` | End of every command but configure, after the flow's own `after` | Allowed | Reported; the rest still run |

"Only in the checkout" means no deploying, publishing, migrating, or writing to a shared service or database. Ready's hooks run whatever `--skip` says: they're the repo's own requirements, not ready's steps. A command another flow runs (ready's sync) leaves the general hooks to the outer one, and `help` runs none.

**A hook** has a `name` (unique at its point; lowercase letters, digits, `.`, `_`, `-`) and either:

- `run`: a command, from the repo root. Exit 0 passes. **Exit 2** hands its stderr to the agent as a task, for a check that finds something only judgment can fix ("these docs no longer match"). With `"recheck": true`, the flow runs the command once more after the agent does that task, and a command that still exits non-zero fails (a stop, at a point that stops). Any other exit, or running past `timeout` (seconds, default 60), fails; with a `fix` command, the flow runs it once and the check again (a timeout doesn't try the fix). A timeout kills everything the command started.
- `prompt`: a task for the agent at that point, for a rule about a moment ("after the merge, post in #releases") rather than about the code. Rules about the code belong in the agent instructions (a `CLAUDE.md` or `AGENTS.md` next to it), which every flow already reads.

Filters narrow when it applies:

- `paths`: globs, repo-relative (`*` within a directory, `**` across them); only when the branch changed a match.
- `flows`: at a general point, only around these flows (`["sync", "ready", "merge"]`).
- `modes`: the flow's modes, at its own points (`["default", "loop"]`). At a general point, only with `flows`, and they're those flows' modes (`"flows": ["sync"], "modes": ["local"]`).
- `on`: `success` or `failure`, at an `after` point. `merged`, at `merge.after` and `hooks.after`: whenever the pull request merged, even when what came after it (the close-out, the deploy watch) failed and the outcome is `failure`. Teardown and release hooks for a merged branch want `merged`, not `success`.

At `evaluate.scan`, `findings` is a regex (`"^(FINDING|  CHECK|UNTESTED):"`): only the lines of a passing command's output it matches go to the reviewer, and the 400-line budget counts those.

Commands get these filled in as `{name}`, and the same in their environment, which is safer to read than a pasted string. A flow passes the ones it knows; the rest stay as written in the command, and empty in the environment.

| Placeholder | Environment | Value | Passed by |
|---|---|---|---|
| `{base}` | `AGENT_FLOWS_BASE` | The merge base | Every flow |
| `{branch}` | `AGENT_FLOWS_BRANCH` | The branch | Every flow |
| `{outcome}` | `AGENT_FLOWS_OUTCOME` | `success` or `failure` | `after` points |
| `{pr}` | `AGENT_FLOWS_PR` | The pull request's number | ready (each point, once there's one), sync's `after`, evaluate (`scan` and `after`), merge, close |
| `{prs}` | `AGENT_FLOWS_PRS` | Every pull request merge lands, bottom first, space-separated | merge |
| `{issue}` | `AGENT_FLOWS_ISSUE` | The branch's issue id | sync's `after` |
| | `AGENT_FLOWS_ISSUE_FILED` | `1` when this run filed that issue | sync's `after` |
| `{result}` | `AGENT_FLOWS_RESULT` | Which of sync's phases ran: `noop` (neither), `local`, `remote`, or `full` (both) | sync's `after` |
| | `AGENT_FLOWS_MERGED` | `1` when the pull request merged | merge's `after` points |
| `{merge}` | `AGENT_FLOWS_MERGE_COMMIT` | The commit the merge landed | merge's `after` points, once merged |
| `{since}` | `AGENT_FLOWS_SINCE` | The commit the previous recorded evaluation was on | `evaluate.scan`, when there is one |
| `{scope}` | `AGENT_FLOWS_SCOPE` | What evaluate reviews: `full` or `delta` | `evaluate.scan` |

Every command also gets `AGENT_FLOWS_FLOW`, `AGENT_FLOWS_MODE`, `AGENT_FLOWS_POINT`, `AGENT_FLOWS_HOOK`, and `AGENT_FLOWS_CHANGED_FILES` (a file listing the branch's changed files, one per line).

Whatever a hook hands the agent, the command's own rules hold: the same high-confidence bar as a CI fix, and in ready, never a migration or a dependency version. A task the agent can't do with confidence stops the command and asks.

**Adding them.** `/dev-flows:configure hooks` (or `ready`, `merge`, or a manual run) walks the points one at a time: what each one is for, the hooks it has, and what the checkout suggests for it. Suggestions come from the same read-only look as detection: checks a pull request's CI runs that ready would otherwise meet only after pushing (a version, changelog, or migration check, with `$GITHUB_BASE_REF` turned into `{base}`), package scripts and `scripts/` files named for those checks (a file runs through the package script that runs it, else its shebang, else the lockfile's runner), a package's `bump` script as a version check's fix, and teardown scripts for `merge.after` and `close.after`. A check the detected `ready.checks` already run isn't offered, so it doesn't run twice. Rules in the agent instructions about a moment are offered as prompts. Nothing is added unless you take it, and auto mode only lists what it found. Before writing a command hook at a `before` point, configure tries it once with `hooks.ts try <point> --hook '<json>'` (its filters ignored, its fix never run, since that would change the checkout), so a check that fails on a clean branch shows up now rather than on the next ready. `after` points aren't tried: teardown has side effects.

You can also edit the file and check it with `configure.ts show`. A hook that breaks the file stops every flow until it's fixed, but `configure.ts write` patches an invalid file as it stands, so a write that fixes the hook goes through.

**How flows run them.** `src/commands/hooks.ts run <point>... --flow <flow> [--mode] [--base] [--branch] [--outcome] [--pr] [--prs] [--issue] [--issue-filed] [--result] [--merged] [--merge-commit] [--since] [--scope] [--max-wait <seconds>]` runs the lists in order and prints `status`: `done` (with `ran`, each hook's result, and `failures` at reporting points), `agent` (a task, and where to resume: the flow does it, then calls again with `--after <point>/<name>`, so the work lands between the hooks around it; a `recheck` hook's command runs again first), `stop`, or `running`. Each hook's full output goes to a log in the worktree's git dir; the JSON carries only the end of a failure's. At `evaluate.scan`, `findings` also carries what each passing command printed (its first 400 lines, after its `findings` filter).

Commands run detached, each in its own process group with a watchdog for its timeout, so a slow one (a 30-minute test suite) doesn't need the agent's shell to stay open that long. With `--max-wait <seconds>`, a call stops waiting after that long and prints `running` (the hook's `name`, `seconds` so far, `pid`, and its `resume`), with the hook still running; the call `--wait <point>/<name>` picks it up where it is and goes on with the rest. The skills pass a `--max-wait` a bit under the host's limit on one command (Claude Code's is 10 minutes) and call again until the status is something else. The timeout holds across calls, whether or not anyone is waiting.

### Sections

The file is made of **sections**: objects of fields at a dotted path (`repo`, `integrations.github`). Every section follows the same rules:

- **Configure is idempotent.** Configured values win over detected ones, `skipped` remembers sections the team declined, and writes are normalized (registry order) and skipped when nothing changed. A second run with nothing new reports "up to date" and touches nothing.
- **Reads go through one door.** Flows read with `configure.ts get <path>...` (`get repo.baseBranch`) or `configure.ts integrations <capability>...`. When the file is missing, invalid, or doesn't set what's asked, it exits 2 with `{"configured": false}` and the skill sends you to `/dev-flows:configure` instead of guessing; `get <path>... --optional` reads an unset optional setting as `null` instead. An unknown path or capability is a hard error, and tests check every `get` and `integrations` call in the generated skills against the registries. The exceptions are `sync` and `ready`, whose fields all have defaults: `sync.ts` reads `sync` itself, over the format recorded for the branch, and the survey prints the result as `format`; `ready.ts plan` reads `ready` and prints it as `commands`.
- **Forward compatible.** `version` is the format: older files are migrated forward on read (`MIGRATIONS` in `src/config/config.ts`), and a file from a newer plugin is rejected with "upgrade the plugin" rather than misread. Sections and fields this plugin doesn't know are warnings, never errors, and writes keep them, so teammates on different plugin versions don't break each other. The exception is a format change itself: once anyone writes the new `version`, teammates on an older plugin get "upgrade the plugin" until they update. Version 2 (`services` renamed to `integrations`, with instance lists) is one, so update the whole team to 0.2 together.
- **Strict where it's known.** Known fields are type-checked (`string`, `boolean`, `string[]`, `number[]`), required fields are enforced, and a write can only touch sections in the registry.

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
| `src/commands/` | Scripts the skills run (`configure.ts`, `sync.ts` for sync's git state and no-op gate, `ready.ts` for ready's scope and its CI passes (settled, timed out, stalled), `hooks.ts` for running the repo's hooks at a point and trying one before it's configured, `tickets.ts` for create-tickets' plan checks, table, and planning document, and `work.ts` for what start-work starts and the order tickets-to-work goes in). Node built-ins only, since nothing is installed at runtime |
| `src/config/` | The config format: capability registry (`capabilities.ts`), integration and section registry (`sections/`), capability resolution (`integrations.ts`), validation, patching, planning, detection. Runtime code, same rules |
| `skills/` | Generated skill files. Don't edit them; run `bun run build` |
| `scripts/` | `build-skills.ts` renders `skills/`; `version.ts` bumps the version and backs the CI version checks |
| `.claude-plugin/plugin.json` | Plugin manifest and the plugin's version. The repo-root `.claude-plugin/marketplace.json` points here |

`bun run validate` typechecks, tests, and fails when `skills/` is stale.
