# delegate-skills (Claude Code plugin)

Drive a separate CLI agent as a **background implementer** — brief it, review its diff, land the
commit yourself. Your agent (the orchestrator) writes a self-contained brief, hands it to an
implementer CLI, then reviews the diff and commits — staying the reviewer the whole way.

> **Attribution.** The skills in this repository are the work of
> [**amElnagdy/delegate-skills**](https://github.com/amElnagdy/delegate-skills) (Ahmed Mohammed),
> MIT-licensed. This repository repackages them **unchanged** as a Claude Code plugin (it adds only
> the `.claude-plugin/` manifests). All credit for the skills goes to the original author; please
> star and follow the upstream repo.

Five skills — same loop, different implementer:

| Skill | Drives | Autonomy | Resume |
| --- | --- | --- | --- |
| `codex-delegate` | [OpenAI Codex CLI](https://github.com/openai/codex) | Codex `--sandbox` enum (`workspace-write` default) | `--resume-last` |
| `opencode-delegate` | [OpenCode CLI](https://opencode.ai) | agent: `build` (write) / `plan` (read-only) | `--resume-last`, `--session <id>` |
| `agy-delegate` | Google Antigravity CLI (`agy`) | Antigravity's own permission policy; bypass is opt-in | `--resume-last`, `--conversation <id>` |
| `grok-delegate` | Grok Build CLI (`grok`) | explicit: default workspace-scoped, `--read-only` best-effort with violation detection, `--full-access` opt-in | `--resume-last`, `--session <id>` |
| `kimi-delegate` | Kimi Code CLI (`kimi`) | headless runs always use Kimi's auto permission mode | `--resume-last`, `--session <id>` |

## Install (Claude Code)

Add this repo as a marketplace, then install the plugin:

```
/plugin marketplace add yahiaashraf222/delegate-skills
/plugin install delegate-skills
```

Then invoke a skill by name, e.g. `Use codex-delegate to have Codex implement the refactor in
services/billing/, then review and commit it.`

> Still a valid [skills.sh](https://skills.sh/amElnagdy/delegate-skills) package too —
> `npx skills add amElnagdy/delegate-skills` installs the skills directly from upstream.

## What it does

The loop:

1. **Write a brief** — a self-contained task spec; the implementer sees only what you send.
2. **Dispatch** it with the bundled `relay.mjs`.
3. **Wait** for completion — the helper writes a structured `result.json`.
4. **Review** the diff — re-run the project's gates yourself.
5. **Land** it — *you* commit, because committing belongs to the reviewer.

Every relay speaks the same `delegate-relay.result.v1` contract: `status`, `exitCode`, `signal`,
the implementer's own final report, `touchedFiles`, and a session/conversation id for delta briefs.
Learn the loop once, swap the implementer freely.

## The skills

- **codex-delegate** — drive the OpenAI Codex CLI as a background implementer.
- **opencode-delegate** — same loop for OpenCode; autonomy is set by the **agent** (`build` / `plan`),
  and `--model` is required (OpenCode has no safe default).
- **agy-delegate** — same loop for Google Antigravity (`agy`); permission bypass is opt-in, never default.
- **grok-delegate** — same loop for Grok Build; `--read-only` is best-effort, so the relay flags
  `readOnlyViolation: true` when a read-only run wrote anyway.
- **kimi-delegate** — same loop for Kimi Code (`kimi`); headless runs always use Kimi's auto mode —
  `touchedFiles` and the diff, not a flag, are the guarantee.

## Requirements

- The implementer CLI for the skill you use, authenticated as you would at the terminal:
  [`codex`](https://github.com/openai/codex) · [`opencode`](https://opencode.ai) · `agy` · `grok` ·
  [`kimi`](https://moonshotai.github.io/kimi-code/en/).
- Node 18+ and `git`.
- An orchestrating agent (Claude Code) that can run shell commands and read files.
- Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).

## Trust and validation

Intentionally inspectable: all skill content is Markdown plus exactly **one** executable per skill —
each a `scripts/relay.mjs` with no network calls, no credential access, no telemetry, and no
dependencies (Node built-ins only). It shells out only to its implementer CLI and `git`, and never
commits — committing is always the orchestrator's job, after review. Read the script before you run it.

## License

MIT — see [LICENSE](LICENSE). Original work © Ahmed Mohammed (amElnagdy); this packaging preserves
the license in full.
