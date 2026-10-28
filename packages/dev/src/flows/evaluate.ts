import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  STACK_PARENT,
  USE_INTEGRATIONS,
} from "./kit.ts"

// What the gather subagent is told. It collects, the main model judges, so the
// file-read round-trips run against a small context.
const GATHER_PROMPT = `You are a data-gathering assistant for a branch/PR evaluation. Collect the diff, file contents, and project context listed below. Run the commands, read the files, and return all results in the structured format at the end. Do not analyze, summarize, or editorialize. Just collect and return.

**Target:** \`<target>\` (either \`pr:<entry>:<N>\` or \`worktree:<branch>\`)
**Base:** branch \`<base>\`, compared against ref \`<base-ref>\`
**PR metadata from caller (if any):** \`<the PR metadata from the identify-target step>\`
**Source-control ops (\`pr:\` targets only):** the target entry's \`values\` and, for each op, the one way to run it the caller chose, pasted below as JSON. Each says how this repository's host does the job: run it as given, with \`<N>\` filled in (and any condition it states, like a self-managed \`host\`, applied from \`values\`). Never print a token an op reads from the environment.

#### What to collect

**For \`pr:<entry>:<N>\`:**
1. **PR metadata** (skip if the caller already pasted these fields): the \`prMetadata\` op.
2. The \`prDiff\` op (full unified diff)
3. The \`prFiles\` op (file list)
4. The \`prCommits\` op (commit subjects)
5. For each file in the file list, read the **full current file** (post-change state). Note deleted files as deleted, skip binary files and note them, and read only the first 5000 lines of longer files, noting the truncation.

**For \`worktree:<branch>\`** (everything in the working tree: commits ahead of the base plus uncommitted and untracked changes):
1. \`BASE=$(git merge-base <base-ref> HEAD)\`. All diffs below are against this merge base, so upstream movement on the base doesn't pollute the diff.
2. \`git diff "$BASE"\` (committed + staged + unstaged changes in one view)
3. File list: \`git diff "$BASE" --name-only\`, plus untracked files from \`git ls-files --others --exclude-standard\`, each marked \`(untracked)\`.
4. \`git diff "$BASE" --shortstat\` (the counts for the report header; pasted PR metadata describes only what the source-control host has seen)
5. \`git log --oneline <base-ref>..HEAD\` (commit subjects; may be empty)
6. \`git status --porcelain\`
7. For each file in the combined list (including untracked files), read the full current file with the same rules as above. Untracked files aren't in the diff; their full content is their entire addition.

**Always also read** the agent instructions for the changed files: write every changed path (one per line) to a file in \`$(git rev-parse --absolute-git-dir)/agent-flows/evaluate\`, then run \`{{command:ready}} instructions --files <that file>\`. It lists the \`CLAUDE.md\` and \`AGENTS.md\` files at the root and above each changed file, and the path-scoped rule files (\`.claude/rules/\`, \`.cursor/rules/\`) whose globs match one. Read each it lists except the root's \`CLAUDE.md\` and \`AGENTS.md\`, which are already in the caller's context.

**Always also surface reuse candidates:** for the handful of substantive new functions, helpers, components, hooks, services, or routes the diff introduces (skip one-liners, type-only changes, and tests), search the repo for an existing implementation of the same concept: grep by likely name, signature, or a distinctive string, and check the usual shared homes (\`lib/\`, \`utils/\`, \`shared/\`, shared workspace packages). Record the closest existing abstraction (path and symbol) or "no existing match found". Keep it bounded to the main additions, and don't editorialize.

#### Return format

Return your results using exactly these section headers:

\`\`\`
=== PR METADATA ===
<number, url, title, body, state, draft, base and head branches, additions, deletions, changed files; or "worktree diff, no PR">

=== DIFF STATS ===
<worktree targets: the --shortstat output plus "untracked: M file(s)"; omit for pr targets>

=== FILE LIST ===
<one path per line; untracked files suffixed " (untracked)">

=== COMMIT SUBJECTS ===
<one per line; "none (nothing committed yet)" if empty>

=== GIT STATUS ===
<git status --porcelain output; omit for pr targets>

=== DIFF ===
<full unified diff, unmodified>

=== CHANGED FILE CONTENTS ===
--- <path> ---
<full file content>
...

=== AGENT INSTRUCTIONS (<directory>) ===
<one section per instruction or rule file read: each CLAUDE.md / AGENTS.md below the root, and each matching rule file; omit if none>

=== REUSE CANDIDATES ===
<"<new thing> (<path>) -> <existing path:symbol>" or "... -> no existing match found"; omit if no substantive new abstractions>

=== GATHER NOTES ===
<unreadable, binary, or truncated files; "Includes N uncommitted file(s) and M untracked file(s)" when nonzero; "Large diff: N lines across M files" past 1000 lines or 30 files>
\`\`\`

Do not add commentary, analysis, or suggestions. Return only the collected data in the format above.`

