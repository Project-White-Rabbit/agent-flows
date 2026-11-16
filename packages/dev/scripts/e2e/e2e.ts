// End-to-end check of the plugins as people get them: this checkout served as
// a marketplace, dev-flows installed from it (pulling in dev-flows-base), and
// real headless Claude Code sessions running the flows in throwaway repos.
// GitHub is the fake in fake-gh.ts, so sync, ready, finish, evaluate, and
// cancel run all the way through, CI and merge included.
//
//   node scripts/e2e/e2e.ts [--only <run>,<run>] [--keep] [--list]
//
// Manual, not CI: it needs a signed-in `claude`, costs about $10 for every
// run, and a model's run varies. It installs into your Claude Code config at
// local scope (each run's directory) under the marketplace `agent-flows-e2e`,
// and removes all of it at the end, even when interrupted.

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:http"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { isMain } from "../../src/commands/lib.ts"
import { loadState, OWNER, REPO } from "./fake-gh.ts"

const MARKETPLACE = "agent-flows-e2e"
const ROOT = path.resolve(import.meta.dirname, "../../../..")
const BIN = path.join(import.meta.dirname, "bin")
const CONFIG = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")
const IDENTITY = ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e"]
// Inherited from a Claude Code session this is started from; a nested
// session must not think it's that one.
const SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_ENV_FILE",
  "DEV_FLOWS_BASE",
]

/** What the fake GitHub must show once a run ends. */
type Outcome = "pr-draft" | "pr-ready-green" | "merged" | "closed" | "unchanged"

interface RunSpec {
  name: string
  model: "opus" | "sonnet" | "haiku"
  prompt: string
  /** Turn off every hook, the base's SessionStart hook included. */
  hooksOff?: boolean
  /** Start with the work committed, pushed, and a draft PR open. */
  withPr?: boolean
  expect: Outcome
}

export const RUNS: RunSpec[] = [
  {
    name: "sync-opus",
    model: "opus",
    prompt: "/dev-flows:sync",
    expect: "pr-draft",
  },
  {
    name: "sync-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:sync",
    expect: "pr-draft",
  },
  {
    name: "sync-haiku",
    model: "haiku",
    prompt: "/dev-flows:sync",
    expect: "pr-draft",
  },
  {
    name: "ready-opus",
    model: "opus",
    prompt: "/dev-flows:ready",
    expect: "pr-ready-green",
  },
  {
    name: "ready-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:ready",
    expect: "pr-ready-green",
  },
  {
    name: "finish-opus",
    model: "opus",
    prompt: "/dev-flows:finish",
    expect: "merged",
  },
  {
    name: "finish-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:finish",
    expect: "merged",
  },
  {
    name: "evaluate-opus",
    model: "opus",
    prompt: "/dev-flows:evaluate",
    withPr: true,
    expect: "unchanged",
  },
  {
    name: "evaluate-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:evaluate",
    withPr: true,
    expect: "unchanged",
  },
  {
    name: "cancel-opus",
    model: "opus",
    prompt: "/dev-flows:cancel",
    withPr: true,
    expect: "closed",
  },
  {
    name: "cancel-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:cancel",
    withPr: true,
    expect: "closed",
  },
  {
    name: "ready-nohooks-opus",
    model: "opus",
    prompt: "/dev-flows:ready",
    hooksOff: true,
    expect: "pr-ready-green",
  },
  {
    name: "finish-nohooks-sonnet",
    model: "sonnet",
    prompt: "/dev-flows:finish",
    hooksOff: true,
    expect: "merged",
  },
]

interface Run extends RunSpec {
  dir: string
  work: string
  origin: string
  env: NodeJS.ProcessEnv
}

