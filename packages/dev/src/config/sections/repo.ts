import type { SectionSpec } from "../types.ts"

export const repo: SectionSpec = {
  path: "repo",
  name: "Repository",
  purpose: "The branch work merges into, for diffs, reviews, and PRs",
  required: true,
  fields: [
    {
      key: "baseBranch",
      description: "Branch feature work merges into",
      example: "main",
      required: true,
    },
  ],
  lookup: "`git symbolic-ref --short refs/remotes/origin/HEAD`, or ask",
  detect(ctx) {
    const head = ctx.git([
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
    if (head) {
      return {
        values: { baseBranch: head.replace(/^origin\//, "") },
        evidence: [`origin/HEAD is ${head}`],
      }
    }
    for (const candidate of ["main", "master"]) {
      if (
        ctx.git(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])
      ) {
        return {
          values: { baseBranch: candidate },
          evidence: [`local branch ${candidate} exists`],
        }
      }
    }
    return undefined
  },
}
