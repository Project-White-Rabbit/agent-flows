import { describe, expect, it } from "vitest"
import { INTEGRATIONS } from "../../integrations/index.ts"
import { checkConfig, exampleConfig } from "../config.ts"
import { toInstanceName, uniqueInstanceNames } from "../instances.ts"
import type { DetectContext, FieldSpec } from "../types.ts"
import { SECTIONS } from "./index.ts"
import { detectPythonReady, detectReady, ready } from "./ready.ts"
import { BITFAB_DEV_FORMAT, sync } from "./sync.ts"
import { ranksFromDoc, ranksProblem, tickets } from "./tickets.ts"

function typeOf(value: FieldSpec["example"]): string {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return "string[]"
    }
    if (value.every((item) => typeof item === "number")) {
      return "number[]"
    }
    // A project is a name, or an object with a name and no hook command.
    return value.every(
      (item) =>
        typeof item === "string" ||
        (typeof item === "object" && !("run" in item) && !("prompt" in item)),
    )
      ? "project[]"
      : "hook[]"
  }
  return typeof value
}

// The contract every section must meet. A new section that breaks the shared
// rules fails here, not in some flow later.
describe("section registry", () => {
  it("has unique, well-formed paths", () => {
    const paths = SECTIONS.map((s) => s.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/)
      expect(["version", "skipped"]).not.toContain(path.split(".")[0])
    }
  })

  it("never nests a section inside another section", () => {
    for (const { path } of SECTIONS) {
      expect(SECTIONS.some((s) => path.startsWith(`${s.path}.`))).toBe(false)
    }
  })

  it.each(SECTIONS.map((s) => [s.path, s] as const))(
    "%s has unique fields whose examples match their types",
    (_path, spec) => {
      const keys = spec.fields.map((f) => f.key)
      expect(new Set(keys).size).toBe(keys.length)
      // Settings that all have defaults (sync's format) may leave every field out.
      if ("provides" in spec || spec.required) {
        expect(spec.fields.some((f) => f.required)).toBe(true)
      }
      for (const field of spec.fields) {
        expect(field.key).toMatch(/^[a-z][a-zA-Z0-9]*$/)
        // Reserved: it names an instance when the section is a list.
        expect(field.key).not.toBe("name")
        expect(typeOf(field.example)).toBe(field.type ?? "string")
      }
    },
  )

  it("accepts a config built from every section's examples", () => {
    expect(checkConfig(exampleConfig())).toEqual({ issues: [], warnings: [] })
  })
})

