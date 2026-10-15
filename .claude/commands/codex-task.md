---
description: Delegate a TASKS.md task to Codex in its own worktree, then verify, review and loop fixes (max 3 cycles)
argument-hint: <TASK-ID> [extra instructions for this run]
allowed-tools: Bash, Read, Grep, Glob
---

Delegate task **$1** to the Codex CLI and supervise it until it is ready for the merge gate.
Extra instructions from the user for this run (may be empty): $ARGUMENTS

Talk to the user in pt-BR. Never push, open a remote PR or merge: the user is the merge gate.

## 1. Read the task

From `TASKS.md` (on `main`) extract for `$1`:
- the table row: front, dependencies, **allowed directories**;
- the `### $1 …` section: goal, bullets and the **Aceite** paragraph.

Stop and tell the user if the task does not exist, is not a `[Codex]` task, or depends on a task not yet merged into `main`.

Choose `<slug>`: 2–4 kebab-case English words from the title (e.g. `W1-X1` → `kong-image`).
Then set: `WT=../gg-codex-$1`, `BRANCH=task/$1-<slug>`, `LOG=/tmp/codex-$1.log`, `LAST=/tmp/codex-$1.last.md`.

## 2. Create the worktree

```bash
git worktree add "$WT" -b "$BRANCH" main   # reuse it if it already exists for this branch; never reset it
(cd "$WT" && pnpm install --frozen-lockfile)
```

Local overrides (`POSTGRES_PORT`, `TEST_DATABASE_URL`, `KONG_IMAGE`) apply here too: export them for every command run in the worktree, and pass them on to Codex in the prompt.

## 3. Launch Codex (background)

Write the prompt to `/tmp/codex-$1.prompt.md`:

```
You are the Codex front of the Gromesh Gateway monorepo. Read AGENTS.md and task $1 in TASKS.md first; they are binding.
Branch: <BRANCH> (already checked out in this worktree, created from main).
You may ONLY change files under: <allowed directories, one per line>.
If you need anything outside them (contracts/, root package.json, lockfile, other apps), stop and explain it in your final message instead of editing.
Acceptance criterion: <Aceite paragraph, verbatim>.
<extra instructions from the user, if any>
<local env overrides, if any>
Do not run git add/commit/push or switch branches: the sandbox blocks .git and the orchestrator commits after review. Leave your changes in the working tree.
Before finishing run `pnpm typecheck && pnpm test` (and `go test ./... && go vet ./...` under apps/agent if touched) plus the task's acceptance check where it can run locally.
Final message: what changed, a proposed Conventional Commit message per logical change (with its files), how it was tested (commands + results), what could not be verified locally and why, open questions.
```

Run with Bash `run_in_background: true`. The workspace-write sandbox keeps every `.git` read-only (even with `--add-dir`), so Codex cannot commit in a worktree; do not loosen the sandbox to work around it.

```bash
cd "$WT" && codex exec -C . \
  -c sandbox_mode='"workspace-write"' \
  -c sandbox_workspace_write.network_access=true \
  -c approval_policy='"never"' -c 'notify=[]' \
  --json -o "$LAST" - < /tmp/codex-$1.prompt.md > "$LOG" 2>&1
```

Do not pass `-m`: the model comes from `~/.codex/config.toml`.
Record the session id: the `thread_id` of the first `"type":"thread.started"` line in `$LOG`.
While it runs, keep doing your own work; check `tail -n 5 "$LOG"` between steps and tell the user about errors or blockers (`"type":"error"`, `turn.failed`).

## 4. Verify and review (after each Codex run)

In `$WT`, with the local overrides exported:
1. `pnpm typecheck`, `pnpm test`, Go checks if `apps/agent/` changed, and the acceptance check (or the local substitute the user allowed).
2. `git status --porcelain` and `git diff --name-only main...HEAD`: every changed or untracked path must be under the allowed directories (also check nothing landed outside `$WT`).
3. Review the working-tree diff (`git add -N . && git diff main`) against CLAUDE.md:
   - `contracts/` untouched (contract changes are a separate PR);
   - only the compiler builds Kong config; Kong stays DB-less; Admin API not exposed;
   - mutations in `db.transaction` with `audit(...)`; every handler has `@RequiredRole` or `@Public`;
   - no secrets, tokens or credentials (grep the diff for `password|secret|token|key` and judge each hit);
   - exact dependency versions, lockfile only if the task needs it; no extra docs (READMEs, ADRs);
   - the acceptance test exists and actually asserts the criterion.
4. When the review is clean, commit in `$WT` yourself, following Codex's proposed Conventional Commits (adjust if they do not match the diff), ending each message with the attribution lines from the session's system reminder.

If there are problems and fewer than 3 cycles have run, resume the same session in the background, from inside the worktree:

```bash
cd "$WT" && codex exec resume <thread_id> \
  -c sandbox_mode='"workspace-write"' \
  -c sandbox_workspace_write.network_access=true \
  -c approval_policy='"never"' -c 'notify=[]' \
  --json -o "$LAST" - < /tmp/codex-$1.fix-<n>.md >> "$LOG" 2>&1
```

The fix prompt is a numbered list of concrete problems (file:line, failing command + relevant output). Then repeat step 4.
After 3 cycles with problems left, stop and hand over to the user.

## 5. Report to the user

- Diff summary (≤ 10 lines, the PR description shape from CLAUDE.md) and `git log --oneline main..HEAD`.
- Each check with its result; anything not verified locally and why.
- Review findings still open, cycles used, Codex's open questions (from `$LAST`).
- Merge recommendation, and ask for explicit confirmation before `git checkout main && git merge --no-ff <BRANCH>`.
