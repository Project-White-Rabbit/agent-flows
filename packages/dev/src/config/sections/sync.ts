import type { FieldPattern, SectionSpec } from "../types.ts"

/** What bitfab-dev's sync writes, so the two can take turns on one PR. */
export const BITFAB_DEV_FORMAT = {
  linkLabels: "integration",
  errorVerb: "Fixes",
  prTitle: "{issueId}: {title}",
  blockMarkers: false,
}

const LINK_LABELS: FieldPattern = {
  regex: /^(capability|integration)$/,
  hint: "`capability` or `integration`",
}

const WORDS: FieldPattern = {
  regex: /^[A-Za-z]+( [A-Za-z]+)*$/,
  hint: "a word or a few, letters only (`Fixes`)",
}

const TITLE_TEMPLATE: FieldPattern = {
  regex: /^([^{}]|\{(issueId|title|summary)\})+$/,
  hint: "text with `{issueId}`, `{title}`, and `{summary}` placeholders (`{issueId}: {title}`, `{summary} ({issueId})`)",
}

const LINK_STYLE: FieldPattern = {
  regex: /^(link|url)$/,
  hint: "`link` or `url`",
}

/** What's wrong with an IANA time zone name (`America/Los_Angeles`), or undefined. */
export function timeZoneProblem(value: unknown): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value as string })
    return undefined
  } catch {
    return "must be an IANA time zone (`UTC`, `America/Los_Angeles`)"
  }
}

