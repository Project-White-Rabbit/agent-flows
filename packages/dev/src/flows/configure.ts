import type { Flow } from "@agent-flows/core"
import { CONFIG_PATH, CONFIG_VERSION } from "../config/config.ts"
import { SECTIONS } from "../config/sections/index.ts"
import { DEV_COMMANDS, devKit } from "./kit.ts"

// The skill documents whatever the registry holds, so a new section shows up
// here without touching the flow.
const sectionRows = SECTIONS.map((spec) => ({
  key: `\`${spec.path}\``,
  label: spec.name,
  cells: {
    name: spec.required ? `${spec.name} (always)` : spec.name,
    purpose: spec.purpose,
    fields: spec.fields
      .map(
        (f) =>
          `\`${f.key}\`${f.required ? " (required)" : ""}${f.type && f.type !== "string" ? ` [${f.type}]` : ""}: ${f.description}`,
      )
      .join("; "),
    lookup: spec.lookup ?? "ask",
  },
}))

export const configureFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "configure",
  title: "{{cmd}}configure",
  frontmatter: {
    description: `Set up or update ${CONFIG_PATH}, the repo's shared dev configuration: base branch and the third-party services it uses (GitHub, Linear, Vercel, Neon, Sentry, …).`,
    argumentHint: "[section ...]",
  },
  commands: DEV_COMMANDS.defineCommands({
    configure: {
      description:
        "`show` the config, `detect` what this checkout uses and plan changes, `get <path>...` values, or `write` a patch read from stdin (JSON)",
      args: "<subcommand>",
    },
  }),
  tables: {
    sections: {
      keyHeader: "Section",
      columns: {
        name: "Name",
        purpose: "Used for",
        fields: "Fields",
        lookup: "Look up with",
      },
      rows: sectionRows,
    },
  },
  variables: { configPath: CONFIG_PATH },
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: { default: "configure/detect" },
  defaultMode: "default",
  intro: `Record this repository's dev configuration in \`{{configPath}}\` at the repo root: settings every flow relies on (like the base branch) and the third-party services the repo uses, with the ids flows need to reach them. Other agent-flows commands read it instead of guessing or asking every time. The file is committed and shared with the team, so it holds **configuration only**: ids, slugs, branch names. No secrets, and nothing that points at one.

The file is made of **sections**, each an object of fields at a dotted path:

{{table:sections:name,purpose,fields,lookup}}

\`\`\`json
{
  "version": ${CONFIG_VERSION},
  "repo": { "baseBranch": "main" },
  "services": { "github": { "owner": "acme", "repo": "web" } },
  "skipped": ["services.sentry"]
}
\`\`\`

\`version\` is the file format, set by \`write\`. \`skipped\` lists sections the team chose not to configure. Sections and fields this plugin doesn't know (from a newer plugin, or added by hand) are reported as warnings and kept as they are.

To configure individual sections, name them ({{argsToken}}): \`{{cmd}}configure linear vercel\`. A name is a section path or its last part (\`services.linear\` or \`linear\`). Only the named sections are detected, shown, and changed, even ones that were skipped or are already configured; the rest of the file stays as it is. With no names, every section above is considered.

Re-running is safe: values already in the file are kept, skipped sections stay skipped, and when nothing new turns up the command says so and changes nothing.`,
  invariants: [
    "Never write a token, key, password, or connection string into the config, and never read a real `.env` file to find one. If the user pastes a secret, don't save it, and tell them it doesn't belong in this file.",
    "Never call a service in a way that changes it. Lookups are read-only.",
    "Only change the config through `write`; never edit the file by hand to get past the validator.",
  ],
  phases: [
    {
      id: "configure",
      title: "Configure",
      stepStyle: "headers",
      steps: [
        {
          id: "detect",
          kind: "branch",
          title: "Detect",
          commandCalls: ["configure"],
          body: `\`\`\`bash
{{command:configure}} detect [section ...]
\`\`\`

Pass the sections the user named, if any, as they typed them. An unknown name fails with the list of known sections: show it and ask which they meant.

The JSON has \`configPath\`, \`exists\`, the current \`config\` (when valid), its \`issues\`, \`detected\` (per section path: guessed \`values\` and the \`evidence\` behind them, from local files and git metadata only), and a \`plan\`:

- \`changes\`: sections to \`add\`, and empty fields of configured sections to \`fill\`.
- \`needs\`: required fields still missing after those changes.
- \`conflicts\`: configured values that disagree with detection. Configured values always win; mention a conflict, never change it on your own.
- \`requested\`: the section paths you passed. The plan then covers only those, and proposes each even if it was skipped or nothing was detected, plus any section marked *always* that the config still lacks (the file isn't valid without it).
- \`upToDate\`: the config exists and there is nothing to add or fill. Sections listed in \`skipped\` were deliberately left out on an earlier run and are never proposed again.

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
              when: "`plan.upToDate` is true and the user named no sections",
              description:
                "say the config is already up to date (list its sections, any `skipped`, any `warnings`, and any `conflicts`) and stop. Change nothing",
              next: null,
            },
            {
              when: "the user named sections",
              description:
                "go to fill for exactly the `requested` sections. For each one already configured, show its current values and ask what to change; for the rest, fill them as usual",
              next: "configure/fill",
            },
            {
              when: "otherwise",
              next: "configure/fill",
            },
          ],
        },
        {
          id: "fill",
          kind: "action",
          title: "Fill the gaps",
          body: `Work through \`plan.changes\` and \`plan.needs\`, plus any sections the user named. Evidence that a service is used (a dependency) is not the same as its ids, so look up each missing required field read-only, in this order:

1. **The section's lookup** from the table above: a connected MCP server or a signed-in CLI.
2. **The user**, for anything still missing or ambiguous (two Vercel projects, several Linear teams).

When the user named sections, touch only those (and any *always* section the plan adds because the config lacks it): don't propose, fill, or skip any other section.

A section whose required fields can't be found, or that the user doesn't want, goes in the write's \`skip\` list (sections marked *always* can't be skipped; ask for their values instead), so the next run doesn't propose it again. Never change a value the config already has unless the user asks.`,
          next: "configure/confirm",
        },
        {
          id: "confirm",
          kind: "branch",
          title: "Confirm",
          body: `Show one table of what will change: section, field, new value, and where it came from (detected, looked up, or asked). Then the sections you'll mark skipped. Leave out everything that stays the same, and say how many sections are unchanged.

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
{"sections": {"repo": {"baseBranch": "main"}, "services.github": {"owner": "acme", "repo": "web"}, "services.linear": {"teamKey": "ENG"}}, "skip": ["services.sentry"]}
JSON
\`\`\`

It validates the whole result and writes only if the content changed, in a fixed order, so the same answers always produce the same file. On issues it prints them with \`"written": false\` and exits 1: fix each one and run it again. \`warnings\` (unknown sections or fields it kept) are worth mentioning but don't block.`,
          next: "configure/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          body: `Say what changed in \`{{configPath}}\`, or that nothing did (\`"written": false\` with no issues). If it changed, remind the user to commit it so the team shares it.`,
          next: null,
        },
      ],
    },
  ],
})
