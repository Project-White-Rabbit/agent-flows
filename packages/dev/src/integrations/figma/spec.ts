import type {
  DetectContext,
  Detection,
  FieldPattern,
  IntegrationSpec,
} from "../../config/types.ts"

/** A Figma design file's URL, with an optional node id or branch. */
export const FIGMA_URL: FieldPattern = {
  regex:
    /^https:\/\/(www\.)?figma\.com\/(design|file)\/[A-Za-z0-9]+(\/branch\/[A-Za-z0-9]+)?(\/[^\s?#]*)?(\?[^\s#]*)?$/,
  hint: "a Figma file URL (`https://www.figma.com/design/<fileKey>/<name>`)",
}

const URL_IN_TEXT =
  /https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[A-Za-z0-9]+(?:\/branch\/[A-Za-z0-9]+)?(?:\/[^\s?#)\]>"'`]*)?(?:\?[^\s#)\]>"'`]*)?/g

/** Code Connect files and config: the repo maps its components to Figma. */
const CODE_CONNECT = /(^|\/)(figma\.config\.json|[^/]+\.figma\.(tsx?|jsx?))$/

/** Docs that link the team's design file, read for its URL. */
const DOCS = /(^|\/)(README|CLAUDE|AGENTS|DESIGN|CONTRIBUTING)\.md$/i

/** The Figma file most linked from the repo's docs and Code Connect files. */
export function detectFigma(ctx: DetectContext): Detection | undefined {
  const connect = ctx.tracked.filter((f) => CODE_CONNECT.test(f))
  const counts = new Map<string, number>()
  for (const file of [
    ...connect,
    ...ctx.tracked.filter((f) => DOCS.test(f)),
  ].slice(0, 200)) {
    for (const url of (ctx.read(file) ?? "").match(URL_IN_TEXT) ?? []) {
      // The file, not a node in it: the link without its query.
      const key = (url.split("?")[0] as string).replace(/\/+$/, "")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const evidence = [
    ...(connect.length > 0
      ? [`${connect.length} Figma Code Connect file(s) (${connect[0]})`]
      : []),
    ...(best ? [`the repo links the Figma file ${best[0]}`] : []),
  ]
  if (evidence.length === 0) {
    return undefined
  }
  return {
    values: best && FIGMA_URL.regex.test(best[0]) ? { file: best[0] } : {},
    evidence,
  }
}

const SKILLS =
  "When this session has the Figma plugin's skills, load `figma-use` before the first `use_figma` call and follow it"

const TARGET =
  "The file: <link>'s when given, else {file}. In a URL, the file key follows `/design/` (a branch URL's key is the one after `/branch/`), and a `node-id` of `12-345` is the node `12:345`"

export const figma: IntegrationSpec = {
  path: "integrations.figma",
  name: "Figma",
  purpose:
    "The team's designs and design system: the look mockups take, and where they go for the team",
  fields: [
    {
      key: "file",
      description:
        "The team's main design file or library: where prototype reads the design system from, and puts mockups when no other file is named. A file of its own for mockups works too, when the design system is a library it uses",
      example: "https://www.figma.com/design/AbC123xyz/Product",
      pattern: FIGMA_URL,
      required: true,
    },
  ],
  lookup:
    "A Figma URL the repo's docs or Code Connect files link, the Figma MCP's `get_libraries` for the team's library, or ask. Use `design` at `read` to only take mockups' look from it, `write` to also put mockups in it",
  access: { mcp: { server: "figma" } },
  provides: {
    design: {
      styleGuide: {
        mcp: `${SKILLS}. ${TARGET}. \`get_variable_defs\` on the file (or the node <link> names) for its color, spacing, and radius variables, with colors as hex; \`search_design_system\` (else \`get_libraries\`) for its text styles and main components. Print them as a short list`,
      },
      showMockup: {
        mcp: `${SKILLS}, and \`figma-generate-design\` too when there is one. ${TARGET}. Put the page in: \`html_to_figma\` with the HTML of <file> when the server has that tool; else build it with \`use_figma\` as \`figma-generate-design\` says (auto-layout frames, real text, the file's own components and variables where they match), never as a flattened screenshot. With <link>, replace the frames it names; else place new frames to the right of what's on the page. Name the top frame <title>. When Figma answers that a rate limit was hit, say so and stop: don't retry. Prints the frames' link: \`https://www.figma.com/design/<file key>/?node-id=<node id with : as ->\``,
      },
    },
  },
  detect: detectFigma,
}
