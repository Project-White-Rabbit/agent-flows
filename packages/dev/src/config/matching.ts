// How create-tickets finds the issues a planned item may already describe:
// every open issue, and every one closed in the last 90 days, is scored by the
// words it shares with the item's title and each line of its description, and
// that ranking is fused with the tracker's own search. A match is certain, and
// set without asking, on the same title or on an issue already filed from the
// same notes; everything else is a candidate the agent judges.
//
// Runtime code: Node built-ins only.

import { branchFromDescription, hasBranchLine } from "./branch-line.ts"

/** An issue as the tracker's `recentIssues` and `searchIssues` ops list it. */
export type Candidate = {
  identifier: string
  title: string
  url?: string
  state?: string
  open?: boolean
  parent?: string | null
  pullRequests?: string[]
  description?: string | null
}

/** One tracker entry's issues, and its search's results by item key, best first. */
export type EntryIssues = {
  /** The entry is at `link`: its issues are shown, never matched. */
  link?: boolean
  issues: Candidate[]
  hits?: Record<string, string[]>
}

export type Ranked = {
  entry: string
  issue: Candidate
  score: number
  exact: boolean
  sameSource: boolean
  searchRank?: number
  /** Where it sorts: higher first. */
  fused: number
}

export type Matchable = { key: string; title?: string; description?: string }

const STOPWORDS = new Set(
  "a all an and are as at be by can do done for from has have how in into is it need not of on or our should so that the their them this to we what when will with work".split(
    " ",
  ),
)
const CANDIDATE_FLOOR = 0.4
const SAME_SOURCE_FLOOR = 0.5
const SAME_SOURCE_MARGIN = 0.15
const DESCRIPTION_WEIGHT = 0.85
const NO_TITLE_OVERLAP_WEIGHT = 0.5
const FULL_COVERAGE_TOKENS = 4
const FUSION_OFFSET = 10
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/
const SENTENCE_END = /(?<=[.!?;])\s+/

function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

export function tokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return new Set(
    words.filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem),
  )
}

function withoutMark(title: string, mark?: string): string {
  return (mark ? title.replaceAll(mark, "") : title).trim()
}

function normalizedTitle(title: string, mark?: string): string {
  return (
    withoutMark(title, mark)
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).join(" ")
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const word of a) {
    if (b.has(word)) {
      count++
    }
  }
  return count
}

/** How well one phrase of an item describes the issue, 0 to 1. */
export function scorePhrase(
  phrase: string,
  issue: Candidate,
  mark?: string,
): number {
  const words = tokens(withoutMark(phrase, mark))
  if (words.size === 0) {
    return 0
  }
  const title = tokens(withoutMark(issue.title, mark))
  const dice =
    title.size > 0 ? (2 * overlap(words, title)) / (words.size + title.size) : 0
  const text = new Set([...title, ...tokens(issue.description ?? "")])
  const coverage = overlap(words, text) / words.size
  const weight = Math.min(1, words.size / FULL_COVERAGE_TOKENS)
  const titleWeight = overlap(words, title) > 0 ? 1 : NO_TITLE_OVERLAP_WEIGHT
  const value = Math.max(
    dice,
    DESCRIPTION_WEIGHT * coverage * weight * titleWeight,
  )
  return Math.round(value * 100) / 100
}

/** The item's title, then each checklist line and sentence of its description. */
export function itemPhrases(item: Matchable): string[] {
  const sentences = (item.description ?? "")
    .split("\n")
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .flatMap((line) => line.split(SENTENCE_END).map((s) => s.trim()))
    .filter((s) => tokens(s).size > 0)
  return [item.title ?? "", ...sentences]
}

export function scoreItem(
  item: Matchable,
  issue: Candidate,
  mark?: string,
): number {
  return Math.max(...itemPhrases(item).map((p) => scorePhrase(p, issue, mark)))
}

/**
 * One entry's issues that may describe the item, best first: the same title
 * first, then by the word score's rank and the search's rank together.
 */
export function rankCandidates(
  item: Matchable,
  entry: string,
  issues: Candidate[],
  options: { key?: string; hits?: string[]; mark?: string } = {},
): Ranked[] {
  const searchRank = new Map(
    (options.hits ?? []).map((id, i) => [id, i + 1] as const),
  )
  const ranked: Omit<Ranked, "fused">[] = []
  for (const issue of issues) {
    const value = scoreItem(item, issue, options.mark)
    const exact =
      Boolean(item.title) &&
      normalizedTitle(item.title as string, options.mark) ===
        normalizedTitle(issue.title, options.mark)
    const rank = searchRank.get(issue.identifier)
    if (exact || rank || value >= CANDIDATE_FLOOR) {
      ranked.push({
        entry,
        issue,
        score: exact ? 1 : value,
        exact,
        sameSource: Boolean(
          options.key && (issue.description ?? "").includes(options.key),
        ),
        ...(rank ? { searchRank: rank } : {}),
      })
    }
  }
  const byWords = ranked
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
  const wordsRank = new Map(byWords.map((c, i) => [c, i + 1] as const))
  const fuse = (...ranks: (number | undefined)[]) =>
    ranks.reduce<number>((sum, r) => sum + (r ? 1 / (FUSION_OFFSET + r) : 0), 0)
  return ranked
    .map((c) => ({ ...c, fused: fuse(wordsRank.get(c), c.searchRank) }))
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.fused - a.fused ||
        b.score - a.score,
    )
}

/** An issue this item can be matched to: open, in an entry it can update. */
export type CanMatch = (candidate: Ranked) => boolean

/**
 * The one candidate certain enough to match without asking: the only issue
 * with the same title, else one filed from the same notes that clearly
 * outscores the others that were.
 */
export function certainMatch(
  ranked: Ranked[],
  canMatch: CanMatch,
): Ranked | undefined {
  const matchable = ranked.filter(canMatch)
  const exact = matchable.filter((c) => c.exact)
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : undefined
  }
  const same = matchable
    .filter((c) => c.sameSource && c.score >= SAME_SOURCE_FLOOR)
    .sort((a, b) => b.score - a.score)
  const [first, second] = same
  if (!first) {
    return undefined
  }
  return first.score - (second?.score ?? 0) >= SAME_SOURCE_MARGIN
    ? first
    : undefined
}

/**
 * With `branch`: a branch's issue is one no other work holds, so not one with
 * a pull request attached or a `> Branch:` line naming another branch.
 */
export function canMatchFor(
  entries: Record<string, EntryIssues>,
  branch?: string,
): CanMatch {
  return (c) => {
    if (c.issue.open === false || entries[c.entry]?.link) {
      return false
    }
    if (!branch) {
      return true
    }
    const description = c.issue.description ?? ""
    return (
      (c.issue.pullRequests ?? []).length === 0 &&
      (!branchFromDescription(description) ||
        hasBranchLine(description, branch))
    )
  }
}
