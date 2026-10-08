#!/usr/bin/env bash
# Install the packed tarball into a fresh project and render a flow through
# the public API, so a broken `exports`/`files`/types setup fails CI.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pnpm --dir "$root" pack --pack-destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund ./agent-flows-*.tgz "zod@${ZOD_VERSION:-4}" typescript@5 @types/node@22 >/dev/null

cat > smoke.ts <<'TS'
import { claudeCode, createFlowKit } from "agent-flows"

const kit = createFlowKit({ targets: { claude: claudeCode({ plugin: "demo" }) } })
const flow = kit.defineFlow({
  schemaVersion: 1,
  id: "hello",
  title: "Hello",
  frontmatter: { description: "Say hello" },
  entries: { default: "main/hi" },
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [{ id: "hi", kind: "action", title: "Hi", body: "Say hi.", next: null }],
    },
  ],
})
const out: string = kit.renderMarkdown(flow, "claude")
if (!out.includes("Say hi.")) throw new Error("render failed")
console.log("smoke ok")
TS
mv smoke.ts smoke.mts

# The README's first ```ts block must type-check and run as written.
awk '/^```ts$/{f=1;next} /^```$/{if(f)exit} f' "$root/README.md" > readme.mts
test -s readme.mts

npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext \
  --target es2022 --types node --skipLibCheck false smoke.mts readme.mts
node --no-warnings smoke.mts
node --no-warnings readme.mts
test -f plugins/claude/skills/deploy/SKILL.md
echo "readme ok"
