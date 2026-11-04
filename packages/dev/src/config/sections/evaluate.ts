import { hookField } from "../hooks.ts"
import type { FieldPattern, SectionSpec } from "../types.ts"

const SCOPE: FieldPattern = {
  regex: /^(full|delta)$/,
  hint: "`full` or `delta`",
}

const REVIEWER: FieldPattern = {
  regex: /^(session|subagent)$/,
  hint: "`session` or `subagent`",
}

const STOP_ON: FieldPattern = {
  regex: /^(rethink|high)$/,
  hint: "`rethink` or `high`",
}

/** A repo-relative file: no leading `/`, no `..` segment. */
const REPO_FILE: FieldPattern = {
  regex: /^(?!\/)(?!(.*\/)?\.\.(\/|$)).+$/,
  hint: "repo-relative paths",
}

export const evaluate: SectionSpec = {
  path: "evaluate",
  name: "Evaluate",
  purpose:
    "Whether evaluate records its verdict for merge to gate on, how much of a branch it reviews again, who judges and by which of the repo's rules, what it runs first (a fetch, the repo's scan, the tests), and what stops a merge",
  fields: [
    {
      key: "record",
      type: "boolean",
      description:
        "Record each evaluation of the current branch's committed, pushed head: its verdict (`pass` for Ship, `flag` for Address first, `stop` for Rethink), its findings, and each file's change, in the repo's git common dir (default false). A dirty tree or an unpushed head isn't recorded; the review is still given. `merge.requireEvaluation` gates on it",
      example: true,
    },
    {
      key: "scope",
      description:
        "`full` (the default): review the whole branch every time. `delta`: with a recorded verdict, review only the files whose change moved since it; the record keeps the previous findings anchored in files it didn't review again, and its verdict is the new one, made worse only by those. When none moved (only the base was merged in), carry the verdict to the new head without a review. A recorded `stop`, or `evaluate full`, reviews everything again",
      example: "delta",
      pattern: SCOPE,
    },
    {
      key: "reviewer",
      description:
        "Who judges: `session` (the default), the session that runs evaluate, or `subagent`, a fresh subagent given only the gathered diff, the scope, the issue, the tests' result, and the scan's findings, never the conversation that wrote the code. When the subagent fails twice, evaluate says so, gives no verdict, and records nothing",
      example: "subagent",
      pattern: REVIEWER,
    },
    {
      key: "stopOn",
      description:
        "What records `stop`, the verdict merge never lets through: `rethink` (the default), only a Rethink; `high`, also any confirmed HIGH risk, or a confirmed scan finding whose first word is `STOP` (otherwise those record `flag`, which merge lets you accept)",
      example: "high",
      pattern: STOP_ON,
    },
    {
      key: "instructions",
      type: "string[]",
      description:
        "Repo-relative files holding the repo's own review rules (a rubric, a checklist), pasted verbatim into the judging prompt, the subagent's too, as an extra lens: they add what to look for and how to grade it, and never change the report's format or the verdict rules",
      example: [".agent-flows/review.md"],
      pattern: REPO_FILE,
    },
    {
      key: "tests",
      description:
        "Command that runs the tests relevant to the change before the judging, from the repo root; `{tests}` is the test files evaluate picks (shell-quoted), and with none it doesn't run. `{base}` and `{files}` as for `ready.fix`. Its output goes to a log in the git dir; the judge gets whether it passed and the log's path, and a failure is a finding, never the verdict by itself. Like a scan, it may write only the caches and build output a test runner keeps",
      example: "bun run test {tests}",
      check: (value) =>
        typeof value === "string" && value.includes("{tests}")
          ? undefined
          : "must name `{tests}`, the test files evaluate picks",
    },
    {
      key: "fetch",
      type: "boolean",
      description:
        "Fetch `origin/<base>` before diffing against it (default false: the remote-tracking ref as it is, with no network call)",
      example: true,
    },
    hookField("evaluate.scan"),
  ],
  lookup:
    "Leave it out for evaluate's read-only review, a recommendation only. Set `record` when merge should gate on a verdict (with `merge.requireEvaluation`), `scope` to `delta` when branches are reviewed several times and a review of what moved is enough, `reviewer` to `subagent` when the session that wrote the code shouldn't grade it, `stopOn` to `high` when no HIGH risk should merge without the work changing, `instructions` for a review rubric the repo already keeps, `tests` for the command that runs the tests a change touches (often the same as `ready.tests`), `fetch` when the local copy of the base is often stale, and `scan` for a script the repo already runs over a diff against its own rules",
}
