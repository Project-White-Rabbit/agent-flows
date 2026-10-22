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
| `/agent-flows:configure [section ...]` | Detects the base branch and the third-party services the repo uses (GitHub, Graphite, Linear, Vercel, Neon, Sentry, PostHog, Slack), fills in their ids from MCP servers, CLIs, or you, and writes `.agent-flows/config.json` after you confirm. Name sections (`/agent-flows:configure linear vercel`) to set up or change just those, including ones skipped before. Idempotent: re-running keeps existing values, remembers declined services, and changes nothing when nothing new turns up. |
| `/agent-flows:evaluate [PR number or URL]` | Read-only shippability review of the current branch (committed, uncommitted, and untracked work) or a PR: what it does in plain English, prioritized risks, and a verdict. Diffs against `repo.baseBranch` from `.agent-flows/config.json`. |

## `.agent-flows/config.json`

The repo's shared dev configuration, committed so the whole team uses the same values. It holds configuration only (ids, slugs, branch names): no secrets, and nothing that points at one. Credentials stay with each service's own CLI, MCP server, or environment.

```json
{
  "version": 1,
  "repo": { "baseBranch": "main" },
  "services": {
    "github": { "owner": "acme", "repo": "web" },
    "linear": { "teamKey": "ENG" },
    "sentry": { "org": "acme", "project": "web" }
  },
  "skipped": ["services.posthog"]
}
```

The file is made of **sections**: objects of fields at a dotted path (`repo`, `services.github`). Every section follows the same rules:

- **Configure is idempotent.** Configured values win over detected ones, `skipped` remembers sections the team declined, and writes are normalized (registry order) and skipped when nothing changed. A second run with nothing new reports "up to date" and touches nothing.
- **Reads go through one door.** Flows read with `configure.ts get <path>...` (`get repo.baseBranch`, `get services.linear`). When the file is missing, invalid, or doesn't set a path, it exits 2 with `{"configured": false}` and the skill sends you to `/agent-flows:configure` instead of guessing. An unknown path is a hard error, and a test checks every `get` in the generated skills against the registry.
- **Forward compatible.** `version` is the format: older files are migrated forward on read (`MIGRATIONS` in `src/config/config.ts`), and a file from a newer plugin is rejected with "upgrade the plugin" rather than misread. Sections and fields this plugin doesn't know are warnings, never errors, and writes keep them, so teammates on different plugin versions don't break each other.
- **Strict where it's known.** Known fields are type-checked (`string`, `boolean`, `string[]`), required fields are enforced, and a write can only touch sections in the registry.

### Adding configuration

Write a `SectionSpec` in `src/config/sections/` and list it in [`src/config/sections/index.ts`](src/config/sections/index.ts):

```ts
export const jira: SectionSpec = {
  path: "services.jira",
  name: "Jira",
  purpose: "Tickets",
  fields: [{ key: "projectKey", description: "Issue key prefix", example: "ENG", required: true }],
  lookup: "Atlassian MCP (list projects)",
  detect: (ctx) => {
    const evidence = ctx.dependsOn(/^jira-client$/)
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}
```

That's all. Validation, detection, the plan, `get`, and the configure skill's section table come from the registry; `bun run build` regenerates the skill. The registry tests check every section against the shared contract (well-formed path, unique fields, examples that match their types). `required: true` makes a section always configured (like `repo`), for settings every flow can rely on. Changing the *shape* of existing data, rather than adding to it, means bumping `CONFIG_VERSION` and adding a migration.

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
| `src/config/` | The config format: section registry (`sections/`), validation, patching, planning, detection. Runtime code, same rules |
| `skills/` | Generated skill files. Don't edit them; run `bun run build` |
| `scripts/` | `build-skills.ts` renders `skills/`; `version.ts` bumps the version and backs the CI version checks |
| `.claude-plugin/plugin.json` | Plugin manifest and the plugin's version. The repo-root `.claude-plugin/marketplace.json` points here |

`bun run validate` typechecks, tests, and fails when `skills/` is stale.
