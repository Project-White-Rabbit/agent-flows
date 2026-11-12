// Committed values that look true only for one person or machine. The
// committed config is the team's, so these are warnings: the value may still
// be meant, but usually belongs in this machine's override.

/** A path inside one person's home folder (`/Users/sam/…`, `/home/sam/…`). */
const HOME_PATH =
  /(^|[\s"'=:(])(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/

/**
 * The warning for a committed value that names a path in someone's home
 * folder, which no teammate has: `~/…` or a path in the repo works for all.
 */
export function homePathWarning(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(" ") : String(value)
  return HOME_PATH.test(text)
    ? "names a path in one person's home folder, which teammates don't have: use `~/…` or a path relative to the repo, or put it in this machine's override (`configure local`)"
    : undefined
}
