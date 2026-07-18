#!/usr/bin/env node
/**
 * delegate-skills · kimi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Kimi Code CLI (`kimi --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON -
 * every Kimi-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * The relay probes `kimi` first and falls back to `kimi-cli`; either command
 * may satisfy the prerequisite. It forces UTF-8 for the child process on
 * every platform (PYTHONUTF8=1, PYTHONIOENCODING=utf-8) while preserving the
 * caller's environment.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `kimi` and `git`. The `kimi` process it launches
 * does authenticate - exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `kimi -p` takes the prompt as a command-line argument, so the brief is
 * visible in the host process list (`ps`, /proc). On a shared machine keep
 * secrets out of the brief - reference them by a path or environment variable
 * the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * - after it reviews the diff and re-runs the project gates.
 *
 * Headless `--print` mode always uses Kimi's auto permission mode and never
 * asks for approval, so this relay passes no additional autonomy flag and
 * offers no read-only mode. The diff reported in `touchedFiles`, not a flag,
 * is the guarantee of what changed.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Kimi (default: current directory).
 *   --model <alias>         Kimi model alias (default: Kimi's own default_model).
 *                           An explicit alias is validated against the first
 *                           discovered config.toml before dispatch.
 *   --session <id>          Resume a specific Kimi session; send only the delta brief.
 *   --resume-last           Resume the most recent Kimi session for this cwd;
 *                           send only the delta brief.
 *   --add-dir <dir>         Add an extra workspace directory. Repeatable.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Kimi has no
 *                           timeout flag; durations use h/m/s strings.
 *   --heartbeat <dur>       Liveness heartbeat on stderr (default: 30s); pass
 *                           0 to disable. It never resets or extends --timeout.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, kimiVersion, kimiCommand, sessionId,
 *   finalMessage (Kimi's own report), touchedFiles (git porcelain, null if
 *   git cannot report), and paths to brief.txt, final.txt, events.jsonl, and
 *   stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; if neither `kimi` nor `kimi-cli`
 * is executable the relay exits 127; otherwise the exit code mirrors Kimi's
 * own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome - completed, failed, or kimi_unavailable.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { constants, homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT = "30m";
const DEFAULT_HEARTBEAT = "30s";

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    session: null,
    resumeLast: false,
    addDirs: [],
    timeout: DEFAULT_TIMEOUT,
    heartbeat: DEFAULT_HEARTBEAT,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--add-dir": opts.addDirs.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      case "--heartbeat": opts.heartbeat = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive; pass only one");
  }
  // kimi resolves a relative --add-dir against ITS cwd, so resolve against --cd
  // (not the relay's own cwd) - and only after the loop, since --add-dir may
  // appear before --cd on the command line. resolve() passes absolutes through.
  opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  // The watchdog is relay-only (kimi has no timeout flag), so a malformed
  // --timeout must fail loudly here - a silent 30m fallback would be wrong.
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is not a duration; use h/m/s strings like 30m, 90s, or 1h30m`);
  }
  if (parseHeartbeatDuration(opts.heartbeat) === null) {
    fail(`--heartbeat "${opts.heartbeat}" is not a duration; use 30s, 2m, or 0 to disable it`);
  }
  return opts;
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to kimi -p\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

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

function sanitizeLabel(value) {
  // Progress metadata must stay single-line and bounded: keep only printable
  // non-space ASCII so a malformed stream event cannot inject newlines,
  // control characters, or unbounded text into progress output.
  return String(value ?? "").replace(/[^\x21-\x7E]/g, "").slice(0, 40);
}

export function eventCategory(event) {
  const role = (typeof event?.role === "string" && sanitizeLabel(event.role)) || "event";
  const raw = typeof event?.type === "string"
    ? event.type
    : typeof event?.name === "string" ? event.name : null;
  const detail = raw === null ? "" : sanitizeLabel(raw);
  return detail ? `${role}/${detail}` : role;
}

export function formatHeartbeat({ elapsedMs, pid, eventCount, idleMs, lastCategory }) {
  const last = (lastCategory && sanitizeLabel(lastCategory)) || "none";
  return `relay: heartbeat elapsed=${compactDuration(elapsedMs)} pid=${pid ?? "?"} events=${eventCount} idle=${compactDuration(idleMs)} last=${last}\n`;
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
      const label = category ? sanitizeLabel(category) : "";
      if (label && label !== lastCategory && current - lastProgressAt >= 2_000) {
        lastCategory = label;
        lastProgressAt = current;
        write(`relay: progress elapsed=${compactDuration(current - startedAt)} event=${label}\n`);
      } else if (label) {
        lastCategory = label;
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

function parseDuration(duration) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute.
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}

function gitTouchedFiles(cwd) {
  // null (not []) when git cannot report - git missing, or a non-repo run - so
  // the caller can tell "git unavailable" apart from "Kimi changed nothing."
  // [] means git ran and the working tree is clean.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function buildArgv(opts, brief) {
  // --output-format only applies to Kimi's print mode, so --print must come
  // with stream-json; without it Kimi CLI 1.49 rejects the flag pairing.
  const argv = ["--print", "--output-format", "stream-json"];
  if (opts.model) argv.push("-m", opts.model);
  // Kimi parses --session as an optional-value option, so only the equals
  // form binds the id unambiguously.
  if (opts.session) argv.push(`--session=${opts.session}`);
  else if (opts.resumeLast) argv.push("--continue");
  for (const dir of opts.addDirs) argv.push("--add-dir", dir);
  // Use --prompt=<brief>, not a separate ["--prompt", brief] pair: the equals
  // form binds a brief that starts with "-" instead of letting it parse as a flag.
  argv.push(`--prompt=${brief}`);
  return argv;
}

function makeEventScanner(onObject) {
  // stream-json is newline-delimited JSON, but this brace-aware scan also
  // tolerates junk prefixes and concatenated objects if the format drifts.
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    buf += chunk;
    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { if (depth > 0) inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            const slice = buf.slice(start, i + 1);
            try { onObject(JSON.parse(slice)); } catch { /* ignore non-objects */ }
            start = -1;
          }
        }
      }
    }
    buf = depth > 0 && start !== -1 ? buf.slice(start) : "";
    start = -1;
    depth = 0;
    inString = false;
    escaped = false;
  };
}

