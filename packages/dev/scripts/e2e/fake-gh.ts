// A stand-in for the `gh` CLI, for the e2e runs (`e2e.ts`). Pull requests
// live in a JSON file ($FAKE_GH_STATE), the repository is a bare repo
// ($FAKE_GH_ORIGIN), CI is `node --test` run at the commit asked about, and a
// merge really merges into the bare repo. It answers only the `gh` commands
// the GitHub integration uses; anything else fails loudly, so a run that
// needs a new one shows it. Every call is appended to $FAKE_GH_STATE.log.
// `--jq` and `-q` go through the system `jq`, as gh's built-in jq would.

import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isMain } from "../../src/commands/lib.ts"

export const OWNER = "e2e-fake"
export const REPO = "app"

export interface FakePr {
  number: number
  title: string
  body: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  baseRefName: string
  headRefName: string
  mergeCommit?: string
}

export interface FakeState {
  prs: FakePr[]
  checks: Record<string, "pass" | "fail">
  logs: Record<string, string>
}

const STATE = process.env.FAKE_GH_STATE ?? ""
const ORIGIN = process.env.FAKE_GH_ORIGIN ?? ""
const args = process.argv.slice(2)

class Exit extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function fail(message: string): never {
  throw new Exit(1, message)
}

export function loadState(file: string): FakeState {
  if (!existsSync(file)) {
    return { prs: [], checks: {}, logs: {} }
  }
  return { logs: {}, ...JSON.parse(readFileSync(file, "utf8")) }
}

function save(state: FakeState): void {
  writeFileSync(STATE, JSON.stringify(state, null, 2))
}

function git(gitArgs: string[], cwd?: string, check = true): string {
  const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8" })
  if (check && r.status !== 0) {
    fail(r.stderr.trim() || `git ${gitArgs.join(" ")} failed`)
  }
  return (r.stdout ?? "").trim()
}

const bare = (gitArgs: string[], check = true) =>
  git(["--git-dir", ORIGIN, ...gitArgs], undefined, check)

function opt(name: string, fallback?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return fallback
}

const flag = (name: string) => args.includes(name)
const url = (n: number) => `https://github.com/${OWNER}/${REPO}/pull/${n}`

/** JSON as gh prints it, through --jq when given. */
function out(value: unknown): string {
  const query = opt("--jq") ?? opt("-q")
  const text = JSON.stringify(value)
  if (!query) {
    return text
  }
  const r = spawnSync("jq", ["-c", "-r", query], {
    input: text,
    encoding: "utf8",
  })
  if (r.error) fail("fake gh: --jq needs jq on the PATH")
  if (r.status !== 0) fail(r.stderr)
  return r.stdout.replace(/\n$/, "")
}

const headSha = (pr: FakePr) =>
  bare(["rev-parse", `refs/heads/${pr.headRefName}`], false)

