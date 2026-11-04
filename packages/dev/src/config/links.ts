// Document links as an issue description stores them. The Linear MCP's
// `get_issue` shows a stored `[Title](url)` document link as a tag, either
// `<document id="…" label="Title" href="url" />` or the older
// `<document id="…" href="url">Title</document>`. The MCP's `save_issue` turns
// its own tag back into the link, but the GraphQL API's `issueUpdate` stores
// it as text, nesting the link inside `href` (`href="[Title](url)"`), and the
// line stays garbled from then on. So every flow that writes a description it
// read makes the links plain first, whichever way it then writes.
//
// Runtime code: Node built-ins only.

const ATTRIBUTE = /\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/
const DOCUMENT_TAG = new RegExp(
  `<document\\b((?:${ATTRIBUTE.source})+)\\s*(?:/>|>([\\s\\S]*?)</document\\s*>)`,
  "g",
)
const ATTRIBUTES =
  /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const URL = /https?:\/\/[^\s()<>"'[\]]+/g

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
}

function decode(value: string): string {
  return value.replace(
    /&(amp|quot|apos|lt|gt|#39);/g,
    (_, name: string) => ENTITIES[name] ?? "'",
  )
}

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTES)) {
    found.set(name.toLowerCase(), decode(double ?? single ?? bare ?? ""))
  }
  return found
}

/**
 * `text` with each document tag the MCP shows as the plain link Linear stores:
 * `[title](url)`, the title from the paired tag's text, else its `label`, else
 * the URL. The URL is the last one in `href`, so an `href` an earlier write
 * already nested (`[Title](https://…)`) comes back as the link too. A tag with
 * no URL becomes its title. A tag with no attributes isn't the MCP's (a
 * mention of one, say), and it and everything else are left as they are, so a
 * second run changes nothing.
 */
export function plainDocumentLinks(text: string): string {
  return text.replace(DOCUMENT_TAG, (_, source: string, inner?: string) => {
    const attrs = attributes(source)
    const url = (attrs.get("href") ?? "").match(URL)?.at(-1)
    const title = inner?.trim() || attrs.get("label")?.trim() || url || ""
    return url ? `[${title}](${url})` : title
  })
}
