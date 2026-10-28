import { describe, expect, it } from "vitest"
import { newHookSuggestions } from "../commands/configure.ts"
import { suggestHooks, workflowCommands } from "./hook-suggestions.ts"
import type { DetectContext } from "./types.ts"

/** A checkout made of `files`, every one tracked. */
function checkout(files: Record<string, string>): DetectContext {
  const tracked = Object.keys(files)
  const dirs = tracked
    .filter((f) => f.endsWith("package.json"))
    .map((f) =>
      f === "package.json" ? "" : f.slice(0, -"/package.json".length),
    )
  return {
    tracked,
    packageDirs: dirs.includes("") ? dirs : ["", ...dirs],
    read: (file: string) => files[file],
    readJson: (file: string) =>
      files[file] ? JSON.parse(files[file] as string) : undefined,
  } as DetectContext
}

describe("workflowCommands", () => {
  it("reads single-line runs and each line of a block, and nothing else", () => {
    const text = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: bun install",
      '      - run: "bun run lint"',
      "      - name: Check",
      "        run: |",
      "          bun run test",
      "          # a comment",
      "          node scripts/version.ts check main",
      "      - uses: actions/checkout@v5",
    ].join("\n")
    expect(workflowCommands(text)).toEqual([
      "bun install",
      "bun run lint",
      "bun run test",
      "node scripts/version.ts check main",
    ])
  })
})

describe("suggestHooks", () => {
  it("offers package checks before ready, with the package's bump as the fix", () => {
    expect(
      suggestHooks(
        checkout({
          "bun.lock": "",
          "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
          "packages/sdk/package.json": JSON.stringify({
            scripts: {
              "check-version": "x",
              bump: "y",
              "db:verify-migrations": "z",
            },
          }),
        }),
      ),
    ).toEqual([
      {
        point: "ready.before",
        hook: {
          name: "check-version",
          run: "bun run --cwd packages/sdk check-version",
          fix: "bun run --cwd packages/sdk bump patch",
        },
        evidence: "packages/sdk/package.json has a `check-version` script",
      },
      {
        point: "ready.before",
        hook: {
          name: "db-verify-migrations",
          run: "bun run --cwd packages/sdk db:verify-migrations",
        },
        evidence:
          "packages/sdk/package.json has a `db:verify-migrations` script",
      },
    ])
  })

  it("offers teardown scripts after a merge, only on success", () => {
    const [suggestion] = suggestHooks(
      checkout({
        "pnpm-lock.yaml": "",
        "package.json": JSON.stringify({ scripts: { "server:down": "x" } }),
      }),
    )
    expect(suggestion).toMatchObject({
      point: "merge.after",
      hook: { name: "server-down", on: "success", run: "pnpm run server:down" },
    })
  })

  it("offers check and teardown files under scripts/, run by their extension", () => {
    expect(
      suggestHooks(
        checkout({
          "scripts/check-version-bump.sh": "",
          "scripts/server-down.ts": "",
          "scripts/check-version-bump.test.ts": "",
          "src/check-version.ts": "",
        }),
      ).map((s) => [s.point, s.hook.run]),
    ).toEqual([
      ["ready.before", "bash scripts/check-version-bump.sh"],
      ["merge.after", "node scripts/server-down.ts"],
    ])
  })

  it("offers CI checks a pull request runs, with the base ref as {base}, and never unsafe ones", () => {
    const workflow = (on: string, steps: string[]) =>
      [
        `on: ${on}`,
        "jobs:",
        "  a:",
        "    steps:",
        ...steps.map((s) => `      - run: ${s}`),
      ].join("\n")
    expect(
      suggestHooks(
        checkout({
          ".github/workflows/ci.yml": workflow("pull_request", [
            'node scripts/version.ts check "origin/$GITHUB_BASE_REF"',
            "bun run test",
            "npm publish --tag next-version",
            "echo version is fine",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept literal
            "./check-changelog.sh ${{ github.sha }}",
          ]),
          ".github/workflows/release.yml": workflow("push", [
            "node scripts/version.ts release",
          ]),
        }),
      ),
    ).toEqual([
      {
        point: "ready.before",
        hook: { name: "version", run: "node scripts/version.ts check {base}" },
        evidence:
          ".github/workflows/ci.yml runs it in CI, so ready would otherwise meet it only after pushing",
      },
    ])
  })

  it("offers each command once, under a name unique at its point", () => {
    const names = suggestHooks(
      checkout({
        "scripts/check-version.sh": "",
        "tools/scripts/check-version.py": "",
      }),
    ).map((s) => s.hook.name)
    expect(names).toEqual(["check-version", "check-version-2"])
  })
})

describe("newHookSuggestions", () => {
  it("leaves out what's already a hook at that point, by command or name", () => {
    const suggestions = suggestHooks(
      checkout({
        "scripts/check-version.sh": "",
        "scripts/verify-migrations.sh": "",
      }),
    )
    const config = {
      ready: {
        before: [{ name: "bump", run: "bash scripts/check-version.sh" }],
      },
    }
    expect(
      newHookSuggestions(suggestions, config).map((s) => s.hook.name),
    ).toEqual(["verify-migrations"])
  })
})
