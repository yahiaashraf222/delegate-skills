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
