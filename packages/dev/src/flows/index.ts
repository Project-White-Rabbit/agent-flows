import type { FlowOutputs, GeneratedFile } from "@agent-flows/core"
import { cancelFlow } from "./cancel.ts"
import { configureFlow } from "./configure.ts"
import { createTicketsFlow } from "./create-tickets.ts"
import { evaluateFlow } from "./evaluate.ts"
import { finishFlow } from "./finish.ts"
import { BASE_MARKETPLACE, renderFrontEnd } from "./front-end.ts"
import {
  BASE_PLUGIN,
  type DevTargetName,
  devKit,
  FLOW_CONTRACT,
  flowsDir,
} from "./kit.ts"
import { previewFlow } from "./preview.ts"
import { prototypeFlow } from "./prototype.ts"
import { readyFlow } from "./ready.ts"
import { serverFlow } from "./server.ts"
import { startWorkFlow } from "./start-work.ts"
import { syncFlow } from "./sync.ts"
import { ticketsToWorkFlow } from "./tickets-to-work.ts"

export const DEV_FLOWS = [
  cancelFlow,
  configureFlow,
  createTicketsFlow,
  evaluateFlow,
  finishFlow,
  previewFlow,
  prototypeFlow,
  readyFlow,
  serverFlow,
  startWorkFlow,
  syncFlow,
  ticketsToWorkFlow,
]

/** Where each flow lands in the base, relative to its root. */
export const DEV_PROJECTS: FlowOutputs<DevTargetName>[] = DEV_FLOWS.map(
  (flow) => ({
    flow,
    outputs: { claude: `${flowsDir("claude")}/${flow.id}/flow.md` },
  }),
)

/** What front ends check against: the contract and each host's flows. */
export function renderManifest(): GeneratedFile {
  const manifest = {
    plugin: BASE_PLUGIN,
    contract: FLOW_CONTRACT,
    hosts: { claude: DEV_FLOWS.map((flow) => flow.id).sort() },
  }
  return {
    flowId: "manifest",
    target: "claude",
    kind: "monolith",
    path: "flows/manifest.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  }
}

/** The base's generated files: every flow, and the manifest. */
export function renderBase(): GeneratedFile[] {
  return [...devKit.renderProject(DEV_PROJECTS), renderManifest()]
}

/** The dev-flows front end: a wrapper skill for every flow. */
export function renderDevFlowsFrontEnd(): GeneratedFile[] {
  return renderFrontEnd({
    plugin: "dev-flows",
    marketplace: BASE_MARKETPLACE,
    flows: DEV_FLOWS,
  })
}
