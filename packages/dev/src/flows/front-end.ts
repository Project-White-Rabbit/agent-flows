import {
  claudeFrontmatter,
  entryFrontmatterInput,
  type Flow,
  type GeneratedFile,
} from "@agent-flows/core"
import {
  BASE_PLUGIN,
  BASE_ROOT_VAR,
  CALLER_CMDS,
  devKit,
  FLOW_CONTRACT,
  flowsDir,
  HOST_NAMES,
  type Host,
  hostTarget,
} from "./kit.ts"

/** The marketplace the base ships from. */
export const BASE_MARKETPLACE = "agent-flows"

/** The repository the base ships from, for hosts that install from it. */
export const BASE_REPO = "Project-White-Rabbit/agent-flows"

/**
 * Where someone can clone the base by hand, for a host with no way to install
 * it (Amp), relative to `$XDG_CONFIG_HOME` (`~/.config`). The lookup takes
 * the clone itself or its `packages/dev`.
 */
export const MANUAL_BASE_DIR = `agent-flows/${BASE_PLUGIN}`

export interface FrontEndOptions {
  /** The front end's plugin name: its commands are `/<plugin>:<flow>`. */
  plugin: string
  /** The marketplace the front end ships from, for its update hint. */
  marketplace: string
  /** The base's flows to wrap. */
  flows: readonly Flow[]
  /** The host the front end is a plugin for. Default `claude`. */
  host?: Host
  /** Flow ids to leave out, e.g. ones the front end has its own version of. */
  exclude?: readonly string[]
  /** First line of every wrapper. */
  generatedNotice?: string
}

/** How `host` writes the front end's command prefix: `/acme:`, `$acme:`. */
export function commandPrefix(host: Host, plugin: string): string {
  return CALLER_CMDS[host].replace("<caller>", plugin)
}

/**
 * The directory under `skills/` a host looks for a flow's skill in: the flow's
 * id, or on Cursor, whose skills share one namespace, `<plugin>-<flow>`.
 */
export function skillDirName(
  host: Host,
  plugin: string,
  flowId: string,
): string {
  return host === "cursor" ? `${plugin}-${flowId}` : flowId
}

/**
 * One skill per base flow, named after the flow under the front end's own
 * plugin, in the host's skill format. Each sends the agent to the flow's file
 * in the base, as this front end, so every command the flow names is the
 * front end's. The wrapper holds no workflow of its own: when the base
 * updates, the front end gets the change with nothing to rebuild.
 */
export function renderFrontEnd(options: FrontEndOptions): GeneratedFile[] {
  const host = options.host ?? "claude"
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
      target: host,
      kind: "monolith" as const,
      path: `skills/${skillDirName(host, options.plugin, flow.id)}/SKILL.md`,
      content: renderWrapper(flow, options, host),
    }))
}

