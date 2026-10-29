import { hookField } from "../hooks.ts"
import {
  binCommand,
  commandsOf,
  packageScripts,
  resolveScript,
  runnerFor,
  runsTests,
  type ScriptStep,
  scriptCommand,
  testRunners,
  unsafeCommand,
} from "../scripts.ts"
import type { DetectContext, Detection, SectionSpec } from "../types.ts"

/** Root scripts that run the whole check, most likely first. */
const AGGREGATE_NAMES = [
  "validate",
  "check",
  "checks",
  "check-all",
  "check:all",
  "verify",
  "ci",
  "ci:check",
]

/** Root scripts that fix the tree in place, in the order they run. */
const FIX_NAMES = ["lint:fix", "fix", "format", "format:write", "format:fix"]

/** Runners that pick the tests a change touches, and how. */
const CHANGED_TESTS: Record<string, string> = {
  vitest: "vitest run --changed {base}",
  jest: "jest --changedSince={base}",
}

/** Root files that configure a runner, so the repo uses it. */
const RUNNER_CONFIGS: [RegExp, string][] = [
  [/^vitest\.config\.(?:ts|mts|js|mjs|cjs)$/, "vitest"],
  [/^vitest\.workspace\.\w+$/, "vitest"],
  [/^jest\.config\.(?:ts|js|mjs|cjs|json)$/, "jest"],
]

/** Each runner once, in the order found, leaving out those without changed tests. */
function known<T extends { runner: string }>(found: T[]): T[] {
  const runners = new Set<string>()
  return found.filter(
    ({ runner }) =>
      runner in CHANGED_TESTS && !runners.has(runner) && runners.add(runner),
  )
}

/**
 * The runners whose changed-tests command fits the root, and the evidence
 * that names them. A shared toolchain package (a stack preset) can bring the
 * runner in without the root depending on it, so after the root's own
 * dependencies come its test scripts, then a tracked runner config. The
 * first source that names one decides; more than one is for the user.
 */
export function changedTestsRunners(
  ctx: DetectContext,
  scripts: Record<string, string>,
): { runners: string[]; source: string } | undefined {
  const deps = known(
    ctx
      .dependsOn(/^(?:vitest|jest)$/)
      .filter((line) => line.startsWith("package.json "))
      .map((line) => ({ runner: line.split(" ").at(-1) as string })),
  ).map((d) => d.runner)
  if (deps.length > 0) {
    return {
      runners: deps,
      source: `package.json depends on ${deps.join(" and ")}`,
    }
  }

  const testScripts = Object.keys(scripts)
    .filter((name) => /^test(?::|$)/.test(name))
    .sort((a, b) => Number(b === "test") - Number(a === "test"))
  const run = known(
    testScripts.flatMap((name) =>
      testRunners(resolveScript(ctx, "", scripts[name] as string)).map(
        (runner) => ({ runner, name }),
      ),
    ),
  )
  if (run.length > 0) {
    const names = [...new Set(run.map((r) => r.name))]
    const runners = run.map((r) => r.runner).join(" and ")
    return {
      runners: run.map((r) => r.runner),
      source:
        names.length === 1
          ? `package.json's ${names[0]} script runs ${runners}`
          : `package.json's ${names.join(" and ")} scripts run ${runners}`,
    }
  }

  const configs = ctx.tracked.flatMap((file) =>
    RUNNER_CONFIGS.filter(([pattern]) => pattern.test(file)).map(
      ([, runner]) => ({ runner, source: `${file} is tracked` }),
    ),
  )
  if (ctx.readJson("package.json")?.jest !== undefined) {
    configs.push({ runner: "jest", source: "package.json has a jest key" })
  }
  const configured = known(configs)
  if (configured.length > 0) {
    return {
      runners: configured.map((c) => c.runner),
      source: configured.map((c) => c.source).join(" and "),
    }
  }
  return undefined
}

/** A script chains others (or other commands): the whole check, not one tool. */
function chains(body: string, steps: ScriptStep[]): boolean {
  return (
    steps.length > 1 ||
    /^\s*(?:\w+=\S+\s+)*(?:run-[sp]|npm-run-all2?|concurrently|turbo)\b/.test(
      body,
    )
  )
}

/** What a step runs, as evidence says it: the script's name, else the command. */
function label(step: ScriptStep): string {
  return step.calls.length > 0
    ? step.calls
        .map((c) => (c.dir ? `${c.name} in ${c.dir}` : c.name))
        .join(", ")
    : step.command
}

type Candidate = { name: string; steps: ScriptStep[]; tests: boolean }

/**
 * The `fix` and `checks` ready should run, from a root script that runs the
 * whole check (`validate`), plus every command those checks run, so hook
 * suggestions don't offer one twice. Only the root's: in a monorepo without
 * one, ready's per-package scripts fit better than a pinned root command.
 */
