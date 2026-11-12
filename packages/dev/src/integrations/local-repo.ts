// Finding this repository in a local workspace app (Orca, Superset), whose ids
// for it are made by the app on each machine when someone adds the folder, so
// they never go in the committed config. Each machine finds its own: by the
// main checkout's path, then by origin.
//
// Runtime code: Node built-ins only.

import fs from "node:fs"
import path from "node:path"
import type { SessionContext } from "../config/types.ts"

/** This checkout, as an app would know the repository it belongs to. */
export type Checkout = {
  /** The worktree this session is in (`git rev-parse --show-toplevel`). */
  root: string
  /** The main checkout, the one the app added; undefined for a bare repo. */
  main?: string
  /** origin's URL, when there is one. */
  origin?: string
}

export async function checkoutOf(session: SessionContext): Promise<Checkout> {
  const [common, origin] = await Promise.all([
    session.run(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      session.root,
    ),
    session.run(["git", "remote", "get-url", "origin"], session.root),
  ])
  const dir = common?.trim()
  const main =
    dir && path.basename(dir) === ".git" ? path.dirname(dir) : undefined
  return {
    root: session.root,
    ...(main ? { main } : {}),
    ...(origin?.trim() ? { origin: origin.trim() } : {}),
  }
}

function real(p: string): string {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p
  try {
    return fs.realpathSync(trimmed)
  } catch {
    return path.resolve(trimmed)
  }
}

/** The same folder, through symlinks (`/tmp` and `/private/tmp`) too. */
export function samePath(a: string | undefined, b: string | undefined) {
  return Boolean(a && b) && real(a as string) === real(b as string)
}

/**
 * A remote URL as `host/owner/repo`, lowercased, whatever its form
 * (`git@host:owner/repo.git`, `https://user@host/owner/repo`,
 * `ssh://git@host:22/owner/repo`), so two clones of one repo compare equal.
 * Orca's `gitRemoteIdentity.canonicalKey` has this shape.
 */
export function remoteKey(url: string | undefined): string | undefined {
  let rest = url?.trim()
  if (!rest) {
    return undefined
  }
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//i)
  if (scheme) {
    rest = rest.slice(scheme[0].length)
    const slash = rest.indexOf("/")
    const host = (slash < 0 ? rest : rest.slice(0, slash))
      .replace(/^[^@]*@/, "")
      .replace(/:\d+$/, "")
    rest = `${host}${slash < 0 ? "" : rest.slice(slash)}`
  } else {
    // scp-like: [user@]host:owner/repo
    rest = rest.replace(/^[^@/]*@/, "").replace(/^([^:/]+):/, "$1/")
  }
  const key = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase()
  return key.includes("/") ? key : undefined
}

/** Where this repository is, for messages: its main checkout, else this one. */
export function where(checkout: Checkout): string {
  return checkout.main ?? checkout.root
}

/**
 * The one of an app's entries for this repository: the one at the main
 * checkout, else the one whose remote is origin. Several by origin and none at
 * this path (two clones of it added) is ambiguous, so it's a problem, never a
 * guess; so is none.
 */
export function pickEntry<T>(
  entries: T[],
  checkout: Checkout,
  {
    pathOf,
    keysOf,
  }: {
    pathOf(entry: T): string | undefined
    /** The entry's remote, as `remoteKey` would give it. */
    keysOf(entry: T): (string | undefined)[]
  },
): { entry: T } | { ambiguous: T[] } | { none: true } {
  const atPath = entries.filter(
    (e) =>
      samePath(pathOf(e), checkout.main) || samePath(pathOf(e), checkout.root),
  )
  if (atPath.length === 1) {
    return { entry: atPath[0] }
  }
  const origin = remoteKey(checkout.origin)
  const byOrigin = origin
    ? entries.filter((e) =>
        keysOf(e).some((k) => k !== undefined && k.toLowerCase() === origin),
      )
    : []
  if (byOrigin.length === 1) {
    return { entry: byOrigin[0] }
  }
  if (byOrigin.length > 1) {
    return { ambiguous: byOrigin }
  }
  return atPath.length > 1 ? { ambiguous: atPath } : { none: true }
}