describe("sync format", () => {
  /** A checkout with these tracked files and these files on disk. */
  const checkout = (
    tracked: string[],
    files: Record<string, string> = {},
  ): DetectContext =>
    ({ tracked, read: (file: string) => files[file] }) as DetectContext

  it("proposes bitfab-dev's format where the checkout uses its sync", () => {
    for (const ctx of [
      checkout(["bitfab-internal/bitfab-dev/skills/sync/SKILL.md"]),
      checkout([".gitignore"], {
        ".gitignore": "node_modules\n.bitfab-dev/\n",
      }),
      checkout([], { ".bitfab-dev/state.json": "{}" }),
    ]) {
      expect(sync.detect?.(ctx)?.values).toEqual(BITFAB_DEV_FORMAT)
    }
  })

  it("proposes nothing without a sign of it", () => {
    const ctx = checkout(["src/bitfab-dev.ts", ".gitignore"], {
      ".gitignore": ".bitfab-dev-cache/\n",
    })
    expect(sync.detect?.(ctx)).toBeUndefined()
  })

  it("accepts bitfab-dev's format and rejects values sync can't write", () => {
    const base = { version: 2, repo: { baseBranch: "main" } }
    expect(checkConfig({ ...base, sync: BITFAB_DEV_FORMAT }).issues).toEqual([])
    expect(checkConfig({ ...base, sync: {} }).issues).toEqual([])
    expect(
      checkConfig({
        ...base,
        sync: {
          linkLabels: "vendor",
          errorVerb: "Fixes;",
          prTitle: "{id}: {title}",
          blockMarkers: "no",
        },
      }).issues,
    ).toEqual([
      "sync.linkLabels must be `capability` or `integration`",
      "sync.errorVerb must be a word or a few, letters only (`Fixes`)",
      "sync.prTitle must be text with `{issueId}`, `{title}`, and `{summary}` placeholders (`{issueId}: {title}`, `{summary} ({issueId})`)",
      "sync.blockMarkers must be true or false",
    ])
  })

  it("takes plain link lines and the PR body's own headings", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        sync: {
          quoteLinks: false,
          prSections: ["Summary", "Verification"],
          prTitle: "{summary} ({issueId})",
        },
      }).issues,
    ).toEqual([])
    for (const prSections of [["Summary", "Summary"], ["## Summary"]]) {
      expect(checkConfig({ ...base, sync: { prSections } }).issues).toEqual([
        "sync.prSections must be distinct headings, each starting with a letter (`Summary`, `Verification`)",
      ])
    }
    expect(checkConfig({ ...base, sync: { prSections: [""] } }).issues).toEqual(
      [expect.stringContaining("sync.prSections")],
    )
  })

  it("takes another tool's state files and header, and the body knobs", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        sync: {
          adoptState: ["{gitDir}/tool/state.json", ".tool/state.json"],
          adoptHeader: "^Linear\\s*:",
          prLinkLine: false,
          noIssueLine: "none",
          footer: false,
          commitBodies: true,
          linkUnverified: true,
          requireBase: true,
        },
      }).issues,
    ).toEqual([])
    expect(
      checkConfig({
        ...base,
        sync: { adoptState: ["{home}/x.json"], adoptHeader: "(" },
      }).issues,
    ).toEqual([
      "sync.adoptState may use only the `{gitDir}` and `{gitCommonDir}` placeholders",
      "sync.adoptHeader must be a valid regular expression",
    ])
  })

  it("takes a bare-URL issue line and a time zone for the last-synced line", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        sync: { linkStyle: "url", timezone: "America/Los_Angeles" },
      }).issues,
    ).toEqual([])
    expect(
      checkConfig({
        ...base,
        sync: { linkStyle: "bare", timezone: "Pacific" },
      }).issues,
    ).toEqual([
      "sync.linkStyle must be `link` or `url`",
      "sync.timezone must be an IANA time zone (`UTC`, `America/Los_Angeles`)",
    ])
  })
})

describe("repo section", () => {
  it("takes the branches no flow works on directly", () => {
    const repo = {
      baseBranch: "dev",
      protectedBranches: ["main", "release/prod"],
    }
    expect(checkConfig({ version: 3, repo }).issues).toEqual([])
    expect(
      checkConfig({
        version: 3,
        repo: { baseBranch: "dev", protectedBranches: ["main branch"] },
      }).issues,
    ).toEqual([
      "repo.protectedBranches must list only branch names (`main`, `release/prod`) (not `main branch`)",
    ])
  })
})

describe("ticket rules for sync and dates", () => {
  it("takes assignOnSync and a time zone for today", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        tickets: { assignOnSync: true, timezone: "Europe/Berlin" },
      }).issues,
    ).toEqual([])
    expect(
      checkConfig({
        ...base,
        tickets: { assignOnSync: "yes", timezone: "Berlin" },
      }).issues,
    ).toEqual([
      "tickets.assignOnSync must be true or false",
      "tickets.timezone must be an IANA time zone (`UTC`, `America/Los_Angeles`)",
    ])
  })
})

describe("issue tracker states", () => {
  it("moves an issue to the state named for its stage before one of the same type", () => {
    const linearOps = INTEGRATIONS.find((s) => s.path === "integrations.linear")
      ?.provides.issueTracker?.updateIssue as Record<string, string>
    for (const variant of Object.values(linearOps)) {
      expect(variant).toContain(
        "named for <state>, any case: `todo` → Todo, `in progress` → In Progress",
      )
      expect(variant).toContain("`canceled` → `canceled` (not Duplicate)")
    }
    const jiraOps = INTEGRATIONS.find((s) => s.path === "integrations.jira")
      ?.provides.issueTracker?.updateIssue as Record<string, string>
    for (const variant of Object.values(jiraOps)) {
      expect(variant).toContain(
        "`canceled` → Canceled (or Cancelled, Won't Do); when there's no status of that name",
      )
    }
  })
})

