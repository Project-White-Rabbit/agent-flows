import type { Flow } from "@agent-flows/core"
import { CAPABILITIES } from "../config/capabilities.ts"
import { CONFIG_PATH, CONFIG_VERSION } from "../config/config.ts"
import { providersOf } from "../config/integrations.ts"
import { SECTIONS } from "../config/sections/index.ts"
import type { AccessSpec, IntegrationSpec } from "../config/types.ts"
import { optInOf } from "../config/use.ts"
import { DEV_COMMANDS, devKit } from "./kit.ts"

/** "MCP (`Linear`), API (`LINEAR_API_KEY`)": the ways to reach an integration. */
function reachOf(access: AccessSpec, adapters: string[] = []): string {
  return [
    access.mcp && `MCP (\`${access.mcp.server}\`)`,
    access.cli && `CLI (\`${access.cli.bin}\`)`,
    access.api &&
      `API (token in ${access.api.token.map((t) => `\`${t}\``).join(" or ")}, or where configure records it)`,
    adapters.length > 0 &&
      `adapters (${adapters.map((a) => `\`${a}\``).join(", ")})`,
  ]
    .filter(Boolean)
    .join(", ")
}

// The skill documents whatever the registries hold, so a new section or
// capability shows up here without touching the flow.
const sectionRows = SECTIONS.map((spec) => ({
  key: `\`${spec.path}\``,
  label: spec.name,
  cells: {
    name: spec.required ? `${spec.name} (always)` : spec.name,
    provides:
      "provides" in spec
        ? Object.keys(spec.provides as object)
            .map(
              (id) =>
                `\`${id}\`${optInOf(spec).includes(id) ? " (opt-in)" : ""}`,
            )
            .join(", ")
        : "",
    purpose: spec.purpose,
    fields: spec.fields
      .map(
        (f) =>
          `\`${f.key}\`${f.required ? " (required)" : ""}${f.type && f.type !== "string" ? ` [${f.type}]` : ""}: ${f.description}`,
      )
      .join("; "),
    lookup: spec.lookup ?? "ask",
    reach:
      "access" in spec
        ? reachOf(
            spec.access as AccessSpec,
            Object.keys((spec as IntegrationSpec).adapters ?? {}),
          )
        : "",
  },
}))

const capabilityRows = CAPABILITIES.map((capability) => ({
  key: `\`${capability.id}\``,
  label: capability.name,
  cells: {
    name: capability.name,
    purpose: capability.purpose,
    integrations: providersOf(capability.id)
      .map((spec) => spec.name)
      .join(", "),
    levels: capability.levels
      ? capability.levels
          .map(
            (l) =>
              `\`${l.id}\`${l.id === capability.defaultLevel ? " (default)" : ""}: ${l.description}`,
          )
          .join("; ")
      : "used or not",
  },
}))