function renderWrapper(
  flow: Flow,
  options: FrontEndOptions,
  host: Host,
): string {
  const cmd = commandPrefix(host, options.plugin)
  const input = entryFrontmatterInput(flow, devKit.targets[host])
  const description = input.description.replaceAll("{{cmd}}", cmd)
  if (/\{\{/.test(description)) {
    throw new Error(
      `renderFrontEnd: ${flow.id}'s description has a placeholder a wrapper can't fill: ${description}`,
    )
  }
  const target = hostTarget(host, options.plugin)
  const frontmatter =
    host === "claude"
      ? claudeFrontmatter({ ...input, description })
      : // These hosts' presets add ". Invoke with …" after the description.
        target.frontmatter({
          ...input,
          description: description.replace(/\.$/, ""),
        })
  const file = `${flowsDir(host)}/${flow.id}/flow.md`
  const notice =
    options.generatedNotice ??
    `<!-- Generated: sends ${cmd}${flow.id} to the ${flow.id} flow in ${BASE_PLUGIN}. Do not edit by hand. -->`
  const head = `${frontmatter}

${notice}

# ${cmd}${flow.id}

This command's instructions are in the ${BASE_PLUGIN} plugin.
`
  if (host === "claude") {
    return `${head}
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
  const args = target.argsToken.startsWith("$")
    ? `with these arguments: ${target.argsToken}`
    : `with the arguments in ${target.argsToken}`
  return `${head}
1. **Find ${BASE_PLUGIN}.** In a shell, run \`echo "$${BASE_ROOT_VAR}"\`. When it prints nothing, run \`${locateBaseCommand(host)}\`, which prints the newest ${BASE_PLUGIN} installed where ${HOST_NAMES[host]} or another agent host keeps plugins, or cloned to \`~/.config/${MANUAL_BASE_DIR}\`.

   When neither prints a directory, stop: ${BASE_PLUGIN} isn't installed. Tell the user to ${installHint(host)}, then start a new session.
2. **Check it's one this plugin can follow.** Read the \`contract\` in \`<that directory>/flows/manifest.json\`. When it isn't ${FLOW_CONTRACT}, stop: ${options.plugin} is out of date for the installed ${BASE_PLUGIN}. Tell the user to update the ${options.plugin} plugin (from ${options.marketplace}) and start a new session.
3. **Follow the flow.** Read \`<that directory>/${file}\` with your file-reading tool and follow it to the end, as the caller \`${options.plugin}\` (its commands are \`${cmd}<name>\`), ${args}.

   When \`echo "$${BASE_ROOT_VAR}"\` printed nothing, write that directory in place of \`$${BASE_ROOT_VAR}\` in every command the flow gives.
`
}

/** How a host's user gets the base. */
function installHint(host: Host): string {
  const clone = `git clone https://github.com/${BASE_REPO} ~/.config/${MANUAL_BASE_DIR}`
  switch (host) {
    case "cursor":
      return `install the ${BASE_PLUGIN} plugin from the ${BASE_MARKETPLACE} marketplace (https://github.com/${BASE_REPO}), or run \`${clone}\``
    case "codex":
      return `run \`codex plugin marketplace add ${BASE_REPO}\` and install ${BASE_PLUGIN} from it, or run \`${clone}\``
    default:
      return `run \`${clone}\``
  }
}

/**
 * A shell command printing the base's install directory on a host with no
 * startup hook to say it: the newest version among the places `host` installs
 * plugins, else the places the other hosts do, else a clone at
 * `~/.config/agent-flows/dev-flows-base`. A directory counts only when its
 * manifest lists flows for `host`. It prints nothing when there's none.
 */
export function locateBaseCommand(host: Host): string {
  const js = [
    `const f=require("fs"),p=require("path"),h=require("os").homedir(),e=process.env,host=process.argv[1],N="${BASE_PLUGIN}"`,
    `const x=e.XDG_CONFIG_HOME||p.join(h,".config")`,
    `const k=d=>{try{return f.readdirSync(d).map(n=>p.join(d,n))}catch{return[]}}`,
    `const vs=m=>[p.join(m,N),...k(p.join(m,N))]`,
    `let r="";try{r=require("child_process").execSync("git rev-parse --show-toplevel",{stdio:["ignore","pipe","ignore"]}).toString().trim()}catch{}`,
    `const g={claude:k(p.join(e.CLAUDE_CONFIG_DIR||p.join(h,".claude"),"plugins","cache")).flatMap(vs),cursor:[p.join(h,".cursor","plugins","local",N),...k(p.join(h,".cursor","plugins","cache")).flatMap(vs)],codex:k(p.join(e.CODEX_HOME||p.join(h,".codex"),"plugins","cache")).flatMap(vs),amp:[r&&p.join(r,".amp","plugins",N),p.join(x,"amp","plugins",N)],clone:[p.join(x,"${MANUAL_BASE_DIR}"),p.join(x,"${MANUAL_BASE_DIR}","packages","dev")]}`,
    `const j=(d,...a)=>{try{return JSON.parse(f.readFileSync(p.join(d,...a),"utf8"))}catch{}}`,
    `const v=d=>String(j(d,".claude-plugin","plugin.json")?.version||"0").split(".").map(Number)`,
    `const c=(a,b)=>{for(let i=0;i<3;i++){const d=(b[i]||0)-(a[i]||0);if(d)return d}return 0}`,
    `for(const n of [host,...Object.keys(g).filter(n=>n!==host)]){const o=(g[n]||[]).filter(d=>d&&j(d,"flows","manifest.json")?.hosts?.[host]).sort((a,b)=>c(v(a),v(b)));if(o.length){console.log(o[0]);break}}`,
  ].join(";")
  return `node -e '${js}' ${host}`
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
