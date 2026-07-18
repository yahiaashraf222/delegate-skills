# Kimi Relay Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use `superpowers:executing-plans` to execute this plan task-by-task and `kimi-delegate` with `kimi-code/k3` for code-writing steps. Kimi must leave changes uncommitted; the orchestrator reviews, reruns gates, and commits.

**Goal:** Make the Kimi delegation relay select `kimi` or `kimi-cli`, force UTF-8, reject unknown explicit model aliases before dispatch, and report safe progress throughout long inference waits.

**Architecture:** Keep the relay as one dependency-free Node ESM script. Add small exported pure helpers for command discovery, environment construction, model-alias discovery, heartbeat parsing, and progress formatting; guard `main()` so `node:test` can import those helpers. Integrate the helpers into the existing dispatch lifecycle without changing existing statuses, exit codes, artifact paths, watchdog semantics, or prompt delivery.

**Tech Stack:** Node.js 18+ ESM, Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`, `node:string_decoder`, `node:url`), `node:test`, native Windows PowerShell smoke tests, Kimi CLI 1.49.0.

## Global Constraints

- Keep `skills/kimi-delegate/scripts/relay.mjs` dependency-free and inspectable; it may call only Kimi and `git`.
- Preserve existing `delegate-relay.result.v1` fields and semantics; add only `kimiCommand`.
- Preserve existing brief, resume, timeout, artifact, exit-code, and watchdog behavior.
- Try executable candidates in exact order: `kimi`, then `kimi-cli`.
- Set `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` while preserving every other inherited environment value.
- Validate only an explicitly supplied `--model`; omission continues to use Kimi's default model.
- Discover config in exact precedence: `$KIMI_CODE_HOME/config.toml`, `~/.kimi-code/config.toml`, then `~/.kimi/config.toml`.
- Heartbeat defaults to `30s`; literal `0` disables it; heartbeats never reset or extend `--timeout`.
- Never print prompt text, response content, tool arguments/results, credentials, or file contents in progress output.
- Preserve the user's existing unrelated changes to `README.md`, `.agents/`, and `.codex-plugin/`.
- Follow TDD: observe each focused test fail for the intended missing behavior before writing production code.
- Kimi does not stage or commit. Each commit step below is performed only by the orchestrator after reviewing the diff and rerunning the stated gates.

---

## File Structure

- Modify `skills/kimi-delegate/scripts/relay.mjs`: command discovery, UTF-8 environment, alias validation, heartbeat/progress lifecycle, `kimiCommand`, and import-safe entrypoint.
- Create `skills/kimi-delegate/scripts/relay.test.mjs`: built-in Node tests for every new pure behavior and timer cleanup.
- Modify `skills/kimi-delegate/SKILL.md`: prerequisites, dispatch, heartbeat, and completion guidance.
- Modify `skills/kimi-delegate/references/dispatch-and-poll.md`: exact flags, config validation, progress semantics, result field, and troubleshooting.
- Do not modify `README.md`, `.agents/plugins/marketplace.json`, or `.codex-plugin/plugin.json` as part of this feature.

---

### Task 1: Import-Safe Relay, UTF-8 Environment, and Command Discovery

**Files:**
- Modify: `skills/kimi-delegate/scripts/relay.mjs:65-165,402-455`
- Create: `skills/kimi-delegate/scripts/relay.test.mjs`

**Interfaces:**
- Produces: `makeKimiEnv(baseEnv?: object): object`
- Produces: `resolveKimiCommand(probe?: function, baseEnv?: object): { command: string, version: string, env: object } | null`
- Produces: import-safe `main()` guard using `pathToFileURL()`
- Consumes later: Tasks 2-4 use the resolved `{command, version, env}` runtime object.

- [ ] **Step 1: Delegate this task to Kimi K3 with a bounded brief**

Run the currently installed relay from outside the source file being edited with this complete brief:

```powershell
$relay = 'C:\Users\kaito\.codex\plugins\cache\delegate-skills\delegate-skills\0.1.0\skills\kimi-delegate\scripts\relay.mjs'
$brief = @'
<task>
Implement Task 1 from docs/superpowers/plans/2026-07-18-kimi-relay-resilience.md: make the Kimi relay import-safe, add dependency-free UTF-8 environment construction, and resolve kimi before falling back to kimi-cli. Touch only skills/kimi-delegate/scripts/relay.mjs and skills/kimi-delegate/scripts/relay.test.mjs. Preserve all unrelated dirty files.
</task>
<verification_loop>
Use TDD. Run node --test skills/kimi-delegate/scripts/relay.test.mjs and node skills/kimi-delegate/scripts/relay.mjs --help. Fix failures before reporting.
</verification_loop>
<action_safety>
Do not stage or commit. Do not modify README.md, .agents/, .codex-plugin/, or design/plan documents.
</action_safety>
<structured_output_contract>
Report what changed, files touched, exact gate results, and anything left open.
</structured_output_contract>
'@
$brief | node $relay --model 'kimi-code/k3' --cd 'D:\laragon\www\delegate-skills' --timeout 30m
```

The installed relay does not yet accept `--heartbeat`, so this initial dispatch deliberately omits it.

- [ ] **Step 2: Write failing command-resolution and UTF-8 tests**

Create `skills/kimi-delegate/scripts/relay.test.mjs` with these tests:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  makeKimiEnv,
  resolveKimiCommand,
} from "./relay.mjs";

test("makeKimiEnv preserves inherited values and enforces UTF-8", () => {
  const env = makeKimiEnv({ PATH: "sentinel", PYTHONUTF8: "0", CUSTOM: "kept" });
  assert.equal(env.PATH, "sentinel");
  assert.equal(env.CUSTOM, "kept");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("resolveKimiCommand prefers kimi when both candidates succeed", () => {
  const calls = [];
  const resolved = resolveKimiCommand((command, env) => {
    calls.push({ command, env });
    return `${command}, version 1.49.0`;
  }, { PATH: "sentinel" });

  assert.equal(resolved.command, "kimi");
  assert.equal(resolved.version, "kimi, version 1.49.0");
  assert.equal(resolved.env.PYTHONUTF8, "1");
  assert.deepEqual(calls.map(({ command }) => command), ["kimi"]);
});

test("resolveKimiCommand falls back to kimi-cli", () => {
  const calls = [];
  const resolved = resolveKimiCommand((command) => {
    calls.push(command);
    if (command === "kimi") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return "kimi, version 1.49.0";
  });

  assert.equal(resolved.command, "kimi-cli");
  assert.deepEqual(calls, ["kimi", "kimi-cli"]);
});

test("resolveKimiCommand returns null when neither command succeeds", () => {
  const resolved = resolveKimiCommand(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  assert.equal(resolved, null);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
```