export const configureFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "configure",
  title: "{{cmd}}configure",
  frontmatter: {
    description: `Set up or update ${CONFIG_PATH}, the repo's shared dev configuration: base branch and the integrations it uses for each capability (source control, issue tracker, deployments, error tracking, …).`,
    argumentHint: "[auto | manual] [section | capability ...]",
  },
  commands: DEV_COMMANDS.defineCommands({
    configure: {
      description:
        "`show` the config, `detect [auto|manual]` what this checkout uses and plan changes, `get <path>...` values, `integrations <capability>...` for a capability's configured integrations, `write` a patch read from stdin (JSON), or `token <integration> --env|--file|--command <where>` to record where an API token is on this machine",
      args: "<subcommand>",
    },
    hooks: {
      description:
        "`try <point> --hook '<json>'` runs one hook that isn't configured yet, once, without its fix, to check it before it's written",
      args: "<subcommand>",
    },
  }),
  tables: {
    sections: {
      keyHeader: "Section",
      columns: {
        name: "Name",
        provides: "Provides",
        purpose: "Used for",
        fields: "Fields",
        reach: "Reached through",
        lookup: "Look up with",
      },
      rows: sectionRows,
    },
    capabilities: {
      keyHeader: "Capability",
      columns: {
        name: "Name",
        purpose: "Used for",
        integrations: "Integrations",
        levels: "Levels (`use`)",
      },
      rows: capabilityRows,
    },
  },
  variables: { configPath: CONFIG_PATH },
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: { default: "configure/mode" },
  defaultMode: "default",
  intro: `Record this repository's dev configuration in \`{{configPath}}\` at the repo root: settings every flow relies on (like the base branch) and the integrations the repo uses, with the ids flows need to reach them. Other dev-flows commands read it instead of guessing or asking every time. The file is committed and shared with the team, so it holds **configuration only**: ids, slugs, branch names. No secrets, and nothing that points at one.

Flows never ask for a vendor. They ask for a **capability**, and use every integration the repo configured for it:

{{table:capabilities:name,purpose,integrations,levels}}

A repo can configure any number of integrations for a capability (none, one, or several, like Linear for product work and Jira for support tickets), and flows use all of them. An integration can provide more than one capability, and most can be configured more than once (one Vercel project per app in a monorepo): the entry is then a list of instances, each with a unique \`name\`:

\`\`\`json
"vercel": [
  { "name": "web", "project": "prj_web", "directory": "apps/web" },
  { "name": "docs", "project": "prj_docs", "directory": "apps/docs" }
]
\`\`\`

The file is made of **sections**, each an object of fields at a dotted path. Every section but \`repo\`, \`sync\`, \`ready\`, \`merge\`, and \`hooks\` is an integration:

{{table:sections:name,provides,purpose,fields,reach,lookup}}

\`\`\`json
{
  "version": ${CONFIG_VERSION},
  "repo": { "baseBranch": "main" },
  "integrations": {
    "github": { "owner": "acme", "repo": "web" },
    "linear": { "teamKey": "ENG" }
  },
  "skipped": ["integrations.sentry"]
}
\`\`\`

\`version\` is the file format, set by \`write\`. An older file is upgraded when it's read (version 1 called the integrations \`services\`), and the next \`write\` saves it in the current format. \`skipped\` lists integrations the team chose not to configure. Sections and fields this plugin doesn't know (from a newer plugin, or added by hand) are reported as warnings and kept as they are.

A field marked \`[hook[]]\` is a list of **hooks**: the repo's own steps at that point (\`ready.before\`, \`merge.after\`, or \`hooks.before\` and \`hooks.after\` around every command but configure). Each is an object: a unique \`name\` (lowercase letters, digits, \`.\`, \`_\`, \`-\`), then either \`run\` (a command from the repo root: exit 0 passes, exit 2 hands its stderr to the agent as a task, anything else fails; with an optional \`fix\` command run once before checking again, and \`timeout\` in seconds, default 60) or \`prompt\` (a task for the agent at that point). \`paths\` (globs), \`modes\` (the flow's modes, at a flow's own points), and \`on\` (\`success\` or \`failure\`, at an \`after\` point) narrow when it applies. Commands get \`{base}\`, \`{branch}\`, and \`{outcome}\`, and the same as \`AGENT_FLOWS_*\` variables. Detection never adds hooks: the hooks walk (below) offers what the checkout suggests and adds only what the user takes, each in the section of the flow it's for, with that section's other fields in the write, since a write replaces the whole section.

A run goes one of three ways ({{argsToken}}):

- **Auto** (\`{{cmd}}configure auto\`): examine this checkout and machine, settle everything that has one clear answer, and ask only about what's ambiguous.
- **Manual** (\`{{cmd}}configure manual\`): go through every section one at a time, skipped ones included, and ask about each.
- **Per section** (\`{{cmd}}configure linear vercel\`): the manual walk, for just the named sections. A name is a section path or its last part (\`integrations.linear\` or \`linear\`), or a capability (\`issueTracker\`), which stands for every integration that provides it. Only the named sections are detected, shown, and changed, even ones that were skipped or are already configured; the rest of the file stays as it is.

With neither a mode nor names, configure asks which mode to run.

Each integration also records what the team **uses** it for, under \`use\`: per capability it provides, a level from the table above (\`"use": {"issueTracker": "track"}\`), or \`true\` for a capability without levels. A capability left out isn't used, even if the integration provides it (PostHog only for feature flags). Flows never go past the level, so this is where a team decides, say, that sync links issues but doesn't file them. Without \`use\`, flows assume each capability's default level, and configure asks.

An integration can be reached in up to three ways: its **MCP server**, its **CLI**, or its **HTTP API** directly, with a token from an environment variable. Which ones work depends on the machine, not the repo, so it's never written to the config: every flow checks at run time and uses the first that works, in that order. Configure uses the same check to offer integrations this machine can already reach, even when the repo shows no sign of them.

Re-running is safe: values already in the file are kept, skipped sections stay skipped (until a manual run or naming them brings them back), and when nothing new turns up the command says so and changes nothing.`,
  invariants: [
    "Never write a token, key, password, or connection string into the config, and never read a real `.env` file to find one. If the user pastes a secret, don't save it, and tell them it doesn't belong in this file.",
    "Never call a service in a way that changes it. Lookups are read-only, and that includes local setup: don't run a CLI command that initializes or configures the tool in this repo (some do on first use), even to read a value. Read its files instead, or ask.",
    "Only change the config through `write`; never edit the file by hand to get past the validator.",
  ],
  phases: [
    {
      id: "configure",
      title: "Configure",
      stepStyle: "headers",
      steps: [
        {
          id: "mode",
          kind: "branch",
          title: "Pick the mode",
          body: `If the user typed \`auto\`, \`manual\`, or any section names, that settles it: go straight to detect. Otherwise {{askVerb}} how to run it:

{{branches}}`,
          branches: [
            {
              option: {
                letter: "A",
                label: "Auto",
                description:
                  "examine the repo and this machine, and ask only about what's ambiguous",
              },
              next: "configure/detect",
              recommended: true,
            },
            {
              option: {
                letter: "B",
                label: "Manual",
                description: "go through every section, one at a time",
              },
              next: "configure/detect",
            },
          ],
        },
        {
          id: "detect",
          kind: "branch",
          title: "Detect",
          commandCalls: ["configure"],
          body: `\`\`\`bash
{{command:configure}} detect [auto | manual] [section | capability ...]
\`\`\`

Pass the mode (typed or picked) and the sections or capabilities the user named, if any, as they typed them. An unknown name fails with the list of known sections, capabilities, and modes: show it and ask which they meant.

The JSON has \`mode\` (\`auto\` or \`manual\`; names alone mean \`manual\`), \`configPath\`, \`exists\`, the current \`config\` (when valid), its \`issues\`, \`requested\` (when you passed names: the section paths they resolved to, with each capability expanded to its integrations), \`coverage\` (per capability, the integrations configured for it), \`detected\` (per section path: guessed \`values\` and the \`evidence\` behind them, from local files and git metadata only), \`hookSuggestions\` (hooks the checkout suggests, not already configured: each with its \`point\`, the \`hook\`, and the \`evidence\`, which says what to check before taking it; offered in the hooks walk, never planned), and a \`plan\`:

- \`changes\`: sections to \`add\`, and empty fields of configured sections to \`fill\`.
- \`needs\`: required fields still missing after those changes (per instance, with its \`instance\` name, for a list).
- \`conflicts\`: configured values that disagree with detection. Configured values always win; mention a conflict, never change it on your own.
- \`moreInstances\`: for an integration that's already configured, instances detected that match none of its configured ones (a second linked Vercel app). Detection only fills the instance it matches, and never edits a list. These are offered, not planned, and don't make the config out of date.
- With \`requested\` set (the named sections, or every section in manual mode), the plan covers only those sections, and proposes each even if it was skipped or nothing was detected, plus any section marked *always* that the config still lacks (the file isn't valid without it).
- \`upToDate\`: the config exists and there is nothing to add or fill. Sections listed in \`skipped\` were deliberately left out on an earlier run and are never proposed again.

\`access\` says, per integration, how this machine can reach it: \`cli\` (\`installed\`, and \`ready\` when it's also signed in), \`api\` (the token variable, and \`ready\` when it's set; never print its value), and \`mcp.server\`, which only you can check: it's available when your tools include ones from that MCP server (named for it, like \`mcp__<server>__…\`, or a connector of that name). An integration is **in reach** when it isn't configured, isn't in \`skipped\`, and one of those three works.

Route on the result:

{{whens}}`,
          branches: [
            {
              when: "`issues` is non-empty (the file is broken)",
              description:
                "show the issues and stop. For each issue, say what's wrong and the fix (a wrong type or a missing required field); with the user's OK, fix it with `write`, or by hand only when `write` refuses because the file is unreadable, then re-run this command. A version newer than the plugin means the user should upgrade the plugin instead",
              next: null,
            },
            {
              when: "`mode` is `auto`, `plan.upToDate` is true, and no integration is in reach",
              description:
                "say the config is already up to date (any `warnings` and any `conflicts` too) and change nothing. If `plan.moreInstances` isn't empty, add one line per integration naming the instances found, and that `{{cmd}}configure <integration>` adds them",
              next: "configure/report",
            },
            {
              when: "`mode` is `manual`",
              description: "walk the `requested` sections one at a time",
              next: "configure/fill",
            },
            {
              when: "otherwise (`auto`)",
              next: "configure/fill",
            },
          ],
        },
        {
          id: "fill",
          kind: "action",
          title: "Fill the gaps",
          body: `How much this step asks depends on the mode.

**Auto: ask only what's ambiguous.** Settle everything with one clear answer yourself, and keep the questions below for real choices:

- Integrations in reach that the plan doesn't add: don't ask about them, and don't skip them. List them in confirm as available but not added, so \`{{cmd}}configure manual\` or \`{{cmd}}configure <integration>\` can pick them up later.
- \`use\`: record each capability's default level without asking, and leave out \`(opt-in)\` capabilities. Ask only when the repo points somewhere else (its agent instructions say sync files issues, an opt-in capability no other integration covers).
- Tokens: when an integration's usual variable is already set (\`access.api.ready\`), the token is found; don't ask. Ask only when one is needed and none is found.
- Lookups: a lookup with exactly one result is the answer. Ask when it returns several (two Vercel projects, several Linear teams) or none.
- Several integrations detected for one capability, \`plan.conflicts\`, and \`plan.moreInstances\`: ask.
- A section that can't be filled without the user and isn't worth asking about: leave it out of this run rather than skipping it.
- Hooks: never add any. When \`hookSuggestions\` has some, list them in confirm as available, with \`{{cmd}}configure hooks\` (or \`ready\`, \`merge\`) to set them up.

**Manual: one section at a time.** Go through the \`requested\` sections in the sections table's order. For each, show what's configured (and any of its \`plan.moreInstances\`), what was detected, and how this machine reaches it, then {{askVerb}} whether to configure it, keep it as it is, or skip it, then ask the questions below for that section only before moving on. Recommend keeping what's configured, and configuring what was detected or is in reach.

The rest of this step applies to both modes, within those limits.

**Offer what's in reach.** Auto only lists these (above), and naming sections leaves them out. In manual mode with no names, take the integrations in reach that the plan doesn't already add, and {{askVerb}} with multiple selection: which of them should the repo use? One option per integration, saying how it's reached (\`Linear: MCP connected\`, \`Vercel: CLI signed in\`, \`Sentry: SENTRY_AUTH_TOKEN set\`). Being reachable from this machine doesn't mean the repo uses it, so recommend none by default, only ones the repo shows signs of. With more than fit in one question, ask several. The ones picked join the plan as sections to add; the rest go in the write's \`skip\` list, so the next run doesn't offer them again.

**Ask what each is for.** For every integration being added, and every configured one \`plan.needs\` lists \`use\` for, {{askVerb}} what the team uses it for: one question per capability it provides, with that capability's levels from the table above plus "Not for this", and its default level recommended. For a capability the sections table marks \`(opt-in)\`, recommend "Not for this" unless the repo shows it uses the integration for it (no other integration covers the capability, and the agent instructions or recent PRs point to it), since without \`use\` flows leave it out. A capability without levels is a yes or no. Several integrations can go in one call, up to its limit on questions. Record the answers as the entry's \`use\`, and leave out the capabilities answered "Not for this". If every capability is "Not for this", the integration isn't used: skip it instead.

**Ask where each token is.** For every integration being added or already configured that has an API, ask where its API token is on this machine when \`access.api.configured\` is false and either the table lists adapters for it (they need the token) or neither its MCP server nor its CLI works here. Don't look for the token yourself (no searching the disk, no reading files or variables to see what's there); the user says where it is. {{askVerb}} with the options:

- **An environment variable**: its name (the integration's usual ones, from the table, are a good default).
- **A file**: the path of a file holding just the token.
- **A command**: one that prints it, like a password manager's (\`op read op://<vault>/<item>/credential\`).
- **None**: use its MCP server or CLI instead; adapters that need the token are skipped.

Record each answer: \`{{command:configure}} token <integration> --env <NAME>\` (or \`--file <path>\`, \`--command '<command>'\`; \`--clear\` forgets it). It saves where the token is, never the token, in the repo's git dir: per machine, shared by the repo's worktrees, never committed, and not part of the confirm table below. Never print a token, and never pass one to the command.

Then work through \`plan.changes\` and \`plan.needs\` (other than \`use\`), plus the sections picked or named. Evidence that a service is used (a dependency) is not the same as its ids, so look up each missing required field read-only, in this order:

1. **The section's lookup** from the table above, through whichever way of reaching it works here: its MCP server, its signed-in CLI, or its API with the token variable (never print the token).
2. **The user**, for anything still missing or ambiguous (two Vercel projects, several Linear teams).

When detection finds several instances of one integration (\`detected.<path>.instances\`, like a linked Vercel project per app), the plan proposes them all as a list: confirm each, and drop the ones the team doesn't want. To add instances to an integration configured as a single object (the user asked, or accepted some of \`plan.moreInstances\`), turn its entry into a list: give the existing one a \`name\` and add the new ones. Names are unique within the list and use lowercase letters, digits, \`.\`, \`_\`, and \`-\` (\`web\`, \`apps-docs\`).

Several integrations can provide the same capability (Linear and Jira are both issue trackers). Don't make the user pick just one: when detection finds evidence for more than one, propose each, and when the user named a capability, ask which of its integrations the team uses. They can choose any number; configure those and skip the rest.

**The hooks walk.** For each \`requested\` section with hook fields (\`hooks\`, \`ready\`, \`merge\`; in manual mode, once the user chooses to configure it), go through its points in order: \`hooks\`: \`before\`, \`after\`; \`ready\`: \`before\`, \`beforePublish\`, \`after\`; \`merge\`: \`before\`, \`after\`. For each point:

1. Say in one line when it runs and what it may do (its field's description in the sections table), and list the hooks it has now.
2. Gather what fits it: the \`hookSuggestions\` for this point, each with its command, its fix, and its evidence; and, for a prompt, rules in the repo's agent instructions about this moment rather than about the code ("after a merge, post in #releases"). Rules about the code stay in the instructions; don't copy them into prompts.
3. {{askVerb}} with multiple selection: which suggestions to add, whether to add one of the user's own, and, for a point with hooks, which to change or remove. Leaving the point as it is is always an option, and the default.
4. For a hook of the user's own: a command or a prompt; the command, and a \`fix\` only when there's an obvious one (a version check's bump script); \`paths\`, \`modes\`, or \`on\` only when the user says it applies only sometimes; a \`timeout\` only for a check slower than a minute. Name it after what it does.
5. Try each new or changed command at a point that isn't an \`after\` one: \`{{command:hooks}} try <point> --hook '<the hook as JSON>'\` (single quotes, with any \`'\` written as \`'\\''\`). It runs the command once, whatever its filters say, and never its fix. \`done\`, with the hook \`passed\`: it works. \`stop\`: show \`stop.output\`. A check that fails on this branch stops every run of its command, so ask whether to keep it (\`fix\` in the output names the fix that would run), change it, or drop it; a command that's missing or takes other arguments is the usual cause. \`agent\`: show the task it would hand over. Exit 2: the hook isn't valid; its message says why. At an \`after\` point nothing is tried, since teardown and notifications have side effects: read the command back to the user instead.

When the user named sections, or in manual mode, touch only the \`requested\` sections (and any *always* section the plan adds because the config lacks it): don't propose, fill, or skip any other section.

A section whose required fields can't be found, or that the user doesn't want, goes in the write's \`skip\` list (sections marked *always* can't be skipped; ask for their values instead), so the next run doesn't propose it again. Never change a value the config already has unless the user asks.`,
          next: "configure/confirm",
        },
        {
          id: "confirm",
          kind: "branch",
          title: "Confirm",
          body: `Show one table of what will change: section (with the instance name, for a list), field, new value, and where it came from (detected, looked up, or asked). A hook gets a row of its own: its point, its name, what it runs (and its fix) or its prompt, its filters, and what trying it showed. Then the sections you'll mark skipped, and in auto mode, the integrations in reach that weren't added and the hooks the checkout suggests. Leave out everything that stays the same, and say how many sections are unchanged.

Then {{askVerb}}:

{{branches}}`,
          branches: [
            {
              option: { letter: "A", label: "Save it" },
              next: "configure/write",
              recommended: true,
            },
            {
              option: {
                letter: "B",
                label: "Change something",
                description: "add, drop, or skip a section, or correct a value",
              },
              next: "configure/fill",
            },
            { option: { letter: "C", label: "Cancel" }, next: null },
          ],
        },
        {
          id: "write",
          kind: "action",
          title: "Write",
          commandCalls: ["configure"],
          body: `Pass only what changes on stdin, keyed by section path. Each section you include **replaces** that section's whole entry (so include its existing fields too); \`null\` removes one; \`skip\` marks sections as deliberately not configured; everything you omit stays as it is.

\`\`\`bash
{{command:configure}} write <<'JSON'
{"sections": {"repo": {"baseBranch": "main"}, "integrations.github": {"owner": "acme", "repo": "web"}, "integrations.linear": {"teamKey": "ENG"}}, "skip": ["integrations.sentry"]}
JSON
\`\`\`

A list entry replaces the whole list, so include every instance you're keeping: \`"integrations.vercel": [{"name": "web", ...}, {"name": "docs", ...}]\`.

It validates the whole result and writes only if the content changed, in a fixed order, so the same answers always produce the same file. On issues it prints them with \`"written": false\` and exits 1: fix each one and run it again. \`warnings\` (unknown sections or fields it kept) are worth mentioning but don't block.`,
          next: "configure/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          commandCalls: ["configure"],
          body: `Print the resulting configuration:

\`\`\`bash
{{command:configure}} show
\`\`\`

Show it as one table: section (with the instance name, for a list), its fields and values, and what the team uses it for (\`use\`). Then list the \`skipped\` sections, and any \`warnings\`.

Say what changed in \`{{configPath}}\`, or that nothing did (\`"written": false\` with no issues). Then, from \`coverage\`, say which integrations cover each capability, and which capabilities have none, so the user knows what flows can reach. For each configured integration, say how this machine reaches it (from \`access\`, plus your MCP check; for the API, \`access.api.source\`, which says where the token comes from, never what it is), and for any it can't reach at all, the fix: connect its MCP server, install or sign in to its CLI (\`access.cli.auth\`), or record where its token is (\`token\`). That part is about this machine only and never goes in the config. If the file changed, remind the user to commit it so the team shares it.`,
          next: null,
        },
      ],
    },
  ],
})
