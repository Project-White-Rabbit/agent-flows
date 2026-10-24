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
  regex: /^([^{}]|\{(issueId|title)\})+$/,
  hint: "text with `{issueId}` and `{title}` placeholders (`{issueId}: {title}`)",
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
        "PR title template, with `{issueId}` and `{title}` the issue's; unset, the repo's convention",
      example: "{issueId}: {title}",
      pattern: TITLE_TEMPLATE,
    },
    {
      key: "blockMarkers",
      type: "boolean",
      description:
        "Wrap sync's part of the PR body in HTML comment markers (default true); false bounds it by the link lines and the last-synced line instead",
      example: false,
    },
  ],
  lookup:
    "Leave it out for sync's own format. A team that also runs bitfab-dev's sync uses its format, so the two don't duplicate each other's lines",
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