export const sync: SectionSpec = {
  path: "sync",
  name: "Sync format",
  purpose:
    "How sync writes the PR body, its title, and the issue's link lines; unset, it uses its own format",
  fields: [
    {
      key: "linkLabels",
      description:
        "Label link lines by capability (`> Issue:`, `> Errors:`, the default) or by integration name (`> Linear:`, `> Sentry:`)",
      example: "integration",
      pattern: LINK_LABELS,
    },
    {
      key: "errorVerb",
      description: "Word that starts each error line (`Fixes`)",
      example: "Fixes",
      pattern: WORDS,
    },
    {
      key: "prTitle",
      description:
        "PR title template: `{issueId}` and `{title}` are the issue's, `{summary}` a summary of the change in the repo's title convention; unset, the repo's convention",
      example: "{issueId}: {title}",
      pattern: TITLE_TEMPLATE,
    },
    {
      key: "linkStyle",
      description:
        "How the PR body's issue line links the issue: `link` (the default: `[<ID>](<URL>) <title>`) or `url` (the issue's bare URL, `Issue: https://...`)",
      example: "url",
      pattern: LINK_STYLE,
    },
    {
      key: "timezone",
      description:
        "IANA time zone for the last-synced line's time (default `UTC`), shown by its short name (`PT` for `America/Los_Angeles`)",
      example: "America/Los_Angeles",
      check: timeZoneProblem,
    },
    {
      key: "quoteLinks",
      type: "boolean",
      description:
        "Write the PR body's link lines as quotes (`> Issue:`, the default); false writes them plain (`Issue:`). The issue's own lines stay quoted",
      example: false,
    },
    {
      key: "prSections",
      type: "string[]",
      description:
        "The headings of sync's sections in the PR body, in order, in place of the repo's PR template or Summary and Test plan",
      example: ["Summary", "Verification"],
      check: (value) =>
        Array.isArray(value) &&
        (value as unknown[]).every(
          (heading) =>
            typeof heading === "string" &&
            /^[A-Za-z][\w ()/&-]*$/.test(heading),
        ) &&
        new Set(value as unknown[]).size === value.length
          ? undefined
          : "must be distinct headings, each starting with a letter (`Summary`, `Verification`)",
    },
    {
      key: "blockMarkers",
      type: "boolean",
      description:
        "Wrap sync's part of the PR body in HTML comment markers (default true); false bounds it by the link lines and the last-synced line instead",
      example: false,
    },
    {
      key: "prLinkLine",
      type: "boolean",
      description:
        "Write the issue tracker's link line (`Fixes <ID>`, `Part of <ID>`) in the PR body when its `prLink` op puts one there (default true); false leaves it out, for a repo whose tracker links by the issue line or the title alone",
      example: false,
    },
    {
      key: "noIssueLine",
      description:
        "With no issue, still write the issue line, with this after its label (`Linear: none`); unset leaves the line out",
      example: "none",
    },
    {
      key: "footer",
      type: "boolean",
      description:
        "End sync's part of the PR body with the last-synced line (default true). False leaves it out, only with `blockMarkers` on: without markers, that line is where sync's part ends, so it's always written",
      example: false,
    },
    {
      key: "commitBodies",
      type: "boolean",
      description:
        "Read each commit's whole message, not only its subject, when writing the PR body (default false), for a repo whose commits carry notes the PR draws on (a `Verification:` section)",
      example: true,
    },
    {
      key: "linkUnverified",
      type: "boolean",
      description:
        "When an issue ref the branch, PR title, argument, or an adopted tool's state names can't be loaded from an issue tracker at `link` (a token or MCP server for another workspace, an outage), link it anyway, marked unverified in the report, instead of linking none (default false)",
      example: true,
    },
    {
      key: "requireBase",
      type: "boolean",
      description:
        "Stop when the pull request targets neither `repo.baseBranch` nor the branch's stack parent, as finish does (default false: sync catches up to whatever base the pull request has)",
      example: true,
    },
    {
      key: "adoptState",
      type: "string[]",
      description:
        "Another sync tool's per-branch state files, read once for a branch sync hasn't synced (after bitfab-dev's own), for the issue it linked: JSON with `branch` and `linearId` or `issueId`. `{gitDir}` and `{gitCommonDir}` are the worktree's git dirs; other paths are relative to the worktree root",
      example: ["{gitDir}/other-tool/state.json"],
      check: (value) =>
        (value as string[]).every(
          (file) => !/\{(?!gitDir\}|gitCommonDir\})/.test(file),
        )
          ? undefined
          : "may use only the `{gitDir}` and `{gitCommonDir}` placeholders",
    },
    {
      key: "adoptHeader",
      description:
        "A regular expression for the link lines another sync tool puts on top of a PR body (`^Linear\\s*:`). A body that starts with one is that tool's: sync replaces those lines and its sections of the same names as sync's own, instead of adding its block above them",
      example: "^Linear\\s*:",
      check: (value) => {
        try {
          new RegExp(value as string)
          return undefined
        } catch {
          return "must be a valid regular expression"
        }
      },
    },
  ],
  lookup:
    "Leave it out for sync's own format. A team that also runs bitfab-dev's sync uses its format, so the two don't duplicate each other's lines. A team moving from another sync tool sets `adoptState` and `adoptHeader` to that tool's state file and PR header, and the format fields to what it wrote, so sync takes its branches over without a second copy of each line. Set `commitBodies` when the repo's commit messages carry verification notes, `requireBase` when the host's default branch isn't the base (a pull request opened by hand would target it), and `linkUnverified` when the issue tracker is linked only and its issues may be out of reach",
  detect(ctx) {
    const evidence: string[] = []
    if (
      ctx.tracked.some((file) => file.startsWith("bitfab-internal/bitfab-dev/"))
    ) {
      evidence.push("bitfab-internal/bitfab-dev is tracked")
    }
    const ignore = ctx.read(".gitignore") ?? ""
    if (/^\/?\.bitfab-dev\/?$/m.test(ignore)) {
      evidence.push(".gitignore lists .bitfab-dev/")
    }
    if (ctx.read(".bitfab-dev/state.json") !== undefined) {
      evidence.push(".bitfab-dev/state.json exists")
    }
    return evidence.length > 0
      ? { values: { ...BITFAB_DEV_FORMAT }, evidence }
      : undefined
  },
}
