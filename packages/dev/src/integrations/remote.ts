import type { DetectContext } from "../config/types.ts"

/**
 * The repository the team shares, from the checkout's remotes: `upstream`
 * when there is one that `parse` reads (in a fork workflow `origin` is the
 * person's own fork, which no teammate pushes to), else `origin`.
 */
export function teamRemote<T>(
  ctx: DetectContext,
  parse: (url: string) => T | undefined,
): { parsed: T; remote: string; url: string } | undefined {
  for (const remote of ["upstream", "origin"]) {
    const url = ctx.git(["remote", "get-url", remote])?.trim()
    const parsed = url ? parse(url) : undefined
    if (url && parsed) {
      return { parsed, remote, url }
    }
  }
  return undefined
}

/** Evidence for the remote `teamRemote` chose. */
export function remoteEvidence({
  remote,
  url,
}: {
  remote: string
  url: string
}): string {
  return remote === "upstream"
    ? `upstream remote ${url} (origin, a fork, is one person's)`
    : `origin remote ${url}`
}