Expected: FAIL because `relay.mjs` does not export `makeKimiEnv` or `resolveKimiCommand`, and importing it currently executes `main()`.

- [ ] **Step 4: Implement the minimal helpers and import guard**

Update imports and replace `kimiVersion()` with:

```js
import { constants, homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const KIMI_COMMAND_CANDIDATES = ["kimi", "kimi-cli"];

export function makeKimiEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function defaultVersionProbe(command, env) {
  return execFileSync(command, ["--version"], { encoding: "utf8", env }).trim();
}

export function resolveKimiCommand(probe = defaultVersionProbe, baseEnv = process.env) {
  const env = makeKimiEnv(baseEnv);
  for (const command of KIMI_COMMAND_CANDIDATES) {
    try {
      const version = probe(command, env);
      if (version) return { command, version, env };
    } catch {
      // Try the next supported command name.
    }
  }
  return null;
}
```

Replace the unconditional final `main();` with:

```js
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
```

Do not integrate the runtime into dispatch yet; this task only establishes testable helpers and safe imports.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
node skills/kimi-delegate/scripts/relay.mjs --help
```

Expected: four tests pass; help exits 0 and prints the existing usage text.

- [ ] **Step 6: Orchestrator review and commit**

Review only the Task 1 diff, confirm `git diff --check`, then:

```powershell
git add skills/kimi-delegate/scripts/relay.mjs skills/kimi-delegate/scripts/relay.test.mjs
git commit -m "fix: resolve current Kimi CLI commands"
```

---

### Task 2: Explicit Model Alias Validation

**Files:**
- Modify: `skills/kimi-delegate/scripts/relay.mjs:65-200,402-424`
- Test: `skills/kimi-delegate/scripts/relay.test.mjs`

**Interfaces:**
- Produces: `kimiConfigCandidates(env?: object, home?: string): string[]`
- Produces: `findKimiConfig(env?: object, home?: string, fileExists?: function): string | null`
- Produces: `parseModelAliases(toml: string): string[]`
- Produces: `validateModelAlias(alias: string, options?: object): { configPath: string, aliases: string[] }`
- Consumes: existing `fail(message, 2)` in `main()` for clear pre-dispatch failure.

- [ ] **Step 1: Delegate Task 2 to Kimi K3**

Use this delta brief tied to the Task 1 Kimi session:

```powershell
$brief = @'
Implement only Task 2 from docs/superpowers/plans/2026-07-18-kimi-relay-resilience.md. Add explicit model-alias validation with the exact config precedence and test cases in the plan. Use test-first development, add no TOML dependency, never print credentials or config contents, preserve unrelated dirty files, and do not stage or commit. Run the complete relay test file and the unknown-alias command from Task 2 before reporting exact outcomes.
'@
$brief | node $relay --resume-last --cd 'D:\laragon\www\delegate-skills' --timeout 30m
```

- [ ] **Step 2: Add failing alias and path-precedence tests**

Append:

```js
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findKimiConfig,
  kimiConfigCandidates,
  parseModelAliases,
  validateModelAlias,
} from "./relay.mjs";

