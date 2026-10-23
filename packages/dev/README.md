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
| `/agent-flows:configure [section \| capability ...]` | Detects the base branch and the integrations the repo uses (GitHub, GitLab, Graphite, Linear, Jira, Vercel, Neon, Sentry, PostHog, Slack), fills in their ids from MCP servers, CLIs, or you, and writes `.agent-flows/config.json` after you confirm. Name sections or capabilities (`/agent-flows:configure linear vercel`, `/agent-flows:configure issueTracker`) to set up or change just those, including ones skipped before. Idempotent: re-running keeps existing values, remembers declined integrations, and changes nothing when nothing new turns up. |
| `/agent-flows:evaluate [PR number or URL]` | Read-only shippability review of the current branch (committed, uncommitted, and untracked work) or a PR: what it does in plain English, prioritized risks, and a verdict. Diffs against `repo.baseBranch`, and reads PRs through whichever source-control integrations are configured. |

## `.agent-flows/config.json`

The repo's shared dev configuration, committed so the whole team uses the same values. It holds configuration only (ids, slugs, branch names): no secrets, and nothing that points at one. Credentials stay with each integration's own CLI, MCP server, or environment.

```json
{
  "version": 2,
  "repo": { "baseBranch": "main" },
  "integrations": {
    "github": { "owner": "acme", "repo": "web" },
    "linear": { "teamKey": "ENG" },
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

Skills never name a vendor. They ask for a **capability** (`sourceControl`, `issueTracker`, `deployments`, `database`, `errorTracking`, `analytics`, `featureFlags`, `chat`, `stacking`; see [`src/config/capabilities.ts`](src/config/capabilities.ts)) and use **every** integration the repo configured for it. A repo can have none, one, or several (Linear and Jira above are both issue trackers), and an integration can provide more than one capability (PostHog provides `analytics` and `featureFlags`).

Most integrations can also be configured **more than once**, like one Vercel project per app in a monorepo (`multiple: true` on the spec). The entry is then a list of instances, each with a unique `name`. Skills see one entry per instance, and `get integrations.vercel.directory` reads as one `{name, value}` per instance. Detection proposes a list when it finds several (one linked `.vercel/` per app). For an integration already configured, it fills only the instance it matches by required fields (a different project id is another instance, not a conflict), offers the rest as `plan.moreInstances`, and never edits a list. Instance names use lowercase letters, digits, `.`, `_`, and `-`.

A capability declares the **ops** skills call through it: for `sourceControl`, things like `prDiff` and `currentPr`, each with the contract a provider must meet. Each integration implements those ops, as a command or prose. Skills read them when they run, since the shipped skill is the same for every repo:

```
configure.ts integrations sourceControl [--optional]
→ {"integrations": {"sourceControl": [{"integration": "github", "values": {...}, "ops": {"prDiff": "`gh pr diff <N>`", ...}}]}}
```

`{field}` in an op is filled from the integration's config (`{field:encoded}` URL-encodes it), and `<N>`-style placeholders are left for the skill. Since each instance gets its own filled-in ops, an op has to name the repo or project it acts on (`gh … --repo {owner}/{repo}`, `glab … -R {project}`) rather than rely on the current directory. With no integration for a capability, it exits 2 with `{"configured": false}` and the skill sends you to `/agent-flows:configure <capability>`. With `--optional`, it returns an empty list instead, for skills that can carry on without that capability.

### Sections

The file is made of **sections**: objects of fields at a dotted path (`repo`, `integrations.github`). Every section follows the same rules:

- **Configure is idempotent.** Configured values win over detected ones, `skipped` remembers sections the team declined, and writes are normalized (registry order) and skipped when nothing changed. A second run with nothing new reports "up to date" and touches nothing.
- **Reads go through one door.** Flows read with `configure.ts get <path>...` (`get repo.baseBranch`) or `configure.ts integrations <capability>...`. When the file is missing, invalid, or doesn't set what's asked, it exits 2 with `{"configured": false}` and the skill sends you to `/agent-flows:configure` instead of guessing. An unknown path or capability is a hard error, and tests check every `get` and `integrations` call in the generated skills against the registries.
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
  provides: {
    sourceControl: {
      prRef: "A bare number, or `https://bitbucket.org/{workspace}/{repo}/pull-requests/<N>`",
      prDiff: "...",
      // ...every op sourceControl declares
    },
  },
  detect: (ctx) => { /* from the origin remote */ },
}
```

That's all. Validation, detection, the plan, `get`, `integrations`, and the configure skill's tables come from the registries; `bun run build` regenerates the skills. The registry tests check every section against the shared contract (well-formed path, unique fields, examples that match their types), and every integration against the capabilities it claims: each op implemented, and `{field}` only for required fields.

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
| `src/commands/` | Scripts the skills run. Node built-ins only, since nothing is installed at runtime |
| `src/config/` | The config format: capability registry (`capabilities.ts`), integration and section registry (`sections/`), capability resolution (`integrations.ts`), validation, patching, planning, detection. Runtime code, same rules |
| `skills/` | Generated skill files. Don't edit them; run `bun run build` |
| `scripts/` | `build-skills.ts` renders `skills/`; `version.ts` bumps the version and backs the CI version checks |
| `.claude-plugin/plugin.json` | Plugin manifest and the plugin's version. The repo-root `.claude-plugin/marketplace.json` points here |

`bun run validate` typechecks, tests, and fails when `skills/` is stale.
