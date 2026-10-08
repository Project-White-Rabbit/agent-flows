# agent-flows

[![CI](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml/badge.svg)](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-flows)](https://www.npmjs.com/package/agent-flows)
[![license](https://img.shields.io/npm/l/agent-flows)](LICENSE)

Write an agent workflow once as typed data. Compile it into skill files for each agent host: Claude Code, Cursor, Codex, Amp, or a host you define.

A flow is a graph of phases and steps (actions, branches, loops, references, parallel work) with invocation modes. The compiler checks the graph: every edge resolves, every step is reachable, and `byMode` routing is exhaustive. It then renders host-specific markdown: frontmatter, tool names, numbered steps, user-choice prompts, mode gates and cross-file dispatch.

Why not hand-write the skills? Once a workflow ships to more than one host, or grows past a few steps, hand-written copies drift: a step gets renumbered in one file and not the other, a branch points nowhere, or a tool name has the wrong prefix. Here the graph is data, so those mistakes become build errors.

## Install

```sh
npm install agent-flows zod
```

Requires Node 22+ and zod 4.1+ (a peer dependency, so flows and your own schemas share one zod). The package is ESM-only.

## Quick start

```ts
import { claudeCode, codex, createFlowKit, writeGeneratedFiles } from "agent-flows"

const kit = createFlowKit({
  targets: {
    claude: claudeCode({ plugin: "acme", mcpServer: "Acme" }),
    codex: codex({ plugin: "acme", mcpServer: "Acme" }),
  },
  // `{{#claude}}…{{/claude}}` works for every target; groups are optional.
  sections: { "ask-user-question": ["claude"] },
})

const deploy = kit.defineFlow({
  schemaVersion: 1,
  id: "deploy",
  title: "{{cmd}}deploy",
  frontmatter: { description: "Ship the current branch", argumentHint: "[env]" },
  entries: { default: "main/check" },
  tools: { status: { name: "deploy_status", kind: "mcp" } },
  phases: [
    {
      id: "main",
      title: "Deploy",
      stepStyle: "headers",
      steps: [
        {
          id: "check",
          kind: "branch",
          title: "Confirm",
          body: "Check {{tool:status}}, then {{askVerb}}:\n\n{{branches}}",
          branches: [
            { option: { letter: "A", label: "Ship it" }, next: "main/ship", recommended: true },
            { option: { letter: "B", label: "Cancel" }, next: null },
          ],
        },
        { id: "ship", kind: "action", title: "Ship", body: "Deploy to `$ARGUMENTS`.", next: null },
      ],
    },
  ],
})

const files = kit.renderProject([
  {
    flow: deploy,
    outputs: {
      claude: "plugins/claude/skills/deploy/SKILL.md",
      codex: "plugins/codex/skills/deploy/SKILL.md",
    },
  },
])

// In CI pass `check: true` and fail when `changed` is non-empty.
const { changed } = writeGeneratedFiles(files, { rootDir: process.cwd() })
```

This writes `plugins/claude/skills/deploy/SKILL.md`:

```markdown
---
description: Ship the current branch
argument-hint: "[env]"
allowed-tools: ["mcp__plugin_acme_Acme__deploy_status"]
---

# /acme:deploy

## 1. Confirm

Check `mcp__plugin_acme_Acme__deploy_status`, then use `AskUserQuestion`:

> A) **Ship it** *(recommended)* → step 2
> B) **Cancel** → stop

## 2. Ship

Deploy to `$ARGUMENTS`.
```

The Codex file gets a `name:` frontmatter with the usage line, `# $acme:deploy`, the tool as `mcp__Acme__deploy_status`, and "ask the user" in place of `AskUserQuestion`.

## Concepts

| Concept | What it does |
|---|---|
| **Target** | One agent host. Supplies `{{tokens}}`, the MCP tool prefix, the arguments token, frontmatter renderers, and how one skill invokes another. Presets: `claudeCode`, `cursor`, `codex`, `amp`. Any object matching `TargetSpec` works. |
| **Kit** | `createFlowKit({ targets, sections, commands })` binds targets to a validating schema and a renderer. |
| **Per-target values** | Any prose field can be `"text"` or `{ default: "…", codex: "…" }`. Unknown target keys are rejected. A map must define `default` or every target. |
| **Sections** | `{{#name}}…{{/name}}` keeps content only for that target or group. `{{^name}}` keeps it for everyone else. `{{#mode:x}}` gates content by mode. |
| **Modes** | `entries` maps each mode to its first step. `byMode` nexts route modes differently. Gates such as "Run only when mode is `x`" are generated. |
| **Compile modes** | `monolith` produces one file. `split` produces an orchestrator plus call-and-return sub-skills. `split-chain` uses tail-call dispatch with generated **Next:** blocks. `compile.mode` can be set per target. |
| **Registries** | `tools` (`{{tool:id}}`, derives `allowed-tools`), `commands` (`{{command:id}}` plus a reference table), `tables` (`{{table:name:a,b}}`, `{{list:name:a}}`), `variables` (`{{name}}`), `appendices`, `invariants`. |

## Placeholders

| Placeholder | Renders |
|---|---|
| `{{step:phase/step}}` | The step's number within the current file |
| `{{step-ref:phase/step}}` | The step's `refName` or `title`; works across files |
| `{{skill-ref:phase}}` / `{{dispatch-ref:phase}}` | Where a phase lives (a section, sub-skill, or reference), with mode and argument forwarding for dispatch |
| `{{branches}}` / `{{branches:prompt}}` / `{{whens}}` | User-choice options and runtime routing lines, each with its destination |
| `{{tool:id}}` / `{{command:id}}` | Tool name with the host's prefix / command invocation |
| `{{table:name:cols}}` / `{{list:name:col}}` | Tabular data from `flow.tables` |
| `{{argsToken}}` and target tokens | Defined by the target (preset tokens: `cmd`, `editor`, `pluginRoot`, `pluginDirLookup`, `askUser`, `askVerb`, `askVerbCap`, `askNoun`) |

## Targets

Each preset takes the plugin namespace plus optional settings:

| Option | Meaning |
|---|---|
| `plugin` | Namespace used in invocations (`/acme:deploy`, `$acme:deploy`) |
| `mcpServer` / `mcpPrefix` | MCP server name the prefix is derived from, or the prefix itself |
| `tokens` | Extra or overriding `{{tokens}}` |
| `usageInBody` | Move the usage line out of the frontmatter description (Cursor, Codex, Amp) |
| `pluginDir` | Codex and Amp only: `{ markerFile, envVar? }` generates a `{{pluginDirLookup}}` shell snippet that finds the installed plugin |

For a host with no preset, pass any object matching `TargetSpec`:

```ts
import { createFlowKit, namedFrontmatter } from "agent-flows"

const kit = createFlowKit({
  targets: {
    prompts: {
      tokens: { cmd: "run ", editor: "Prompt Runner" },
      mcpPrefix: "",
      argsToken: "the input",
      frontmatter: ({ flowId, description }) => namedFrontmatter(flowId, description, ""),
      subSkillFrontmatter: ({ flowId, description }) => namedFrontmatter(flowId, description, ""),
    },
  },
})
```

Optional fields: `subSkillTool` (the tool one skill uses to call another), `dispatchRef` (how prose names a sibling skill), and `phaseReferences` (under `split-chain`, emit phases as reference files rather than separate skills).

## Commands

Commands render through the kit's `commands.invoke`. By default this is the command's `file`, verbatim. A plugin that ships node scripts would use:

```ts
createFlowKit({
  targets,
  commands: {
    invoke: (c) => `node "{{pluginRoot}}/dist/commands/${c.file}"`,
    tableIntro: "**CLI commands** (paths relative to `{{pluginRoot}}/dist/commands/`):",
  },
})
```

`defineCommandCatalog({ status: { file: "status.js" } })` maps command ids to files once. Each flow then calls `.defineCommands({ status: { description: "…" } })` to pick the commands it uses, with a description in its own words. An unknown id is a type error and throws.

## Diagrams

`kit.renderMermaid(flow)` draws the graph from the schema alone, with one labeled edge per mode where they diverge. Pass `{ mode }` to show one mode's path, or `{ target }` to use that target's titles. `kit.describeFlow(flow)` prints a plain-text adjacency list, which works well in snapshot tests.

## Keeping generated files in sync

`writeGeneratedFiles(files, { rootDir })` writes only files whose content changed and returns `{ changed, unchanged }`. With `check: true` it writes nothing, so a CI step can fail when someone edits a flow without regenerating, or edits generated output by hand. Two flows writing to the same path is an error.

## Status

Pre-1.0. The flow schema carries `schemaVersion: 1`; breaking changes to it or to the API bump the minor version until 1.0. See [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas go in [issues](https://github.com/Project-White-Rabbit/agent-flows/issues).

## License

[MIT](LICENSE)