test("kimiConfigCandidates honors KIMI_CODE_HOME before current and legacy homes", () => {
  assert.deepEqual(
    kimiConfigCandidates({ KIMI_CODE_HOME: "X:/managed" }, "X:/home"),
    [
      join("X:/managed", "config.toml"),
      join("X:/home", ".kimi-code", "config.toml"),
      join("X:/home", ".kimi", "config.toml"),
    ],
  );
});

test("parseModelAliases reads quoted and simple TOML model tables", () => {
  const aliases = parseModelAliases(`
[models."kimi-code/k3"]
model = "k3"
[models.local]
model = "local-model"
[providers.secret]
api_key = "do-not-return"
`);
  assert.deepEqual(aliases, ["kimi-code/k3", "local"]);
});

test("validateModelAlias accepts an exact configured alias", () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-config-"));
  const current = join(root, ".kimi-code");
  mkdirSync(current);
  writeFileSync(join(current, "config.toml"), '[models."kimi-code/k3"]\nmodel="k3"\n');

  assert.deepEqual(validateModelAlias("kimi-code/k3", { env: {}, home: root }), {
    configPath: join(current, "config.toml"),
    aliases: ["kimi-code/k3"],
  });
});

test("validateModelAlias rejects an unknown alias and lists safe choices", () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-config-"));
  const legacy = join(root, ".kimi");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "config.toml"), '[models."kimi-code/k3"]\nmodel="k3"\n');

  assert.throws(
    () => validateModelAlias("k3", { env: {}, home: root }),
    /model alias "k3" is not configured.*kimi-code\/k3/s,
  );
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern='Config|ModelAlias|model alias' skills/kimi-delegate/scripts/relay.test.mjs
```

Expected: FAIL because the four alias/config helpers do not exist.

- [ ] **Step 4: Implement config discovery and exact alias parsing**

Add:

```js
export function kimiConfigCandidates(env = process.env, home = homedir()) {
  const paths = [];
  if (env.KIMI_CODE_HOME) paths.push(join(env.KIMI_CODE_HOME, "config.toml"));
  paths.push(join(home, ".kimi-code", "config.toml"));
  paths.push(join(home, ".kimi", "config.toml"));
  return [...new Set(paths)];
}