function git(args: string[], cwd?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`)
  }
  return r.stdout.trim()
}

/** A child process as a promise. Async on purpose: the marketplace server
 * runs in this process, and a blocking spawn would starve it. */
function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: string } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const file = options.stdout ? createWriteStream(options.stdout) : undefined
    const written = new Promise<void>((done) => {
      if (file) file.on("finish", done)
      else done()
    })
    if (file) {
      child.stdout?.pipe(file)
    } else {
      child.stdout?.on("data", (d) => {
        output += d
      })
    }
    child.stderr?.on("data", (d) => {
      output += d
    })
    child.on("close", (code) => {
      written.then(() => resolve({ code, output }))
    })
  })
}

const claude = (args: string[], cwd?: string) => exec("claude", args, { cwd })

/** This checkout, as the marketplace `agent-flows-e2e`, committed in a bare
 * repo: Claude Code installs plugins from git, not from a folder. */
function snapshotMarketplace(work: string): string {
  const files = git(["ls-files", "-co", "--exclude-standard"], ROOT)
    .split("\n")
    .filter((f) => f && existsSync(path.join(ROOT, f)))
  const tree = path.join(work, "marketplace")
  for (const file of files) {
    mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
    cpSync(path.join(ROOT, file), path.join(tree, file))
  }
  const rename = (file: string, from: RegExp, to: string) => {
    const full = path.join(tree, file)
    writeFileSync(full, readFileSync(full, "utf8").replace(from, to))
  }
  rename(
    ".claude-plugin/marketplace.json",
    /"name": "agent-flows"/,
    `"name": "${MARKETPLACE}"`,
  )
  rename(
    "plugins/dev-flows/.claude-plugin/plugin.json",
    /@agent-flows"/g,
    `@${MARKETPLACE}"`,
  )
  git(["init", "-q", "-b", "main"], tree)
  git(["add", "-A"], tree)
  git([...IDENTITY, "commit", "-qm", "e2e snapshot"], tree)
  const served = path.join(work, "served")
  mkdirSync(served)
  git(["clone", "-q", "--bare", tree, path.join(served, "marketplace.git")])
  return served
}