export function extractText(content) {
  // stream-json assistant content is either a plain string or an array of
  // typed parts. Only text parts are user-visible - think/reasoning and tool
  // payloads never belong in the final report.
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    startedAt,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

export function makeResultWriter(opts, runtime, run) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      tool: "kimi",
      workdir: opts.cd,
      model: opts.model,
      resumed: Boolean(opts.resumeLast || opts.session),
      kimiVersion: runtime?.version ?? null,
      kimiCommand: runtime?.command ?? null,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...extra,
    };
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
}

function reportUnavailable(writeResult, resultPath) {
  const result = writeResult({
    status: "kimi_unavailable",
    exitCode: 127,
    signal: null,
    sessionId: null,
    finalMessage: "",
    touchedFiles: null,
  });
  printSummary(result, resultPath);
  process.stderr.write("relay: neither `kimi` nor `kimi-cli` could be executed from PATH. Install Kimi Code and run `kimi login` or `kimi-cli login`.\n");
  process.exit(127);
}

function dispatchToKimi(opts, brief, runtime, run, writeResult) {
  const child = spawn(runtime.command, buildArgv(opts, brief), {
    cwd: opts.cd,
    env: runtime.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Liveness reporting carries metadata only (elapsed time, pid, event count,
  // event categories) - never prompt text, message content, or tool payloads.
  // Its interval is independent of the watchdog: activity neither resets nor
  // extends --timeout.
  const reporter = createProgressReporter({
    heartbeatMs: parseHeartbeatDuration(opts.heartbeat),
    pid: child.pid,
  });

  let sessionId = null;
  const textChunks = [];
  const stderrTail = [];
  const scan = makeEventScanner((event) => {
    reporter.event(event);
    if (event.role === "assistant") {
      const text = extractText(event.content);
      if (text) textChunks.push(text);
    }
    if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }
  });

  // Decode across chunk boundaries: a multibyte UTF-8 character split between
  // two data events would otherwise decode as U+FFFD and corrupt the report.
  // Files get the raw bytes; only in-memory parsing goes through the decoders.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk) => {
    reporter.activity("stdout");
    appendFileSync(run.eventsPath, chunk);
    scan(stdoutDecoder.write(chunk));
  });

  child.stderr.on("data", (chunk) => {
    reporter.activity("stderr");
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    const text = stderrDecoder.write(chunk);
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > 20) stderrTail.shift();
  });

  const assembleFinal = () => {
    const message = textChunks.join("\n\n");
    if (message) writeFileSync(run.finalPath, message, "utf8");
    return message;
  };

  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const timeoutMs = parseDuration(opts.timeout) ?? parseDuration(DEFAULT_TIMEOUT);
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000);
  }, timeoutMs);

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    reporter.stop();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      stderrTail: stderrTail.slice(-20),
      error: String(err && err.message ? err.message : err),
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    reporter.stop();
    // A timed-out run is failed even if kimi handles SIGTERM by exiting 0 -
    // orchestrators key off status and the relay exit code.
    const succeeded = code === 0 && !watchdogFired;
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const exitCode = succeeded ? 0 : mapped === 0 ? 1 : mapped;
    const result = writeResult({
      status: succeeded ? "completed" : "failed",
      exitCode,
      signal: signal ?? null,
      sessionId,
      finalMessage: assembleFinal(),
      touchedFiles: gitTouchedFiles(opts.cd),
      ...(succeeded ? {} : { stderrTail: stderrTail.slice(-20) }),
      ...(watchdogFired ? { error: `kimi did not finish within --timeout ${opts.timeout}; killed by the relay watchdog` } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  // kimi --prompt takes the prompt as a CLI argument, so the brief rides argv.
  // The OS caps one argument (~128KB on Linux via MAX_ARG_STRLEN); reject a
  // huge brief early instead of allowing an opaque E2BIG spawn failure.
  const briefBytes = Buffer.byteLength(brief, "utf8");
  const MAX_BRIEF_BYTES = 120 * 1024;
  if (briefBytes > MAX_BRIEF_BYTES) {
    fail(`brief is ${Math.round(briefBytes / 1024)}KB; kimi passes the prompt as a CLI argument, which the OS caps (~128KB on Linux). Trim it, or have kimi read large context from the workspace instead of inlining it.`);
  }

  // Validate an explicit --model against the first discovered Kimi config
  // before any command resolution or artifact creation: a typo'd alias must
  // fail here, not after Kimi starts a session.
  if (opts.model) {
    try {
      validateModelAlias(opts.model);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  const runtime = resolveKimiCommand();
  const run = prepareRunDir(opts, brief);
  const writeResult = makeResultWriter(opts, runtime, run);
  if (!runtime) {
    reportUnavailable(writeResult, run.resultPath);
    return;
  }
  dispatchToKimi(opts, brief, runtime, run, writeResult);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  ${result.kimiCommand ?? "kimi"} ${result.kimiVersion ?? "?"}`);
  if (result.signal === "SIGKILL") lines.push("hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a kimi error; check host memory and re-dispatch, or split the task into smaller briefs.");
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (resume with: --session ${result.sessionId}): ${result.sessionId}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- kimi final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
