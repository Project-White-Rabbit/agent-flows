import {
  claudeFrontmatter,
  entryFrontmatterInput,
  type Flow,
  type GeneratedFile,
} from "@agent-flows/core"
import {
  BASE_PLUGIN,
  BASE_ROOT_VAR,
  devKit,
  FLOW_CONTRACT,
  flowsDir,
} from "./kit.ts"

/** The marketplace the base ships from. */
export const BASE_MARKETPLACE = "agent-flows"

export interface FrontEndOptions {
  /** The front end's plugin name: its commands are `/<plugin>:<flow>`. */
  plugin: string
  /** The marketplace the front end ships from, for its update hint. */
  marketplace: string
  /** The base's flows to wrap. */
  flows: readonly Flow[]
  /** Flow ids to leave out, e.g. ones the front end has its own version of. */
  exclude?: readonly string[]
  /** First line of every wrapper. */
  generatedNotice?: string
}

const HOST = "claude"

/**
 * One Claude Code skill per base flow, named after the flow under the front
 * end's own plugin. Each sends the agent to the flow's file in the base, as
 * this front end, so every command the flow names is the front end's. The
 * wrapper holds no workflow of its own: when the base updates, the front end
 * gets the change with nothing to rebuild.
 */
export function renderFrontEnd(options: FrontEndOptions): GeneratedFile[] {
  const exclude = new Set(options.exclude ?? [])
  const known = new Set(options.flows.map((flow) => flow.id))
  for (const id of exclude) {
    if (!known.has(id)) {
      throw new Error(`renderFrontEnd: exclude names no flow: ${id}`)
    }
  }
  return options.flows
    .filter((flow) => !exclude.has(flow.id))
    .map((flow) => ({
      flowId: flow.id,
      target: HOST,
      kind: "monolith" as const,
      path: `skills/${flow.id}/SKILL.md`,
      content: renderWrapper(flow, options),
    }))
}

function renderWrapper(flow: Flow, options: FrontEndOptions): string {
  const cmd = `/${options.plugin}:`
  const input = entryFrontmatterInput(flow, devKit.targets[HOST])
  const description = input.description.replaceAll("{{cmd}}", cmd)
  if (/\{\{/.test(description)) {
    throw new Error(
      `renderFrontEnd: ${flow.id}'s description has a placeholder a wrapper can't fill: ${description}`,
    )
  }
  const file = `${flowsDir(HOST)}/${flow.id}/flow.md`
  const notice =
    options.generatedNotice ??
    `<!-- Generated: sends ${cmd}${flow.id} to the ${flow.id} flow in ${BASE_PLUGIN}. Do not edit by hand. -->`
  return `${claudeFrontmatter({ ...input, description })}

${notice}

# ${cmd}${flow.id}

This command's instructions are in the ${BASE_PLUGIN} plugin.

1. **Find ${BASE_PLUGIN}.** Take the directory from the first of these that gives one:
   - the session start, which names the directory it's installed in;
   - in a shell, \`echo "$${BASE_ROOT_VAR}"\`;
   - in a shell, \`${installPathCommand()}\`, which prints where Claude Code installed it (for a session where its startup hook didn't run).

   When none gives one, stop: ${BASE_PLUGIN} isn't installed. Tell the user to run \`claude plugin install ${BASE_PLUGIN}@${BASE_MARKETPLACE}\` and start a new session.
2. **Check it's one this plugin can follow.** Its flow contract is the one the session start names, else the \`contract\` in \`<that directory>/flows/manifest.json\`. When it isn't ${FLOW_CONTRACT}, stop: ${options.plugin} is out of date for the installed ${BASE_PLUGIN}. Tell the user to run \`claude plugin update ${options.plugin}@${options.marketplace}\` and start a new session.
3. **Follow the flow.** Read \`<that directory>/${file}\` with the Read tool and follow it to the end, as the caller \`${options.plugin}\` (its commands are \`${cmd}<name>\`), with these arguments: $ARGUMENTS

   When \`echo "$${BASE_ROOT_VAR}"\` printed nothing, write that directory in place of \`$${BASE_ROOT_VAR}\` in every command the flow gives.
`
}

/**
 * A shell command printing the base's install directory from Claude Code's
 * record of installed plugins: the install for this project when there is
 * one, else the user's. It's the fallback for a session where the base's
 * SessionStart hook didn't run (hooks turned off), so nothing set the path.
 */
export function installPathCommand(): string {
  const js = [
    `const f=require("fs"),p=require("path")`,
    `const d=process.env.CLAUDE_CONFIG_DIR||p.join(require("os").homedir(),".claude")`,
    `const all=Object.entries(JSON.parse(f.readFileSync(p.join(d,"plugins","installed_plugins.json"),"utf8")).plugins).filter(([k])=>k.startsWith("${BASE_PLUGIN}@")).flatMap(([,v])=>v)`,
    `const r=x=>{try{return f.realpathSync(x)}catch{return x}}`,
    `const c=r(process.cwd())+"/"`,
    `const e=all.find(e=>e.projectPath&&c.startsWith(r(e.projectPath)+"/"))||all.find(e=>e.scope==="user")`,
    `if(e)console.log(e.installPath)`,
  ].join(";")
  return `node -e '${js}'`
}