describe("merge section", () => {
  it("takes only the issueOnMerge values merge and sync act on", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    for (const issueOnMerge of ["close", "tracker", "leave"]) {
      expect(checkConfig({ ...base, merge: { issueOnMerge } }).issues).toEqual(
        [],
      )
    }
    expect(
      checkConfig({ ...base, merge: { issueOnMerge: false } }).issues,
    ).toEqual([expect.stringContaining("merge.issueOnMerge")])
    expect(
      checkConfig({ ...base, merge: { issueOnMerge: "never" } }).issues,
    ).toEqual(["merge.issueOnMerge must be `close`, `tracker`, or `leave`"])
  })

  it("takes the gates and the deploy watch merge acts on", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    for (const unresolvedThreads of ["allow", "bots", "all"]) {
      expect(
        checkConfig({
          ...base,
          merge: {
            requireAllChecks: true,
            unresolvedThreads,
            watchDeploy: true,
          },
        }).issues,
      ).toEqual([])
    }
    expect(
      checkConfig({
        ...base,
        merge: {
          requireAllChecks: "yes",
          unresolvedThreads: "people",
          watchDeploy: 1,
        },
      }).issues,
    ).toEqual([
      "merge.requireAllChecks must be true or false",
      "merge.unresolvedThreads must be `allow`, `bots`, or `all`",
      "merge.watchDeploy must be true or false",
    ])
  })

  it("takes how merge syncs and how long and how much the deploy watch reads", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    for (const sync of ["full", "remote"]) {
      expect(
        checkConfig({
          ...base,
          merge: { sync, deployTimeout: 40, deployLogLines: 120 },
        }).issues,
      ).toEqual([])
    }
    expect(
      checkConfig({
        ...base,
        merge: { sync: "local", deployTimeout: "40", deployLogLines: 0 },
      }).issues,
    ).toEqual([
      "merge.sync must be `full` or `remote`",
      "merge.deployTimeout must be a number greater than 0",
      "merge.deployLogLines must be a number greater than 0",
    ])
  })

  it("takes the blocking reviewers, the clean-tree gate, and the CI wait", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        merge: {
          blockingReviewers: ["github-advanced-security", "claude[bot]"],
          requireClean: true,
          ciTimeout: 45,
        },
      }).issues,
    ).toEqual([])
    expect(
      checkConfig({
        ...base,
        merge: {
          blockingReviewers: ["github advanced security"],
          requireClean: "yes",
          ciTimeout: 0,
        },
      }).issues,
    ).toEqual([
      "merge.blockingReviewers must list logins (`github-advanced-security`, `claude[bot]`)",
      "merge.requireClean must be true or false",
      "merge.ciTimeout must be a number greater than 0",
    ])
    expect(
      checkConfig({ ...base, merge: { blockingReviewers: "codeql" } }).issues,
    ).toEqual([expect.stringContaining("merge.blockingReviewers")])
  })
})

describe("ready section's CI settle rules", () => {
  it("takes the settle grace, requireChecks, and rollup checks", () => {
    const base = { version: 3, repo: { baseBranch: "main" } }
    expect(
      checkConfig({
        ...base,
        ready: {
          settleGrace: 20,
          requireChecks: true,
          rollupChecks: ["tests-passed"],
        },
      }).issues,
    ).toEqual([])
    expect(
      checkConfig({
        ...base,
        ready: { settleGrace: -1, requireChecks: 1, rollupChecks: "ci" },
      }).issues,
    ).toEqual([
      "ready.settleGrace must be a number greater than 0",
      "ready.requireChecks must be true or false",
      expect.stringContaining("ready.rollupChecks"),
    ])
  })
})

describe("evaluate section", () => {
  const base = { version: 3, repo: { baseBranch: "main" } }

  it("takes what stops, the rubric, the tests, and the fetch evaluate acts on", () => {
    for (const stopOn of ["rethink", "high"]) {
      expect(
        checkConfig({
          ...base,
          evaluate: {
            stopOn,
            instructions: ["docs/review.md", ".agent-flows/rubric.md"],
            tests: "bun run test {tests}",
            fetch: true,
          },
        }).issues,
      ).toEqual([])
    }
    expect(
      checkConfig({
        ...base,
        evaluate: {
          stopOn: "medium",
          instructions: "docs/review.md",
          tests: "bun run test",
          fetch: "yes",
        },
      }).issues,
    ).toEqual([
      "evaluate.stopOn must be `rethink` or `high`",
      expect.stringContaining("evaluate.instructions"),
      "evaluate.tests must name `{tests}`, the test files evaluate picks",
      "evaluate.fetch must be true or false",
    ])
  })

  it("takes only repo-relative rubric files", () => {
    for (const file of ["/etc/review.md", "../review.md", "docs/../../x.md"]) {
      expect(
        checkConfig({ ...base, evaluate: { instructions: [file] } }).issues,
      ).toEqual([
        `evaluate.instructions must list only repo-relative paths (not \`${file}\`)`,
      ])
    }
    expect(
      checkConfig({ ...base, evaluate: { instructions: ["..rc/review.md"] } })
        .issues,
    ).toEqual([])
  })
})

