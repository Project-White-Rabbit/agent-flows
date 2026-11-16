# Make a plugin a dev-flows front end

You are turning a Claude Code plugin (the "front end") into one that runs the dev-flows workflows under its own command names: `/<plugin>:sync`, `/<plugin>:ready`, and the rest. The workflows stay in the `dev-flows-base` plugin; the front end gets one short generated skill per flow that reads the base's flow file. When the base updates, the front end gets the change with nothing to rebuild.

Follow these steps in order. Ask the person where a step says to; don't decide those yourself. Don't commit or push unless they ask.

## 1. Find the base

You need the directory `dev-flows-base` is installed in. Take the first that gives one:

- the session start, which names it ("dev-flows-base … is installed at …");
- `echo "$DEV_FLOWS_BASE"` in a shell;
- `claude plugin list`, then the path in `installed_plugins.json` (in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`) under `dev-flows-base@agent-flows`.

When it isn't installed: `claude plugin marketplace add Project-White-Rabbit/agent-flows`, then `claude plugin install dev-flows-base@agent-flows`, and use the path it was installed to. Below, `$BASE` is that directory.

Read `$BASE/flows/manifest.json`: `hosts.claude` lists the flows, and `contract` is the flow contract the wrappers you write will check for.

## 2. Find the front end

Ask the person which plugin, unless they named it. You need:

- **its directory**: the one holding `.claude-plugin/plugin.json`;
- **its name**: `name` in that `plugin.json`;
- **its marketplace**: `name` in the `.claude-plugin/marketplace.json` that lists this plugin (usually in a parent directory).

## 3. Decide which flows the base runs

List the plugin's own commands: every `skills/<name>/SKILL.md` and `commands/<name>.md`. Then show the person one table with a row per base flow:

| Flow | The plugin has | Proposed |
|---|---|---|
| `sync` | `skills/sync`, plus `sync-local`, `sync-remote`, `sync-report` | base |
| `prototype` | nothing | base |

For each flow, propose **base** (the generated wrapper replaces whatever the plugin has) or **own** (the plugin keeps its version). Propose **own** only when its version does something the base's doesn't; say what. Name the plugin's skills that belong to a flow (its phases, like `sync-local`, or helpers only that flow uses), since moving that flow to the base leaves them unused. Ask the person to confirm the table, and whether to delete those leftover skills.

Every base flow calls other flows by name (`/<plugin>:configure`, `/<plugin>:sync`, …), so the front end must answer every name in the table: a flow the person keeps as **own** needs a skill or command with exactly that name. Flag any flow kept as own whose name the plugin doesn't have.

The flows marked **own** are your `--exclude` list.

## 4. Depend on the base

In the front end's `.claude-plugin/plugin.json`, add (or extend) `"dependencies": ["dev-flows-base@agent-flows"]`. No version: the front end always gets the latest base.

When the front end's marketplace isn't `agent-flows`, Claude Code refuses to install a dependency from another marketplace unless the front end's marketplace allows it. In its `.claude-plugin/marketplace.json`, add (or extend) at the top level:

```json
"allowCrossMarketplaceDependenciesOn": ["agent-flows"]
```

## 5. Write the wrappers

Delete the skills the person agreed to replace or drop, then run:

```sh
node "$BASE/src/commands/front-end.ts" write --plugin <name> --marketplace <marketplace> --dir <front end directory> --exclude <own,flows>
```

(Leave out `--exclude` when every flow goes to the base.) It prints JSON: `written` and `unchanged` wrappers, `removed` ones it wrote earlier for flows now excluded, `own` flows the plugin answers itself, and `missing` ones nothing answers.

- It exits 2 and names the file when a skill or command it didn't write already has a flow's name: that's the plugin's own version of that flow. Go back to step 3 for it; never delete it without the person's yes.
- A `missing` flow means a base flow will call a command that doesn't exist. Fix it (stop excluding it, or give the plugin that command) before going on.

Never edit a generated wrapper by hand: the next `write` replaces it.

## 6. Check it

- `claude plugin validate <front end directory>`, and the same for the marketplace's directory.
- Bump the front end's `version` in `plugin.json` the way its repo does, so installs update.
- Say what changed, then tell the person to run `claude plugin marketplace update <marketplace>` and `claude plugin update <name>@<marketplace>`, start a new session, and try `/<name>:sync help`. `claude plugin list` should show both `<name>` and `dev-flows-base` enabled.

## 7. Tell the team

Everyone who installs the front end needs the `agent-flows` marketplace added, or `dev-flows-base` won't install and the front end won't load. Either they run `claude plugin marketplace add Project-White-Rabbit/agent-flows` once, or the repo adds it for everyone in `.claude/settings.json`:

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

The wrappers only send each command to the base, so most base updates need nothing here. Rerun step 5 when the base adds a flow, or when a wrapper says the front end is out of date for the base (the flow contract changed). `node "$BASE/src/commands/front-end.ts" check` with the same flags writes nothing and exits 1 when the wrappers are stale.
