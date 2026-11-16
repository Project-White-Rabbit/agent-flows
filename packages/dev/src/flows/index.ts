import type { FlowOutputs, GeneratedFile } from "@agent-flows/core"
import {
  MARKETPLACE_SLOT,
  PLUGIN_SLOT,
  templatesDir,
} from "../commands/front-end.ts"
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
  HOSTS,
  type Host,
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
    outputs: Object.fromEntries(
      HOSTS.map((host) => [host, `${flowsDir(host)}/${flow.id}/flow.md`]),
    ) as Record<DevTargetName, string>,
  }),
)

/** What front ends check against: the contract and each host's flows. */
export function renderManifest(): GeneratedFile {
  const manifest = {
    plugin: BASE_PLUGIN,
    contract: FLOW_CONTRACT,
    hosts: Object.fromEntries(
      HOSTS.map((host) => [host, DEV_FLOWS.map((flow) => flow.id).sort()]),
    ),
  }
  return {
    flowId: "manifest",
    target: "claude",
    kind: "monolith",
    path: "flows/manifest.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  }
}

/**
 * Every flow's wrapper skill for every host, with slots for the front end's
 * plugin and marketplace, so `front-end.ts` can write a front end's skills
 * from the installed base with Node alone.
 */
export function renderFrontEndTemplates(): GeneratedFile[] {
  return HOSTS.flatMap((host) =>
    renderFrontEnd({
      host,
      plugin: PLUGIN_SLOT,
      marketplace: MARKETPLACE_SLOT,
      flows: DEV_FLOWS,
    }).map((file) => ({
      ...file,
      path: `${templatesDir(host)}/${file.flowId}/SKILL.md`,
    })),
  )
}

/** The base's generated files: every flow, and the manifest. */
export function renderBase(): GeneratedFile[] {
  return [...devKit.renderProject(DEV_PROJECTS), renderManifest()]
}

/**
 * The hosts the dev-flows front end ships for, each a plugin of its own under
 * `plugins/`. Amp's plugins are code that registers skills, so Amp users get
 * the base and write a front end with `front-end.ts --host amp`.
 */
export const DEV_FLOWS_FRONT_ENDS: { host: Host; dir: string }[] = [
  { host: "claude", dir: "dev-flows" },
  { host: "cursor", dir: "dev-flows-cursor" },
  { host: "codex", dir: "dev-flows-codex" },
]

/** The dev-flows front end for `host`: a wrapper skill for every flow. */
export function renderDevFlowsFrontEnd(host: Host = "claude"): GeneratedFile[] {
  return renderFrontEnd({
    host,
    plugin: "dev-flows",
    marketplace: BASE_MARKETPLACE,
    flows: DEV_FLOWS,
  })
}
