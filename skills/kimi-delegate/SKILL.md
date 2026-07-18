---
name: kimi-delegate
description: >-
  Delegate a coding task to the Kimi Code CLI (`kimi`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Kimi -
  phrasings like "have Kimi implement X", "delegate this to Kimi", "run it through Kimi Code", or
  "use Kimi to implement/fix/refactor" - or wants to run a queue of coding tasks through Kimi while
  staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the user wants the code
  written directly without delegating.
license: MIT
metadata:
  version: 0.1.0
---

# Kimi Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer** - the Kimi Code
CLI - then review what it produced and land it yourself. You write the brief and own the judgment;
Kimi does the typing in its own session; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `kimi` CLI is not installed or authenticated (the relay probes `kimi`, then `kimi-cli`).
- You need a CLI-enforced read-only implementer. Headless Kimi has no read-only mode.

## Prerequisites (check once)

1. Install Kimi Code using the recommended install script or npm instructions in the
   [official getting-started guide](https://moonshotai.github.io/kimi-code/en/guides/getting-started).
2. Authenticate with `kimi login` or `kimi-cli login` (device-code flow, no TUI), or use `/login` in the TUI.
3. Confirm `kimi --version` or `kimi-cli --version` succeeds.
4. Work in, or point `--cd` at, the target git repository.

The relay probes `kimi` first and falls back to `kimi-cli`; either command may satisfy the prerequisite.
It forces UTF-8 for the child process on every platform while preserving the caller's environment.

## Choose the model alias

Kimi uses `default_model` from its `config.toml` when `--model` is omitted. To choose another model
alias, pass `--model <alias from your kimi config>`. Model aliases are user-defined config keys; use
one the human has configured rather than inventing one. When `--model` is supplied, the relay
validates the exact alias before dispatch using `$KIMI_CODE_HOME/config.toml`, then
`~/.kimi-code/config.toml`, then legacy `~/.kimi/config.toml`; an unknown alias exits 2 before any
run starts. Omitting `--model` keeps Kimi's configured default.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write the brief

Kimi sees only the text you send plus what it can inspect in the workspace - no chat history or shared
context. Include the goal, current state, what to change, what to leave untouched, the project's
**actual** gates, and a report contract. Tell Kimi not to commit. Keep one task per brief. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Use the bundled helper. It wraps Kimi's headless prompt mode, captures the structured event stream,
and writes `result.json`. (`<skill-dir>` is the installed folder containing this `SKILL.md`.)

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a configured model alias:       add --model <alias from your kimi config>
# liveness heartbeat every 30s (default): add --heartbeat 30s
# disable the heartbeat:                 add --heartbeat 0
# resume the most recent session:        add --resume-last  (delta brief only)
# resume a specific session:             add --session <id> (delta brief only)
# see all options:                       node .../relay.mjs --help
```

The child process's cwd pins the workspace. Use repeatable `--add-dir` flags only for extra workspace
directories. Use `--heartbeat <duration>` to control liveness output (`30s` by default); pass
`--heartbeat 0` to disable it. Heartbeats and progress lines show that the child remains active. The
relay writes artifacts under the system temp dir by default and never commits. See
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

The helper blocks until Kimi finishes. Run it with the orchestrator's background-command facility, or
background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; if neither `kimi` nor `kimi-cli` is executable the relay exits 127 and writes
`status: "kimi_unavailable"`.

Completion still requires the process to exit and `result.json` to contain a status. Trust process
state and the working tree over a progress display.

### 4. Review - do not trust the self-report

Treat Kimi's final message and gate claims as claims:

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.
- Round-trip migrations and grep for dangling references after removals or renames.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Commit only after the gates pass
and the diff holds. If rework is needed, send a delta brief with `--resume-last` or `--session <id>`,
then review again.

## Autonomy and permissions

In headless `--print` mode, Kimi always runs in **auto permission mode** and never asks for
approval, so the relay passes no additional autonomy flag and offers no `--read-only` or
`--full-access` option. There is no CLI-enforced read-only mode: inspect
`touchedFiles` and the diff after every run. That diff, not a flag, is the guarantee of what changed.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits remain: **surface, don't absorb**
(report Kimi's design decisions, defensible-but-unasked turns, and non-blocking nitpicks) and **stop
for scope changes** (if correct completion needs going beyond the brief, ask instead of expanding the
mandate). See [references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, report contract,
  real gates, argv delivery, and delta briefs.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts,
  `result.json`, polling, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - review checklist, commit boundary,
  and rework through Kimi sessions.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues, constraint
  carry-forward, progress tracking, and the final coherence pass.
