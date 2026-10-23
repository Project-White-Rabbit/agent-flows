// Naming the instances of a section configured more than once. Names show up
// in flow targets (`pr:github:app:12`) and coverage (`vercel:web`), so they're
// kept to a slug alphabet with no `:`.
//
// Runtime code, imported by detectors and the config core alike, so it depends
// on nothing else in the package.

/** The field that tells instances apart in a section configured as a list. */
export const INSTANCE_KEY = "name"

export const INSTANCE_NAME = /^[a-z0-9][a-z0-9._-]*$/

/** `Apps/Web App` → `apps-web-app`; never empty. */
export function toInstanceName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
  return slug === "" ? "default" : slug
}

/**
 * Names for detected instances: each preferred name, made unique by falling
 * back to its fallback (a directory path, say), then to a numeric suffix.
 */
export function uniqueInstanceNames(
  candidates: { preferred: string; fallback: string }[],
): string[] {
  const preferred = candidates.map((c) => toInstanceName(c.preferred))
  const names = preferred.map((name, i) =>
    preferred.indexOf(name) === preferred.lastIndexOf(name)
      ? name
      : toInstanceName(candidates[i].fallback),
  )
  const taken = new Set<string>()
  return names.map((name) => {
    const free = freeInstanceName(name, taken)
    taken.add(free)
    return free
  })
}

/** `name`, or the first `name-2`, `name-3`, … not in `taken`. */
export function freeInstanceName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${name}-${n}`
  }
  return candidate
}
