# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0, breaking changes bump the minor version).

## [Unreleased]

## [0.1.0]

First release.

- `createFlowKit` binds a set of targets, section groups and command conventions to a validating flow schema and renderer.
- Target presets for Claude Code, Cursor, Codex and Amp; any object matching `TargetSpec` defines a new host.
- Compile modes `monolith`, `split` and `split-chain`, with `inlinePhases` and `continuousStepNumbers`.
- Per-target values, target and mode sections, and the tool, command, table, step and dispatch placeholders.
- `renderProject`, `resolveOutputPath` and `writeGeneratedFiles` (with a `check` mode for CI).
- `renderMermaid` and `describeFlow` for diagrams and snapshot tests.

[Unreleased]: https://github.com/Project-White-Rabbit/agent-flows/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Project-White-Rabbit/agent-flows/releases/tag/v0.1.0
