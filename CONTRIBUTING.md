# Contributing

Thanks for helping. Issues and pull requests are both welcome; for a large change, open an issue first so we can agree on the shape.

## Setup

```sh
pnpm install
pnpm validate   # lint, type-check, test, build
```

Node 22+ and pnpm (the version is pinned in `package.json`) are required. `pnpm lint:fix` applies Biome's formatting and safe fixes.

## Guidelines

- **Keep it host-agnostic.** Behavior specific to one host belongs in its target preset or `TargetSpec`, and anything specific to one product belongs in that product's kit configuration, not in the renderer.
- **Add a test with every change.** Renderer tests assert on rendered markdown; schema tests assert on the validation message. The fixture kit in `src/__fixtures__/kit.ts` covers all four presets.
- **Output changes are breaking.** Users commit generated skills and check them for drift in CI, so changing rendered output for an existing flow forces them to regenerate. Note such changes under "Changed" in `CHANGELOG.md`.
- **Update the docs.** Add an entry under `[Unreleased]` in `CHANGELOG.md` for user-visible changes, and update the README when the API or placeholders change.

## Releasing

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version and bump `version` in `package.json`.
2. Commit, then create a GitHub release tagged `vX.Y.Z`.
3. The `Release` workflow validates and publishes to npm with provenance.