export const evaluateFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "evaluate",
  title: "{{cmd}}evaluate",
  frontmatter: {
    description:
      "Assess branch or PR shippability without edits. Use for readiness and risk assessment, not an audit/fix loop.",
    argumentHint: "[PR number or URL | help]",
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    ready: {
      description:
        "`instructions --files <file>` lists the agent instruction and path-scoped rule files for the changed paths in the file",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // The help dispatcher stays inline; the `run` phase (identify-target
    // through the report) lazy-loads only when a real evaluation begins.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "run/identify-target",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Read the current branch (or a given PR) and assess shippability risks. Read-only.",
    help: "Show usage and exit without evaluating.",
  },
  intro: `Read the diff and tell the user two things, in this order:

1. **What it does**, in plain English. Not a file list, not a section-by-section walkthrough, not a copy-paste of the PR body. A distillation: the change, the why, the surface it touches.
2. **Risks**, prioritized. Things that could break in production, on deploy, for existing users, or for the team's ability to roll back. Not style, not layer rules, not convention violations (those live in the user's head and in CI). This is a shippability lens.

The skill is read-only. It never writes to source control, the issue tracker, error tracking, or the working tree. It is safe to invoke at any point in a branch's life. With no argument it evaluates **everything in the working tree**: commits ahead of the base branch, uncommitted (staged and unstaged) changes, and untracked files. A PR, if one exists for the branch, supplies title/body context but never narrows the diff. With an explicit PR number or URL (including post-merge), it evaluates that PR's diff.`,
  invariants: [hooksInvariant("evaluate")],
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If the argument is \`help\`, print the block below verbatim and exit. No reads.

> \`{{cmd}}evaluate\` reads a diff and reports (1) what it does in plain English and (2) prioritized shippability risks.
>
> Targets:
>   - no argument -> everything on the current branch: commits ahead of the base branch + uncommitted changes + untracked files. A PR, if one exists, supplies title/body context only.
>   - PR number (e.g. \`1234\`) or URL -> that PR's diff, for a PR of this checkout's repository
>
> What it never does: write to source control or any other service, modify files, run code, or push. Read-only.
>
> Risk lens: migration safety, blast radius, customer impact, cross-package sync, rollback difficulty, monitoring gaps, edge cases, code duplication/reuse, and necessary refactors. Style and layer-rule audits live in CI and in the reviewer's head; this skill skips them on purpose.`,
          next: null,
        },
      ],
    },
    {
      id: "run",
      title: "Run",
      stepStyle: "headers",
      steps: [
        {
          id: "identify-target",
          kind: "action",
          title: "Identify target",
          refName: "identify-target",
          commandCalls: ["configure"],
          body: `Pure reads.

1. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG} Then pick the ref to diff against: \`<base-ref>\` is \`origin/<base>\` when \`git rev-parse --verify --quiet refs/remotes/origin/<base>\` succeeds, else \`<base>\`. Comparing against the remote-tracking ref keeps a stale local base branch from counting already-merged work as this branch's. Don't fetch; use the refs as they are.
2. **Source control:** \`{{command:configure}} integrations sourceControl stacking --optional\` prints \`{"integrations": {"sourceControl": [...], "stacking": [...]}}\`: every source-control entry the repo configured (often one, possibly several, possibly none), and the stacking entry, if any (the first). ${USE_INTEGRATIONS} An entry's id is its \`integration\`, plus \`:<instance>\` when it has one.

   This checkout can only evaluate PRs of its own repository, since the file contents come from it. So keep the **local entries**: those whose repository (from their \`values\`) is one of this checkout's remotes in \`git remote -v\`. Counting every remote, not just \`origin\`, keeps fork workflows working, where the PR lives in \`upstream\`. None configured, or none local, means there's no PR context for the working tree.
3. **Argument provided?** If the argument is a bare number or a pull (or merge) request URL, it's an explicit PR target:
   - A URL belongs to the entry whose \`prRef\` it matches. A bare number belongs to the local entry; with several local entries, ask the user which. With entries configured but none local, stop: \`No configured source-control repository is a remote of this checkout. Run {{cmd}}configure sourceControl, or run this command from a checkout of a configured repository.\`
   - If that entry isn't local, stop: \`That PR is in <entry>'s repository, not this checkout. Check out that repository and re-run.\`
   - If there's no entry at all (none configured, or the URL matches none), stop: tell the user to run \`{{cmd}}configure sourceControl\`, then re-run this command.
   - Otherwise skip to the {{step-ref:run/gather-diff}} step with \`target = pr:<entry>:<N>\`.
4. **Current branch:** \`git branch --show-current\`. If it is the base, abort: \`Refusing to evaluate from <base>. Check out the feature branch, or pass an explicit PR number.\`
5. **PR for current branch (context only):** run each local entry's \`currentPr\` op and stop at the first open PR. If none finds one (or there are no local entries), there is no PR; continue. A PR found here supplies title/body/state context for the report; it does **not** become the diff source, because the working tree may contain work the PR hasn't seen.
6. **Parent:** a stacked branch is compared against its parent, not the base, so the review covers only its own work. The source-control entry here is the local one step 5 used (the first local one when it found no PR). ${STACK_PARENT} When the branch's own work starts at a branch other than \`<base>\` (\`<landed>\`, else a \`<parent>\` that isn't \`<base>\`), make that branch the base: \`<base>\` is its name, and \`<base-ref>\` is picked for it as in step 1.
7. **Working tree state:** \`git log --oneline <base-ref>..HEAD\` and \`git status --porcelain\`.
   - If either is non-empty: \`target = worktree:<branch>\`, covering commits ahead of the base, uncommitted (staged and unstaged) changes, and untracked files.
   - If both are empty and a PR exists (e.g. post-merge): fall back to \`target = pr:<entry>:<number>\`.
   - If both are empty and no PR exists, abort: \`Nothing to evaluate: <branch> has no commits ahead of <base>, a clean working tree, and no PR. Make a change, or pass an explicit PR number.\`

You now have one of: \`pr:<entry>:<N>\` (explicit argument or clean-tree fallback) or \`worktree:<branch>\` (with PR metadata attached if a PR exists).`,
          next: "run/gather-diff",
        },
        {
          id: "gather-diff",
          kind: "action",
          title: "Gather the diff and context",
          refName: "gather-diff",
          commandCalls: ["ready"],
          body: `Delegate the data-gathering to a subagent on a fast, cheaper model (Sonnet on Claude Code) with this prompt, substituting \`<target>\`, \`<base>\`, \`<base-ref>\`, the PR metadata, and (for \`pr:\` targets) the target entry's \`values\` and, for each of the \`prMetadata\`, \`prDiff\`, \`prFiles\`, and \`prCommits\` ops, the variant you chose by the rule in the {{step-ref:run/identify-target}} step, as a JSON block, all from the {{step-ref:run/identify-target}} step. The subagent runs the commands and file reads against a small context; you analyze the results in the {{step-ref:run/what-it-does}} through {{step-ref:run/report}} steps, without re-sending the whole conversation on every file read.

~~~~markdown
${GATHER_PROMPT}
~~~~

If the subagent call fails (tool error, timeout, empty result), or this host has no subagents, run the same gather instructions yourself. It's the same work at a higher token cost.

### After the subagent returns

Parse the structured sections. Use the root agent instructions already in your context plus the \`AGENT INSTRUCTIONS\` sections to recognize cross-package coupling the repo documents (packages released in lockstep, versions pinned in several places, generated files that must be regenerated). You are not auditing for convention violations, but you do need to spot when a diff touches a surface with known coupling.

\`REUSE CANDIDATES\` is the load-bearing input for the duplication and refactor lens in the {{step-ref:run/risks}} step (category 8): a match is a concrete reuse opportunity to name; "no existing match found" means the addition is genuinely new, and a duplication flag would need to come from within the diff itself. Treat it as a lead, not a verdict; confirm against the full file contents before flagging.

If \`GATHER NOTES\` mentions a large diff, say so in the report header: large diffs make every risk harder to assess, and the user should know the evaluation is coarser.

For \`worktree:\` targets, \`GIT STATUS\` tells you which changes are uncommitted or untracked. Uncommitted work is part of the evaluation, not a reason to ask the user to commit. Take the header's counts from \`DIFF STATS\`, never from the PR metadata, which describes only what the source-control host has seen.`,
          next: "run/what-it-does",
        },
        {
          id: "what-it-does",
          kind: "action",
          title: "What it does (plain English)",
          refName: "what-it-does",
          body: `Write 2-5 sentences (longer for genuinely large changes, never more than a paragraph or two). The reader should be able to skip the diff and still know what shipped.

Cover, in order:

1. **The change**: what is now true that wasn't before. Verb-led, concrete. ("Adds a \`synonyms\` column to \`products\` and indexes it for fuzzy search." beats "This PR introduces synonym support.")
2. **The why**, if discoverable from the PR body, commits, or a linked ticket. Skip it if unclear; don't invent motivation.
3. **The surface**: which packages, which user-visible features, which internal subsystems.
4. **Anything notable about the approach** that a reader wouldn't infer from the title alone.

Don't restate the PR title, walk through files one by one, copy the PR body verbatim, or speculate about intent the diff doesn't support.

If the stated intent (title, body, ticket) and the actual diff disagree (the diff does more, less, or something else), say so here. That drift is itself a shippability risk and also goes into the {{step-ref:run/risks}} step.`,
          next: "run/risks",
        },
        {
          id: "risks",
          kind: "action",
          title: "Risks",
          refName: "risks",
          body: `For each category below, decide **none / low / medium / high**. Include only categories where there is something specific to say; omit the rest rather than writing "no concerns."

For each risk, write one or two sentences: what could go wrong, where it lives (\`path:line\`, or \`path\` if the line is fuzzy), and, when there's a clear next step, how to mitigate it.

### Categories (in priority order)

1. **Migration / schema safety.** Schema definitions, migration files, or any persistence format:
   - NOT NULL columns without defaults on existing tables
   - Removed or renamed columns or tables that running code still reads
   - Type changes on existing columns, or new constraints existing rows might violate
   - Backfills: present? idempotent? sized for the real dataset?
   - Generated migrations committed against a repo rule that says they need approval

2. **Blast radius.** How much of the system this touches, and what fails if it's wrong:
   - Hot paths (request handlers, ingestion, auth, billing): a bug hits every user at once.
   - Shared utilities and domain types with many callers: the change ripples wide.
   - One-off scripts, docs, a single feature: small.
   - Quantify when you can ("touches 14 call sites of \`createClient\`").

3. **Customer-facing impact.** What an end user sees, and whether it's backward-compatible from their seat:
   - Public API or SDK changes, and their semver implications
   - HTTP contract changes (request/response shape, status codes, error format)
   - UI changes that break existing workflows
   - Auth and permission changes

4. **Cross-package sync.** Is everything that must change together actually changed together: lockstep packages, a version pinned in several places, generated code or skill files that need regenerating, feature-parity tables the repo keeps. Raise deploy order only when the pieces really ship separately; a genuine incompatibility between two packages in the same diff is a correctness problem, so report it as one.

5. **Rollback difficulty.** If it ships and breaks, how hard is recovery:
   - Migrations that can't be reversed without data loss
   - Data written in a format old code can't read
   - External-service state (payments, auth providers, issue trackers) that doesn't revert cleanly
   - Published package versions, which can only be superseded

6. **Monitoring and error-surface gaps.** Will anyone notice if it breaks:
   - New code paths without error tracking or structured logging
   - Background jobs without stated retry and idempotency behavior
   - Catches that swallow errors without re-raising or logging
   - Removed monitoring or alerts (flag it deliberately)

7. **Edge cases the diff appears to miss.** Trace each new path through: nil/empty input, upstream failure or timeout, concurrent requests and stale reads, authorization (can user A act on user B's resources?), zero and many results. Only the ones a reader of the diff would reasonably ask about.

8. **Code reuse, duplication, and necessary refactors.** Duplicated or poorly factored logic is a maintenance risk: one copy gets fixed and the other doesn't.
   - **Duplication within the change.** A pattern repeated 3+ times, or copy-pasted blocks with minor variations. **Always note copy-paste** (default medium); raise it to high only when the duplication itself is a correctness hazard, like two copies of a security check that will drift.
   - **Reinventing what exists.** New code that reimplements an existing utility, helper, or service. Use \`REUSE CANDIDATES\` and name the abstraction the change should lean on.
   - **Refactors this change makes necessary.** A function or file this change pushes past a reasonable size or the repo's stated limits; a parallel path bolted beside an existing one that should be consolidated; a flag or switch chain this case tips into needing a lookup table; a shared helper whose shape has become a hazard at this many callers.
   - **Don't flag** intentional inlining, repeated test setup, premature abstraction of a one-off, or a pre-existing mess the change merely sits next to. "Necessary" means *this change* created or worsened it.

9. **Change coherence.** One sentence, only if there's drift: title, body, or ticket disagree with the diff; tests don't cover the new paths (note the gap, don't write the tests); commit history hides the intent.

### Calibrating severity

- **High**: would break production for current users, lose or leak data across tenants, need an incident to recover, or block deploy.
- **Medium**: would surface as bug reports, degrade a feature, or need a follow-up change to clean up.
- **Low**: real and worth naming, but realistically caught in review or staging. Only include it if it's specific.

If everything is genuinely low or absent, keep the risk section short. Don't manufacture risks to fill categories. The one exception: copy-pasted code is always listed when present, even at low.`,
          next: "run/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `Output, in this order, no extra ceremony:

\`\`\`
EVALUATE: <PR #N "title" | working tree of <branch>> | <branch> -> <base>
<additions>+ / <deletions>- across <files> files | <state> [draft] [| includes uncommitted: N files, untracked: M]

What it does
  <2-5 sentences in plain English>

What changes for a user
  <omit entirely when the change replaces no existing behavior>
  <one or two changes: a short paragraph each, with a bolded Before and a bolded After>
  <three or more: a table with Before and After columns, one row per change>

Risks
  [HIGH] <category>: <one or two sentences>. <path[:line]>
    Mitigation: <if there's a clear next step>
  [MEDIUM] <category>: <one or two sentences>. <path[:line]>
  [LOW] <category>: <one or two sentences>. <path[:line]>
  (or: "No high or medium risks identified." if genuinely clean)

Verdict
  <one sentence: ship / address first / rethink, with the load-bearing reason>
\`\`\`

Header counts: for \`pr:\` targets use the PR metadata; for \`worktree:\` targets use \`DIFF STATS\`.

Verdicts:

- **Ship**: no high risks; mediums, if any, are acknowledged or trivially mitigated.
- **Address first**: at least one high risk, or a cluster of mediums that together threaten shippability. List the must-fix items.
- **Rethink**: the change as designed has a structural issue (wrong layer, wrong primitive, wrong rollout) that no incremental fix resolves. Be specific about what to rethink.

The verdict is the user's call. Phrase it as a recommendation, not a gate: they may know context the diff doesn't show (a coordinated launch, an accepted risk, a planned follow-up).

### Notes

- This skill is read-only. The source-control ops it uses only read. If you find yourself editing a PR, running \`git push\`, or writing to any service, stop. The output is the report.
- "Plain English" is load-bearing. If the summary reads like a dump of section headers, rewrite it as if telling a teammate in chat.
- **What changes for a user**: **Before** is what a person saw happen (the input, the result, whether anything was raised), not what the code said; **After** is what they see now. Cause belongs in "What it does". Say plainly which paths are unchanged. Omit the section for a diff that only adds something new, and never pad it with rows where nothing moved.
- The risk list is not a checklist. A 3-item list on a 200-line change is more useful than 14 items padded with "no concerns."
- If the user asks for a convention or style audit rather than a shippability review, say so and offer a focused pass instead; don't do both in one report.
- Don't speculate beyond the diff and its linked context. If "is this safe?" depends on something the diff doesn't show, say so rather than inventing a position.`,
          next: null,
        },
      ],
    },
  ],
})