export function detectReady(
  ctx: DetectContext,
): { detection: Detection; runs: string[] } | undefined {
  const scripts = packageScripts(ctx, "")
  const runner = runnerFor(ctx, "")
  const evidence: string[] = []
  const candidates: Candidate[] = []
  for (const name of AGGREGATE_NAMES) {
    const body = scripts[name]
    if (body === undefined) {
      continue
    }
    const steps = resolveScript(ctx, "", body)
    if (!chains(body, steps)) {
      continue
    }
    const unsafe = unsafeCommand(steps)
    if (unsafe) {
      evidence.push(
        `package.json's ${name} script runs \`${unsafe}\`, so ready can't run it`,
      )
      continue
    }
    candidates.push({ name, steps, tests: runsTests(steps) })
  }
  // Ready runs only the tests a branch touches; CI runs the whole suite.
  const untested = candidates.filter((c) => !c.tests)
  const [chosen, ...others] = untested.length > 0 ? untested : candidates
  if (!chosen) {
    return undefined
  }
  evidence.unshift(
    `package.json has a ${chosen.name} script (${chosen.steps.map(label).join(", ")}); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service`,
  )
  for (const other of others) {
    evidence.push(
      `package.json also has a ${other.name} script (${other.steps.map(label).join(", ")}); ask which one ready runs`,
    )
  }

  // The fixes the check runs, else the repo's: either way they run first, so
  // no check reads files still being rewritten.
  const called = new Set(
    chosen.steps.flatMap((s) =>
      s.calls.filter((c) => c.dir === "").map((c) => c.name),
    ),
  )
  const calledFixes = FIX_NAMES.filter((name) => called.has(name))
  const fix = (calledFixes.length > 0 ? calledFixes : FIX_NAMES)
    .filter((name) => {
      const body = scripts[name]
      return body !== undefined && !unsafeCommand(resolveScript(ctx, "", body))
    })
    .map((name) => scriptCommand(runner, "", name))

  const checks = [scriptCommand(runner, "", chosen.name)]
  const found = chosen.tests ? undefined : changedTestsRunners(ctx, scripts)
  if (found?.runners.length === 1) {
    checks.push(binCommand(runner, CHANGED_TESTS[found.runners[0] as string]))
    evidence.push(
      `${found.source}, and ${chosen.name} runs no tests: ready runs the ones changed since the merge base`,
    )
  } else if (found) {
    evidence.push(
      `${found.source}, and ${chosen.name} runs no tests: ask which runner's changed tests ready runs, since detection can't tell`,
    )
  }
  return {
    detection: {
      values: fix.length > 0 ? { fix, checks } : { checks },
      evidence,
    },
    runs: [
      ...checks,
      ...commandsOf(chosen.steps),
      ...chosen.steps.flatMap((s) =>
        s.calls.map((c) => scriptCommand(runnerFor(ctx, c.dir), c.dir, c.name)),
      ),
    ],
  }
}

export const ready: SectionSpec = {
  path: "ready",
  name: "Ready checks",
  purpose:
    "The commands ready runs before it publishes a branch (unset, it runs the scripts of each package the branch touches), the steps it skips, the CI checks it ignores, and the repo's own hooks at its steps",
  fields: [
    {
      key: "fix",
      type: "string[]",
      description:
        "Commands that fix the tree in place (formatters, lint autofixes, code generators), run in order from the repo root before the checks. `{base}` is the branch's merge base",
      example: ["bun run lint:fix"],
    },
    {
      key: "checks",
      type: "string[]",
      description:
        "Commands that verify the branch (lint, type checks, the tests it touches, a build), run in order from the repo root; none of them may deploy, publish, migrate, or write to a shared service. `{base}` is the branch's merge base",
      example: ["bun run validate"],
    },
    {
      key: "skip",
      type: "string[]",
      description:
        "Steps ready skips on every run: `cleanup` (what must change with the branch), `tests` (writing tests for new behavior), `fix` and `checks` (the local fix and check commands, before the first push and before every CI fix push), `local` (all four), `ci` (waiting on CI and fixing it), `reviews` (automated reviewers' threads), `all` (every step: ready only commits, publishes, and syncs). A run's `--skip` adds to these",
      example: ["tests"],
    },
    {
      key: "ignoreChecks",
      type: "string[]",
      description:
        "CI check names ready neither waits on nor fixes, such as preview deploys or optional coverage. `*` matches any run of characters, case aside. A run's `--ignore-check` adds to these",
      example: ["Vercel*", "codecov/*"],
    },
    hookField("ready.before"),
    hookField("ready.beforePublish"),
    hookField("ready.after"),
  ],
  detect: (ctx) => detectReady(ctx)?.detection,
  lookup:
    "Leave it out to run each touched package's own scripts and every step, and to wait on every CI check. Set `fix` and `checks` when the repo has one command for the whole check (`bun run validate`), or its own script that picks the checks a branch needs; detection proposes them from a root `validate`, `check`, `verify`, or `ci` script that chains others and runs nothing unsafe, its fix scripts, and, when that script runs no tests, the changed-tests command of the runner the root depends on, its test script runs, or a tracked runner config (`vitest.config.ts`) sets up, since `checks` replaces ready's own related-tests step; `skip` and `ignoreChecks` when the team never wants a step, or a check is slow or optional (a preview deploy); `before` for a check CI runs that ready would otherwise find only after pushing (a version bump), or a rule that applies only when certain paths change; `beforePublish` and `after` for the repo's own steps at those points",
}