describe("instance names", () => {
  it("slugs anything into a valid name", () => {
    expect(toInstanceName("Apps/Web App")).toBe("apps-web-app")
    expect(toInstanceName("a:b")).toBe("a-b")
    expect(toInstanceName("///")).toBe("default")
  })

  it("falls back on collisions, then numbers", () => {
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "packages/web" },
        { preferred: "docs", fallback: "apps/docs" },
        { preferred: "x", fallback: "same" },
        { preferred: "x", fallback: "same" },
      ]),
    ).toEqual(["apps-web", "packages-web", "docs", "same", "same-2"])
    // A suffix never lands on a name that's already used.
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "apps-web" },
        { preferred: "apps-web-2", fallback: "x" },
      ]),
    ).toEqual(["apps-web", "apps-web-2", "apps-web-2-2"])
  })
})

/** A checkout made of `files`, every one tracked; JSON files given as objects. */
function checkout(files: Record<string, unknown>): DetectContext {
  const text = (file: string) => {
    const value = files[file]
    return typeof value === "string" || value === undefined
      ? value
      : JSON.stringify(value)
  }
  const tracked = Object.keys(files)
  const manifests = tracked.filter((f) => f.endsWith("package.json"))
  return {
    tracked,
    packageDirs: [
      "",
      ...manifests
        .filter((f) => f !== "package.json")
        .map((f) => f.slice(0, -"/package.json".length)),
    ],
    read: text,
    readJson: (file: string) =>
      files[file] === undefined ? undefined : JSON.parse(text(file) as string),
    dependsOn: (pattern: RegExp) =>
      manifests.flatMap((file) => {
        const manifest = files[file] as Record<string, object | undefined>
        return Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        })
          .filter((name) => pattern.test(name))
          .map((name) => `${file} depends on ${name}`)
      }),
  } as DetectContext
}

/** mxpt's scripts: one root package, bun, vitest. */
const MXPT_SCRIPTS = {
  "lint:fix": "biome check --write .",
  format: "biome format --write .",
  lint: "biome check .",
  tsc: "react-router typegen && tsc",
  typecheck: "react-router typegen && tsc",
  knip: "knip",
  test: "vitest run",
  validate:
    "bun run lint:fix && bun run tsc && bun run knip && bun run db:migrate:check",
  "db:migrate:check": "bun scripts/check-migrations.ts",
  "check-all": "bun run validate && bun run test",
}

describe("Python ready detection", () => {
  // The real context reads Python dependencies; the fake one, package.json only.
  const python = (files: Record<string, unknown>, deps: string[]) => ({
    ...checkout(files),
    dependsOn: (pattern: RegExp) =>
      deps.filter((line) => pattern.test(line.split(" ").at(-1) as string)),
  })

  it("proposes Black, Flake8, and pytest through uv from a uv project's dev dependencies", () => {
    expect(
      ready.detect?.(
        python({ "uv.lock": "", "pyproject.toml": "[project]\n" }, [
          "pyproject.toml depends on black",
          "pyproject.toml depends on flake8",
          "pyproject.toml depends on pytest",
          "pyproject.toml depends on django",
        ]),
      ),
    ).toEqual({
      values: {
        fix: ["uv run black {files:*.py}"],
        checks: ["uv run flake8 {files:*.py}"],
        tests: "uv run pytest {tests}",
      },
      evidence: [
        "pyproject.toml depends on black",
        "pyproject.toml depends on flake8",
        "pyproject.toml depends on pytest",
        "uv.lock is tracked, so the tools run through uv run",
        "the commands run on the changed Python files ({files:*.py}) and the tests the branch touches ({tests}); lint rules or directories CI selects (Flake8's --select) belong in them too",
      ],
    })
  })

  it("prefers Ruff, found from its config, and runs tools directly without a lockfile", () => {
    expect(
      detectPythonReady(
        python({ "requirements-dev.txt": "", "ruff.toml": "" }, [
          "requirements-dev.txt depends on pytest",
          "requirements-dev.txt depends on black",
        ]),
      )?.values,
    ).toEqual({
      fix: ["ruff format {files:*.py}", "ruff check --fix {files:*.py}"],
      checks: ["ruff check {files:*.py}"],
      tests: "pytest {tests}",
    })
  })

  it("proposes nothing without Python dependencies, or without tools it knows", () => {
    expect(detectPythonReady(checkout({ "README.md": "" }))).toBeUndefined()
    expect(
      detectPythonReady(
        checkout({
          "pyproject.toml": '[project]\ndependencies = ["django"]\n',
        }),
      ),
    ).toBeUndefined()
  })
})

