# Contributing

Thanks for helping. Issues and pull requests are both welcome; for a large change, open an issue first so we can agree on the shape.

## Setup

```sh
bun install
bun run validate   # lint, type-check, test, build
```

Node 22+ and Bun (the version is pinned in `package.json`) are required. `bun run lint:fix` applies Biome's formatting and safe fixes.

The repo is a Bun workspace. Each package lives under `packages/`; `@agent-flows/core` in `packages/core` is the compiler. Run a single package's scripts with `bun run --filter @agent-flows/core <script>`, or from inside its directory.

## Guidelines

- **Keep it host-agnostic.** Behavior specific to one host belongs in its target preset or `TargetSpec`, and anything specific to one product belongs in that product's kit configuration, not in the renderer.
- **Add a test with every change.** Renderer tests assert on rendered markdown; schema tests assert on the validation message. The fixture kit in `packages/core/src/__fixtures__/kit.ts` covers all four presets.
- **Output changes are breaking.** Users commit generated skills and check them for drift in CI, so changing rendered output for an existing flow forces them to regenerate. Note such changes under "Changed" in the package's `CHANGELOG.md`.
- **Update the docs.** Add an entry under `[Unreleased]` in the package's `CHANGELOG.md` for user-visible changes, and update the package README when the API or placeholders change.

## Releasing

1. Move the `[Unreleased]` entries in `packages/core/CHANGELOG.md` under the new version and bump `version` in `packages/core/package.json`.
2. Merge to `main`.
3. The `Release` workflow sees a version that isn't on npm yet, validates, publishes `@agent-flows/core` to npm with provenance, and creates the `core@X.Y.Z` tag and GitHub release.
