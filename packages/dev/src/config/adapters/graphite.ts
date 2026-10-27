// Graphite ops as code. `downstack` needs it: the chain is read from
// Graphite's own record of each branch's parent, which needs no checkout (a
// stack's other branches are often checked out in other worktrees) and no
// parsing of `gt log`'s glyphs.
//
// Runtime code: Node built-ins only.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Adapter } from "../types.ts"
import { cli } from "./checks.ts"

/** Far deeper than any real stack: a guard against a cycle in the records. */
const MAX_DEPTH = 50

export type Downstack = { chain: string[]; above: number; size: number }

function git(args: string[]): string | undefined {
  const result = spawnSync("git", args, { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/**
 * Each tracked branch's parent. Graphite 1.8 moved them from
 * `refs/branch-metadata/<branch>` into `.graphite_metadata.db` and stopped
 * updating the refs without deleting them, so the database wins and the refs
 * only fill in branches it doesn't have.
 */
export function graphiteParents(): Map<string, string> {
  const parents = new Map<string, string>()
  const commonDir = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
  const db = commonDir && path.join(commonDir, ".graphite_metadata.db")
  if (db && fs.existsSync(db)) {
    // char(9) is a tab, which a branch name can't hold.
    const rows = cli("sqlite3", [
      "-readonly",
      db,
      "SELECT branch_name || char(9) || COALESCE(parent_branch_name, '') FROM branch_metadata;",
    ])
    for (const line of rows.split(/\r?\n/)) {
      const [branch, parent] = line.split("\t")
      if (branch && parent) {
        parents.set(branch, parent)
      }
    }
  }
  const refs = git([
    "for-each-ref",
    "--format=%(refname:strip=2)",
    "refs/branch-metadata/",
  ])
  for (const branch of refs ? refs.split(/\r?\n/) : []) {
    if (!branch || parents.has(branch)) {
      continue
    }
    try {
      const meta = JSON.parse(
        git(["cat-file", "-p", `refs/branch-metadata/${branch}`]) ?? "",
      ) as { parentBranchName?: unknown }
      if (typeof meta.parentBranchName === "string" && meta.parentBranchName) {
        parents.set(branch, meta.parentBranchName)
      }
    } catch {
      // Not Graphite's JSON: leave the branch untracked.
    }
  }
  return parents
}

/** `branch`'s chain down to `trunk` (left out), bottom first, and its stack's counts. */
export function downstackOf(
  branch: string,
  trunk: string,
  parents: Map<string, string>,
): Downstack {
  const chain = [branch]
  let cursor = branch
  while (chain.length < MAX_DEPTH) {
    const parent = parents.get(cursor)
    if (!parent || parent === trunk || chain.includes(parent)) {
      break
    }
    chain.push(parent)
    cursor = parent
  }
  chain.reverse()

  const children = new Map<string, string[]>()
  for (const [child, parent] of parents) {
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const descendants = (root: string): number => {
    const seen = new Set<string>()
    const queue = [...(children.get(root) ?? [])]
    while (queue.length > 0 && seen.size < MAX_DEPTH * MAX_DEPTH) {
      const next = queue.shift() as string
      if (next !== root && !seen.has(next)) {
        seen.add(next)
        queue.push(...(children.get(next) ?? []))
      }
    }
    return seen.size
  }
  return {
    chain,
    above: descendants(branch),
    size: 1 + descendants(chain[0]),
  }
}

export const downstack: Adapter = {
  needs: "cli",
  async run({ values }) {
    const branch = git(["branch", "--show-current"])
    if (!branch) {
      throw new Error("HEAD is detached: check out a branch first")
    }
    return downstackOf(branch, String(values.trunk), graphiteParents())
  },
}
