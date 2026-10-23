# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0, breaking changes bump the minor version).

## [Unreleased]

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
