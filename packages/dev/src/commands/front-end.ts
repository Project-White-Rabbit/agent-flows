// Writes a front-end plugin's skills from the installed base: one wrapper per
// flow, sending `/<plugin>:<flow>` (or the host's form of it) to the flow's
// file in dev-flows-base. The build renders each wrapper once per host as a
// template (flows/<host>/front-end), with slots for the front end's plugin
// and marketplace, so this command needs nothing but Node: a front end in
// another repo runs it from the base the session already has, and
// FRONT-END.md walks an agent through the rest.
//
// A front end can keep its own version of a flow (`--exclude`); this never
// overwrites a skill it didn't write, and only removes wrappers it wrote.

import fs from "node:fs"
import path from "node:path"
import {
  isMain,
  parseFlags,
  printJson,
  requiredFlag,
  runSubcommand,
  UsageError,
} from "./lib.ts"

/** The hosts a front end can be a plugin for. */
export const FRONT_END_HOSTS = ["claude", "cursor", "codex", "amp"] as const

export type FrontEndHost = (typeof FRONT_END_HOSTS)[number]

/** Where the base keeps a host's wrapper templates, relative to its root. */
export function templatesDir(host: FrontEndHost): string {
  return `flows/${host}/front-end`
}
/** Stands for the front end's plugin name in a template. */
export const PLUGIN_SLOT = "__FRONT_END_PLUGIN__"
/** Stands for the front end's marketplace in a template. */
export const MARKETPLACE_SLOT = "__FRONT_END_MARKETPLACE__"
/** Every wrapper's notice starts with this; nothing else is ever replaced. */
export const WRAPPER_MARK = "<!-- Generated: sends "

const NAME = /^[a-z0-9][a-z0-9-]*$/

const USAGE = `Usage: front-end.ts <write|check> --plugin <name> --marketplace <name> --dir <plugin dir> [--host <claude|cursor|codex|amp>] [--exclude <flow,flow>]

  write   writes <dir>/skills/<flow>/SKILL.md (on Cursor, skills/<plugin>-<flow>)
          for every base flow not excluded, and removes wrappers it wrote
          earlier for flows now excluded or gone
  check   writes nothing; exits 1 when a wrapper is missing, stale, or left over

  --host  the agent host the front end is a plugin for (default claude)`

export interface FrontEndArgs {
  /** Default `claude`. */
  host?: FrontEndHost
  plugin: string
  marketplace: string
  dir: string
  exclude: string[]
}

/** A template with the front end's names in place of the slots. */
export function fill(
  template: string,
  plugin: string,
  marketplace: string,
): string {
  return template
    .replaceAll(PLUGIN_SLOT, plugin)
    .replaceAll(MARKETPLACE_SLOT, marketplace)
}

/** The base's wrapper templates for `host`, by flow id. */
export function readTemplates(
  base: string,
  host: FrontEndHost = "claude",
): Map<string, string> {
  const dir = path.join(base, templatesDir(host))
  if (!fs.existsSync(dir)) {
    throw new UsageError(
      `no ${host} wrapper templates in ${dir}: the installed dev-flows-base is older than this command, or ${base} isn't dev-flows-base`,
    )
  }
  const templates = new Map<string, string>()
  for (const flow of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, flow, "SKILL.md")
    if (fs.existsSync(file)) {
      templates.set(flow, fs.readFileSync(file, "utf8"))
    }
  }
  return templates
}

export interface FrontEndPlan {
  /** Wrappers to write: new or changed, by flow. */
  write: { flow: string; file: string; content: string }[]
  unchanged: string[]
  /** Wrappers this command wrote earlier that no flow wants any more. */
  remove: string[]
  /** Excluded flows the front end has its own skill or command for. */
  own: string[]
  /** Excluded flows nothing in the front end answers: base flows call them. */
  missing: string[]
}

/** The directory under `skills/` a flow's skill is in: on Cursor, `<plugin>-<flow>`. */
function skillDir(args: FrontEndArgs, flow: string): string {
  return args.host === "cursor" ? `${args.plugin}-${flow}` : flow
}

/** The flow a directory under `skills/` is for, undoing `skillDir`. */
function flowOfSkillDir(args: FrontEndArgs, name: string): string | undefined {
  if (args.host !== "cursor") {
    return name
  }
  const prefix = `${args.plugin}-`
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined
}

/** The front end's own skill or command named `flow`, when it has one. */
function ownFile(args: FrontEndArgs, flow: string): string | undefined {
  const name = skillDir(args, flow)
  return [
    path.join(args.dir, "skills", name, "SKILL.md"),
    path.join(args.dir, "commands", `${name}.md`),
  ].find((file) => fs.existsSync(file) && !isWrapper(file))
}