describe("ready detection", () => {
  it("proposes the validate script, its fix first, and the tests a branch changed", () => {
    // check-all runs the whole suite on top of validate, so it's no candidate.
    expect(
      ready.detect?.(
        checkout({
          "bun.lock": "",
          "package.json": {
            scripts: MXPT_SCRIPTS,
            devDependencies: { vitest: "4" },
          },
        }),
      ),
    ).toEqual({
      values: {
        fix: ["bun run lint:fix"],
        checks: ["bun run validate", "bunx vitest run --changed {base}"],
      },
      evidence: [
        "package.json has a validate script (lint:fix, tsc, knip, db:migrate:check); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
        "package.json depends on vitest, and validate runs no tests: ready runs the ones changed since the merge base",
      ],
    })
  })

  // A shared stack package can bring the runner in: the root's own
  // dependencies don't name it, its test scripts and config files do.
  const { test: _test, ...UNTESTED_SCRIPTS } = MXPT_SCRIPTS
  const changedTests = (files: Record<string, unknown>) => {
    const detection = ready.detect?.(checkout({ "bun.lock": "", ...files }))
    return {
      checks: detection?.values.checks,
      evidence: detection?.evidence.at(-1),
    }
  }

  it("finds the runner from the root's test script", () => {
    expect(changedTests({ "package.json": { scripts: MXPT_SCRIPTS } })).toEqual(
      {
        checks: ["bun run validate", "bunx vitest run --changed {base}"],
        evidence:
          "package.json's test script runs vitest, and validate runs no tests: ready runs the ones changed since the merge base",
      },
    )
  })

  it("finds the runner through the scripts a test script calls", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: {
            ...UNTESTED_SCRIPTS,
            test: "bun run test:unit",
            "test:unit": "jest",
          },
        },
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx jest --changedSince={base}"],
      evidence:
        "package.json's test script runs jest, and validate runs no tests: ready runs the ones changed since the merge base",
    })
  })

  it("finds the runner from a tracked config file", () => {
    expect(
      changedTests({
        "package.json": { scripts: UNTESTED_SCRIPTS },
        "vitest.config.ts": "",
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx vitest run --changed {base}"],
      evidence:
        "vitest.config.ts is tracked, and validate runs no tests: ready runs the ones changed since the merge base",
    })
    expect(
      changedTests({
        "package.json": { scripts: UNTESTED_SCRIPTS, jest: {} },
      }).checks,
    ).toEqual(["bun run validate", "bunx jest --changedSince={base}"])
  })

  it("takes the root's dependency over a config file for another runner", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: UNTESTED_SCRIPTS,
          devDependencies: { jest: "30" },
        },
        "vitest.config.ts": "",
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx jest --changedSince={base}"],
      evidence:
        "package.json depends on jest, and validate runs no tests: ready runs the ones changed since the merge base",
    })
  })

  it("guesses no runner when the test script runs both", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: { ...UNTESTED_SCRIPTS, test: "vitest run && jest" },
        },
      }),
    ).toEqual({
      checks: ["bun run validate"],
      evidence:
        "package.json's test script runs vitest and jest, and validate runs no tests: ask which runner's changed tests ready runs, since detection can't tell",
    })
  })

  it("adds no changed tests without a runner, or when the check runs the tests", () => {
    expect(
      changedTests({ "package.json": { scripts: UNTESTED_SCRIPTS } }).checks,
    ).toEqual(["bun run validate"])
    const { validate: _validate, ...scripts } = MXPT_SCRIPTS
    expect(
      changedTests({
        "package.json": { scripts, devDependencies: { vitest: "4" } },
        "vitest.config.ts": "",
      }).checks,
    ).toEqual(["bun run check-all"])
  })

  it("takes a check that runs the tests as it is, with every fix script", () => {
    expect(
      ready.detect?.(
        checkout({
          "package.json": {
            scripts: {
              "lint:fix": "eslint --fix .",
              format: "prettier --write .",
              ci: "npm run lint && jest",
            },
            devDependencies: { jest: "30" },
          },
        }),
      )?.values,
    ).toEqual({
      fix: ["npm run lint:fix", "npm run format"],
      checks: ["npm run ci"],
    })
  })

  it("runs jest's changed tests through the runner, and reads run-s and npm-run-all", () => {
    expect(
      ready.detect?.(
        checkout({
          "pnpm-lock.yaml": "",
          "package.json": {
            scripts: {
              lint: "eslint .",
              "lint:types": "tsc",
              verify: "run-s 'lint:*'",
            },
            devDependencies: { jest: "30" },
          },
        }),
      ),
    ).toEqual({
      values: {
        checks: ["pnpm run verify", "pnpm exec jest --changedSince={base}"],
      },
      evidence: [
        "package.json has a verify script (lint:types); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
        "package.json depends on jest, and verify runs no tests: ready runs the ones changed since the merge base",
      ],
    })
  })

  it.each([
    ["deploys", "bun run lint && vercel deploy --prebuilt"],
    ["migrates", "bun run lint && prisma migrate deploy"],
    ["calls a script that migrates", "bun run lint && bun run db:migrate"],
  ])("proposes nothing when the check %s", (_why, validate) => {
    expect(
      detectReady(
        checkout({
          "package.json": {
            scripts: {
              lint: "biome check .",
              "db:migrate": "prisma migrate dev",
              validate,
            },
          },
        }),
      ),
    ).toBeUndefined()
  })

  it("lets a migration check that only reads through", () => {
    expect(
      ready.detect?.(
        checkout({
          "package.json": {
            scripts: { validate: "tsc && prisma migrate diff --exit-code" },
          },
        }),
      )?.values,
    ).toEqual({ checks: ["npm run validate"] })
  })

  it("passes over an unsafe check for a safe one, and says why", () => {
    const detection = ready.detect?.(
      checkout({
        "package.json": {
          scripts: {
            validate: "tsc && vercel deploy",
            ci: "tsc && eslint .",
          },
        },
      }),
    )
    expect(detection?.values).toEqual({ checks: ["npm run ci"] })
    expect(detection?.evidence).toContain(
      "package.json's validate script runs `vercel deploy`, so ready can't run it",
    )
  })

  it("names the other candidates, so configure asks", () => {
    const detection = ready.detect?.(
      checkout({
        "package.json": {
          scripts: { validate: "tsc && eslint .", ci: "tsc && next build" },
        },
      }),
    )
    expect(detection?.values).toEqual({ checks: ["npm run validate"] })
    expect(detection?.evidence.at(-1)).toBe(
      "package.json also has a ci script (tsc, next build); ask which one ready runs",
    )
  })

  it("proposes nothing without a root script that runs the whole check", () => {
    // One tool isn't the whole check, and a package's own scripts are what
    // ready runs per touched package anyway.
    expect(
      detectReady(
        checkout({
          "package.json": {
            scripts: { check: "biome check .", lint: "biome check" },
          },
        }),
      ),
    ).toBeUndefined()
    expect(
      detectReady(
        checkout({
          "package.json": { scripts: { dev: "turbo dev" } },
          "apps/web/package.json": {
            scripts: {
              validate: "tsc && eslint .",
              "lint:fix": "eslint --fix",
            },
          },
          "apps/api/package.json": {
            scripts: { validate: "tsc && vitest run" },
          },
        }),
      ),
    ).toBeUndefined()
  })

  it("reads a monorepo's root check through the packages it filters", () => {
    expect(
      detectReady(
        checkout({
          "bun.lock": "",
          "package.json": {
            scripts: {
              "lint:fix": "biome check --write",
              validate: "bun run lint && bun run --filter @acme/web validate",
            },
          },
          "apps/web/package.json": {
            name: "@acme/web",
            scripts: { validate: "tsc && vitest run" },
          },
          "apps/api/package.json": {
            name: "@acme/api",
            scripts: { validate: "tsc && prisma migrate deploy" },
          },
        }),
      )?.detection,
    ).toEqual({
      values: { fix: ["bun run lint:fix"], checks: ["bun run validate"] },
      evidence: [
        "package.json has a validate script (bun run lint, validate in apps/web); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
      ],
    })
  })
})

