# agent-flows

[![CI](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml/badge.svg)](https://github.com/Project-White-Rabbit/agent-flows/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Project-White-Rabbit/agent-flows)](LICENSE)

Write an agent workflow once as typed data. Compile it into skill files for each agent host: Claude Code, Cursor, Codex, Amp, or a host you define.

## Packages

| Package | Description |
|---|---|
| [`@agent-flows/core`](packages/core) [![npm](https://img.shields.io/npm/v/@agent-flows/core)](https://www.npmjs.com/package/@agent-flows/core) | Typed flow schema and compiler that renders flows into skill files |
| [`@agent-flows/dev`](packages/dev) | Dev workflow commands for any repository, shipped as the `dev-flows` Claude Code plugin |

## Install the plugin

```
/plugin install dev-flows --marketplace Project-White-Rabbit/agent-flows
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas go in [issues](https://github.com/Project-White-Rabbit/agent-flows/issues). This project follows a [Code of Conduct](CODE_OF_CONDUCT.md); report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
