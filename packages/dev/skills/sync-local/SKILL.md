---
name: sync-local
description: Local sync phase of the /agent-flows:sync flow. Invoked by the sync flow; not run directly
user-invocable: false
---

# /agent-flows:sync: Local sync

**Mode:** you were dispatched with a mode (`default` or `local`); which steps apply and where they route below depend on it.

**Run only when mode is `default` or `local`.**

## 1. Local git work

**Skip when the survey said `runLocal: false`**: in default mode go straight to the `sync-remote` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one); in `local` mode go straight to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

`<base>`, `<baseRef>`, and the integration entries are from the survey.

### 2a. Branch

Only when `onBase` is true. Create the branch before anything else, and don't stage anything first: `git switch -c <name>`, where `<name>` is the issue id in lowercase (when 1a found or planned one with an id) and a 3-5 word slug of the work, joined by `-`. Follow the naming the repo's recent branches use (`git branch -r --sort=-committerdate | head -20`), such as a personal prefix. On a feature branch, keep it: never rename a branch that has a PR.

### 2b. Track the stack

With a stacking integration: run its `parent` op. If it fails, the branch isn't tracked; run its `track` op with `<parent>` set to the PR's base branch when there's a PR, else `<base>`.

### 2c. Commit

When `git status --porcelain` isn't empty: `git add -A`, then `git commit -m "<message>"`. Write the message in the repo's convention: its agent instructions first, then the shape of recent subjects (`git log -20 --format=%s`). If the commit fails (a hook rejected it), read the error, fix the cause, and commit again; don't skip hooks.

### 2d. Catch up

- **With a stacking integration:** run its `restack` op.
- **Without one:** when `git rev-list --count HEAD..<baseRef>` isn't 0, `git merge --no-edit <baseRef>`.

On conflicts, run `git status`, read each conflicted file, and write a resolution that keeps the intent of both sides. Resolve routine collisions yourself (imports, lockfiles, settings, formatting, counts both sides moved); **stop and ask** only when both sides changed the same logic incompatibly. Stage each file with `git add <file>`, then finish: the stacking integration's `continue` op after a restack (repeat until the restack completes), `git commit --no-edit` after a merge.

### 2e. Push

**Default mode only**, and only when `git rev-list --count <baseRef>..HEAD` isn't 0.

- **With a stacking integration:** its `submit` op.
- **Without one:** `git push -u origin HEAD`. If it's rejected because the remote branch moved, `git fetch origin <branch>`, `git merge --no-edit origin/<branch>`, resolve as above, and push again. Never force.

`local` mode never pushes.

### 2f. Mergeability

**Default mode only, when a PR exists** (re-run `currentPr`: the push may have opened one). Run the source-control entry's `prMergeability` op:

- `clean`: continue.
- `pending`: the host is still computing it. `sleep 3` and ask again, up to 3 times; then treat it as `clean`.
- `conflicting` or `behind`: take one more pass: fetch, run 2d and 2e again, and ask again. Still `conflicting` or `behind`: stop and show the user what the op returned. With a stack, a parent that hasn't merged or restacked is the usual cause. Don't loop.

**Next:**

- Mode `default`: invoke the `sync-remote` skill with mode `default`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- Mode `local`: invoke the `sync-report` skill with mode `local`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
