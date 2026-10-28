// The planning document create-tickets keeps per cycle (`tickets.planningDoc`):
// one dated section per set of notes, holding the notes as written and the
// issues filed from them. A section is found again by its `Source:` line, so a
// re-run on the same notes replaces it instead of adding a second. The tracker
// stores the document; this only shapes its text, so every tracker's
// `recordNotes` writes the same thing.
//
// Runtime code: Node built-ins only.

import { createHash } from "node:crypto"

export type NotesSource = { title?: string; url?: string }

export type FiledIssue = {
  id: string
  title: string
  url?: string
  /** `filed`, `updated`, or `unchanged`. */
  action: string
}

const SHALLOW_HEADING = /^#{1,3}(?=\s)/gm
const SECTION_START = /^## /gm
const PLANNING_LINE = /^> Planning:/
const LINK_LINE = /^> [A-Za-z][A-Za-z ]*:/

/**
 * What identifies the notes across runs: the page's URL, or a hash of pasted
 * text, so the same notes pasted again find their section.
 */
export function sourceKey(source: NotesSource, notes: string): string {
  const url = source.url?.trim()
  if (url) {
    return url
  }
  const hash = createHash("sha1")
    .update(notes.split(/\s+/).filter(Boolean).join(" "))
    .digest("hex")
  return `notes-${hash.slice(0, 10)}`
}

/** The document's title: the week its cycle starts, else today's. */
export function planningTitle(cycleStart: string | undefined, today: string) {
  return `Planning, week of ${(cycleStart ?? today).slice(0, 10)}`
}

/** One run's section: the notes (headings pushed below the section's) and its issues. */
export function renderSection(
  today: string,
  source: NotesSource,
  key: string,
  notes: string,
  issues: FiledIssue[],
): string {
  const title = source.title || "Planning notes"
  const origin = source.url
    ? `[${title}](${source.url})`
    : `pasted notes (${key})`
  const lines = issues.map(
    (issue) =>
      `- ${issue.url ? `[${issue.id}](${issue.url})` : issue.id}: ${issue.title} (${issue.action})`,
  )
  return [
    `## ${today}: ${title}`,
    `Source: ${origin}`,
    "### Notes",
    notes.trim().replace(SHALLOW_HEADING, "####") || "_No notes recorded._",
    "### Issues",
    lines.length > 0 ? lines.join("\n") : "_Not filed yet._",
  ].join("\n\n")
}

/** The document with `section` in place of the one from the same notes, or added at the end. */
export function upsertSection(
  content: string,
  key: string,
  section: string,
): string {
  const starts = [...content.matchAll(SECTION_START)].map(
    (m) => m.index as number,
  )
  const preamble = (
    starts.length > 0 ? content.slice(0, starts[0]) : content
  ).trim()
  const sections = starts.map((start, i) =>
    content.slice(start, starts[i + 1] ?? content.length).trim(),
  )
  const sourceOf = (text: string) =>
    text.split("\n").find((line) => line.startsWith("Source:")) ?? ""
  const index = sections.findIndex((s) => sourceOf(s).includes(key))
  if (index >= 0) {
    sections[index] = section
  } else {
    sections.push(section)
  }
  return `${[preamble, ...sections].filter(Boolean).join("\n\n")}\n`
}

/** The `> Planning:` line each issue filed or updated from the notes carries. */
export function planningLine(
  title: string,
  url: string,
  source: NotesSource,
  key: string,
): string {
  const origin = source.url
    ? `[${source.title || "planning notes"}](${source.url})`
    : `${source.title || "planning notes"} (${key})`
  return `> Planning: [${title}](${url}), from ${origin}`
}

/**
 * The description with `line` among its `> ` link lines at the top, in place
 * of a `> Planning:` line it already has; the rest stays as written.
 */
export function upsertPlanningLine(description: string, line: string): string {
  const lines = description
    .split("\n")
    .filter((existing) => !PLANNING_LINE.test(existing))
  let end = 0
  while (end < lines.length && LINK_LINE.test(lines[end] as string)) {
    end++
  }
  const rest = lines.slice(end)
  while (rest.length > 0 && !rest[0]?.trim()) {
    rest.shift()
  }
  const head = [...lines.slice(0, end), line]
  return `${[...head, ...(rest.length > 0 ? ["", ...rest] : [])].join("\n").trim()}\n`
}
