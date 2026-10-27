#!/usr/bin/env node
/**
 * **The reading-tools trial** (plans/reading-tools-trial.md): the same
 * read-only questions put to `claude -p` with jcodemunch and jdocmunch and
 * their policy (`tools`) and without (`native`), tokens, cost, turns and
 * success read from each run's JSON result, one line per run appended to
 * `results.jsonl`.
 *
 *   node trials/reading-tools/run.mjs --repo <path> [--arm native|tools] [--reps 2] [--pilot] [--dry]
 *
 * Both arms when `--arm` is left out, in a shuffled order that alternates
 * them. A run happens in a copy of the repository's committed tree
 * (`git archive HEAD`, without `trials/` and `plans/`), so neither arm finds
 * an answer in a plan or in this task file. Bounded: `MAX_RUNS` per
 * invocation, `$1` and 300 seconds per run, a log line per run, and a stop
 * when the five-hour window is past `STOP_AT` percent; run again, it skips
 * the runs already in the file.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { data, sessionEnv } from "../../plugins/workflow/scripts/plan-queue.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..");

/** Runs in one invocation at most; the trial is 96. */
export const MAX_RUNS = 100;
/** Dollars per run, passed as `--max-budget-usd`. */
export const BUDGET_USD = 1;
/** Seconds per run before it is killed. */
export const TIMEOUT_S = 300;
/** Percent of the five-hour window past which the trial stops. */
export const STOP_AT = 60;
export const ARMS = ["native", "tools"];

export const files = {
  tasks: join(here, "tasks.json"),
  mcp: join(here, "mcp.json"),
  results: process.env.READING_TRIAL_RESULTS || join(here, "results.jsonl"),
};

/** The tasks, `{ id, repo, kind, prompt, expect, oracle }`. */
export function readTasks(path = files.tasks) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** What a prompt asks for at its end, so the check reads the answer and not the reasoning. */
export const ANSWER_LINE = "Answer in one line with the names and paths.";

/** A run's answer passes when every `expect` matches it, case aside. */
export function check(task, answer) {
  if (!answer) return false;
  return task.expect.every((source) => new RegExp(source, "i").test(answer));
}

/**
 * **A run's stream**: the last line of type `result` (the same object
 * `--output-format json` prints) and the count of each tool the run called,
 * so the report can say whether the `tools` arm used the servers at all.
 */
export function readStream(stdout = "") {
  let result = null;
  const tools = {};
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // A killed run's last line may be cut.
    }
    if (event.type === "result") result = event;
    if (event.type !== "assistant") continue;
    for (const part of event.message?.content || [])
      if (part.type === "tool_use") tools[part.name] = (tools[part.name] || 0) + 1;
  }
  return { result, tools };
}

/** The per-run token figures from a result's `usage` object; null when it has none. */
export function usageOf(result) {
  const u = result?.usage;
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_creation: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

/** **T**, what a run paid for new reading: cache writes and uncached input; null with no usage. */
export const tokensOf = (usage) => (usage ? usage.cache_creation + usage.input : null);

/** The arguments of one run: the plan's command, the servers and their policy for `tools`. */
export function argsFor(task, arm, policy = "") {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(BUDGET_USD),
    "--setting-sources",
    "user",
    "--strict-mcp-config",
  ];
  if (arm === "tools") args.push("--mcp-config", files.mcp, "--append-system-prompt", policy);
  args.push("--tools", "default", "--no-session-persistence", `${task.prompt} ${ANSWER_LINE}`);
  return args;
}

/** A small seeded generator, so a resumed trial runs in the order it began in. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    t ^= t + Math.imul(t ^ (t >>> 14), 71 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * **The order**: every (task, rep) shuffled, each run for both arms back to
 * back, the arm that goes first alternating (the A/B report's control for
 * order). One arm only when `arms` names one.
 */
export function schedule(tasks, { reps = 2, arms = ARMS, seed = 27 } = {}) {
  const pairs = [];
  for (let rep = 1; rep <= reps; rep++) for (const task of tasks) pairs.push({ task, rep });
  const next = random(seed);
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const runs = [];
  pairs.forEach(({ task, rep }, i) => {
    const order = arms.length === 2 && i % 2 ? [...arms].reverse() : arms;
    for (const arm of order) runs.push({ task, rep, arm });
  });
  return runs;
}