export function findKimiConfig(env = process.env, home = homedir(), fileExists = existsSync) {
  return kimiConfigCandidates(env, home).find((path) => fileExists(path)) ?? null;
}

export function parseModelAliases(toml) {
  const aliases = [];
  const table = /^\s*\[models\.(?:"((?:\\.|[^"\\])*)"|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/gm;
  for (const match of toml.matchAll(table)) aliases.push(match[1] ?? match[2]);
  return aliases;
}

export function validateModelAlias(alias, {
  env = process.env,
  home = homedir(),
  readFile = readFileSync,
  fileExists = existsSync,
} = {}) {
  const configPath = findKimiConfig(env, home, fileExists);
  if (!configPath) {
    throw new Error(`cannot validate model alias "${alias}": no Kimi config.toml found`);
  }
  const aliases = parseModelAliases(readFile(configPath, "utf8"));
  if (!aliases.includes(alias)) {
    const choices = aliases.length ? aliases.join(", ") : "(none found)";
    throw new Error(`model alias "${alias}" is not configured in ${configPath}; available aliases: ${choices}`);
  }
  return { configPath, aliases };
}
```

In `main()`, after brief-size validation and before command resolution or run-directory creation:

```js
if (opts.model) {
  try {
    validateModelAlias(opts.model);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 5: Verify GREEN and pre-dispatch rejection**

Run:

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
'Diagnostic only' | node skills/kimi-delegate/scripts/relay.mjs --model definitely-not-configured --cd .
```

Expected: all tests pass; the second command exits 2, names the checked config and available aliases, creates no Kimi session, and prints no configuration values.

- [ ] **Step 6: Orchestrator review and commit**

```powershell
git add skills/kimi-delegate/scripts/relay.mjs skills/kimi-delegate/scripts/relay.test.mjs
git commit -m "fix: validate Kimi model aliases before dispatch"
```

---

### Task 3: Configurable Heartbeats and Safe Progress Reporting

**Files:**
- Modify: `skills/kimi-delegate/scripts/relay.mjs:38-127,167-172,297-400`
- Test: `skills/kimi-delegate/scripts/relay.test.mjs`

**Interfaces:**
- Produces: `parseHeartbeatDuration(value: string): number | null`
- Produces: `eventCategory(event: object): string`
- Produces: `formatHeartbeat(state: object): string`
- Produces: `createProgressReporter(options: object): { activity(category?: string): void, event(event: object): void, stop(): void }`
- Consumes: `opts.heartbeat`, child PID, and parsed stream events.

- [ ] **Step 1: Delegate Task 3 to the same Kimi K3 session**

Use this delta-only brief:

```powershell
$brief = @'
Implement only Task 3 from docs/superpowers/plans/2026-07-18-kimi-relay-resilience.md. Follow its exact heartbeat interfaces and test cases. Use deterministic fake clocks and fake timers, never log event content, keep heartbeat independent of the watchdog, preserve unrelated dirty files, and do not stage or commit. Run the complete relay tests and help smoke before reporting exact outcomes.
'@
$brief | node $relay --resume-last --cd 'D:\laragon\www\delegate-skills' --timeout 30m
```

- [ ] **Step 2: Add failing heartbeat and timer tests**

Append these exact tests:

```js
import {
  createProgressReporter,
  eventCategory,
  formatHeartbeat,
  parseHeartbeatDuration,
} from "./relay.mjs";

test("parseHeartbeatDuration accepts durations and literal zero", () => {
  assert.equal(parseHeartbeatDuration("30s"), 30_000);
  assert.equal(parseHeartbeatDuration("1m30s"), 90_000);
  assert.equal(parseHeartbeatDuration("0"), 0);
  assert.equal(parseHeartbeatDuration("0s"), 0);
  assert.equal(parseHeartbeatDuration("bad"), null);
});

test("eventCategory uses metadata only", () => {
  assert.equal(eventCategory({ role: "assistant", type: "message", content: "secret" }), "assistant/message");
  assert.equal(eventCategory({ role: "tool", name: "Shell", content: "secret" }), "tool/Shell");
});

test("formatHeartbeat contains liveness metadata but no content", () => {
  const line = formatHeartbeat({
    elapsedMs: 420_000,
    pid: 1234,
    eventCount: 8,
    idleMs: 90_000,
    lastCategory: "assistant/message",
  });
  assert.match(line, /elapsed=7m/);
  assert.match(line, /pid=1234/);
  assert.match(line, /events=8/);
  assert.match(line, /idle=1m30s/);
  assert.doesNotMatch(line, /secret/);
});

test("createProgressReporter clears its heartbeat timer exactly once", () => {
  const cleared = [];
  let intervalCallback;
  const writes = [];
  const reporter = createProgressReporter({
    heartbeatMs: 30_000,
    pid: 1234,
    write: (line) => writes.push(line),
    now: () => 100_000,
    setIntervalFn: (callback) => { intervalCallback = callback; return 77; },
    clearIntervalFn: (id) => cleared.push(id),
  });
  intervalCallback();
  reporter.stop();
  reporter.stop();
  assert.equal(writes.length, 1);
  assert.deepEqual(cleared, [77]);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
node --test --test-name-pattern='Heartbeat|heartbeat|eventCategory|ProgressReporter' skills/kimi-delegate/scripts/relay.test.mjs
```

Expected: FAIL because heartbeat/progress exports do not exist.

- [ ] **Step 4: Add heartbeat parsing and reporter helpers**

Add `DEFAULT_HEARTBEAT = "30s"`, parse `--heartbeat`, validate it after `--timeout`, and implement:

```js
export function parseHeartbeatDuration(value) {
  if (value === "0") return 0;
  return parseDuration(value);
}

function compactDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m${remainder ? `${remainder}s` : ""}` : `${remainder}s`;
}

export function eventCategory(event) {
  const role = typeof event?.role === "string" ? event.role : "event";
  const detail = typeof event?.type === "string"
    ? event.type
    : typeof event?.name === "string" ? event.name : null;
  return detail ? `${role}/${detail}` : role;
}

export function formatHeartbeat({ elapsedMs, pid, eventCount, idleMs, lastCategory }) {
  return `relay: heartbeat elapsed=${compactDuration(elapsedMs)} pid=${pid ?? "?"} events=${eventCount} idle=${compactDuration(idleMs)} last=${lastCategory ?? "none"}\n`;
}

export function createProgressReporter({
  heartbeatMs,
  pid,
  write = (line) => process.stderr.write(line),
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let lastCategory = null;
  let eventCount = 0;
  let stopped = false;
  const timer = heartbeatMs > 0 ? setIntervalFn(() => {
    const current = now();
    write(formatHeartbeat({
      elapsedMs: current - startedAt,
      pid,
      eventCount,
      idleMs: current - lastActivityAt,
      lastCategory,
    }));
  }, heartbeatMs) : null;

  return {
    activity(category = lastCategory) {
      const current = now();
      lastActivityAt = current;
      if (category && category !== lastCategory && current - lastProgressAt >= 2_000) {
        lastCategory = category;
        lastProgressAt = current;
        write(`relay: progress elapsed=${compactDuration(current - startedAt)} event=${category}\n`);
      } else if (category) {
        lastCategory = category;
      }
    },
    event(event) {
      eventCount += 1;
      this.activity(eventCategory(event));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearIntervalFn(timer);
    },
  };
}
```

Add `heartbeat: DEFAULT_HEARTBEAT` to parsed options, accept `--heartbeat`, and fail with:

```js
if (parseHeartbeatDuration(opts.heartbeat) === null) {
  fail(`--heartbeat "${opts.heartbeat}" is not a duration; use 30s, 2m, or 0 to disable it`);
}
```

- [ ] **Step 5: Integrate reporter lifecycle without changing watchdog behavior**

Change `dispatchToKimi` to accept the resolved runtime. Create the reporter immediately after `spawn`, call `reporter.activity("stdout")` for stdout chunks, `reporter.event(event)` inside the JSON scanner, and `reporter.activity("stderr")` for stderr chunks. Call `reporter.stop()` in both `error` and `close` handlers before writing results. Do not touch `watchdogTimer` scheduling or reset it on activity.

- [ ] **Step 6: Verify GREEN and disabled behavior**

Run:

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
node skills/kimi-delegate/scripts/relay.mjs --help | Select-String heartbeat
```

Expected: all tests pass; help shows default `30s` and `0` disable behavior.

- [ ] **Step 7: Orchestrator review and commit**

```powershell
git add skills/kimi-delegate/scripts/relay.mjs skills/kimi-delegate/scripts/relay.test.mjs
git commit -m "feat: report Kimi relay heartbeat progress"
```

---

### Task 4: Dispatch Integration, Result Contract, and Documentation

**Files:**
- Modify: `skills/kimi-delegate/scripts/relay.mjs:38-62,261-301,297-424,426-452`
- Test: `skills/kimi-delegate/scripts/relay.test.mjs`
- Modify: `skills/kimi-delegate/SKILL.md:23-78`
- Modify: `skills/kimi-delegate/references/dispatch-and-poll.md:6-109`

**Interfaces:**
- Consumes: `resolveKimiCommand()`, `validateModelAlias()`, and `createProgressReporter()`.
- Produces: result field `kimiCommand: string | null`.
- Produces: dispatch uses the exact runtime selected by the version probe.

- [ ] **Step 1: Delegate Task 4 to the same Kimi K3 session**

Use this delta-only brief:

```powershell
$brief = @'
Implement only Task 4 from docs/superpowers/plans/2026-07-18-kimi-relay-resilience.md. Preserve delegate-relay.result.v1 semantics while adding kimiCommand, wire the exact resolved runtime into spawn, and update only the listed Kimi skill documentation. Keep docs synchronized with real flags. Do not modify README.md, .agents/, or .codex-plugin/. Do not stage or commit. Run all Task 4 gates and report exact outcomes.
'@
$brief | node $relay --resume-last --cd 'D:\laragon\www\delegate-skills' --timeout 30m
```

- [ ] **Step 2: Add a failing result-contract test**

Export `makeResultWriter` and append this test:

```js
test("makeResultWriter records the resolved Kimi command additively", () => {
  const root = mkdtempSync(join(tmpdir(), "kimi-result-"));
  const run = {
    startedAt: "2026-07-18T00:00:00.000Z",
    briefPath: join(root, "brief.txt"),
    finalPath: join(root, "final.txt"),
    eventsPath: join(root, "events.jsonl"),
    stderrPath: join(root, "stderr.txt"),
    resultPath: join(root, "result.json"),
  };
  writeFileSync(run.briefPath, "brief", "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");

  const writeResult = makeResultWriter(
    { cd: root, model: "kimi-code/k3", resumeLast: false, session: null },
    { command: "kimi-cli", version: "kimi, version 1.49.0", env: {} },
    run,
  );
  const result = writeResult({ status: "completed", exitCode: 0, signal: null });

  assert.equal(result.kimiCommand, "kimi-cli");
  assert.equal(result.kimiVersion, "kimi, version 1.49.0");
  assert.equal(result.schema, "delegate-relay.result.v1");
});
```

Run the focused test and expect failure because `kimiCommand` is absent.

- [ ] **Step 3: Wire the resolved runtime through result writing and dispatch**

In `main()`:

```js
const runtime = resolveKimiCommand();
const run = prepareRunDir(opts, brief);
const writeResult = makeResultWriter(opts, runtime, run);
if (!runtime) {
  reportUnavailable(writeResult, run.resultPath);
  return;
}
dispatchToKimi(opts, brief, runtime, run, writeResult);
```

Update result creation:

```js
kimiVersion: runtime?.version ?? null,
kimiCommand: runtime?.command ?? null,
```

Update dispatch:

```js
const child = spawn(runtime.command, buildArgv(opts, brief), {
  cwd: opts.cd,
  env: runtime.env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Update unavailable diagnostics to name both candidates:

```js
process.stderr.write("relay: neither `kimi` nor `kimi-cli` could be executed from PATH. Install Kimi Code and run `kimi login`.\n");
```

Update the printed summary to show `runtime.command` through `result.kimiCommand` without changing completion logic.

- [ ] **Step 4: Update user-facing documentation**

In `SKILL.md`:

- prerequisites accept either `kimi --version` or `kimi-cli --version`;
- explain exact alias validation against the first discovered config;
- show `--heartbeat 30s` and `--heartbeat 0` examples;
- state heartbeat/progress means the process remains active, not that the run completed.

Use this wording where those behaviors are introduced:

```markdown
The relay probes `kimi` first and falls back to `kimi-cli`; either command may satisfy the prerequisite.
It forces UTF-8 for the child process on every platform while preserving the caller's environment.

When `--model` is supplied, the relay validates the exact alias before dispatch using
`$KIMI_CODE_HOME/config.toml`, then `~/.kimi-code/config.toml`, then legacy
`~/.kimi/config.toml`. Omitting `--model` keeps Kimi's configured default.

Use `--heartbeat <duration>` to control liveness output (`30s` by default); pass
`--heartbeat 0` to disable it. Heartbeats and progress lines show that the child remains active.
Completion still requires the process to exit and `result.json` to contain a status.
```

In `references/dispatch-and-poll.md`:

- add the `--heartbeat` flag row;
- document command fallback order and UTF-8 child environment;
- add `kimiCommand` to result fields;
- replace “missing `kimi`” with “neither command is executable”;
- describe safe heartbeat fields and watchdog independence;
- update the equivalent command to `kimi|kimi-cli` and exact alias validation.

Add this exact troubleshooting paragraph:

```markdown
Heartbeat lines contain only elapsed time, child PID, parsed-event count, idle time, and the last
event category. They never contain brief or model output. A heartbeat does not extend or reset
`--timeout`; the watchdog remains authoritative.
```

Update the relay header comment so `--help` contains the same claims. Remove the stale “verified against 0.24.0 on macOS” and Windows native-binary-only claims rather than replacing them with an unverified version pin.

- [ ] **Step 5: Run all automated and static gates**

Run:

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
node skills/kimi-delegate/scripts/relay.mjs --help
git diff --check
rg -n "0\.24\.0|missing `kimi`|native `kimi`|--heartbeat|kimiCommand|PYTHONUTF8|PYTHONIOENCODING" skills/kimi-delegate
```

Expected: all tests pass; help/docs agree; no stale compatibility claims remain; UTF-8, heartbeat, and `kimiCommand` references are present.

- [ ] **Step 6: Orchestrator review and commit**

```powershell
git add skills/kimi-delegate/scripts/relay.mjs skills/kimi-delegate/scripts/relay.test.mjs skills/kimi-delegate/SKILL.md skills/kimi-delegate/references/dispatch-and-poll.md
git commit -m "docs: explain resilient Kimi relay behavior"
```

---

### Task 5: Native Windows Smoke Tests, Package Validation, and Plugin Refresh

**Files:**
- Verify only: `skills/kimi-delegate/scripts/relay.mjs`
- Verify only: `skills/kimi-delegate/scripts/relay.test.mjs`
- Verify only: locally installed Codex plugin cache/configuration

**Interfaces:**
- Consumes: completed relay and docs from Tasks 1-4.
- Produces: evidence that K3 dispatch, `kimi-cli` fallback, heartbeat output, package discovery, and installed plugin refresh work on native Windows.

- [ ] **Step 1: Re-run the complete source gates**

```powershell
node --test skills/kimi-delegate/scripts/relay.test.mjs
node skills/kimi-delegate/scripts/relay.mjs --help
npx --yes skills add . --list
git diff --check
git status --short
```

Expected: tests pass; help exits 0; all five delegate skills are listed; only intended feature changes plus the user's pre-existing unrelated changes appear.

- [ ] **Step 2: Run a no-write K3 heartbeat smoke test**

Use a fresh temp artifact directory outside the repository:

```powershell
$smokeRoot = Join-Path $env:TEMP ('kimi-relay-smoke-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$briefText = 'Diagnostic only. Do not call tools and do not modify files. Reply exactly: HEARTBEAT_SMOKE_OK'
$briefText | node skills/kimi-delegate/scripts/relay.mjs --model 'kimi-code/k3' --cd . --heartbeat 5s --timeout 2m --out-dir (Join-Path $smokeRoot 'artifacts')
```

Expected: at least one heartbeat if K3 takes over five seconds; exit 0; `result.json` has `status: "completed"`, `kimiCommand`, and Kimi 1.49.0; `git status --short` is unchanged from before the smoke.

- [ ] **Step 3: Smoke-test `kimi-cli` fallback on native Windows**

Create a temporary PATH directory containing only a copy of `kimi-cli.exe`, while keeping Node and system paths available:

```powershell
$fallbackRoot = Join-Path $env:TEMP ('kimi-cli-fallback-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fallbackRoot | Out-Null
Copy-Item -LiteralPath (Get-Command kimi-cli).Source -Destination (Join-Path $fallbackRoot 'kimi-cli.exe')
$node = (Get-Command node).Source
$savedPath = $env:Path
try {
  $env:Path = $fallbackRoot + ';' + (Split-Path $node) + ';C:\Windows\System32;C:\Windows'
  $briefText | & $node skills/kimi-delegate/scripts/relay.mjs --model 'kimi-code/k3' --cd . --heartbeat 0 --timeout 2m --out-dir (Join-Path $fallbackRoot 'artifacts')
} finally {
  $env:Path = $savedPath
}
```

Expected: exit 0 and fallback `result.json` contains `"kimiCommand": "kimi-cli"`. Do not rename or delete either real Kimi executable.

- [ ] **Step 4: Refresh the installed local Codex plugin**

The marketplace already points at `D:\laragon\www\delegate-skills`. Refresh the cached installation:

```powershell
codex plugin remove delegate-skills@delegate-skills --json
codex plugin add delegate-skills@delegate-skills --json
codex plugin list --json
```

Expected: removal and reinstallation succeed; list reports `delegate-skills@delegate-skills` installed and enabled from `D:\laragon\www\delegate-skills`.

- [ ] **Step 5: Verify the installed relay matches the source**

Locate the installed cache from the plugin result/list output, then compare hashes:

```powershell
$sourceRelay = 'D:\laragon\www\delegate-skills\skills\kimi-delegate\scripts\relay.mjs'
$installedRelay = 'C:\Users\kaito\.codex\plugins\cache\delegate-skills\delegate-skills\0.1.0\skills\kimi-delegate\scripts\relay.mjs'
Get-FileHash -Algorithm SHA256 $sourceRelay, $installedRelay
node $installedRelay --help
```

Expected: hashes match and installed help includes `--heartbeat`.

- [ ] **Step 6: Clean only disposable smoke artifacts**

Resolve and verify `$smokeRoot` and `$fallbackRoot` are children of `$env:TEMP`, then remove only those two directories:

```powershell
$tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
foreach ($candidate in @($smokeRoot, $fallbackRoot)) {
  $resolvedCandidate = [IO.Path]::GetFullPath($candidate)
  if (-not $resolvedCandidate.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove non-temp path: $resolvedCandidate"
  }
  Remove-Item -LiteralPath $resolvedCandidate -Recurse -Force
}
```

Do not remove repository or plugin files.

- [ ] **Step 7: Final review and handoff**

Run:

```powershell
git log --oneline -5
git status --short
git diff HEAD~3 -- skills/kimi-delegate
```

Confirm:

- every acceptance criterion in the design spec has evidence;
- no test was skipped or weakened;
- no unrelated README/manifests changes were absorbed into feature commits;
- Kimi made no commits;
- the installed plugin cache matches the source relay.

No new commit is required for verification-only Task 5.
