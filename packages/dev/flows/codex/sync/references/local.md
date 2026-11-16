# $<caller>:sync: Local sync

This continues the flow you were following: `<caller>`, the arguments, and `$DEV_FLOWS_BASE` mean what they did there.

**Mode:** you were dispatched with a mode (`default` or `local`); which steps apply and where they route below depend on it.

**Run only when mode is `default` or `local`.**

## 1. Local git work

**Skip when the survey said `runLocal: false`**: in default mode go straight to the [Remote sync](./remote.md) reference with the current mode, forwarding the arguments you were given minus the leading mode keyword (if the user typed one); in `local` mode go straight to the [Report](./report.md) reference with the current mode, forwarding the arguments you were given minus the leading mode keyword (if the user typed one).

`<base>`, `<baseRef>`, and the integration entries are from the survey.

### 2a. Branch

Only when `onBase` is true. Create the branch before anything else, and don't stage anything first: `git switch -c <name>`, where `<name>` is the issue id in lowercase (when 1a found or planned one with an id) and a 3-5 word slug of the work, joined by `-`. Follow the naming the repo's recent branches use (`git branch -r --sort=-committerdate | head -20`), such as a personal prefix. On a feature branch, keep it: never rename a branch that has a PR.

### 2b. Track the stack

Find `<parent>` (and `<landed>`, when the parent already merged): With a stacking entry, its `parent` op. When that succeeds and names a branch other than `<base>`, check it hasn't already merged: the source-control entry's `branchPr` op for it (with no source-control entry, skip the check). Merged means it landed, so `<parent>` is the base that pull request merged into, and `<landed>` is the old parent: `$<caller>:sync` moves the branch off it (until then, the branch still holds the landed parent's commits, so compare its own work against `<landed>`, not `<parent>`). Otherwise `<parent>` is the branch the op named. When there's no stacking entry, or its `parent` op fails (the branch isn't tracked): the pull request's base branch when there's a pull request, else `<base>`. When the stacking entry's `parent` op failed, the branch isn't tracked: run its `track` op with that `<parent>`.

### 2c. Commit

When `git status --porcelain` isn't empty: `git add -A`, then `git commit -m "<message>"`. Write the message in the repo's convention: its agent instructions first, then the shape of recent subjects (`git log -20 --format=%s`), with no attribution beyond what those instructions require. If the commit fails (a hook rejected it), read the error, fix the cause, and commit again; don't skip hooks.

### 2d. Catch up

**Skip with `--no-catch-up`:** the branch stays where it is against the base, and the report says so (`<behind>` commits behind <base>).

- **With a stacking integration:** when 2b found `<landed>`, its `reparent` op with `<old>` `<landed>` and `<onto>` `<parent>`, so the branch keeps only its own commits and its pull request retargets on the next push; otherwise its `restack` op.
- **Without one, by merge** (the survey's `catchUpBy` `merge`, the default): when `git rev-list --count HEAD..<baseRef>` isn't 0, `git merge --no-edit <baseRef>`.
- **Without one, by rebase** (`catchUpBy` `rebase`): first `node "$DEV_FLOWS_BASE/src/commands/sync.ts" upstream`, which fetches the branch's remote tip and prints `remote` (its sha, or `null` when origin has no such branch), `contained`, and `missing`; keep `<remote>` for the push. When it fails (origin can't be asked, the fetch failed), stop: `Couldn't read origin/<branch>: <error>. A rebase would need force without knowing what's there.` When `missing` isn't empty, someone pushed to the branch since this checkout last had it: `git cherry-pick <sha>` each, in the order given, so the push keeps their work; when one has nothing left to apply (the change is already here), `git cherry-pick --skip`. Then, when `git rev-list --count HEAD..<baseRef>` isn't 0, `git rebase <baseRef>`: it replays only the branch's own commits, never what's already on the base.

On conflicts, run `git status`, read each conflicted file, and write a resolution that keeps the intent of both sides. Resolve routine collisions yourself (imports, lockfiles, settings, formatting, counts both sides moved); **stop and ask** only when both sides changed the same logic incompatibly. Stage each file with `git add <file>`, then finish: the stacking integration's `continue` op after a restack (repeat until the restack completes), what its `reparent` op says after a reparent, `git commit --no-edit` after a merge, `git cherry-pick --continue` after a cherry-pick, `git rebase --continue` after each stop of a rebase (repeat until it completes).

### 2e. Push

**Default mode only**, and only when `git rev-list --count <baseRef>..HEAD` isn't 0.

- **With a stacking integration:** its `submit` op. Keep the stacking tool's URL for the pull request when it prints one, for the report. When it fails for a reason other than a conflict (the tool's own API or sign-in), push the branch anyway: `git push --force-with-lease -u origin HEAD` (the stacking tool rewrote the branch, so a plain push would be refused, and the lease refuses to overwrite work pushed since the last fetch). The pull request is then opened in 3c with `prCreate` when there's none; say in the report that `submit` failed, and why. When it failed because the remote branch has commits this one doesn't (its push was refused), never force: do what it says (fetch and merge `origin/<branch>`), then run `submit` again.
- **Without one, by merge:** `git push -u origin HEAD`. If it's rejected because the remote branch moved, `git fetch origin <branch>`, `git merge --no-edit origin/<branch>`, resolve as above, and push again. Never force.
- **Without one, by rebase:** when 2d didn't run (nothing to commit or catch up, or `--no-catch-up`), run `node "$DEV_FLOWS_BASE/src/commands/sync.ts" upstream` now for `<remote>`, and fold in its `missing` as 2d does. When `<remote>` is `null`, or `contained` was true and nothing was rebased (`git merge-base --is-ancestor <remote> HEAD` succeeds), `git push -u origin HEAD`. Otherwise `git push --force-with-lease=<branch>:<remote> -u origin HEAD`: the lease names the tip `upstream` read, so the push can replace only that, never what someone pushed since. When it's refused (the remote moved), run 2d's rebase steps again from `upstream` and push with the new `<remote>`. Never `--force`, and never `--force-with-lease` without the tip.

`local` mode never pushes. After a rebase in `local` mode, the next push (sync's, or ready's) carries the lease.

### 2f. Mergeability

**Default mode only, when a PR exists** (re-run `currentPr`: the push may have opened one). Run the source-control entry's `prMergeability` op:

- `clean`: continue.
- `pending`: the host is still computing it. `sleep 3` and ask again, up to 3 times; then continue, and report it as not yet known, never as clean.
- `conflicting` or `behind`: take one more pass: fetch, run 2d and 2e again, and ask again. Still `conflicting` or `behind`: stop and show the user what the op returned. With a stack, a parent that hasn't merged or restacked is the usual cause. Don't loop. With `--no-catch-up`, take no pass: continue, and lead the report with `<branch> doesn't merge cleanly into <base> (<state>); --no-catch-up left it.`
- **The op fails** (an error, not one of the answers above): stop, `Couldn't read <branch>'s mergeability: <error>.` A read that failed is never clean.

**Next:**

- Mode `default`: read and follow the [Remote sync](./remote.md) reference with mode `default`, forwarding the arguments you were given minus the leading mode keyword (if the user typed one).
- Mode `local`: read and follow the [Report](./report.md) reference with mode `local`, forwarding the arguments you were given minus the leading mode keyword (if the user typed one).