/** git's smart HTTP protocol over `git http-backend`, on a free local port. */
function serve(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const [pathInfo, query = ""] = (req.url ?? "").split("?")
      const body = Buffer.concat(chunks)
      const cgi = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: pathInfo,
          QUERY_STRING: query,
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          REMOTE_ADDR: "127.0.0.1",
          GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        },
      })
      const out: Buffer[] = []
      cgi.stdout.on("data", (c) => out.push(c))
      cgi.on("close", () => {
        const all = Buffer.concat(out)
        const split = all.indexOf("\r\n\r\n")
        const head = all.subarray(0, split).toString()
        let status = 200
        for (const line of head.split("\r\n")) {
          const [key, ...rest] = line.split(":")
          const value = rest.join(":").trim()
          if (key.toLowerCase() === "status")
            status = Number.parseInt(value, 10)
          else if (key) res.setHeader(key, value)
        }
        res.writeHead(status)
        res.end(all.subarray(split + 4))
      })
      cgi.stdin.end(body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/marketplace.git` })
    })
  })
}

/** A repo with a feature branch: one commit, a change not yet committed, and
 * a main that moved on since. Its origin's path ends in
 * `github.com/e2e-fake/app.git`, so it reads as the configured GitHub repo. */
function makeRepo(spec: RunSpec, runs: string): Run {
  const dir = path.join(runs, spec.name)
  const origin = path.join(dir, "github.com", OWNER, `${REPO}.git`)
  const seed = path.join(dir, "seed")
  const work = path.join(dir, "work")
  mkdirSync(path.dirname(origin), { recursive: true })
  git(["init", "-q", "--bare", "-b", "main", origin])
  git(["clone", "-q", origin, seed])
  const write = (root: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  write(
    seed,
    "package.json",
    '{ "name": "e2e-app", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  )
  write(seed, "math.js", "export function add(a, b) {\n  return a + b\n}\n")
  write(
    seed,
    "math.test.js",
    'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { add } from "./math.js"\n\ntest("add", () => assert.equal(add(2, 3), 5))\n',
  )
  write(seed, ".gitignore", ".claude/\nnode_modules/\n")
  write(seed, "README.md", "# e2e app\n")
  write(
    seed,
    ".agent-flows/config.json",
    `${JSON.stringify({
      version: 2,
      repo: { baseBranch: "main" },
      integrations: {
        github: { owner: OWNER, repo: REPO, use: { sourceControl: "write" } },
      },
    })}\n`,
  )
  git(["add", "-A"], seed)
  git([...IDENTITY, "commit", "-qm", "initial"], seed)
  git(["push", "-q", "origin", "main"], seed)

  git(["clone", "-q", origin, work])
  git(["config", "user.email", "e2e@example.com"], work)
  git(["config", "user.name", "e2e"], work)
  git(["checkout", "-q", "-b", "feat/multiply"], work)
  write(
    work,
    "math.js",
    `${readFileSync(path.join(work, "math.js"), "utf8")}\nexport function multiply(a, b) {\n  return a * b\n}\n`,
  )
  git(["commit", "-qam", "Add multiply"], work)
  const test = readFileSync(path.join(work, "math.test.js"), "utf8")
  write(
    work,
    "math.test.js",
    `${test.replace("import { add }", "import { add, multiply }")}test("multiply", () => assert.equal(multiply(2, 3), 6))\n`,
  )

  write(seed, "README.md", "# e2e app\n\nAdds numbers.\n")
  git([...IDENTITY, "commit", "-qam", "Describe the app"], seed)
  git(["push", "-q", "origin", "main"], seed)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_STATE: path.join(dir, "gh-state.json"),
    FAKE_GH_ORIGIN: origin,
  }
  for (const name of SESSION_VARS) delete env[name]
  if (spec.withPr) {
    git(["add", "-A"], work)
    git(["commit", "-qm", "Add multiply test"], work)
    git(["push", "-q", "-u", "origin", "feat/multiply"], work)
    const r = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        "main",
        "--head",
        "feat/multiply",
        "--title",
        "Add multiply",
        "--body",
        "Adds multiply.",
      ],
      { cwd: work, env, encoding: "utf8" },
    )
    if (r.status !== 0) throw new Error(`fake gh pr create: ${r.stderr}`)
  }
  return { ...spec, dir, work, origin, env }
}

/** Installs the e2e plugins at local scope in the run's directory. One at a
 * time: concurrent installs lose each other's writes to the shared record. */
async function install(run: Run, marketplaceUrl: string): Promise<void> {
  const steps = [
    ["plugin", "marketplace", "add", marketplaceUrl, "--scope", "local"],
    ["plugin", "install", `dev-flows@${MARKETPLACE}`, "-s", "local"],
  ]
  for (const args of steps) {
    const r = await claude(args, run.work)
    if (r.code !== 0) throw new Error(`claude ${args.join(" ")}: ${r.output}`)
  }
  // The real dev-flows, when installed, would add a second /dev-flows:sync.
  await claude(
    ["plugin", "disable", "dev-flows@agent-flows", "-s", "local"],
    run.work,
  )
  const settings = path.join(run.work, ".claude", "settings.local.json")
  const local = JSON.parse(readFileSync(settings, "utf8"))
  if (run.hooksOff) local.disableAllHooks = true
  writeFileSync(settings, JSON.stringify(local, null, 2))
}

async function session(run: Run): Promise<void> {
  await exec(
    "claude",
    [
      "-p",
      run.prompt,
      "--model",
      run.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: run.work,
      env: run.env,
      stdout: path.join(run.dir, "session.jsonl"),
    },
  )
}

interface Report {
  name: string
  model: string
  cost: number
  seconds: number
  loaded: string[]
  problems: string[]
  result: string
}

/** The parts of the stream-json events a report reads. */
interface SessionEvent {
  type?: string
  subtype?: string
  model?: string
  skills?: string[]
  message?: {
    content: {
      type: string
      text?: string
      name?: string
      input?: { command?: string; file_path?: string }
    }[]
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

/** What the session did, and whether it ended where the run expects. */
function report(run: Run): Report {
  const problems: string[] = []
  const loaded: string[] = []
  const bash: string[] = []
  let result = ""
  let cost = 0
  let seconds = 0
  let model = run.model as string
  let ended = false
  const file = path.join(run.dir, "session.jsonl")
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : []
  for (const line of lines) {
    let event: SessionEvent
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "system" && event.subtype === "init") {
      model = event.model ?? model
      if (!(event.skills ?? []).includes(run.prompt.slice(1))) {
        problems.push(`${run.prompt} wasn't loaded in the session`)
      }
    }
    if (event.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type === "text" && part.text?.includes("<caller>")) {
          problems.push(`said <caller>: ${part.text.slice(0, 120)}`)
        }
        if (part.type !== "tool_use") continue
        const input = JSON.stringify(part.input)
        if (input.includes("<caller>")) {
          problems.push(`${part.name} with <caller>: ${input.slice(0, 160)}`)
        }
        const command = part.input?.command ?? ""
        if (part.name === "Bash") bash.push(command)
        const flowFiles = [
          ...(part.name === "Read" ? [part.input?.file_path ?? ""] : []),
          ...(command.match(/flows\/claude\/[\w-]+\/[\w/.-]+\.md/g) ?? []),
        ]
        for (const f of flowFiles) {
          const short = f.match(/flows\/claude\/.+$/)?.[0]
          if (short && !loaded.includes(short)) loaded.push(short)
        }
      }
    }
    if (event.type === "result") {
      ended = true
      result = event.result ?? ""
      cost = event.total_cost_usd ?? 0
      seconds = Math.round((event.duration_ms ?? 0) / 1000)
      if (event.is_error) problems.push("the session ended in an error")
    }
  }
  if (!ended) problems.push("the session never finished")
  if (!loaded.some((f) => f.endsWith("/flow.md")))
    problems.push("never loaded a flow file")
  if (result.includes("<caller>")) problems.push("the report says <caller>")
  if (/isn't installed|plugin install dev-flows-base/.test(result)) {
    problems.push("the report says the base is missing")
  }
  for (const command of bash) {
    if (
      /src\/commands\//.test(command) &&
      !/DEV_FLOWS_BASE|dev-flows-base/.test(command)
    ) {
      problems.push(
        `ran a base script without the base path: ${command.slice(0, 120)}`,
      )
    }
  }
  problems.push(...outcomeProblems(run))
  return { name: run.name, model, cost, seconds, loaded, problems, result }
}