/** The key a run is skipped by when the trial is run again. */
export const keyOf = (r) => `${r.repo}|${r.arm}|${r.id}|${r.rep}`;

/** The lines of the results file, pilot and index lines included. */
export function readResults(path = files.results) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Which task set a repository answers: this repository's, else the first project's. */
export function setOf(repo) {
  const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  return resolve(top) === repository ? "plugin" : "project";
}

/** The copy a run happens in: the committed tree at HEAD, made once per commit. */
export function exportOf(repo, set, { make = true } = {}) {
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dir = join(tmpdir(), "reading-tools", `${set}-${sha.slice(0, 8)}`);
  // The marker sits beside the copy, where no run looks.
  if (!make || existsSync(`${dir}.done`)) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  execFileSync("git", [
    "-C",
    repo,
    "archive",
    "--format=tar",
    "-o",
    tar,
    "HEAD",
    "--",
    ".",
    ":(exclude)trials",
    ":(exclude)plans",
  ]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  rmSync(tar, { force: true });
  appendFileSync(`${dir}.done`, sha);
  return dir;
}

/** Bytes under a directory, or 0 when it is missing. */
function sizeOf(path) {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, name) => n + sizeOf(join(path, name)), 0);
}

/**
 * **The indexes, once per copy**, before its first `tools` run: jcodemunch
 * on the tree, jdocmunch on its `docs/` (the whole tree when it has none),
 * the free local index only; the time and the growth of each index store
 * recorded as an `index` line.
 */
function indexOnce(dir, set, done, log) {
  if (done.some((l) => l.kind === "index" && l.dir === dir)) return;
  const stores = [join(homedir(), ".code-index"), join(homedir(), ".doc-index")];
  const before = stores.map(sizeOf);
  const docs = existsSync(join(dir, "docs")) ? join(dir, "docs") : dir;
  const time = (cmd, args) => {
    const t = Date.now();
    execFileSync(cmd, args, { stdio: "ignore", timeout: 600_000 });
    return (Date.now() - t) / 1000;
  };
  const code = time("jcodemunch-mcp", ["index", dir, "--no-ai-summaries"]);
  const doc = time("jdocmunch-mcp", [
    "index-local",
    "--path",
    docs,
    "--no-ai-summaries",
    "--no-embeddings",
  ]);
  const after = stores.map(sizeOf);
  const line = {
    kind: "index",
    at: new Date().toISOString(),
    repo: set,
    dir,
    seconds: { code, docs: doc },
    bytes: { code: after[0] - before[0], docs: after[1] - before[1] },
  };
  appendFileSync(files.results, JSON.stringify(line) + "\n");
  log(
    `index ${set}: jcodemunch ${code}s ${line.bytes.code} B; jdocmunch ${doc}s ${line.bytes.docs} B`,
  );
}

/** The two servers' own policies for CLAUDE.md, joined: the vendor's "ask for it by name". */
export function policy() {
  const out = (cmd) => execFileSync(cmd, ["claude-md"], { encoding: "utf8" }).trim();
  return `${out("jcodemunch-mcp")}\n\n${out("jdocmunch-mcp")}\n`;
}

/** How old a reading of usage.json may be before it is said to be stale: the queue's own bound. */
export const USAGE_STALE_MS = 30 * 60_000;

/**
 * **The five-hour window, from the status line's file**: `over` is the
 * percent when it is past `STOP_AT` in a window not yet reset, else null;
 * `stale` when the reading is older than `USAGE_STALE_MS` (the status line
 * writes it only while a session renders), so the stop cannot see the window.
 */
export function windowOf(path = join(data(), "usage.json"), now = Date.now()) {
  try {
    const usage = JSON.parse(readFileSync(path, "utf8"));
    const u = usage.five_hour;
    const stale = !usage.at || now - usage.at * 1000 > USAGE_STALE_MS;
    if (!u || (u.resets_at && u.resets_at * 1000 < now)) return { over: null, stale };
    return { over: u.used_percentage > STOP_AT ? u.used_percentage : null, stale };
  } catch {
    return { over: null, stale: true };
  }
}

