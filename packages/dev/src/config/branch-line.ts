// The `> Branch:` line that ties an issue to its branch: sync writes it,
// start-work adds it, and finding a branch's issue reads it back, however the
// tracker stored it.
//
// Runtime code: Node built-ins only.

const BRANCH_LINE = /^> Branch:\s*(.+?)\s*$/
export const ISSUE_ID =
  /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9])/g

/**
 * A branch as written in a `> Branch:` line, compared loosely: without the
 * backticks sync writes, with any issue id the tracker turned into a link
 * (`[HVT-1](https://…)`, or `<issue …>HVT-1</issue>` from the MCP) read as its
 * text, and with issue ids in one case, since a link shows the id uppercased.
 */
export function normalizeBranch(text: string): string {
  const plain = text
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .replace(/<issue\b[^>]*>(.*?)<\/issue>/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  return plain.replace(ISSUE_ID, (id) => id.toLowerCase())
}

/** Whether `description` has a `> Branch:` line naming `branch`. */
export function hasBranchLine(description: string, branch: string): boolean {
  const want = normalizeBranch(branch)
  return description.split("\n").some((line) => {
    const found = line.trim().match(BRANCH_LINE)
    return found !== null && normalizeBranch(found[1]) === want
  })
}

/** The `> Label:` lines flows keep at the top of an issue's description. */
const STICKY_LINE = /^> [A-Za-z][A-Za-z -]*:/

/** The description without its `> Label:` link lines. */
export function withoutLinkLines(description: string): string {
  return description
    .split("\n")
    .filter((line) => !STICKY_LINE.test(line))
    .join("\n")
    .trim()
}

/** The branch an issue's `> Branch:` line names, if it has one. */
export function branchFromDescription(
  description: string | null | undefined,
): string | undefined {
  for (const line of (description ?? "").split("\n")) {
    const found = line.trim().match(BRANCH_LINE)
    const branch = found ? normalizeBranch(found[1]) : ""
    if (branch && !/\s/.test(branch)) {
      return branch
    }
  }
  return undefined
}

/**
 * The description with `> Branch: \`<branch>\`` on top, above the other link
 * lines, the way sync writes it; unchanged when it already has a branch line.
 */
export function addBranchLine(description: string, branch: string): string {
  if (branchFromDescription(description)) {
    return description
  }
  const lines = description.trim().split("\n")
  let sticky = 0
  while (sticky < lines.length && STICKY_LINE.test(lines[sticky])) {
    sticky++
  }
  const rest = lines.slice(sticky)
  while (rest.length > 0 && !rest[0].trim()) {
    rest.shift()
  }
  const head = [`> Branch: \`${branch}\``, ...lines.slice(0, sticky)]
  return `${[...head, ...(rest.length > 0 ? ["", ...rest] : [])].join("\n")}\n`
}
