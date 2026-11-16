---
name: cancel
description: "Abandon the current branch's work: close its pull request, delete its remote branch, cancel its issue, and run the repo's teardown. Invoking it authorizes the cleanup. Only for scrapping work without merging, never for landing it. Invoke with $__FRONT_END_PLUGIN__:cancel [force|help]."
---

<!-- Generated: sends $__FRONT_END_PLUGIN__:cancel to the cancel flow in dev-flows-base. Do not edit by hand. -->

# $__FRONT_END_PLUGIN__:cancel

This command's instructions are in the dev-flows-base plugin.

1. **Find dev-flows-base.** In a shell, run `echo "$DEV_FLOWS_BASE"`. When it prints nothing, run `node -e 'const f=require("fs"),p=require("path"),h=require("os").homedir(),e=process.env,host=process.argv[1],N="dev-flows-base";const x=e.XDG_CONFIG_HOME||p.join(h,".config");const k=d=>{try{return f.readdirSync(d).map(n=>p.join(d,n))}catch{return[]}};const vs=m=>[p.join(m,N),...k(p.join(m,N))];let r="";try{r=require("child_process").execSync("git rev-parse --show-toplevel",{stdio:["ignore","pipe","ignore"]}).toString().trim()}catch{};const g={claude:k(p.join(e.CLAUDE_CONFIG_DIR||p.join(h,".claude"),"plugins","cache")).flatMap(vs),cursor:[p.join(h,".cursor","plugins","local",N),...k(p.join(h,".cursor","plugins","cache")).flatMap(vs)],codex:k(p.join(e.CODEX_HOME||p.join(h,".codex"),"plugins","cache")).flatMap(vs),amp:[r&&p.join(r,".amp","plugins",N),p.join(x,"amp","plugins",N)],clone:[p.join(x,"agent-flows/dev-flows-base"),p.join(x,"agent-flows/dev-flows-base","packages","dev")]};const j=(d,...a)=>{try{return JSON.parse(f.readFileSync(p.join(d,...a),"utf8"))}catch{}};const v=d=>String(j(d,".claude-plugin","plugin.json")?.version||"0").split(".").map(Number);const c=(a,b)=>{for(let i=0;i<3;i++){const d=(b[i]||0)-(a[i]||0);if(d)return d}return 0};for(const n of [host,...Object.keys(g).filter(n=>n!==host)]){const o=(g[n]||[]).filter(d=>d&&j(d,"flows","manifest.json")?.hosts?.[host]).sort((a,b)=>c(v(a),v(b)));if(o.length){console.log(o[0]);break}}' codex`, which prints the newest dev-flows-base installed where Codex or another agent host keeps plugins, or cloned to `~/.config/agent-flows/dev-flows-base`.

   When neither prints a directory, stop: dev-flows-base isn't installed. Tell the user to run `codex plugin marketplace add Project-White-Rabbit/agent-flows` and install dev-flows-base from it, or run `git clone https://github.com/Project-White-Rabbit/agent-flows ~/.config/agent-flows/dev-flows-base`, then start a new session.
2. **Check it's one this plugin can follow.** Read the `contract` in `<that directory>/flows/manifest.json`. When it isn't 1, stop: __FRONT_END_PLUGIN__ is out of date for the installed dev-flows-base. Tell the user to update the __FRONT_END_PLUGIN__ plugin (from __FRONT_END_MARKETPLACE__) and start a new session.
3. **Follow the flow.** Read `<that directory>/flows/codex/cancel/flow.md` with your file-reading tool and follow it to the end, as the caller `__FRONT_END_PLUGIN__` (its commands are `$__FRONT_END_PLUGIN__:<name>`), with these arguments: $ARGUMENTS.

   When `echo "$DEV_FLOWS_BASE"` printed nothing, write that directory in place of `$DEV_FLOWS_BASE` in every command the flow gives.