/** ai-assistant's TASK_PRIORITIZATION.md, cut down to its rank table. */
const PRIORITIZATION = `# Task Prioritization

## Priorities

| Ours | Meaning | Deadline | Linear priority |
|---|---|---|---|
| Urgent | Drop everything and work on it now. | None. It is being worked on right now. | Urgent (1) |
| P0 | Highest planned priority. | Required. Every P0 has a date. | High (2) |
| P1 | Normal priority work. | Optional | Medium (3) |
| P2 | Background work. | Optional | Low (4) |
| Audit | Ongoing work with no finish line. | None | No priority (0) |

## Order of work

| Work | Shape in Linear |
|---|---|
| A piece of work | One task |
`

describe("ticket ranks", () => {
  it("reads the team's rank names off a prioritization doc's table", () => {
    expect(ranksFromDoc(PRIORITIZATION)).toEqual([
      "Urgent",
      "P0",
      "P1",
      "P2",
      "Audit",
    ])
    // Rows in any order, Jira's names, and markdown in the cells.
    expect(
      ranksFromDoc(`| Rank | Jira |
|:--|:--|
| **Sev 2** | High |
| **Sev 1** | Highest |
| Sev 3 | Medium |
| Sev 5 | Lowest |
| Sev 4 | \`Low\` |`),
    ).toEqual(["Sev 1", "Sev 2", "Sev 3", "Sev 4", "Sev 5"])
  })

  it("reads nothing from a table that doesn't map every priority once", () => {
    expect(ranksFromDoc("| Ours | Linear |\n|---|---|\n| P0 | High |")).toBe(
      undefined,
    )
    expect(
      ranksFromDoc(
        "| A | Linear |\n|---|---|\n| a | High |\n| b | High |\n| c | Medium |\n| d | Low |\n| e | None |",
      ),
    ).toBe(undefined)
    expect(ranksFromDoc("No tables here.")).toBe(undefined)
  })

  it("detects the ranks from a tracked prioritization doc", () => {
    expect(
      tickets.detect?.(checkout({ "TASK_PRIORITIZATION.md": PRIORITIZATION })),
    ).toEqual({
      values: { ranks: ["Urgent", "P0", "P1", "P2", "Audit"] },
      evidence: [
        "TASK_PRIORITIZATION.md ranks work as Urgent, P0, P1, P2, Audit, mapped to the tracker's urgent, high, medium, low, none",
      ],
    })
    expect(tickets.detect?.(checkout({ "notes.md": PRIORITIZATION }))).toBe(
      undefined,
    )
    // The tracker's own names are the defaults: nothing to configure.
    const plain =
      "| Ours | Linear |\n|---|---|\n| Urgent | Urgent |\n| High | High |\n| Medium | Medium |\n| Low | Low |\n| No priority | No priority |"
    expect(tickets.detect?.(checkout({ "docs/priorities.md": plain }))).toBe(
      undefined,
    )
  })

  it("takes one distinct name per priority, a priority's own name only in its place", () => {
    expect(ranksProblem(["Urgent", "P0", "P1", "P2", "Audit"])).toBe(undefined)
    expect(ranksProblem(["P0", "P1", "P2", "P3"])).toBe(
      "must name 5 ranks, one each for urgent, high, medium, low, none (got 4)",
    )
    expect(ranksProblem(["P0", "p0", "P1", "P2", "P3"])).toBe(
      "names `p0` twice",
    )
    expect(ranksProblem(["High", "P0", "P1", "P2", "P3"])).toBe(
      "names the `urgent` rank `High`, another priority's name",
    )
    expect(
      checkConfig({
        version: 2,
        repo: { baseBranch: "main" },
        tickets: { ranks: ["P0", "P1"] },
      }).issues,
    ).toEqual([
      "tickets.ranks must name 5 ranks, one each for urgent, high, medium, low, none (got 2)",
    ])
  })
})