/** One run: the command in the copy, its JSON result read and checked. */
function runOne({ task, rep, arm }, dir, policyText) {
  const started = Date.now();
  const out = spawnSync("claude", argsFor(task, arm, policyText), {
    cwd: dir,
    env: sessionEnv(process.env),
    encoding: "utf8",
    timeout: TIMEOUT_S * 1000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const seconds = (Date.now() - started) / 1000;
  const { result, tools } = readStream(out.stdout || "");
  const answer = typeof result?.result === "string" ? result.result : "";
  const error = out.error
    ? String(out.error.code || out.error.message)
    : result?.is_error || (result?.subtype && result.subtype !== "success")
      ? result.subtype && result.subtype !== "success"
        ? result.subtype
        : `error${result.api_error_status ? ` ${result.api_error_status}` : ""}`
      : !result
        ? `exit ${out.status}: ${(out.stderr || "").trim().slice(0, 200)}`
        : null;
  return {
    kind: "run",
    at: new Date(started).toISOString(),
    repo: task.repo,
    arm,
    id: task.id,
    rep,
    ok: check(task, answer),
    cost: result?.total_cost_usd ?? null,
    usage: usageOf(result),
    turns: result?.num_turns ?? null,
    seconds,
    tools,
    answer: answer.slice(0, 500),
    error,
  };
}

function parse(argv) {
  const opts = { reps: 2, arm: null, repo: null, pilot: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pilot") opts.pilot = true;
    else if (a === "--dry") opts.dry = true;
    else if (a === "--arm") opts.arm = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--reps") opts.reps = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.arm && !ARMS.includes(opts.arm)) throw new Error(`--arm is native or tools`);
  if (opts.pilot) opts.repo ??= repository;
  if (!opts.repo) throw new Error("--repo <path> is required");
  return opts;
}

/** Shell-quoted, for the dry run's printout. */
const quote = (s) => (/^[\w./:=@,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parse(argv);
  const repo = resolve(opts.repo);
  const set = setOf(repo);
  const tasks = readTasks().filter((t) => t.repo === set);
  const arms = opts.arm ? [opts.arm] : ARMS;
  // The pilot: the first two tasks of this repository, each arm once.
  const runs = opts.pilot
    ? tasks.slice(0, 2).flatMap((task) => arms.map((arm) => ({ task, rep: 1, arm })))
    : schedule(tasks, { reps: opts.reps, arms });
  const dir = exportOf(repo, set, { make: !opts.dry });
  if (opts.dry) {
    for (const r of runs) {
      const args = argsFor(r.task, r.arm, "<the two claude-md policies>");
      log(`(cd ${dir}) claude ${args.map(quote).join(" ")}`);
    }
    return 0;
  }
  const done = readResults();
  const skip = new Set(done.filter((l) => l.kind === "run" && !l.pilot).map(keyOf));
  const todo = opts.pilot
    ? runs
    : runs.filter((r) => !skip.has(keyOf({ repo: set, arm: r.arm, id: r.task.id, rep: r.rep })));
  if (todo.length > MAX_RUNS) {
    log(`${todo.length} runs waiting; this invocation runs ${MAX_RUNS}.`);
    todo.length = MAX_RUNS;
  }
  const policyText = arms.includes("tools") ? policy() : "";
  if (arms.includes("tools")) indexOnce(dir, set, done, log);
  log(`${todo.length} runs on ${set} in ${dir}`);
  let n = 0;
  let warned = false;
  for (const r of todo) {
    const { over, stale } = windowOf();
    if (stale && !warned) {
      log(
        `usage.json is missing or over 30 minutes old: the ${STOP_AT} percent stop cannot see the window.`,
      );
      warned = true;
    }
    if (over !== null) {
      log(
        `Stopped: the five-hour window is at ${over} percent (past ${STOP_AT}). Run again after it resets.`,
      );
      return 2;
    }
    const line = { ...runOne(r, dir, policyText), ...(opts.pilot ? { pilot: true } : {}) };
    appendFileSync(files.results, JSON.stringify(line) + "\n");
    n++;
    const T = tokensOf(line.usage) ?? "?";
    log(
      `[${n}/${todo.length}] ${set} ${r.arm} ${r.task.id} rep ${r.rep}: ${line.ok ? "ok" : "FAIL"}` +
        ` ${line.seconds.toFixed(0)}s $${line.cost?.toFixed(3) ?? "?"} T=${T} turns=${line.turns ?? "?"}` +
        (line.error ? ` error=${line.error}` : ""),
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