function outcomeProblems(run: Run): string[] {
  const state = loadState(path.join(run.dir, "gh-state.json"))
  const pr = state.prs.at(-1)
  const remote = spawnSync(
    "git",
    [
      "--git-dir",
      run.origin,
      "rev-parse",
      "--verify",
      "-q",
      "refs/heads/feat/multiply",
    ],
    { encoding: "utf8" },
  ).stdout.trim()
  const main = git(["--git-dir", run.origin, "log", "--format=%s", "main"])
  const want = (ok: boolean, what: string) => (ok ? [] : [`expected ${what}`])
  switch (run.expect) {
    case "pr-draft":
      return [
        ...want(pr?.state === "OPEN" && pr.isDraft, "an open draft PR"),
        ...want(Boolean(remote), "the branch pushed"),
        ...want(
          remote !== "" && state.checks[remote] !== "fail",
          "no failing CI",
        ),
      ]
    case "pr-ready-green":
      return [
        ...want(pr?.state === "OPEN" && !pr.isDraft, "an open PR marked ready"),
        ...want(
          state.checks[remote] === "pass",
          "CI passed on the pushed head",
        ),
      ]
    case "merged":
      return [
        ...want(pr?.state === "MERGED", "the PR merged"),
        ...want(main.includes("multiply"), "main to have the work"),
        ...want(!remote, "the remote branch deleted"),
      ]
    case "closed":
      return [
        ...want(pr?.state === "CLOSED", "the PR closed"),
        ...want(!remote, "the remote branch deleted"),
        ...want(!main.includes("multiply"), "main without the work"),
      ]
    case "unchanged":
      return want(
        pr?.state === "OPEN" && pr.isDraft && state.prs.length === 1,
        "the PR untouched",
      )
  }
}

