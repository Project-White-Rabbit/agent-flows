# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0, breaking changes bump the minor version).

## [Unreleased]

### Added

- `baseTarget(host, { rootVar, flowsDir, generatedNotice? })` turns a host target into a base: each flow renders as a plain `flow.md` with its phases as `references/<phase>.md` (no skills, no frontmatter), commands are written `/<caller>:<name>` for the front-end plugin that sent the agent there, `{{pluginRoot}}` is `$<rootVar>`, and the arguments are named in plain words. Front-end plugins ship a short skill per flow that reads the base's file, so a base updates without rebuilding them.
- `baseTarget`'s `callerCmd` option sets how the host writes a front end's command, with `<caller>` for its name (`/<caller>-` on Cursor, `$<caller>:` on Codex, `<caller>:` on Amp; `/<caller>:` by default), so a base can render its flows for every host. The entry preamble no longer says `$<rootVar>` is always set in a shell: when it isn't, the agent writes the path it was given in its place.
- `{{flow:<id>}}` names another flow, for prose that runs it: "the `/acme:<id>` skill" on skill targets, the flow's file on a base target.
- `TargetSpec` fields `mainFile`, `flowRef`, `entryPreamble`, and `phasePreamble`, which `baseTarget` sets.
- `entryFrontmatterInput(flow, target)` gives a flow's entry frontmatter fields, for files that stand in for a flow under another name.

### Changed

- An `argsToken` in plain words (Amp's "the user's request") renders as prose, not inside backticks; a `$`-prefixed one stays code.
- `{{skill-ref:<phase>}}` and `{{dispatch-ref:<phase>}}` naming a phase in `inlinePhases`, from another unit, render as "the *<Phase Title>* section of the `<flow>` skill" (with phase references: "the *<Phase Title>* section of [the skill](../SKILL.md)"). They used to name a `<flow>-<phase>` skill or `references/<phase>.md` file that is never generated, since an inline phase is part of the orchestrator. Flows that use them render differently: regenerate.

## [0.1.2]

### Fixed

- The `cursor` preset's `askUser`, `askVerb`, `askVerbCap` and `askNoun` tokens name Cursor's `AskQuestion` tool instead of Claude Code's `AskUserQuestion`, and tell the agent to ask in plain text with lettered options when `AskQuestion` is not available (some models and modes lack it, and headless `cursor-agent -p` skips it).

## [0.1.1]

No code changes. First release published from CI with npm provenance, so the package can be verified as built from this repository.

## [0.1.0]

First release.

- `createFlowKit` binds a set of targets, section groups and command conventions to a validating flow schema and renderer.
- Target presets for Claude Code, Cursor, Codex and Amp; any object matching `TargetSpec` defines a new host.
- Compile modes `monolith`, `split` and `split-chain`, with `inlinePhases` and `continuousStepNumbers`.
- Per-target values, target and mode sections, and the tool, command, table, step and dispatch placeholders.
- `renderProject`, `resolveOutputPath` and `writeGeneratedFiles` (with a `check` mode for CI).
- `renderMermaid` and `describeFlow` for diagrams and snapshot tests.

[Unreleased]: https://github.com/Project-White-Rabbit/agent-flows/compare/core@0.1.2...HEAD
[0.1.2]: https://github.com/Project-White-Rabbit/agent-flows/compare/core@0.1.1...core@0.1.2
[0.1.1]: https://github.com/Project-White-Rabbit/agent-flows/compare/core@0.1.0...core@0.1.1
[0.1.0]: https://github.com/Project-White-Rabbit/agent-flows/releases/tag/core@0.1.0
