import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProgressReporter,
  eventCategory,
  findKimiConfig,
  formatHeartbeat,
  kimiConfigCandidates,
  makeKimiEnv,
  parseHeartbeatDuration,
  parseModelAliases,
  resolveKimiCommand,
  validateModelAlias,
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

test("eventCategory sanitizes control characters and bounds length", () => {
  const category = eventCategory({
    role: "tool\r\nassistant",
    name: `Shell\nINJECT: pwned ${"x".repeat(200)}`,
  });
  assert.match(category, /^[\x21-\x7E]+$/);
  assert.ok(category.length <= 81);
  assert.ok(!category.includes("INJECT: pwned"));
  assert.equal(category, `toolassistant/ShellINJECT:pwned${"x".repeat(23)}`);
  assert.equal(eventCategory({ role: "\n\r", name: "\t" }), "event");
});

test("formatHeartbeat stays single-line with a malicious category", () => {
  const line = formatHeartbeat({
    elapsedMs: 1_000,
    pid: 7,
    eventCount: 1,
    idleMs: 0,
    lastCategory: "tool/Shell\nINJECT: pwned\r\nrelay: fake heartbeat",
  });
  assert.equal(line.split("\n").length, 2);
  assert.ok(!line.includes("INJECT: pwned"));
  assert.ok(!line.includes("fake heartbeat"));
  assert.match(line, /last=\S{1,40}\n$/);
});

test("createProgressReporter writes single-line bounded progress for malicious categories", () => {
  const writes = [];
  // Deterministic clock: creation and first activity share a timestamp, the
  // second event lands past the 2000ms category-change throttle.
  const timestamps = [100_000, 100_000, 103_000];
  const reporter = createProgressReporter({
    heartbeatMs: 0,
    pid: 1,
    write: (line) => writes.push(line),
    now: () => timestamps.shift() ?? 103_000,
  });
  reporter.activity("tool/Shell\nINJECT: pwned");
  reporter.event({ role: "assistant\n", type: "message\r\nINJECT: pwned" });
  reporter.stop();
  assert.equal(writes.length, 2);
  for (const line of writes) {
    assert.equal(line.split("\n").length, 2);
    assert.ok(!line.includes("INJECT: pwned"));
    assert.ok(line.length <= 120);
  }
});