/** Takes out everything the runs added to the Claude Code config. */
async function cleanUp(runs: Run[]): Promise<void> {
  for (const run of runs) {
    if (!existsSync(run.work)) continue
    for (const plugin of ["dev-flows", "dev-flows-base"]) {
      await claude(
        ["plugin", "uninstall", `${plugin}@${MARKETPLACE}`, "-s", "local"],
        run.work,
      )
    }
  }
  await claude(["plugin", "marketplace", "remove", MARKETPLACE])
  const record = path.join(CONFIG, "plugins", "installed_plugins.json")
  if (existsSync(record)) {
    const installed = JSON.parse(readFileSync(record, "utf8"))
    for (const key of Object.keys(installed.plugins ?? {})) {
      if (key.endsWith(`@${MARKETPLACE}`)) delete installed.plugins[key]
    }
    writeFileSync(record, JSON.stringify(installed, null, 2))
  }
  for (const dir of ["cache", "marketplaces"]) {
    rmSync(path.join(CONFIG, "plugins", dir, MARKETPLACE), {
      recursive: true,
      force: true,
    })
  }
}

function print(r: Report, full: boolean): void {
  const mark = r.problems.length ? "FAIL" : "ok  "
  console.log(
    `${mark} ${r.name.padEnd(24)} ${r.model.padEnd(18)} $${r.cost.toFixed(2).padStart(5)} ${String(r.seconds).padStart(4)}s  ${r.loaded.length} flow files`,
  )
  for (const p of r.problems) console.log(`       - ${p}`)
  if (full) {
    console.log(`       loaded: ${r.loaded.join(", ")}`)
    console.log(r.result.replace(/^/gm, "       | "))
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes("--list")) {
    for (const r of RUNS)
      console.log(
        `${r.name}  ${r.prompt}  (${r.model}${r.hooksOff ? ", hooks off" : ""})`,
      )
    return
  }
  const only = argv.includes("--only")
    ? argv[argv.indexOf("--only") + 1]?.split(",")
    : undefined
  const keep = argv.includes("--keep")
  const full = argv.includes("--full")
  const specs = only ? RUNS.filter((r) => only.includes(r.name)) : RUNS
  const unknown = only?.filter((n) => !RUNS.some((r) => r.name === n)) ?? []
  if (unknown.length || !specs.length) {
    throw new Error(`no such run: ${unknown.join(", ")} (--list lists them)`)
  }

  const work = mkdtempSync(path.join(tmpdir(), "agent-flows-e2e-"))
  console.log(`[e2e] working in ${work}`)
  const { server, url } = await serve(snapshotMarketplace(work))
  const runs: Run[] = []
  let interrupted = false
  const onSignal = () => {
    interrupted = true
  }
  process.on("SIGINT", onSignal)
  try {
    for (const spec of specs) {
      const run = makeRepo(spec, path.join(work, "runs"))
      runs.push(run)
      await install(run, url)
    }
    console.log(`[e2e] ${runs.length} runs set up; running the sessions`)
    await Promise.all(runs.map(session))
    if (interrupted) return
    const reports = runs.map(report)
    for (const r of reports) print(r, full)
    const failed = reports.filter((r) => r.problems.length)
    const cost = reports.reduce((sum, r) => sum + r.cost, 0)
    console.log(
      `[e2e] ${reports.length - failed.length}/${reports.length} passed, $${cost.toFixed(2)}`,
    )
    if (failed.length) process.exitCode = 1
  } finally {
    await cleanUp(runs)
    server.close()
    if (keep) console.log(`[e2e] kept ${work}`)
    else rmSync(work, { recursive: true, force: true })
    process.off("SIGINT", onSignal)
  }
}

if (isMain(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[e2e] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
