---
description: Assess branch or PR shippability without edits. Use for readiness and risk assessment, not an audit/fix loop.
argument-hint: "[full] [record] [PR number or URL | help]"
---

<!-- Generated: sends /dev-flows:evaluate to the evaluate flow in dev-flows-base. Do not edit by hand. -->

# /dev-flows:evaluate

This command's instructions are in the dev-flows-base plugin.

1. **Find dev-flows-base.** Take the directory from the first of these that gives one:
   - the session start, which names the directory it's installed in;
   - in a shell, `echo "$DEV_FLOWS_BASE"`;
   - in a shell, `node -e 'const f=require("fs"),p=require("path");const d=process.env.CLAUDE_CONFIG_DIR||p.join(require("os").homedir(),".claude");const all=Object.entries(JSON.parse(f.readFileSync(p.join(d,"plugins","installed_plugins.json"),"utf8")).plugins).filter(([k])=>k.startsWith("dev-flows-base@")).flatMap(([,v])=>v);const r=x=>{try{return f.realpathSync(x)}catch{return x}};const c=r(process.cwd())+"/";const e=all.find(e=>e.projectPath&&c.startsWith(r(e.projectPath)+"/"))||all.find(e=>e.scope==="user");if(e)console.log(e.installPath)'`, which prints where Claude Code installed it (for a session where its startup hook didn't run).

   When none gives one, stop: dev-flows-base isn't installed. Tell the user to run `claude plugin install dev-flows-base@agent-flows` and start a new session.
2. **Check it's one this plugin can follow.** Its flow contract is the one the session start names, else the `contract` in `<that directory>/flows/manifest.json`. When it isn't 1, stop: dev-flows is out of date for the installed dev-flows-base. Tell the user to run `claude plugin update dev-flows@agent-flows` and start a new session.
3. **Follow the flow.** Read `<that directory>/flows/claude/evaluate/flow.md` with the Read tool and follow it to the end, as the caller `dev-flows` (its commands are `/dev-flows:<name>`), with these arguments: $ARGUMENTS

   When `echo "$DEV_FLOWS_BASE"` printed nothing, write that directory in place of `$DEV_FLOWS_BASE` in every command the flow gives.
