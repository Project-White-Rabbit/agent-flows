# agent-flows

[![CI](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml/badge.svg)](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Project-White-Rabbit/agent-flows)](LICENSE)

Write an agent workflow once as typed data. Compile it into skill files for each agent host: Claude Code, Cursor, Codex, Amp, or a host you define.

## Packages

| Package | Description |
|---|---|
| [`@agent-flows/core`](packages/core) [![npm](https://img.shields.io/npm/v/@agent-flows/core)](https://www.npmjs.com/package/@agent-flows/core) | Typed flow schema and compiler that renders flows into skill files |
| [`@agent-flows/dev`](packages/dev) | Dev workflow commands for any repository, shipped as the `dev-flows` plugin for Claude Code ([`plugins/dev-flows`](plugins/dev-flows)), Cursor ([`plugins/dev-flows-cursor`](plugins/dev-flows-cursor)), and Codex ([`plugins/dev-flows-codex`](plugins/dev-flows-codex)), over `dev-flows-base`, which holds the workflows for every host |

## Install the plugin

Claude Code (installs `dev-flows-base` with it):

```
/plugin install dev-flows --marketplace Project-White-Rabbit/agent-flows
```

Cursor: install `dev-flows` and `dev-flows-base` from this repository's marketplace. Codex: `codex plugin marketplace add Project-White-Rabbit/agent-flows`, then install `dev-flows` and `dev-flows-base` from it. Amp, and front ends of your own: see [the plugin README](packages/dev/README.md#cursor-codex-and-amp).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas go in [issues](https://github.com/Project-White-Rabbit/agent-flows/issues). This project follows a [Code of Conduct](CODE_OF_CONDUCT.md); report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