/** Runs `node --test` at the commit once; later asks read the cached result. */
function ci(sha: string): "pass" | "fail" {
  const cached = loadState(STATE).checks[sha]
  if (cached) return cached
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gh-ci-"))
  try {
    git(["clone", "-q", ORIGIN, dir])
    git(["checkout", "-q", sha], dir)
    const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" })
    const result = r.status === 0 ? "pass" : "fail"
    const state = loadState(STATE)
    state.checks[sha] = result
    state.logs[sha] = `${r.stdout}${r.stderr}`.slice(-4000)
    save(state)
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function mergeState(pr: FakePr): [mergeable: string, status: string] {
  if (pr.state !== "OPEN") return ["UNKNOWN", "UNKNOWN"]
  const head = headSha(pr)
  const base = bare(["rev-parse", `refs/heads/${pr.baseRefName}`])
  const tree = spawnSync(
    "git",
    ["--git-dir", ORIGIN, "merge-tree", "--write-tree", base, head],
    { encoding: "utf8" },
  )
  if (tree.status === 1) return ["CONFLICTING", "DIRTY"]
  if (pr.isDraft) return ["MERGEABLE", "DRAFT"]
  const ancestor = spawnSync("git", [
    "--git-dir",
    ORIGIN,
    "merge-base",
    "--is-ancestor",
    base,
    head,
  ])
  if (ancestor.status !== 0) return ["MERGEABLE", "BEHIND"]
  return ["MERGEABLE", ci(head) === "fail" ? "UNSTABLE" : "CLEAN"]
}

function view(pr: FakePr): Record<string, unknown> {
  const open = pr.state === "OPEN"
  const head = headSha(pr)
  const base = bare(["rev-parse", `refs/heads/${pr.baseRefName}`], false)
  let additions = 0
  let deletions = 0
  let changedFiles = 0
  const commits: { oid: string; messageHeadline: string }[] = []
  if (open && head) {
    for (const line of bare(["diff", "--numstat", `${base}...${head}`], false)
      .split("\n")
      .filter(Boolean)) {
      const [a, d] = line.split("\t")
      additions += Number(a) || 0
      deletions += Number(d) || 0
      changedFiles++
    }
    for (const line of bare(
      ["log", "--format=%H%x09%s", `${base}..${head}`],
      false,
    )
      .split("\n")
      .filter(Boolean)) {
      const [oid, ...msg] = line.split("\t")
      commits.push({ oid, messageHeadline: msg.join("\t") })
    }
  }
  const [mergeable, mergeStateStatus] = mergeState(pr)
  const full: Record<string, unknown> = {
    ...pr,
    id: `PR_${pr.number}`,
    url: url(pr.number),
    additions,
    deletions,
    changedFiles,
    headRefOid: head,
    mergeable,
    mergeStateStatus,
    reviewDecision: "",
    commits,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
  }
  const fields = opt("--json")
  return fields
    ? Object.fromEntries(fields.split(",").map((k) => [k, full[k]]))
    : full
}

function find(
  state: FakeState,
  by: { ref?: string; branch?: string },
): FakePr | undefined {
  const number = by.ref?.split("/").pop()
  return [...state.prs]
    .reverse()
    .find((pr) =>
      number !== undefined
        ? String(pr.number) === number
        : pr.headRefName === by.branch,
    )
}

function byNumber(state: FakeState): FakePr {
  return find(state, { ref: args[2] }) ?? fail("no such pull request")
}

function merge(target: FakePr): void {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gh-merge-"))
  const id = ["-c", "user.email=gh@example.com", "-c", "user.name=fake-gh"]
  try {
    git(["clone", "-q", ORIGIN, dir])
    git(["checkout", "-q", target.baseRefName], dir)
    if (flag("--squash")) {
      git(["merge", "--squash", `origin/${target.headRefName}`], dir)
      git([...id, "commit", "-qm", `${target.title} (#${target.number})`], dir)
    } else {
      git(
        [
          ...id,
          "merge",
          "--no-ff",
          "-m",
          `Merge pull request #${target.number}`,
          `origin/${target.headRefName}`,
        ],
        dir,
      )
    }
    git(["push", "-q", "origin", target.baseRefName], dir)
    target.mergeCommit = git(["rev-parse", "HEAD"], dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function pr(sub: string, state: FakeState): string {
  switch (sub) {
    case "view": {
      const target = args[2] && !args[2].startsWith("-") ? args[2] : undefined
      const found =
        target && /^(\d+|https?:\/\/.*)$/.test(target)
          ? find(state, { ref: target })
          : find(state, {
              branch: target ?? git(["branch", "--show-current"]),
            })
      if (!found) fail(`no pull requests found for branch "${target}"`)
      return out(view(found))
    }
    case "list": {
      const head = opt("--head")
      const base = opt("--base")
      const want = opt("--state", "open")
      const list = state.prs
        .filter(
          (p) =>
            (!head || p.headRefName === head) &&
            (!base || p.baseRefName === base) &&
            (want === "all" || p.state.toLowerCase() === want),
        )
        .reverse()
        .slice(0, Number(opt("--limit", "30")))
      return out(list.map(view))
    }
    case "create": {
      const head = opt("--head") ?? git(["branch", "--show-current"])
      if (!bare(["rev-parse", "--verify", "-q", `refs/heads/${head}`], false)) {
        fail(`pull request create failed: head branch ${head} isn't pushed`)
      }
      if (find(state, { branch: head })?.state === "OPEN") {
        fail(`a pull request for branch "${head}" already exists`)
      }
      const bodyFile = opt("--body-file")
      const number = state.prs.length + 1
      state.prs.push({
        number,
        title: opt("--title") ?? opt("-t") ?? "",
        body: bodyFile ? readFileSync(bodyFile, "utf8") : (opt("--body") ?? ""),
        state: "OPEN",
        isDraft: flag("--draft") || flag("-d"),
        baseRefName: opt("--base", "main")!,
        headRefName: head,
      })
      save(state)
      return url(number)
    }
    case "edit": {
      const found = byNumber(state)
      const bodyFile = opt("--body-file")
      found.title = opt("--title") ?? found.title
      found.body = bodyFile
        ? readFileSync(bodyFile, "utf8")
        : (opt("--body") ?? found.body)
      save(state)
      return url(found.number)
    }
    case "ready": {
      const found = byNumber(state)
      found.isDraft = false
      save(state)
      return `✓ Pull request ${OWNER}/${REPO}#${found.number} is marked as "ready for review"`
    }
    case "close": {
      const found = byNumber(state)
      found.state = "CLOSED"
      save(state)
      return `✓ Closed pull request ${OWNER}/${REPO}#${found.number}`
    }
    case "diff": {
      const found = byNumber(state)
      const base = bare(["rev-parse", `refs/heads/${found.baseRefName}`])
      const names = flag("--name-only") ? ["--name-only"] : []
      return bare(["diff", ...names, `${base}...${headSha(found)}`])
    }
    case "merge": {
      const found = byNumber(state)
      if (found.state !== "OPEN") fail("Pull request is not open")
      if (found.isDraft) fail("Pull request is still a draft")
      const sha = opt("--match-head-commit")
      if (sha && !headSha(found).startsWith(sha)) {
        fail("Head branch was modified. Review and try the merge again.")
      }
      const [, status] = mergeState(found)
      if (status === "DIRTY" || status === "BEHIND") {
        fail(`Pull request is not mergeable: ${status}`)
      }
      merge(found)
      found.state = "MERGED"
      save(state)
      return `✓ Merged pull request ${OWNER}/${REPO}#${found.number}`
    }
  }
  fail(`fake gh: unsupported command: ${args.join(" ")}`)
}

function api(): string {
  const joined = args.join(" ")
  if (args[1] === "graphql") {
    if (joined.includes("reviewThreads")) {
      return out({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      })
    }
    return out({
      data: null,
      errors: [
        { message: "Could not resolve to an Issue with the number of 0." },
      ],
    })
  }
  const route =
    args.slice(1).find((a) => !a.startsWith("-") && a.includes("/")) ?? ""
  const commit = route.match(/commits\/([0-9a-f]+)\/(check-runs|status)/)
  if (commit?.[2] === "check-runs") {
    const pass = ci(commit[1]) === "pass"
    const link = `https://github.com/${OWNER}/${REPO}/actions/runs/1`
    return out({
      total_count: 1,
      check_runs: [
        {
          id: 1,
          name: "test",
          status: "completed",
          conclusion: pass ? "success" : "failure",
          details_url: link,
          html_url: link,
          app: { slug: "github-actions" },
        },
      ],
    })
  }
  if (commit) return out({ state: "success", statuses: [] })
  if (route.includes("/rules/branches/")) return out([])
  if (route.includes("/branches/")) {
    return out({ name: "main", protected: false, protection: {} })
  }
  if (route.includes("code-scanning")) {
    fail("gh: Code scanning is not enabled for this repository (HTTP 403)")
  }
  fail(`gh: Not Found (HTTP 404) [the fake has no ${route}]`)
}

function main(): string {
  if (!STATE || !ORIGIN) {
    fail("fake gh: FAKE_GH_STATE and FAKE_GH_ORIGIN must be set")
  }
  appendFileSync(`${STATE}.log`, `${JSON.stringify(args)}\n`)
  const state = loadState(STATE)
  const [group, sub] = args
  if (group === "auth" && sub === "status") {
    return "github.com\n  ✓ Logged in to github.com account e2e (fake)"
  }
  if (group === "repo" && sub === "view") {
    return out({
      owner: { login: OWNER },
      name: REPO,
      isFork: false,
      parent: null,
      nameWithOwner: `${OWNER}/${REPO}`,
      defaultBranchRef: { name: "main" },
    })
  }
  if (group === "pr") return pr(sub, state)
  if (group === "api") return api()
  if (group === "run" && sub === "view") {
    const logs = Object.values(state.logs).join("\n")
    return logs.slice(-4000) || "no logs"
  }
  fail(`fake gh: unsupported command: ${args.join(" ")}`)
}

if (isMain(import.meta.filename)) {
  try {
    const text = main()
    if (text) process.stdout.write(`${text}\n`)
  } catch (error) {
    if (!(error instanceof Exit)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exit(error.code)
  }
}
