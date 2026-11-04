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

export const evaluate: SectionSpec = {
  path: "evaluate",
  name: "Evaluate",
  purpose:
    "Whether evaluate records its verdict for merge to gate on, how much of a branch it reviews again, who judges, and the repo's own scan of the diff",
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
        "`full` (the default): review the whole branch every time. `delta`: with a recorded verdict, review only the files whose change moved since it, keeping the worse of the old and new verdicts and both sets of findings; when none moved (only the base was merged in), carry the verdict to the new head without a review",
      example: "delta",
      pattern: SCOPE,
    },
    {
      key: "reviewer",
      description:
        "Who judges: `session` (the default), the session that runs evaluate, or `subagent`, a fresh subagent given only the gathered diff, the scope, and the scan's findings, never the conversation that wrote the code. When the subagent can't run, evaluate says so and records nothing",
      example: "subagent",
      pattern: REVIEWER,
    },
    hookField("evaluate.scan"),
  ],
  lookup:
    "Leave it out for evaluate's read-only review, a recommendation only. Set `record` when merge should gate on a verdict (with `merge.requireEvaluation`), `scope` to `delta` when branches are reviewed several times and a review of what moved is enough, `reviewer` to `subagent` when the session that wrote the code shouldn't grade it, and `scan` for a script the repo already runs over a diff against its own rules",
}
