import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findKimiConfig,
  kimiConfigCandidates,
  makeKimiEnv,
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