function isWrapper(file: string): boolean {
  return fs.readFileSync(file, "utf8").includes(WRAPPER_MARK)
}

/** What `write` would do to the front end at `args.dir`. */
export function planFrontEnd(
  templates: Map<string, string>,
  args: FrontEndArgs,
): FrontEndPlan {
  for (const [flag, value] of [
    ["plugin", args.plugin],
    ["marketplace", args.marketplace],
  ]) {
    if (!NAME.test(value)) {
      throw new UsageError(
        `--${flag} must be lowercase letters, digits, and dashes: ${value}`,
      )
    }
  }
  const unknown = args.exclude.filter((flow) => !templates.has(flow))
  if (unknown.length > 0) {
    throw new UsageError(
      `--exclude names no base flow: ${unknown.join(", ")} (flows: ${[...templates.keys()].join(", ")})`,
    )
  }
  const exclude = new Set(args.exclude)
  const plan: FrontEndPlan = {
    write: [],
    unchanged: [],
    remove: [],
    own: [],
    missing: [],
  }
  for (const [flow, template] of templates) {
    const file = path.join(args.dir, "skills", skillDir(args, flow), "SKILL.md")
    if (exclude.has(flow)) {
      if (fs.existsSync(file) && isWrapper(file)) {
        plan.remove.push(file)
      }
      if (ownFile(args, flow)) {
        plan.own.push(flow)
      } else {
        plan.missing.push(flow)
      }
      continue
    }
    const own = ownFile(args, flow)
    if (own) {
      throw new UsageError(
        `${own} is the front end's own ${flow}, not a wrapper; pass --exclude ${flow} to keep it, or delete it to use the base's`,
      )
    }
    const content = fill(template, args.plugin, args.marketplace)
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) {
      plan.unchanged.push(flow)
    } else {
      plan.write.push({ flow, file, content })
    }
  }
  const skills = path.join(args.dir, "skills")
  if (fs.existsSync(skills)) {
    for (const name of fs.readdirSync(skills).sort()) {
      const file = path.join(skills, name, "SKILL.md")
      const flow = flowOfSkillDir(args, name)
      if (
        (flow === undefined || !templates.has(flow)) &&
        fs.existsSync(file) &&
        isWrapper(file)
      ) {
        plan.remove.push(file)
      }
    }
  }
  return plan
}

function baseRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..")
}

function report(plan: FrontEndPlan, base: string, wrote: boolean): void {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "flows", "manifest.json"), "utf8"),
  )
  printJson({
    base,
    contract: manifest.contract,
    [wrote ? "written" : "stale"]: plan.write.map((entry) => entry.flow),
    unchanged: plan.unchanged,
    [wrote ? "removed" : "leftOver"]: plan.remove,
    own: plan.own,
    missing: plan.missing,
  })
  if (plan.missing.length > 0) {
    console.error(
      `warning: the base's flows call ${plan.missing.map((flow) => `/<plugin>:${flow}`).join(", ")}, and nothing in the front end answers. Give it its own version, or stop excluding it.`,
    )
  }
}

function parse(rest: string[]): FrontEndArgs {
  const flags = parseFlags(rest)
  const host = flags.get("host") ?? "claude"
  if (!(FRONT_END_HOSTS as readonly string[]).includes(host)) {
    throw new UsageError(
      `--host must be one of ${FRONT_END_HOSTS.join(", ")}: ${host}`,
    )
  }
  return {
    host: host as FrontEndHost,
    plugin: requiredFlag(flags, "plugin"),
    marketplace: requiredFlag(flags, "marketplace"),
    dir: path.resolve(requiredFlag(flags, "dir")),
    exclude: (flags.get("exclude") ?? "")
      .split(",")
      .map((flow) => flow.trim())
      .filter(Boolean),
  }
}

function main(): void {
  runSubcommand(
    process.argv.slice(2),
    USAGE,
    {
      write: (args: FrontEndArgs) => {
        const base = baseRoot()
        const plan = planFrontEnd(readTemplates(base, args.host), args)
        for (const { file, content } of plan.write) {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
        }
        for (const file of plan.remove) {
          fs.rmSync(file)
          const dir = path.dirname(file)
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir)
          }
        }
        report(plan, base, true)
      },
      check: (args: FrontEndArgs) => {
        const base = baseRoot()
        const plan = planFrontEnd(readTemplates(base, args.host), args)
        report(plan, base, false)
        if (plan.write.length + plan.remove.length > 0) {
          process.exitCode = 1
        }
      },
    },
    parse,
  )
}

if (isMain(import.meta.filename)) {
  main()
}
