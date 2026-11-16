# Make a plugin a dev-flows front end

You are turning an agent plugin (the "front end") into one that runs the dev-flows workflows under its own command names: `/<plugin>:sync`, `/<plugin>:ready`, and the rest. The front end can be a plugin for Claude Code, Cursor, Codex, or Amp (its "host"); a project that ships one plugin per host (bitfab-dev, say) does steps 2 to 6 once for each. The workflows stay in the `dev-flows-base` plugin, rendered for every host; the front end gets one short generated skill per flow that reads the base's flow file for its host. When the base updates, the front end gets the change with nothing to rebuild.

| Host | Commands look like | Skills it writes | How the base gets installed |
|---|---|---|---|
| `claude` | `/<plugin>:sync` | `skills/sync/SKILL.md` | a plugin dependency, installed with the front end |
| `cursor` | `/<plugin>-sync` | `skills/<plugin>-sync/SKILL.md` | the `dev-flows-base` plugin from the `agent-flows` marketplace, beside the front end |
| `codex` | `$<plugin>:sync` | `skills/sync/SKILL.md` | `codex plugin marketplace add Project-White-Rabbit/agent-flows`, then `dev-flows-base` from it |
| `amp` | `<plugin>:sync` | `skills/sync/SKILL.md` | a clone: `git clone https://github.com/Project-White-Rabbit/agent-flows ~/.config/agent-flows/dev-flows-base` (the same clone holds dev-flows' own Amp plugin, `plugins/dev-flows-amp`) |

Outside Claude Code nothing tells the session where the base is, so the wrappers for the other hosts find it themselves: the newest `dev-flows-base` installed where that host (or any other) keeps plugins, else the clone above.

Follow these steps in order. Ask the person where a step says to; don't decide those yourself. Don't commit or push unless they ask.

## 1. Find the base

You need the directory `dev-flows-base` is installed in. Take the first that gives one:

- the session start, which names it ("dev-flows-base … is installed at …");
- `echo "$DEV_FLOWS_BASE"` in a shell;
- `claude plugin list`, then the path in `installed_plugins.json` (in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`) under `dev-flows-base@agent-flows`;
- the newest `dev-flows-base/<version>` under `~/.codex/plugins/cache/*/`, `~/.cursor/plugins/local/dev-flows-base`, or `~/.config/agent-flows/dev-flows-base/packages/dev` (a clone).

When it isn't installed: in Claude Code, `claude plugin marketplace add Project-White-Rabbit/agent-flows`, then `claude plugin install dev-flows-base@agent-flows`, and use the path it was installed to; anywhere else, clone it (the table above) and use `~/.config/agent-flows/dev-flows-base/packages/dev`. Below, `$BASE` is that directory. Any host's install will do for writing the wrappers: every install holds every host's flows.

Read `$BASE/flows/manifest.json`: `hosts.<host>` lists the flows for each host, and `contract` is the flow contract the wrappers you write will check for. A host missing from `hosts` means the base is older than multi-host support: update it.

## 2. Find the front end

Ask the person which plugin, unless they named it. You need:

- **its host**: `claude` for a directory with `.claude-plugin/plugin.json`, `cursor` for `.cursor-plugin/plugin.json`, `codex` for `.codex-plugin/plugin.json`, `amp` for an Amp plugin (a `package.json` depending on `@ampcode/plugin`, with code that registers its `skills/`). A project with several of these (one per host, sharing their flow definitions) is several front ends: do the rest once per plugin, with the same choices in step 3 for each;
- **its directory**: the one holding that manifest (for Amp, its package);
- **its name**: `name` in that manifest (for Amp, the namespace its skills are invoked under);
- **its marketplace**: `name` in the marketplace file that lists this plugin (`.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, usually in a parent directory), else the repository it's installed from. It only appears in the wrappers' update hint.

## 3. Decide which flows the base runs

List the plugin's own commands: every `skills/<name>/SKILL.md` and `commands/<name>.md`. Then show the person one table with a row per base flow:

| Flow | The plugin has | Proposed |
|---|---|---|
| `sync` | `skills/sync`, plus `sync-local`, `sync-remote`, `sync-report` | base |
| `prototype` | nothing | base |

For each flow, propose **base** (the generated wrapper replaces whatever the plugin has) or **own** (the plugin keeps its version). Propose **own** only when its version does something the base's doesn't; say what. Name the plugin's skills that belong to a flow (its phases, like `sync-local`, or helpers only that flow uses), since moving that flow to the base leaves them unused. Ask the person to confirm the table, and whether to delete those leftover skills.

Every base flow calls other flows by name (`/<plugin>:configure`, `/<plugin>:sync`, …, in the host's form), so the front end must answer every name in the table: a flow the person keeps as **own** needs a skill or command with exactly that name. Flag any flow kept as own whose name the plugin doesn't have.

The flows marked **own** are your `--exclude` list.

## 4. Depend on the base

**Claude Code** installs the base with the front end. In the front end's `.claude-plugin/plugin.json`, add (or extend) `"dependencies": ["dev-flows-base@agent-flows"]`. No version: the front end always gets the latest base.

When the front end's marketplace isn't `agent-flows`, Claude Code refuses to install a dependency from another marketplace unless the front end's marketplace allows it. In its `.claude-plugin/marketplace.json`, add (or extend) at the top level:

```json
"allowCrossMarketplaceDependenciesOn": ["agent-flows"]
```

**Cursor, Codex, and Amp** have no plugin dependencies, so there's nothing to add: everyone installs the base beside the front end (the table at the top; step 7 says how to tell them). Put that in the front end's README.

## 5. Write the wrappers

Delete the skills the person agreed to replace or drop, then run:

```sh
node "$BASE/src/commands/front-end.ts" write --host <host> --plugin <name> --marketplace <marketplace> --dir <front end directory> --exclude <own,flows>
```

(Leave out `--exclude` when every flow goes to the base; `--host` defaults to `claude`.) It prints JSON: `written` and `unchanged` wrappers, `removed` ones it wrote earlier for flows now excluded, `own` flows the plugin answers itself, and `missing` ones nothing answers.

- It exits 2 and names the file when a skill or command it didn't write already has a flow's name: that's the plugin's own version of that flow. Go back to step 3 for it; never delete it without the person's yes.
- A `missing` flow means a base flow will call a command that doesn't exist. Fix it (stop excluding it, or give the plugin that command) before going on.

Never edit a generated wrapper by hand: the next `write` replaces it.

On **Amp**, a skill loads only when the plugin's code registers it: add each written wrapper's directory to the plugin's list of skills (and drop the removed ones), then rebuild it the way its repo does.

When the front end's skills are generated by a build of their own (a flow compiler writing every skill into `skills/`), make that build leave the wrappers alone: stop generating the flows that moved to the base, and don't let it delete files it didn't write, or the next build removes the wrappers.

## 6. Check it

- On Claude Code, `claude plugin validate <front end directory>`, and the same for the marketplace's directory.
- Bump the front end's `version` in `plugin.json` the way its repo does, so installs update.
- Say what changed, then tell the person how to try it. On Claude Code: run `claude plugin marketplace update <marketplace>` and `claude plugin update <name>@<marketplace>`, start a new session, and try `/<name>:sync help`; `claude plugin list` should show both `<name>` and `dev-flows-base` enabled. Elsewhere: install the base (the table at the top), update the front end, start a new session, and try the host's `sync help` (`/<name>-sync help`, `$<name>:sync help`, `<name>:sync help`).

## 7. Tell the team

On Cursor, Codex, and Amp, everyone who uses the front end installs `dev-flows-base` themselves (the table at the top): say so wherever the team learns to install the front end, and when a repo script sets up their plugins (a worktree setup script, say), offer to add the base there.

On Claude Code, everyone who installs the front end needs the `agent-flows` marketplace added, or `dev-flows-base` won't install and the front end won't load. Either they run `claude plugin marketplace add Project-White-Rabbit/agent-flows` once, or the repo adds it for everyone in `.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "agent-flows": {
    "source": { "source": "github", "repo": "Project-White-Rabbit/agent-flows" },
    "autoUpdate": true
  }
}
```

Offer to add that when the front end is used from a repo with a `.claude/settings.json`.

## Keeping it current

The wrappers only send each command to the base, so most base updates need nothing here. Rerun step 5 (for each host) when the base adds a flow, or when a wrapper says the front end is out of date for the base (the flow contract changed). `node "$BASE/src/commands/front-end.ts" check` with the same flags writes nothing and exits 1 when the wrappers are stale.
