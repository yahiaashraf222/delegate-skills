# Kimi Relay Resilience Design

## Purpose

Make `skills/kimi-delegate/scripts/relay.mjs` reliable with current Kimi Code CLI releases on Windows and make long K3 inference waits visibly active. The change must preserve the relay's existing artifact and result contracts while remaining dependency-free.

## Scope

The implementation will:

- detect an executable Kimi CLI by trying `kimi` first and `kimi-cli` second;
- pass UTF-8 settings to the child process without replacing the caller's environment;
- validate an explicitly supplied `--model` against configured Kimi model aliases before dispatch;
- add configurable heartbeat and structured progress reporting;
- add focused automated tests and update Kimi delegate documentation;
- refresh and verify the locally installed `delegate-skills` plugin after the source change passes its gates.

The implementation will not refactor other delegate relays, change Kimi authentication, change the selected default model, or alter unrelated repository files.

## Command Resolution

The relay will probe candidate commands in this order:

1. `kimi`
2. `kimi-cli`

A candidate is usable only if a version probe starts successfully and exits successfully. The resolved command will be reused for both the version probe and dispatch so the two operations cannot select different installations. If neither candidate is usable, the relay will retain the existing `kimi_unavailable` result status and exit code 127, but its diagnostic will mention both attempted command names.

The stable result object will include the resolved executable name in an additive `kimiCommand` diagnostic field. Existing fields and meanings remain unchanged.

## UTF-8 Environment

The child environment will inherit `process.env` and override only:

- `PYTHONUTF8=1`
- `PYTHONIOENCODING=utf-8`

The version probe and dispatched Kimi process will receive the same environment. This prevents Windows CP1252 failures while preserving credentials, PATH, proxy settings, and other caller-provided environment values.

## Model Alias Validation

Validation applies only when the caller passes `--model`. Omitting `--model` continues to use Kimi's configured default.

The relay will discover configuration in the same practical precedence used by current and legacy installations:

1. `$KIMI_CODE_HOME/config.toml` when `KIMI_CODE_HOME` is set;
2. `~/.kimi-code/config.toml`;
3. `~/.kimi/config.toml` as a legacy fallback.

It will read model table keys from the first existing configuration file. Both quoted TOML keys such as `[models."kimi-code/k3"]` and simple unquoted keys will be recognized. The relay will not add a TOML dependency or attempt to interpret unrelated TOML values.

If the requested alias is absent, dispatch will stop before creating a Kimi session and report the alias, the configuration file checked, and the available aliases. If no configuration file can be read, the relay will fail clearly rather than claiming that an alias is valid. Configuration contents, tokens, and credentials will never be printed.

## Heartbeat and Progress Reporting

A new option controls heartbeat output:

```text
--heartbeat <duration>   Heartbeat interval; default 30s, 0 disables it
```

Duration syntax will match the relay's existing `h`, `m`, and `s` duration syntax, with literal `0` accepted only for disabling heartbeats.

While Kimi is running, the relay will write heartbeat lines to stderr containing:

- elapsed runtime;
- child PID when available;
- number of parsed structured events;
- time since the last stdout/event activity;
- the last event category when known.

Heartbeat output will not include prompt text, assistant content, tool arguments, tool results, credentials, or file contents.

When structured events arrive, the relay will emit concise progress lines for meaningful category changes. Repeated events of the same category will be throttled so active tool-heavy sessions do not flood stderr. All timers will be cleared on normal exit, launch failure, watchdog termination, or signal-driven completion.

The existing watchdog remains authoritative: heartbeat output proves liveness to the orchestrator but does not extend or reset `--timeout`.

## Testing Strategy

Tests will use Node's built-in `node:test` and no third-party dependencies. Small pure helpers may be exported, and script execution will remain guarded so importing the module does not dispatch Kimi.

Focused tests will cover:

- choosing `kimi` when both candidates work;
- falling back to `kimi-cli` when `kimi` is unavailable;
- returning unavailable when neither candidate works;
- preserving inherited environment values while enforcing UTF-8;
- accepting configured quoted and unquoted model aliases;
- rejecting unknown aliases before dispatch;
- configuration path precedence;
- parsing the heartbeat default, explicit duration, and disabled value;
- heartbeat text containing timing/progress metadata but no event content;
- clearing heartbeat timers when a run settles.

Verification will include:

- the focused Node test suite;
- `node skills/kimi-delegate/scripts/relay.mjs --help`;
- a native Windows no-write smoke dispatch using the configured `kimi-code/k3` alias;
- a fallback smoke test where only `kimi-cli` is discoverable;
- `npx skills add . --list`;
- local plugin refresh followed by installed relay discovery and version/help checks.

## Documentation

`skills/kimi-delegate/SKILL.md` and `skills/kimi-delegate/references/dispatch-and-poll.md` will document:

- command fallback behavior;
- exact alias validation;
- UTF-8 enforcement on Windows;
- `--heartbeat`, its default, and how to disable it;
- the distinction between heartbeat liveness and completion;
- the `kimiCommand` diagnostic field added to `result.json`.

## Compatibility and Failure Behavior

The relay remains a single Node script using built-in modules only. Existing briefs, resume flags, timeout behavior, artifacts, statuses, and exit codes remain compatible.

Pre-dispatch validation errors will be explicit and non-destructive. Once Kimi starts, current result-writing guarantees remain in force: a validated run writes `result.json` on success, failure, unavailability, or watchdog termination.

## Acceptance Criteria

The change is complete when:

1. A machine with only `kimi-cli` can dispatch successfully.
2. Every dispatched Kimi process receives UTF-8 environment settings.
3. An unknown explicit alias fails before Kimi starts and lists safe available choices.
4. A silent seven-minute inference period produces regular non-sensitive heartbeat lines.
5. Existing timeout and result semantics remain intact.
6. Automated tests and native Windows smoke tests pass.
7. The installed local plugin uses the verified updated relay.
