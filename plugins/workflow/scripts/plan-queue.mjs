#!/usr/bin/env node
// The plan queue, and the hooks that carry plans from the planner to the
// executor (docs/workflow.md, "The queue"):
//
//   plan-queue.mjs list      `plans`: the plans written, being built, built
//                            and waiting, read from the files
//   plan-queue.mjs prompt    on UserPromptSubmit: an executor takes the lock,
//                            or is refused while another holds it; the queue
//                            goes into the context
//   plan-queue.mjs tool      on PreToolUse: refuses an executor's edit or
//                            writing command while another executor holds
//                            the lock, or after retiring; a planner's edit to
//                            a taken plan
//   plan-queue.mjs stop      on Stop: the project's run on the push, then the
//                            waiting plans (built here while the context is
//                            fresh, or a fresh executor started when tired)
//   plan-queue.mjs wrote     on PostToolUse (Edit, Write): an executor's
//                            Building line stops the retired planner of it
//   plan-queue.mjs compact   on PostCompact: counts the session's compactions
//   plan-queue.mjs resumed   on SessionStart after a compaction: asks for a
//                            handover at the third inside one plan
//   plan-queue.mjs cutoff    on StopFailure (rate_limit): hands the plan over
//                            and starts its resumption at the window's reset
//   plan-queue.mjs start     `plans start`: the one thing that starts
//                            executors and planners, within the bounds below
//   plan-queue.mjs end       `plans end`: ends this queue's finished chats; with
//                            --timer, the end timer each stop arms an hour on
//   plan-queue.mjs pause | resume | sync | init
//
// **Bounded, as every loop over model calls is**: one executor at a time
// (the lock); no start without usage headroom, deferred to the window's
// reset instead; no start after one that died within ten minutes for
// another reason; a tripwire at twenty-four starts a day; a pause switch.
// Every session the queue starts is a Remote Control chat, so none runs
// unwatched. No model call here; a hook that fails does nothing, which is
// the behavior without it. Session state lives in the OS temp directory;
// the lock, the pause and the deferral in the project's `.claude/` (ignored
// by git); the usage numbers and the starts' log in the plugin's data
// directory.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { shellWrites, untiered } from "./turn-audit.mjs";
import { catalogueFiles, locations, paragraphs } from "./catalogue-context.mjs";
import {
  PROJECT_FILE,
  compiles,
  connectorAlone,
  couldNameMcp,
  everyTool,
  init,
  kindOf,
  machine,
  owner,
  pluginAgents,
  project,
} from "./project.mjs";

export { machine, owner };

/** The modes Claude Code runs as hooks, from `hooks/hooks.json`. */
const HOOK_MODES = ["prompt", "tool", "stop", "wrote", "compact", "resumed", "cutoff"];

/**
 * The project: for a hook, `CLAUDE_PROJECT_DIR`, which Claude Code sets for
 * it; for the command, the repository it is run in (`bin/plans` sets
 * `WORKFLOW_ROOT`, since the Bash tool may carry another project's
 * `CLAUDE_PROJECT_DIR`, so `cd <checkout> && plans start` acts there). The
 * processes the command spawns inherit the environment, and with it the root;
 * a hook never reads `WORKFLOW_ROOT`.
 */
const root =
  (HOOK_MODES.includes(process.argv[2]) ? "" : process.env.WORKFLOW_ROOT) ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.cwd();
const here = dirname(fileURLToPath(import.meta.url));

/**
 * **The plugin's data directory**, kept across updates: from the script's own
 * path when run from the cache (`<plugins>/cache/<marketplace>/<plugin>/
 * <version>/scripts` gives `<plugins>/data/<plugin>-<marketplace>`); else the
 * default for this plugin. `WORKFLOW_DATA` for the tests. Never
 * `CLAUDE_PLUGIN_DATA`: in a Bash call, and in a session started from one, it
 * names whichever plugin exported it last, and it named the Codex plugin's
 * directory here.
 */
export function data(env = process.env, scriptDir = here) {
  if (env.WORKFLOW_DATA) return env.WORKFLOW_DATA;
  const cached = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]scripts$/.exec(
    scriptDir,
  );
  if (cached) return join(cached[1], "data", `${cached[3]}-${cached[2]}`);
  return join(homedir(), ".claude", "plugins", "data", "workflow-workflow");
}

/** The project's part, read once per process. */
let projectRead = null;
function proj() {
  projectRead ??= project(root);
  return projectRead;
}
const branch = () => proj().branch;

/** Plans dated before this are built by path only, as before the queue. */
export const QUEUE_SINCE = Date.UTC(2026, 9, 24);
/** No executor starts above these (percent of each window): 80 is lenient, since a plan cut off is resumed at the reset; the seven-day reset can be days away. */
export const FIVE_HOUR_MAX = 80;
export const SEVEN_DAY_MAX = 95;
const MINUTE = 60_000;
const QUICK_DEATH = 10 * MINUTE;
const USAGE_STALE = 30 * MINUTE;
const TRIPWIRE = 24;
const HANDOVER_AT = 3;
const MAX_HANDOVERS = 6;
/** Seconds after a window's reset that a deferred start runs. */
const AFTER_RESET = 120;

const files = {
  lock: () => join(root, ".claude", "executor.lock"),
  pause: () => join(root, ".claude", "executor.pause"),
  // One deferral per kind, so a planner's never drops an executor's.
  deferred: (kind = "executor") => join(root, ".claude", `${kind}.deferred`),
  usage: () => process.env.WORKFLOW_USAGE_FILE || join(data(), "usage.json"),
  starts: () => process.env.WORKFLOW_STARTS_LOG || join(data(), "starts.log"),
  state: (sessionId) => join(tmpdir(), `workflow-queue-${sessionId || "unknown"}.json`),
};

/** What `plans` says, and `plans start` refuses with, in a project with no project file. */
const NO_PROJECT = `No ${PROJECT_FILE} here: plans init writes one.`;
/** What `plans` says, and `plans start` refuses with, in a project in the compact form. */
const COMPACT =
  "This project is in the compact form (form: compact): one chat decides and builds, and there is no queue.";

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "24 October 2026" as a UTC day, or NaN. */
export function parseDay(text) {
  // "26 October 2026", as the plans and `today()` write it, or "2026-10-26",
  // as an agent or a person may (plans/queue-reads-iso-dates.md).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (iso) {
    const [year, month, day] = iso.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
    return Date.UTC(year, month - 1, day);
  }
  const m = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(text.trim());
  if (!m) return NaN;
  const month = MONTHS.indexOf(m[2]);
  return month < 0 ? NaN : Date.UTC(Number(m[3]), month, Number(m[1]));
}

/** A plan's or brief's day in either spelling `parseDay` reads. */
const DAY = "\\d{1,2} [A-Z][a-z]+ \\d{4}|\\d{4}-\\d{2}-\\d{2}";

/** Today as the plans write it: "24 October 2026". */
export function today(now = Date.now()) {
  const d = new Date(now);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function sectionAfter(text, heading) {
  const at = text.search(heading);
  if (at < 0) return "";
  const rest = text.slice(at);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * A plan's place in the queue, read from its text. `live` is the live
 * sessions' ids, or null when they could not be listed, which counts every
 * Building line as live: the safe side.
 */
export function stateOf(text, { mtime = 0, live = null } = {}) {
  // **A plan is a plan before it is a brief**: its header is read first, and
  // the brief's line only at a line's start, so a plan whose first lines
  // mention the brief it replaced reads as the plan.
  const header = new RegExp(`^(Plan only|Short plan), (${DAY})`, "m").exec(
    text.split("\n").slice(0, 12).join("\n"),
  );
  const head = text.split("\n").slice(0, 6).join("\n");
  // **A brief is queued like a plan** (plans/planner-queue.md): one a
  // planner is working on carries its Planning line, live while its session is.
  const brief = header ? null : new RegExp(`^Brief for the planner(?:, (${DAY}))?`, "m").exec(head);
  if (brief) {
    const day = brief[1] || "";
    const base = { kind: "Brief", day, date: day ? parseDay(day) : 0, mtime };
    const planning = /^## Planning, ([^,\n]+), session ([^\s,]+)/m.exec(text);
    if (planning && (live === null || live.includes(planning[2])))
      return { ...base, state: "planning", session: planning[2], since: planning[1] };
    return { ...base, state: "brief", stale: Boolean(planning) };
  }
  if (!header) return null;
  const plan = { kind: header[1], day: header[2], date: parseDay(header[2]), mtime };
  const built = /^## Built(?:, ([^\n]+))?/m.exec(text);
  if (built) {
    // The commit is the hash written after "commit", else the section's first eight-hex word.
    const section = sectionAfter(text, /^## Built/m);
    const named = /\bcommit `?([0-9a-f]{8})[0-9a-f]*`?/.exec(section);
    const sha = named ? named[1] : (/\b[0-9a-f]{8}\b/.exec(section)?.[0] ?? "");
    return { ...plan, state: "built", builtDay: (built[1] || "").trim(), sha };
  }
  const resumed = [
    ...text.matchAll(/^## Resumed, [^,\n]+, session [^,\s]+, at step ([^\s,.]+)/gm),
  ].map((m) => m[1]);
  const stuck =
    resumed.length >= MAX_HANDOVERS || (resumed.length >= 2 && resumed.at(-1) === resumed.at(-2));
  const building = /^## Building, ([^,\n]+), session ([^\s,]+)/m.exec(text);
  if (building && (live === null || live.includes(building[2]))) {
    return { ...plan, state: "building", session: building[2], since: building[1], resumed, stuck };
  }
  const stale = Boolean(building);
  const handed = /^## Handing over/m.test(text);
  if (handed) {
    const section = sectionAfter(text, /^## Handing over/m);
    // The name runs to whitespace, a trailing full stop or comma dropped; a
    // backticked name is taken whole (`feat/v1.2` is not `feat/v1`).
    const named = /branch `([^`\n]+)`|branch ([\w./-]+?)(?=[.,;:]?(?:\s|$))/m.exec(section);
    const branch = named ? [named[1] || named[2]] : null;
    const step = /^Step in hand: ([^\n]+)/m.exec(section);
    return {
      ...plan,
      state: "handed",
      stale,
      resumed,
      stuck,
      branch: branch ? branch[0] : "",
      step: step ? step[1].trim() : "",
    };
  }
  // A date that does not parse (NaN) is no date on or after the queue's start.
  if (!(plan.date >= QUEUE_SINCE)) return { ...plan, state: "old" };
  const asks =
    /^## Decisions for [^\n]*\n[\s\S]*?^\d+\./m.test(sectionAfter(text, /^## Decisions for /m)) &&
    !/^## Decided/m.test(text);
  return { ...plan, state: "ready", stale, asks };
}

/** The repository paths a plan names, once each. */
export function pathsIn(text) {
  // Any path of two or more segments with an extension, but the plans': every
  // batch changes the plans it builds, and every plan names the plans it rests on.
  const found = text.match(/(?<![\w/.:-])[\w-]+(?:\/[\w.-]+)+\.\w+/g) || [];
  return [...new Set(found.filter((path) => !path.startsWith("plans/")))];
}

/** Whether a plan names a file this batch changed. */
export function related(text, changed) {
  const set = new Set(changed);
  return pathsIn(text).some((path) => set.has(path));
}

/**
 * The paths a brief or a planner's plan names: `pathsIn`'s, and `plans/` and
 * `.claude/` too (plans/planner-continues.md, part 3). The executor's rule
 * stays narrow, since every batch changes the plans it builds; a brief that
 * names a plan this planner wrote, or the agent file it read, is on its ground.
 */
export function briefPaths(text) {
  const found = text.match(/(?<![\w/.:-])\.?[\w-]+(?:\/[\w.-]+)+\.\w+/g) || [];
  return [...new Set(found)];
}

/** Whether a brief names a file one of the planner's plans names, or one of those plans. */
export function relatedBrief(briefText, ownTexts = [], ownPaths = []) {
  const own = new Set([...ownPaths, ...ownTexts.flatMap((text) => briefPaths(text))]);
  return briefPaths(briefText).some((path) => own.has(path));
}

/** The plans under `plans/`, each with its path and state, the queue's order (handed over first, then oldest). */
export function readPlans(dir = join(root, "plans"), live = null) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const plans = [];
  for (const name of names) {
    const file = join(dir, name);
    let text;
    let mtime;
    try {
      text = readFileSync(file, "utf8");
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const state = stateOf(text, { mtime, live });
    if (state) plans.push({ path: `plans/${name}`, file, text, ...state });
  }
  return plans.sort(
    (a, b) =>
      Number(b.state === "handed") - Number(a.state === "handed") ||
      (a.date || 0) - (b.date || 0) ||
      a.mtime - b.mtime,
  );
}

/**
 * **The rows a project counts as its own** (each project's queue runs apart):
 * a session whose working directory is in its checkout or one of its
 * worktrees, or one its own files name, the lock's holder or a `Building` or
 * `Planning` line's session, wherever it works.
 */
export function ownRows(rows, { paths = [], lockId = "", named = [] } = {}) {
  return rows.filter(
    (row) =>
      inThisRepo(row.cwd, paths) ||
      Boolean(row.sessionId && (row.sessionId === lockId || named.includes(row.sessionId))),
  );
}

/** The sessions the plans name in their `Building` and `Planning` lines, read from the files. */
function namedSessions(dir = join(root, "plans")) {
  const ids = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return ids;
  }
  for (const name of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^## (?:Building|Planning), [^,\n]+, session ([^\s,]+)/gm))
      ids.push(m[1]);
  }
  return ids;
}

/** The `claude` the queue runs: `WORKFLOW_CLAUDE` in the tests, a script in its place. */
const claudeBin = () => process.env.WORKFLOW_CLAUDE || "claude";

/** `claude agents`, read once per process; the start's wait asks it fresh. */
let liveRead;

/** This project's sessions, from `claude agents --json` (`ownRows`); null when it cannot be read. */
let liveAll = null;

/**
 * The names of every live session on this machine, in any checkout: a
 * start's number counts them all, since two checkouts of one project share
 * its names (Codex, plans/session-names-across-machines.md).
 */
function liveNames() {
  liveSessions();
  return (liveAll || []).map((row) => row.name || "");
}

export function liveSessions({ fresh = false, timeout = 8000 } = {}) {
  if (!fresh && liveRead !== undefined) return liveRead;
  let rows = null;
  // The tests' sessions, so a hook run in a child process sees rows of their own.
  if (process.env.WORKFLOW_LIVE) rows = JSON.parse(process.env.WORKFLOW_LIVE);
  else {
    try {
      rows = JSON.parse(
        execFileSync(claudeBin(), ["agents", "--json"], {
          cwd: root,
          encoding: "utf8",
          timeout,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      rows = null;
    }
  }
  liveAll = rows;
  liveRead =
    rows &&
    ownRows(rows, {
      paths: worktreePaths(),
      lockId: readJson(files.lock())?.sessionId || "",
      named: namedSessions(),
    });
  return liveRead;
}

/**
 * The worktrees of this repository, the checkout first, from `git worktree
 * list`. **A background session lives in one** (plans/queue-sees-worktree-
 * executor.md): Claude Code moves it under `.claude/worktrees/` before its
 * first edit, so a session counted only in the checkout read as gone.
 */
export function worktrees() {
  treesRead ??= readWorktrees();
  return treesRead;
}

/** `git worktree list`, read once per process. */
let treesRead;

function readWorktrees() {
  let out = "";
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [{ path: root, branch: "" }];
  }
  const trees = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) trees.push({ path: line.slice(9), branch: "" });
    else if (line.startsWith("branch refs/heads/") && trees.length)
      trees.at(-1).branch = line.slice(18);
  }
  // The checkout first, as `git worktree list` gives it; root when it does not.
  if (trees[0]?.path !== root) trees.unshift({ path: root, branch: "" });
  return trees;
}

function worktreePaths() {
  return worktrees().map((tree) => tree.path);
}

/** The worktree a working directory is in: the deepest whose path is it or holds it. */
function treeOf(cwd, trees) {
  if (!cwd) return null;
  return (
    trees
      .filter((tree) => cwd === tree.path || cwd.startsWith(`${tree.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

/**
 * **Any live executor counts** (plans/queue-counts-any-executor.md): a
 * session is an executor by its name (`Executor n`, given by `start()`), by
 * the state its prompt hook wrote (`agent: "executor"`, so one the owner started
 * by hand counts too), or by holding the lock. **A planner counts only when
 * the queue started it** (plans/planner-queue.md): a background row named
 * `Planner n`, or one whose state says `agent: "planner"`; the owner's own
 * planner chats are his, not the queue's.
 */
export function isSession(kind, row, state, lock) {
  const named = parseName(row.name || "")?.kind === kind;
  if (kind === "planner") return row.kind === "background" && (named || state?.agent === "planner");
  return (
    named ||
    state?.agent === "executor" ||
    Boolean(lock && !lock.released && lock.sessionId === row.sessionId)
  );
}

/**
 * **A session's name** (plans/session-names-across-machines.md):
 * `<Project> <Kind> <n> (<machine>)`, `Workflow Executor 2 (lab)`, the
 * project and the machine optional, so a session started before the
 * machine was in the name still counts as the queue's.
 */
export const SESSION_NAME = /^(?:(.+) )?(Executor|Planner) (\d+)(?: \(([\w.-]+)\))?$/;

/** The name the queue gives a session it starts. */
export function sessionName(kind, n, { project = "", machine = "" } = {}) {
  return [project, kind === "planner" ? "Planner" : "Executor", n, machine && `(${machine})`]
    .filter(Boolean)
    .join(" ");
}

/** `{ project, kind, n, machine }` from a session's name, or null when the queue gave no such name. */
export function parseName(name) {
  const m = SESSION_NAME.exec(name);
  return m
    ? { project: m[1] || "", kind: m[2].toLowerCase(), n: Number(m[3]), machine: m[4] || "" }
    : null;
}

/**
 * A row's status as the queue says it: "waiting for input" when it waits on
 * the owner (a question asked, a prompt standing: `state` blocked, or
 * `waitingFor` input needed). A session that ended its turn on a question
 * reads `status: idle` with no `waitingFor`, so `state` is what says it
 * (plans/idle-chats-end.md, part 4).
 */
function statusOf(row) {
  const status = row.status || "status unknown";
  if (row.waitingFor === "input needed" || row.state === "blocked") return "waiting for input";
  return row.waitingFor ? `${status}, ${row.waitingFor}` : status;
}

/**
 * The live sessions of a kind (`executor` or `planner`), each with where it
 * works (`checkout` or a worktree's name), its branch, whether it holds the
 * lock, whether it is retired, and the plan its Building line (an
 * executor's) or the brief its Planning line (a planner's) names.
 */
export function sessionsOf(
  kind,
  live,
  lock,
  {
    trees = worktrees(),
    plans = [],
    stateFor = readState,
    usageFor = (row) => sessionUsage(transcriptOf(row)),
    ceiling = REUSE_DEFAULT,
  } = {},
) {
  if (!live) return [];
  const working = kind === "planner" ? "planning" : "building";
  return live
    .map((row) => ({ row, state: stateFor(row.sessionId) }))
    .filter(({ row, state }) => isSession(kind, row, state, lock))
    .map(({ row, state }) => {
      const tree = treeOf(row.cwd, trees);
      return {
        kind,
        sessionId: row.sessionId,
        id: row.id || "",
        name: row.name || String(row.sessionId).slice(0, 8),
        status: statusOf(row),
        // Its context and the age of its last turn, from its transcript.
        usage: usageFor(row),
        ceiling,
        where: !tree || tree.path === root ? "checkout" : basename(tree.path),
        branch: tree?.branch || "",
        holdsLock:
          kind === "executor" &&
          Boolean(lock && !lock.released && lock.sessionId === row.sessionId),
        retired: Boolean(state?.retired),
        on:
          plans.find((plan) => plan.state === working && plan.session === row.sessionId)?.path ||
          "",
        // When its end timer fires, if it is left quiet (plans/idle-chats-end.md).
        endsAt: state?.end?.at || 0,
        // A planner's plans, which its chat still talks about, where each
        // stands, and how tired it is.
        ...(kind === "planner"
          ? {
              holds: withPlans(state)?.plans || [],
              standing: Object.fromEntries(
                (withPlans(state)?.plans || []).map((path) => [
                  path,
                  standingOf(
                    plans.find((plan) => plan.path === path),
                    live,
                    {
                      self: row.sessionId,
                      stateFor,
                      usageFor,
                    },
                  ),
                ]),
              ),
              compactions: state?.compactions || 0,
            }
          : {}),
      };
    });
}

/**
 * Where a planner's plan stands, as its line says it (plans/idle-chats-end.md,
 * part 5), so an idle planner's reason is read off the line.
 */
function standingOf(plan, live, { self = "", ...options } = {}) {
  if (!plan) return "gone";
  if (plan.state === "ready" && plan.asks) {
    // "Asked once": the planner's own while its question is under thirty minutes old.
    const asking = "askingIn" in plan ? plan.askingIn : askingIn(plan, live, options);
    if (!asking) return "unanswered, the executor decides";
    return `asks ${owner()}${asking.row.sessionId === self ? " here" : ""} until ${hhmm(asking.until)}`;
  }
  if (plan.state === "ready") return "ready, for the executor";
  if (plan.state === "handed") return "handed over";
  if (plan.state === "building")
    return `building, ${live?.find((row) => row.sessionId === plan.session)?.name || String(plan.session).slice(0, 8)}`;
  return plan.state;
}

/** "a (built) and b (ready, for the executor)": a planner's plans with where each stands, when known. */
function heldWords(one) {
  const standing = one.standing || {};
  return andList(
    (one.holds || []).map((path) => (standing[path] ? `${path} (${standing[path]})` : path)),
  );
}

/**
 * "ends at 22:49 if left quiet" while the end timer is ahead and the session
 * idle, else "": a turn under way or a question standing is not quiet.
 */
function endsWords(one, now = Date.now()) {
  return one.endsAt > now && /^idle\b/.test(one.status || "")
    ? `ends at ${new Date(one.endsAt).toTimeString().slice(0, 5)} if left quiet`
    : "";
}

/** "618k context, warm", "200k context, cold 130 min, over the reuse ceiling", or "" with no usage. */
export function usageWords(one, now = Date.now()) {
  if (!one.usage) return "";
  const age = now - one.usage.at;
  return [
    `${Math.round(one.usage.context / 1000)}k context`,
    age <= WARM ? "warm" : `cold ${Math.round(age / MINUTE)} min`,
    one.usage.context > (one.ceiling || REUSE_DEFAULT) ? "over the reuse ceiling" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** One session as its kind's line says it. */
export function describeSession(one) {
  if (one.kind === "planner") {
    const holds = one.holds || [];
    const n = one.compactions || 0;
    return [
      `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
      one.status,
      usageWords(one),
      endsWords(one),
      !one.retired && one.on ? `planning ${one.on}` : "",
      !one.retired && holds.length ? `holds ${heldWords(one)}` : "",
      !one.retired && n ? `${n} compaction${n === 1 ? "" : "s"}` : "",
      one.retired
        ? holds.length
          ? `retired, its plan${holds.length === 1 ? "" : "s"} ${heldWords(one)}`
          : "retired"
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
    one.status,
    usageWords(one),
    endsWords(one),
    one.where === "checkout"
      ? "in the checkout"
      : `in ${one.where}${one.branch ? ` on ${one.branch}` : ""}`,
    one.holdsLock ? "holds the lock" : "",
    one.on ? `building ${one.on}` : "",
    one.retired ? "retired" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** "a", "a and b", "a, b and c". */
function andList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The line for a kind: "The executor: ...", "The executors: ...", or "none alive". */
function sessionsLine(kind, alive) {
  const word = kind === "planner" ? "planner" : "executor";
  if (!alive.length) return `The ${word}: none alive.`;
  return `The ${word}${alive.length === 1 ? "" : "s"}: ${alive.map(describeSession).join("; ")}.`;
}

/** Whether a session's working directory is this checkout, one of its worktrees, or under one; no directory is no repository's. */
export function inThisRepo(cwd, paths) {
  return Boolean(cwd) && paths.some((path) => cwd === path || cwd.startsWith(`${path}/`));
}

function pidAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether the lock keeps this session from building: another session's, not released, its process alive. */
export function lockHeldByOther(lock, sessionId, alive = pidAlive) {
  return Boolean(lock && !lock.released && lock.sessionId !== sessionId && alive(lock.pid));
}

/** A shell command a retired or locked-out executor may still run: one that writes nothing, or the queue's own list. */
export function allowedWhileLocked(command) {
  if (/^\s*(plans(\s+(--all|list))?\s*$|node \S*plan-queue\.mjs list\b)/.test(command)) return true;
  return !shellWrites(command);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function readState(sessionId) {
  return withPlans({
    compactions: 0,
    told: [],
    retired: false,
    ...readJson(files.state(sessionId)),
  });
}

/**
 * **A planner's state holds every plan it wrote** (plans/planner-continues.md):
 * `plans`, in order. A state written before the list had `brief` and
 * `planned`, and is read as that one plan.
 */
export function withPlans(state) {
  if (state?.agent !== "planner") return state;
  return { ...state, plans: state.plans ?? (state.planned && state.brief ? [state.brief] : []) };
}

/** One compaction, counted once though PostCompact and SessionStart both report it. */
export function countCompaction(state, now = Date.now()) {
  if (!state.lastCompactAt || now - state.lastCompactAt > MINUTE) {
    state.compactions = (state.compactions || 0) + 1;
    state.lastCompactAt = now;
  }
  return state;
}

function blockReason(lock) {
  const since = lock.taken ? new Date(lock.taken).toTimeString().slice(0, 5) : "earlier";
  return `Another executor is building in this checkout: ${lock.name || "an executor"} [${String(lock.sessionId).slice(0, 8)}], since ${since}. One checkout holds one executor (the plugin's docs/workflow.md, "The queue"). Do not build; say so, and stop.`;
}

function annotate(plan) {
  if (plan.state === "handed") return `${plan.path} (handed over, resume)`;
  return plan.asks
    ? `${plan.path} (decisions unanswered: the recommended options, "Asked once")`
    : plan.path;
}

/** The context, in tokens, above which a finished session retires: the cost wash is near 100k. */
export const REUSE_DEFAULT = 200_000;
/** The prompt cache's life, and how long before its end a context counts as cold. */
export const CACHE_TTL = 60 * MINUTE;
export const WARM = CACHE_TTL - 5 * MINUTE;
/** How long a planner's question holds its plan from the executor ("Asked once"). */
export const ANSWER_WINDOW = 30 * MINUTE;

/**
 * **A session's context and its age, from its transcript**: the last
 * assistant turn's `usage` (input, cache reads and cache writes) and its
 * time; null when the file is missing or holds no such turn. Reads the last
 * 512 KB; an error entry Claude Code writes itself (model `<synthetic>`, its
 * usage all zero) is passed over.
 */
export function sessionUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text = "";
  try {
    const size = statSync(transcriptPath).size;
    const fd = openSync(transcriptPath, "r");
    try {
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The first line read may be cut.
    }
    const u = entry?.type === "assistant" ? entry.message?.usage : null;
    if (!u || entry.message?.model === "<synthetic>") continue;
    const total =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (!total) continue;
    return {
      context:
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0),
      at: Date.parse(entry.timestamp) || 0,
    };
  }
  return null;
}

/**
 * A live row's transcript: `~/.claude/projects/<cwd, each character not a
 * letter or digit a dash>/<id>.jsonl`. `WORKFLOW_PROJECTS` for the tests.
 */
export function transcriptOf(
  row,
  projects = process.env.WORKFLOW_PROJECTS || join(homedir(), ".claude", "projects"),
) {
  if (!row?.cwd || !row.sessionId) return "";
  return join(projects, row.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${row.sessionId}.jsonl`);
}

/** "14:32", a time as the queue's lines say it. */
function hhmm(at) {
  return new Date(at).toTimeString().slice(0, 5);
}

/**
 * **Asked once** (docs/workflow.md, "The queue"): the planner holding a plan
 * that asks the owner, while its question is under thirty minutes old. For a
 * ready plan that asks, the live row the queue counts as a planner whose
 * state names the plan (its `brief`, or one of its `plans`) and whose last
 * turn is within `ANSWER_WINDOW` of `now`: `{ row, until }`, `until` the time
 * the window closes. Null otherwise; a planner whose transcript gives no time
 * is past the window, so the worst case is a decision taken early, never a
 * question asked twice.
 */
export function askingIn(
  plan,
  live,
  {
    stateFor = readState,
    usageFor = (row) => sessionUsage(transcriptOf(row)),
    now = Date.now(),
  } = {},
) {
  if (!plan || plan.state !== "ready" || !plan.asks || !live) return null;
  for (const row of live) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null)) continue;
    if (state?.brief !== plan.path && !(state?.plans || []).includes(plan.path)) continue;
    const at = usageFor(row)?.at || 0;
    if (at && now - at <= ANSWER_WINDOW) return { row, until: at + ANSWER_WINDOW };
  }
  return null;
}

/** The plans with `askingIn` set on each, for the callers that have the live rows in hand. */
export function withAsking(plans, live, options = {}) {
  return plans.map((plan) => ({ ...plan, askingIn: askingIn(plan, live, options) }));
}

/** "plans/x.md asks Javi in Planner 3 [9b372186] until 14:32: ...", the start's refusal of a held plan. */
function askingWords(plan) {
  const { row, until } = plan.askingIn;
  return `${plan.path} asks ${owner()} in ${row.name || "a planner"} [${String(row.sessionId).slice(0, 8)}] until ${hhmm(until)}: he answers there, or the executor takes it then and decides by the recommended options.`;
}

/**
 * **One reuse rule for the executor and the planner**: a finished session
 * takes the next plan or brief when its compactions allow it, its context is
 * under the ceiling, and its cache is warm or its context small; every turn
 * re-reads the whole context at the cache-read price, and a fresh session's
 * first turn is about 50k tokens. With no usage known, the compactions alone.
 */
export function mayReuse({
  compactions = 0,
  related = false,
  usage = null,
  now = Date.now(),
  ceiling = REUSE_DEFAULT,
}) {
  if (compactions >= 2 || (compactions === 1 && !related))
    return {
      reuse: false,
      why: `this session has compacted ${compactions} time${compactions === 1 ? "" : "s"}${compactions === 1 ? ", and nothing waiting is related" : ""}`,
    };
  if (usage && usage.context > ceiling)
    return {
      reuse: false,
      why: `its context is ${Math.round(usage.context / 1000)}k tokens, over the reuse ceiling of ${Math.round(ceiling / 1000)}k: every turn would re-read it`,
    };
  if (usage && usage.at && now - usage.at > WARM && usage.context > 60_000)
    return {
      reuse: false,
      why: `its cache has gone cold after ${Math.round((now - usage.at) / MINUTE)} minutes idle, and rewriting ${Math.round(usage.context / 1000)}k tokens costs more than a fresh start`,
    };
  return { reuse: true };
}

/**
 * **A finished chat ends when its cache has gone cold**
 * (plans/idle-chats-end.md): a background session the queue counts as its
 * own, whose state is `done` (its turn finished; `blocked` is a question or a
 * prompt that stands, `working` a turn), whose last turn is older than the
 * cache's warm span, with no plan or brief under way (`on`). A planner's
 * plans still in the queue keep nothing: each stands alone in its file.
 * `force` (`plans end`) ends a warm one too. `{ end: true }` or
 * `{ end: false, why }`.
 */
export function decideEnd({ row, usage = null, on = "", now = Date.now(), force = false }) {
  if (!row || row.kind !== "background")
    return { end: false, why: "it is not a background session of the queue" };
  if (row.state !== "done") return { end: false, why: `its state is ${row.state || "unknown"}` };
  if (on) return { end: false, why: `it has ${on} under way` };
  // With no usage known, the timer fired an hour after the Stop that armed it.
  if (!force && usage && usage.at && now - usage.at <= WARM)
    return { end: false, why: "its cache is still warm" };
  return { end: true };
}

/**
 * What the Stop hook answers, decided from facts alone: `{refuse, reason}`,
 * `{retire, paths}` (a fresh executor takes them), `{handover, plan}` (a
 * fresh executor resumes it), `{context}` (pass, with words for the model),
 * or null to pass.
 */
export function decideStop({
  compactions = 0,
  waiting = [],
  handed = [],
  run = null,
  told = [],
  paused = false,
  retired = false,
  current = null,
  continuing = false,
  refusedRun = null,
  usage = null,
  ceiling = REUSE_DEFAULT,
  now = Date.now(),
}) {
  if (retired) return null;
  // **A red or unfinished run refuses the first stop of every turn**. On a
  // stop the turn reached by continuing after a stop hook (`stop_hook_active`,
  // `continuing`), only a run other than the one last refused (`refusedRun`):
  // that is the loop guard, with Claude Code's own cap, and a new push's run
  // is still asked about. The rest decides on any stop: the plans have `told`.
  const askedAlready = continuing && refusedRun === run?.id;
  if (
    run &&
    !askedAlready &&
    run.onHead &&
    !(run.status === "completed" && run.conclusion === "success")
  ) {
    const how = run.status === "completed" ? "failed" : "in progress";
    return {
      refuse: true,
      runId: run.id,
      reason: `The ${run.workflow || "Actions"} run on your push (${run.id}) is ${how}. Read it before you stop: \`gh run watch ${run.id} --exit-status\`, then on a failure the job's log (\`gh api repos/{owner}/{repo}/actions/jobs/<job>/logs\`), fix it, push, and read the new run. A green push is not a deploy until the run says so.`,
    };
  }
  // A session with a plan of its own still being built is not done: it is
  // neither handed more nor retired until it writes Built or hands it over.
  if (paused || current) return null;
  const stuck = handed.find((plan) => plan.stuck);
  const resumable = handed.find((plan) => !plan.stuck);
  if (resumable) return { handover: resumable };
  if (stuck && !told.includes(stuck.path)) {
    const why =
      stuck.resumed.length >= MAX_HANDOVERS
        ? `this plan has been handed over ${stuck.resumed.length} times`
        : `this plan was handed over twice at step ${stuck.resumed.at(-1)}; it is stuck there`;
    return {
      context: `${stuck.path} is not handed over again: ${why}. Write its "Built" section with "Needs a decision: ${why}", and ask ${owner()} through the question tool what to do with it.`,
      told: [stuck.path],
    };
  }
  const fresh = waiting.filter((plan) => !told.includes(plan.path));
  if (!fresh.length) return null;
  const verdict = mayReuse({
    compactions,
    related: fresh.some((plan) => plan.related),
    usage,
    now,
    ceiling,
  });
  const keep = verdict.reuse;
  const paths = fresh.map((plan) => plan.path);
  if (!keep) return { retire: true, paths, why: verdict.why };
  return {
    refuse: true,
    told: paths,
    reason: `Plans are waiting and this session can take them: ${fresh.map(annotate).join(", ")}. Build them as a new batch by your agent file: ReadNotifications first, a new branch off origin/${branch()}, Building lines, the suites once at the end, one commit per plan, the push. If ${owner()} told you to stop after this batch, say so in your final message and stop.`,
  };
}

/** The words after a compaction: hand the plan over at the third, unless it is stuck (the Stop hook says what then). */
export function decideResumed({ compactions = 0, plan = null }) {
  if (compactions < HANDOVER_AT || !plan || plan.stuck) return "";
  return `This session has compacted ${compactions} times inside ${plan.path}. Hand it over: finish the step in hand, commit what is done on the branch (a work commit is fine; the next executor squashes), write a "Handing over, ${today()}" section under the plan's header whose first line is "Step in hand: <n>" in the plan's "Building it" numbering (then the branch, the steps done, the step in progress and what failed in it, what is left, the specs run and their counts), take out the Building line, and stop. The hook starts a fresh executor on it.`;
}

/** The windows above their threshold that have not reset yet: a number written before its reset says nothing after it. */
function windowOver(usage, now = Date.now()) {
  const over = [];
  const open = (window) => window && window.resets_at * 1000 > now;
  const five = usage?.five_hour;
  const seven = usage?.seven_day;
  if (open(five) && five.used_percentage > FIVE_HOUR_MAX) over.push(["five-hour", five]);
  if (open(seven) && seven.used_percentage > SEVEN_DAY_MAX) over.push(["seven-day", seven]);
  return over;
}

/**
 * Whether an executor, or with `kind: "planner"` a planner, may start now:
 * `{start, name, note}`, `{defer, until, why}` or `{refuse, why}`. `log` is
 * the starts' log (both kinds, told apart by name), `progressAt` the newest
 * Building, Handing over, Built or plan in the plans, `usage` the status
 * line's numbers with their `at` (epoch seconds), `sessions` the live,
 * unretired sessions of the kind, `taken` the names of this machine's live
 * sessions, `machine` this machine's label. The usage windows and the
 * pause are shared.
 */
export function canStart({
  kind = "executor",
  lock = null,
  alive = pidAlive,
  log: all = [],
  progressAt = 0,
  now = Date.now(),
  paused = false,
  usage = null,
  sessions = [],
  brief = "",
  name = "",
  ceiling = REUSE_DEFAULT,
  taken = [],
  machine = "",
}) {
  // **Session names carry the project and the machine** (`Docs Executor 2
  // (lab)`), and the count is per project and per machine (the log is this
  // machine's), so two projects' executors number apart and two machines'
  // sessions never share a name (plans/session-names-across-machines.md).
  const ours = (one) => {
    const parsed = parseName(one || "");
    return parsed && parsed.project === name && parsed.kind === kind ? parsed : null;
  };
  const log = all.filter((line) => ours(line.name));
  if (paused)
    return {
      refuse: true,
      why: `The queue is paused since ${paused} ("resume the queue" in any session lifts it).`,
    };
  // **Any live, unretired session of the kind refuses a start, lock or not**
  // (plans/queue-counts-any-executor.md, plans/planner-queue.md). The lock
  // below is an executor's only evidence when the sessions cannot be read.
  // **A stale session does not block its successor** (cache-aware queue):
  // one whose context is over the reuse ceiling, or cold, is replaced when
  // idle; a busy planner so is left to finish, and a fresh one starts beside
  // it. A busy executor, or any session still worth reusing, refuses as before.
  // A session with a plan or a brief under way (its Building or Planning
  // line) is never stale: replacing it would orphan that work.
  const stale = (one) => (one.on ? { reuse: true } : mayReuse({ usage: one.usage, now, ceiling }));
  const idle = (one) => /^idle\b/.test(one.status || "");
  let replace = [];
  let beside = [];
  if (sessions.length && sessions.every((one) => !stale(one).reuse)) {
    const busy = sessions.filter((one) => !idle(one));
    if (!busy.length || kind === "planner") {
      replace = sessions.filter(idle).map((one) => ({ ...one, why: stale(one).why }));
      beside = busy;
      sessions = [];
    }
  }
  if (sessions.length) {
    const first = sessions[0];
    const alive = sessions.map(describeSession).join("; ");
    // **A brief reaches a live planner by message** (plans/planner-continues.md,
    // part 4): its hooks decide whether it has room, and a tired one's Stop
    // hook starts the fresh planner.
    if (kind === "planner")
      return {
        refuse: true,
        why: `A planner is alive: ${alive}. Send it the brief with SendMessage, one message per brief: ${brief ? plannerPrompt(brief) : "Plan plans/<topic>.md: it is a brief."}`,
      };
    // Archiving in the Claude app hides the chat and leaves the process
    // running, so the id an agent ends it by stays.
    return {
      refuse: true,
      why: `An executor is alive: ${alive}. Message it in Remote Control, or have the assistant end it (plans end ${String(first.sessionId).slice(0, 8)}), then start again.`,
    };
  }
  const replacing = new Set(replace.map((one) => one.sessionId));
  if (
    kind === "executor" &&
    lock &&
    !lock.released &&
    !replacing.has(lock.sessionId) &&
    alive(lock.pid)
  ) {
    return {
      refuse: true,
      why: `An executor is alive: ${lock.name || "an executor"} [${String(lock.sessionId).slice(0, 8)}]. Message it instead.`,
    };
  }
  let note = "";
  const fresh = usage && usage.at && now - usage.at * 1000 <= USAGE_STALE;
  if (!fresh) {
    note = usage?.at
      ? `Usage unknown: the status line has not written since ${new Date(usage.at * 1000).toTimeString().slice(0, 5)}.`
      : "Usage unknown: the status line has not written the usage file.";
  } else {
    const over = windowOver(usage, now);
    if (over.length) {
      const [name, window] = over.reduce((a, b) => (b[1].resets_at > a[1].resets_at ? b : a));
      return {
        defer: true,
        until: (window.resets_at + AFTER_RESET) * 1000,
        why: `the ${name} window is at ${Math.round(window.used_percentage)} percent`,
      };
    }
  }
  const last = log.at(-1);
  if (last && now - last.at < QUICK_DEATH && progressAt <= last.at) {
    return {
      refuse: true,
      why: `The last ${kind} (${last.name}) ended within ten minutes with nothing ${kind === "planner" ? "planned" : "built"}, and usage was not the cause; starting another would repeat it. ${owner()} decides.`,
    };
  }
  if (log.filter((line) => now - line.at < 24 * 60 * MINUTE).length >= TRIPWIRE) {
    return {
      refuse: true,
      why: `Twenty-four ${kind}s were started in a day; something is looping. ${owner()} decides.`,
    };
  }
  // From 1 in a project with none started yet (/code-review, 27 October).
  // The live list counts too: the log can be reset (a marketplace move) while
  // a session it named is still alive.
  const n =
    Math.max(0, ...[...log.map((line) => line.name), ...taken].map((one) => ours(one)?.n || 0)) + 1;
  const besideNote = beside
    .map(
      (one) =>
        `Started beside ${one.name} [${String(one.sessionId).slice(0, 8)}], which is ${one.status} with a context of ${Math.round((one.usage?.context || 0) / 1000)}k.`,
    )
    .join(" ");
  return {
    start: true,
    name: sessionName(kind, n, { project: name, machine }),
    note: [note, besideNote].filter(Boolean).join(" "),
    ...(replace.length ? { replace } : {}),
  };
}

/** The hook's Handing over section for a session the usage limit cut off, the plan's Building line replaced by it. */
export function cutoffEdit(text, { sessionId, branch, day = today() }) {
  const section = `## Handing over, ${day}, by the hook\n\nStep in hand: unknown, the usage limit cut session ${sessionId} off on branch \`${branch}\`. Read the branch's commits and the task list's state in the final messages above.\n`;
  const building = /^## Building, [^\n]*\n?/m;
  if (building.test(text)) return text.replace(building, section);
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^(Plan only|Short plan), /.test(line));
  let at = lines.findIndex((line, i) => i > header && line.trim() === "");
  if (header < 0 || at < 0) at = lines.length;
  lines.splice(at + 1, 0, section);
  return lines.join("\n");
}

/** When a cut-off session's window resets: the usage file's window over its threshold, else the transcript's last `resetsAt`. */
export function resetTime(usage, transcriptText = "") {
  const over = windowOver(usage);
  if (over.length) return Math.max(...over.map(([, w]) => w.resets_at));
  const resets = [...transcriptText.matchAll(/"resetsAt"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (resets.length) return resets.at(-1);
  const any = [usage?.five_hour?.resets_at, usage?.seven_day?.resets_at].filter(Boolean);
  return any.length ? Math.min(...any) : Math.round(Date.now() / 1000) + 3600;
}

// ---- the parts that touch the machine -----------------------------------------

function readLog() {
  try {
    return readFileSync(files.starts(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function progressAt(plans) {
  let newest = 0;
  for (const plan of plans) {
    if (/^## (Building|Handing over|Built|Resumed)/m.test(plan.text))
      newest = Math.max(newest, plan.mtime);
  }
  return newest;
}

/** The newest plan written over a brief: a planner's progress, for the quick-death rule. */
function plannedAt(plans) {
  let newest = 0;
  for (const plan of plans)
    if (plan.state !== "brief" && plan.state !== "planning")
      newest = Math.max(newest, plan.mtime || 0);
  return newest;
}

/** What a planner the queue starts is told: the brief, and its agent file's way through it. */
export function plannerPrompt(path) {
  return `Plan ${path}: it is a brief. Read it whole, then your agent file: research the products, ground it in the project's docs and code, write the plan over the brief, put what research cannot settle to ${owner()} with the question tool in the same turn, and hand the plan to the executor by "The final message". ${owner()} reads this chat in Remote Control.`;
}

/** "plans/a.md, plans/b.md (until 14:02)", a deferral as the pause and the resume say it. */
function deferredWords(deferred) {
  return `${(deferred.paths || []).join(", ")} (until ${new Date(deferred.until).toTimeString().slice(0, 5)})`;
}

function pausedSince() {
  const pause = readJson(files.pause());
  return pause ? pause.at || "earlier" : existsSync(files.pause()) ? "earlier" : false;
}

/** Whether the lock's session is still running: listed by `claude agents`, or, when that cannot be read, its pid alive. */
function holderAlive(lock, live) {
  if (!lock) return false;
  return live ? live.some((row) => row.sessionId === lock.sessionId) : pidAlive(lock.pid);
}

function liveIds(live) {
  return live ? live.map((row) => row.sessionId) : null;
}

function startPrompt(paths, plans) {
  const handed = plans.find((plan) => plan.state === "handed" && paths.includes(plan.path));
  if (handed) {
    return `Resume ${handed.path} from its "Handing over" section on branch ${handed.branch || "(named in the section)"}: check out the branch, read the plan whole and the section, then go on from the step it names. Then the queue, by your agent file.`;
  }
  return `Build the plans waiting in the queue, oldest first: ${paths.join(", ")}. Then go on by your agent file's "Going on". ${owner()} reads this chat in Remote Control; the plans are the instructions.`;
}

/**
 * A started chat's environment: this one without five variables. A node
 * child of the command inherits them all, a chat none: `WORKFLOW_ROOT` is the
 * command's; `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and
 * `CLAUDE_PLUGIN_DATA` are what a hook is exported, and a carried one reaches
 * the new chat's Bash tool naming another project or plugin (the plugin data
 * named the Codex plugin's directory, and the starts log went there); and
 * `CLAUDE_SESSION_ID`, which `plans pause` records, is the starting chat's.
 */
export function sessionEnv(env = process.env) {
  const {
    WORKFLOW_ROOT: _root,
    CLAUDE_PROJECT_DIR: _project,
    CLAUDE_PLUGIN_ROOT: _pluginRoot,
    CLAUDE_PLUGIN_DATA: _pluginData,
    CLAUDE_SESSION_ID: _session,
    ...rest
  } = env;
  return rest;
}

/** Blocks for `ms`: the hooks and the command are synchronous, and print their answer on return. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const START_WAIT = 10;

/**
 * **A start sees its session, or says why not**: `claude --bg` returns at
 * once, and where no trust dialog can appear it exits with `Workspace not
 * trusted`. Its output goes to `.claude/<kind>.started`, and `claude agents`
 * is asked once a second for ten seconds for a row of the new name. True when
 * seen; else the line to say, and nothing is logged.
 */
function launch(args, name, kind) {
  const out = join(root, ".claude", `${kind}.started`);
  const fd = openSync(out, "w");
  try {
    const child = spawn(claudeBin(), args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: sessionEnv(),
    });
    child.on("error", () => {
      // A launcher that cannot run says so in nothing: the wait reports it.
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  // Ten seconds by the clock, each ask cut to the time left, so a slow
  // `claude agents` cannot hold the Stop hook past its own timeout.
  const deadline = Date.now() + START_WAIT * 1000;
  let read = false;
  for (;;) {
    sleep(Math.max(0, Math.min(1000, deadline - Date.now())));
    const left = deadline - Date.now();
    if (left <= 0) break;
    const rows = liveSessions({ fresh: true, timeout: left });
    if (rows) read = true;
    if (rows?.some((row) => row.name === name)) return true;
  }
  // Nothing could be read: the start is not known to have failed.
  if (!read) return "unread";
  let said = "";
  try {
    said =
      readFileSync(out, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "";
  } catch {
    // No output file: as if it said nothing.
  }
  return said
    ? `${name} was not started: ${said.replace(/[.\s]+$/, "")}.`
    : `${name} was started, but has not appeared in claude agents after ten seconds; its output is in .claude/${kind}.started.`;
}

function detached(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid;
}

/**
 * Stops a background chat after it has had time to write its last message;
 * an interactive one (tmux) is the owner's. A replaced session is stopped
 * three minutes on whatever its state, since its successor is started; a
 * quiet one is `endSession`'s, an hour after its last stop.
 */
function stopLater(sessionId, live) {
  const row = live?.find((r) => r.sessionId === sessionId);
  if (!row || row.kind !== "background") return;
  // The tests' record of what would be stopped, instead of `claude stop`.
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `${row.id || sessionId}\n`);
    return;
  }
  detached(process.execPath, [
    "-e",
    `setTimeout(() => { try { require("node:child_process").execFileSync("claude", ["stop", ${JSON.stringify(row.id || sessionId)}], { stdio: "ignore" }); } catch {} }, 180000)`,
  ]);
}

/**
 * `claude stop` now, which keeps the conversation; the tests' log records the
 * id instead. True when it stopped: a failed stop is said, never reported as
 * an end (Codex, 27 October).
 */
function stopNow(id) {
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `${id}\n`);
    return true;
  }
  try {
    execFileSync(claudeBin(), ["stop", id], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** A process's command line, from `/proc` or `ps`; "" when it cannot be read. */
function commandOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    try {
      return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }
}

/**
 * Kills the end timer the queue armed for `sessionId`, and only it: a pid is
 * signalled only while its command line is that timer's, since a timer gone
 * leaves its pid to be reused (Codex, 27 October).
 */
function killTimer(pid, sessionId) {
  if (!pid || pid === process.pid) return;
  const command = commandOf(pid);
  if (!/plan-queue\.mjs end --timer /.test(command) || !command.includes(sessionId)) return;
  try {
    process.kill(pid);
  } catch {
    // The timer is gone already.
  }
}

/** A timer's own registration, cleared when it has fired, whatever it decided. */
function clearEnd(sessionId, pid = process.pid) {
  const state = readJson(files.state(sessionId));
  if (!state?.end || (pid && state.end.pid !== pid)) return;
  const { end: _end, ...rest } = state;
  writeJson(files.state(sessionId), rest);
}

/**
 * **The end timer, armed at each stop** (plans/idle-chats-end.md, part 2):
 * `plan-queue.mjs end --timer <at> <sessionId>`, `defer`'s shape, its pid
 * and time in the session's state as `end`, so a chat of a hundred turns has
 * one sleeping timer, not a hundred. `at` is the cache's life from now: when
 * it fires the last turn is past `WARM`, and `decideEnd` judges it.
 */
function armEnd(sessionId, live = null, at = Date.now() + CACHE_TTL) {
  // The owner's interactive chat (tmux) is never the queue's to end, so it
  // has no timer and its line no end time (/code-review, 27 October).
  const row = live?.find((r) => r.sessionId === sessionId);
  if (row && row.kind !== "background") return;
  const statePath = files.state(sessionId);
  const state = readJson(statePath) || {};
  killTimer(state.end?.pid, sessionId);
  // The tests' record of the timer, as `stopLater` records stops.
  let pid = null;
  if (process.env.WORKFLOW_STOP_LOG)
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `end ${sessionId} at ${at}\n`);
  else
    pid = detached(
      process.execPath,
      [join(here, "plan-queue.mjs"), "end", "--timer", String(at), sessionId],
      // The timer runs as the command, so its root is said: this project's.
      { ...process.env, WORKFLOW_ROOT: root },
    );
  writeJson(statePath, { ...state, end: { pid, at } });
}

/**
 * **Ends one session by the rule** (`decideEnd`), from the live rows, its
 * state, the plans and its transcript: `claude stop` on an end, the state's
 * timer cleared. One line either way: `Ended <name> [<8 hex>]: done, <usage>.`
 * or `Not ended: <name> [<8 hex>], <why>.`; `ended` says which.
 */
export function endSession(
  sessionId,
  { force = false, live = liveSessions({ fresh: true }) } = {},
) {
  const row = live?.find((r) => r.sessionId === sessionId) || null;
  const state = readState(sessionId);
  const who = `${row?.name || String(sessionId).slice(0, 8)} [${String(sessionId).slice(0, 8)}]`;
  if (!row) return { ended: false, line: `Not ended: ${who}, it is no live session.` };
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const on =
    plans.find(
      (plan) =>
        (plan.state === "building" || plan.state === "planning") && plan.session === sessionId,
    )?.path || "";
  const usage = sessionUsage(transcriptOf(row));
  const verdict = decideEnd({ row, usage, on, force });
  if (!verdict.end) return { ended: false, line: `Not ended: ${who}, ${verdict.why}.` };
  // A failed stop keeps the timer, and says so.
  if (!stopNow(row.id || sessionId))
    return { ended: false, line: `Not ended: ${who}, claude stop failed.` };
  killTimer(state.end?.pid, sessionId);
  clearEnd(sessionId, null);
  const words = [row.state, usageWords({ usage, ceiling: proj().reuse })].filter(Boolean);
  return { ended: true, line: `Ended ${who}: ${words.join(", ")}.` };
}

/**
 * **`plans end [id...]`**: this queue's finished chats now, warm or not
 * (`force`), or the ones named, by session id, background id or the eight
 * hex `plans` prints. One line per session.
 */
export function endCommand(ids = []) {
  const live = liveSessions({ fresh: true });
  if (!live) return "claude agents could not be read, so nothing is ended.";
  const lock = readJson(files.lock());
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const ours = ["executor", "planner"].flatMap((kind) =>
    sessionsOf(kind, live, lock, { plans, usageFor: () => null }),
  );
  const lines = [];
  let targets = ours.map((one) => one.sessionId);
  if (ids.length) {
    targets = [];
    for (const id of ids) {
      const one = ours.find(
        (s) =>
          s.sessionId === id ||
          (s.id && s.id === id) ||
          (id.length >= 8 && s.sessionId.startsWith(id)),
      );
      if (one) targets.push(one.sessionId);
      else lines.push(`${id} is no live session of this queue; plans lists them.`);
    }
  }
  for (const sessionId of [...new Set(targets)])
    lines.push(endSession(sessionId, { force: true, live }).line);
  // Each line above says why a session was not ended; with none alive, this says so.
  if (!ids.length && !targets.length)
    lines.push("Nothing to end: no finished chat of this queue is alive.");
  return lines.join("\n");
}

/**
 * Defers a start to `until` (ms): one timer at a time, the deferral written
 * where `plans` shows it. **Paused, the deferral is held**: the file is
 * written with no timer (`pid: null`), and `resume` re-arms it.
 */
function defer(until, why, paths, replace = "", agent = "executor") {
  const old = readJson(files.deferred(agent));
  if (old?.pid) {
    try {
      process.kill(old.pid);
    } catch {
      // The old timer is gone already.
    }
  }
  // One timer for every deferred plan, at the later time, so a new
  // deferral never drops a pending one; and never in the past, so a timer
  // cannot fire straight into another deferral.
  const all = [...new Set([...(old?.paths || []), ...paths])];
  const when = Math.max(until, old?.until || 0, Date.now() + MINUTE);
  const stop = replace || old?.replace || "";
  const held = Boolean(pausedSince());
  // The timer runs as the command, so its root is said: this project's.
  const pid = held
    ? null
    : detached(
        process.execPath,
        [
          join(here, "plan-queue.mjs"),
          "start",
          "--timer",
          String(when),
          ...(stop ? ["--replace", stop] : []),
          ...(agent === "executor" ? [] : ["--agent", agent]),
          ...all,
        ],
        { ...process.env, WORKFLOW_ROOT: root },
      );
  writeJson(files.deferred(agent), { until: when, why, paths: all, pid, replace: stop });
  const hhmm = new Date(when).toTimeString().slice(0, 5);
  return held
    ? `Deferred until ${hhmm}, held while the queue is paused: ${why}; ${all.join(", ")}.`
    : `Deferred until ${hhmm}: ${why}; ${all.join(", ")}.`;
}

/**
 * Starts a fresh executor on `paths`, or says why not. The only thing that
 * starts executors and planners: the planner, the assistant, the Stop and StopFailure hooks
 * and the timer all come here.
 */
export function start(paths, options = {}) {
  // A project that is not the workflow's is left as it is (Codex, 27 October).
  if (!proj().found) return NO_PROJECT;
  if (proj().form === "compact") return COMPACT;
  // **The checkout follows test first** (part 3 of plans/queue-counts-any-
  // executor.md), so the executor started runs the queue's newest hooks; not
  // for a dry run or a deferred one, which nobody is watching. A start that
  // replaces a session comes from a hook, so it moves without fetching.
  const synced =
    options.dry || options.timer || options.at > Date.now()
      ? ""
      : sync({ fetch: !options.replace });
  const said = startHere(paths, options);
  return synced ? `${synced}\n${said}` : said;
}

/** The effort an agent's frontmatter names (`effort: high`), or "". */
export function agentEffort(agent, dir = join(here, "..", "agents")) {
  try {
    const text = readFileSync(join(dir, `${agent}.md`), "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || "";
    return /^effort:\s*(\w+)/m.exec(front)?.[1] || "";
  } catch {
    return "";
  }
}

function startHere(
  paths,
  { replace = "", dry = false, agent = "executor", at = 0, timer = false } = {},
) {
  if (!proj().found) return NO_PROJECT;
  const live = liveSessions();
  // **Asked once**: a plan whose planner is asking the owner is that chat's
  // for thirty minutes, neither taken by default nor accepted by path.
  const plans = withAsking(readPlans(join(root, "plans"), liveIds(live)), live);
  const kind = agent === "planner" ? "planner" : "executor";
  // **A planner takes one brief, the oldest** (plans/planner-queue.md); an
  // executor every plan waiting.
  if (!paths.length)
    paths =
      kind === "planner"
        ? plans
            .filter((p) => p.state === "brief")
            .slice(0, 1)
            .map((p) => p.path)
        : plans
            .filter((p) => (p.state === "handed" || p.state === "ready") && !p.askingIn)
            .map((p) => p.path);
  if (!paths.length) return "Nothing is waiting in the queue.";
  if (kind === "executor") {
    const held = plans.filter((p) => p.askingIn && paths.includes(p.path));
    // Refused whole, so nothing is half started; a deferred start, which
    // nobody is watching, starts the rest and leaves the held ones to the queue.
    if (held.length && !timer) return held.map(askingWords).join("\n");
    paths = paths.filter((path) => !held.some((p) => p.path === path));
    if (!paths.length) return held.map(askingWords).join("\n");
  }
  if (kind === "planner") {
    // A planner is started on one brief, waiting or left by a session that is gone.
    const asked = paths[0];
    if (!plans.some((p) => p.path === asked && p.state === "brief"))
      return `${asked} is not a brief waiting for a planner; plans shows the briefs.`;
    paths = [asked];
  }
  const paused = pausedSince();
  // Paused, the deferral is held (no timer), so the resume re-arms it.
  if (at && at > Date.now())
    return defer(at, `the usage limit cut the last ${kind} off`, paths, replace, kind);
  const probe = agent !== "executor" && agent !== "planner";
  const decision = probe
    ? { start: true, name: `Probe ${Date.now() % 1000}`, note: "" }
    : canStart({
        kind,
        lock: readJson(files.lock()),
        alive: () => holderAlive(readJson(files.lock()), live),
        log: readLog(),
        progressAt: kind === "planner" ? plannedAt(plans) : progressAt(plans),
        paused,
        usage: readJson(files.usage()),
        // The session being replaced and retired ones do not block their successor.
        sessions: sessionsOf(kind, live, readJson(files.lock()), {
          plans,
          ceiling: proj().reuse,
        }).filter((one) => one.sessionId !== replace && !one.retired),
        brief: kind === "planner" ? paths[0] : "",
        name: proj().name,
        ceiling: proj().reuse,
        taken: liveNames(),
        machine: machine().name,
      });
  if (decision.refuse) return decision.why;
  if (decision.defer) return defer(decision.until, decision.why, paths, replace, kind);
  const prompt = probe
    ? "Reply with the single word ok"
    : kind === "planner"
      ? plannerPrompt(paths[0])
      : startPrompt(paths, plans);
  // **The agent file's effort, on the command line** (part 4): a settings
  // file's effort for the model outranks the frontmatter, and the user
  // settings set Opus to medium for the assistant; the command line outranks both.
  const effort = agentEffort(agent);
  // **The project's MCP configs reach every chat started here**, first: the
  // flag takes every value up to the next flag, so nothing positional may
  // follow it. A probe needs none.
  const mcp = probe
    ? []
    : proj().mcp.flatMap((p) => ["--mcp-config", isAbsolute(p) ? p : resolve(root, p)]);
  const args = [
    ...mcp,
    "--bg",
    "--remote-control",
    decision.name,
    "--name",
    decision.name,
    "--agent",
    // The plugin's agents are scoped by its name.
    probe ? agent : `workflow:${agent}`,
    ...(effort ? ["--effort", effort] : []),
    prompt,
  ];
  if (dry)
    return [
      `Would run: claude ${args.map((a) => JSON.stringify(a)).join(" ")}`,
      ...(decision.replace || []).map(
        (old) => `Would retire ${old.name} [${String(old.sessionId).slice(0, 8)}]: ${old.why}.`,
      ),
    ].join("\n");
  // **A stale idle session is replaced**: retired and its lock released
  // before the launch, so the new executor's first prompt finds the lock
  // free; a launch that fails gives both back.
  const replaced = (decision.replace || []).map((old) => ({
    old,
    state: readState(old.sessionId),
    lock: readJson(files.lock()),
  }));
  for (const { old, state } of replaced) {
    writeJson(files.state(old.sessionId), { ...state, retired: true });
    if (kind === "executor") release(old.sessionId);
  }
  const seen = launch(args, decision.name, kind);
  // A launch that failed keeps the deferral, and with it the timer's pid.
  if (seen !== true && seen !== "unread") {
    for (const { old, state, lock } of replaced) {
      writeJson(files.state(old.sessionId), state);
      if (lock?.sessionId === old.sessionId) writeJson(files.lock(), lock);
    }
    return seen;
  }
  try {
    unlinkSync(files.deferred(kind));
  } catch {
    // Nothing was deferred.
  }
  const unread =
    seen === "unread" ? " claude agents could not be read, so it is not confirmed." : "";
  if (!probe) {
    const usage = readJson(files.usage());
    appendFileSync(
      files.starts(),
      `${JSON.stringify({ at: Date.now(), name: decision.name, paths, five: usage?.five_hour?.used_percentage ?? null, seven: usage?.seven_day?.used_percentage ?? null })}\n`,
    );
  }
  // The session replaced is stopped three minutes on: a tired executor, or a
  // retired planner whose chat was its plan's until this next planner
  // (plans/planner-talks-until-built.md).
  if (replace) stopLater(replace, live);
  // A replaced session is stopped three minutes on; a planner by the sweep
  // below, which finds it retired.
  const retiredWords = [];
  for (const { old } of replaced) {
    if (kind === "executor") stopLater(old.sessionId, live);
    retiredWords.push(
      `${old.name} [${String(old.sessionId).slice(0, 8)}] was retired: ${old.why}.`,
    );
  }
  // A planner started by the assistant, with nothing to replace, still ends
  // the retired planners' chats: the next planner starting is their cut-off.
  if (kind === "planner") stopRetiredPlanners(live, { except: replace });
  return [
    `${decision.name} was started on: ${paths.join(", ")}.${unread}${decision.note ? ` ${decision.note}` : ""}`,
    ...retiredWords,
  ].join(" ");
}

/** "on main" once a built commit reached `main`, else "on <branch>" (/code-review, 27 October). */
function onWhere(sha) {
  if (!sha) return "";
  if (branch() === "main") return "on main";
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
      cwd: root,
      stdio: "ignore",
    });
    return "on main";
  } catch {
    return `on ${branch()}`;
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

/**
 * **`plans sync`**: moves a clean, detached checkout that is not ahead of
 * the project's branch to `origin/<branch>`, or says why not. One line
 * either way.
 *
 * Always the primary checkout, the one the hooks run from, even when run
 * from inside a worktree. `fetch: false` inside a hook, which the plugin's
 * `hooks.json` gives ninety seconds (the Stop and StopFailure hooks) or twenty
 * (the prompt hook): a slow fetch there would kill the Stop hook after it
 * retired its session and before it started the next. Worktrees share the
 * repository's refs, so `origin/<branch>` is as new as the last push or fetch
 * from any of them.
 */
export function sync({ fetch = true } = {}) {
  let cwd = root;
  try {
    const first = git(["worktree", "list", "--porcelain"])
      .split("\n")
      .find((line) => line.startsWith("worktree "));
    if (first) cwd = first.slice(9);
  } catch {
    // Not a repository's worktree list: the root it was given.
  }
  const run = (args, options = {}) => git(args, { cwd, ...options });
  let note = "";
  if (fetch) {
    try {
      run(["fetch", "origin"], { timeout: 15_000 });
    } catch (error) {
      const why = String(error.stderr || error.message)
        .split("\n")[0]
        .trim();
      note = `git fetch failed (${why}), so this is ${branch()} as last fetched. `;
    }
  }
  try {
    let onBranch = "";
    try {
      onBranch = run(["symbolic-ref", "-q", "--short", "HEAD"]);
    } catch {
      // Detached.
    }
    if (onBranch)
      return `${note}Not moved: the checkout is on branch ${onBranch}; it moves only when detached.`;
    if (run(["status", "--porcelain"]))
      return `${note}Not moved: the checkout has changes; commit, stash or discard them first.`;
    const head = run(["rev-parse", "HEAD"]);
    const target = `origin/${branch()}`;
    const tip = run(["rev-parse", target]);
    if (head === tip) return `${note}Already at ${branch()}, ${tip.slice(0, 8)}.`;
    try {
      run(["merge-base", "--is-ancestor", "HEAD", target]);
    } catch {
      return `${note}Not moved: the checkout is ahead of ${branch()}; push or drop its commits first.`;
    }
    run(["checkout", "-q", "--detach", target]);
    return `${note}The checkout is at ${branch()}, ${tip.slice(0, 8)}.`;
  } catch (error) {
    return `${note}Not moved: ${String(error.message).split("\n")[0]}`;
  }
}

/** The installed Claude Code's version: the target of `~/.local/bin/claude`, under `versions/`. */
function installedVersion() {
  try {
    return basename(realpathSync(join(homedir(), ".local", "bin", "claude")));
  } catch {
    return "";
  }
}

/**
 * A live session's version, from its process's binary (Linux); "" when it
 * cannot be read. Read as a link, not resolved: an updated install deletes
 * the old binary, and the link then ends in " (deleted)".
 */
function versionOfPid(pid) {
  try {
    return pid ? basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")) : "";
  } catch {
    return "";
  }
}

/**
 * **Which chats run an older Claude Code** (plans/planner-queue.md, part 5):
 * it updates itself in the background, and a session takes the new version
 * when it starts, so the queue's are current and the owner's long chats are not.
 * "" when every readable one matches.
 */
export function versionLine(
  live,
  { installed = installedVersion(), versionOf = versionOfPid } = {},
) {
  if (!live || !installed || !/^\d+\.\d+\.\d+/.test(installed)) return "";
  const byVersion = new Map();
  for (const row of live) {
    const version = versionOf(row.pid);
    if (!version || version === installed || !/^\d+\.\d+\.\d+/.test(version)) continue;
    const who = `${row.name || "a chat"} [${String(row.sessionId).slice(0, 8)}]`;
    byVersion.set(version, [...(byVersion.get(version) || []), who]);
  }
  if (!byVersion.size) return "";
  const parts = [...byVersion].map(
    ([version, who]) =>
      `${who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`} ${who.length === 1 ? "runs" : "run"} ${version}`,
  );
  return `Claude Code ${installed} is installed; ${parts.join("; ")}: a chat picks the new version up when it is restarted (claude --resume <id>).`;
}

/** The table `plans` prints. */
export function list({ all = false, live } = {}) {
  // **The compact form has no queue**: one line, and no session is read.
  if (proj().found && proj().form === "compact") return COMPACT;
  live = live === undefined ? liveSessions() : live;
  const plans = withAsking(readPlans(join(root, "plans"), liveIds(live)), live);
  const lock = readJson(files.lock());
  const nameOf = (id) => live?.find((row) => row.sessionId === id)?.name || String(id).slice(0, 8);
  const now = new Date();
  const out = [];
  if (!proj().found) out.push(NO_PROJECT);
  const trees = worktrees();
  // **The executor line comes from the sessions** (plans/queue-counts-any-
  // executor.md): a retired executor that kept working held no lock and read
  // as "none alive". The lock alone speaks only when the sessions cannot be read.
  let executor = "The executor: none alive.";
  if (live)
    executor = sessionsLine(
      "executor",
      sessionsOf("executor", live, lock, { trees, plans, ceiling: proj().reuse }),
    );
  else if (lock && !lock.released)
    executor = `The executor: ${lock.name || nameOf(lock.sessionId)} [${String(lock.sessionId).slice(0, 8)}], status unknown.`;
  const here = machine();
  out.push(`Plans on ${here.name}, ${today(now)} ${now.toTimeString().slice(0, 5)}. ${executor}`);
  // **The planner line** (plans/planner-queue.md): the queue's planners only.
  if (live)
    out.push(
      sessionsLine(
        "planner",
        sessionsOf("planner", live, lock, { trees, plans, ceiling: proj().reuse }),
      ),
    );
  const versions = versionLine(live);
  if (versions) out.push(versions);
  // **Leftover worktrees are seen** (plans/queue-sees-worktree-executor.md):
  // a background executor works in one, and a retired one leaves it behind.
  const under = join(root, ".claude", "worktrees") + "/";
  const claudeTrees = trees.filter((tree) => tree.path.startsWith(under));
  if (claudeTrees.length) {
    const users = (path) =>
      (live || [])
        .filter((row) => row.cwd && (row.cwd === path || row.cwd.startsWith(`${path}/`)))
        .map((row) => row.name || String(row.sessionId).slice(0, 8));
    out.push(
      `Worktrees under .claude/worktrees: ${claudeTrees
        .map((tree) => {
          const who = users(tree.path);
          return `${basename(tree.path)}${tree.branch ? ` on ${tree.branch}` : ""} (${who.length ? who.join(", ") : "free"})`;
        })
        .join(", ")}.`,
    );
  }
  const paused = pausedSince();
  if (paused)
    out.push(`The queue is paused since ${paused} ("resume the queue" in any session lifts it).`);
  for (const kind of ["executor", "planner"]) {
    const deferred = readJson(files.deferred(kind));
    if (deferred)
      out.push(
        `Deferred until ${new Date(deferred.until).toTimeString().slice(0, 5)}: ${deferred.paths.join(", ")}${deferred.pid ? "" : ", held while the queue is paused"}`,
      );
  }
  const width = Math.max(40, ...plans.map((p) => p.path.length + 2));
  const row = (path, rest) => `  ${path.padEnd(width)} ${rest}`;
  const group = (title, items, rest) => {
    if (!items.length) return;
    out.push("", title);
    for (const plan of items) out.push(row(plan.path, rest(plan)));
  };
  group(
    "Building",
    plans.filter((p) => p.state === "building"),
    (p) => `${nameOf(p.session)}, since ${p.since}`,
  );
  group(
    "Briefs, oldest first",
    plans.filter((p) => p.state === "brief" || p.state === "planning"),
    (p) =>
      p.state === "planning"
        ? `${nameOf(p.session)}, since ${p.since}`
        : [
            `brief${p.day ? `, ${p.day.replace(/ \d{4}$/, "")}` : ""}`,
            p.stale ? "(a Planning line from a session that is gone)" : "",
          ]
            .filter(Boolean)
            .join(" "),
  );
  // **Asked once**: a plan its planner is asking about, with the chat to
  // answer in and the time the executor takes over.
  group(
    `Asking ${owner()}, oldest first`,
    plans.filter((p) => p.askingIn),
    (p) =>
      `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}, in ${p.askingIn.row.name || "a planner"} [${String(p.askingIn.row.sessionId).slice(0, 8)}], ${statusOf(p.askingIn.row)}, the executor decides at ${hhmm(p.askingIn.until)}`,
  );
  group(
    "Ready, oldest first",
    plans.filter((p) => (p.state === "ready" || p.state === "handed") && !p.askingIn),
    (p) =>
      [
        `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}`,
        p.state === "handed" ? "handed over, resume" : "",
        p.asks ? "unanswered, the executor decides" : "",
        p.stuck ? `stuck, asks ${owner()}` : "",
        p.stale ? "(a Building line from a session that is gone)" : "",
      ]
        .filter(Boolean)
        .join(", "),
  );
  const built = plans.filter((p) => p.state === "built");
  group(
    all ? "Built" : "Built today",
    all ? built : built.filter((p) => p.builtDay.startsWith(today(now))),
    (p) => [p.sha, onWhere(p.sha)].filter(Boolean).join(", "),
  );
  const old = plans.filter((p) => p.state === "old").length;
  if (old)
    out.push(
      "",
      `Older, by path only: ${old} plan${old === 1 ? "" : "s"} dated before 24 October with no Built`,
    );
  // **The label is said where the queue is read** (plans/session-names-
  // across-machines.md), while the hostname stands in for it.
  if (!here.set)
    out.push(
      "",
      `${here.rejected ? `The plugin's "machine" option, "${here.rejected}", is no label (letters, digits, underscores, dots and hyphens), so this machine` : "This machine"} is named by its hostname; the plugin's "machine" option names it: /plugin configure workflow in a chat, or echo '{"machine":"<label>"}' | claude plugin configure workflow@workflow --values-stdin.`,
    );
  return out.join("\n");
}

/**
 * **The files this session's batches changed**, which survive the push and the
 * detach: from `base`, the branch's tip when the session wrote its first
 * Building line (after the batch's fetch), else at its first prompt, to
 * HEAD and to `origin/<branch>` (one executor at a time pushes the branch, so
 * everything after `base` there is this session's), and the turn's writes.
 * With no `base`, the branch's diff to HEAD.
 */
export function changedFiles(state, dir = root) {
  const diff = (range) => {
    try {
      return execFileSync("git", ["diff", "--name-only", range], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      // No such ref here: judge by what else there is.
      return [];
    }
  };
  const changed = state.base
    ? [...diff(`${state.base}..HEAD`), ...diff(`${state.base}..origin/${branch()}`)]
    : diff(`origin/${branch()}...HEAD`);
  const turn = readJson(join(tmpdir(), `workflow-turn-${state.sessionId}.json`));
  return [...new Set([...changed, ...(turn?.wrote || [])])];
}

/** The branch's tip, for a session's `base`; "" when the ref is missing. */
function branchTip() {
  try {
    return git(["rev-parse", `origin/${branch()}`]);
  } catch {
    return "";
  }
}

/** The project's run on its branch (`run` in the project file); null with none, or unread. */
function imageRun() {
  const workflow = proj().run;
  if (!workflow) return null;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const out = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--branch",
        branch(),
        "--workflow",
        workflow,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,headSha",
      ],
      { cwd: root, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const run = JSON.parse(out)[0];
    if (!run) return null;
    return {
      id: run.databaseId,
      status: run.status,
      conclusion: run.conclusion,
      onHead: run.headSha === head,
      workflow,
    };
  } catch {
    process.stderr.write(`plan-queue: the ${workflow} run could not be read (gh)\n`);
    return null;
  }
}

function hookOutput(event, context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
  );
}

/**
 * **One lock holder, by an atomic create**: true when this session holds the
 * lock on return, false when another does. The read, the judgement and the
 * write happen while holding a guard file created exclusively (`wx`), so two
 * claimants of a released, dead or missing lock cannot both win; a bare
 * read-then-write could, and so could renaming a stale lock aside, which can
 * move a lock another claimant has just made.
 */
export function takeLock(sessionId, live, { path = files.lock(), alive = null } = {}) {
  const guard = `${path}.guard`;
  if (!takeGuard(guard)) {
    const lock = readJson(path);
    return Boolean(lock && lock.sessionId === sessionId && !lock.released);
  }
  try {
    const lock = readJson(path);
    if (lock && lock.sessionId === sessionId && !lock.released) return true;
    const holderLives = alive ?? ((held) => holderAlive(held, live));
    if (lock && !lock.released && holderLives(lock)) return false;
    const row = live?.find((r) => r.sessionId === sessionId);
    writeJson(path, {
      sessionId,
      pid: row?.pid || null,
      name: row?.name || "",
      taken: Date.now(),
      released: false,
    });
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

/**
 * The lock's guard, created exclusively; waits up to three seconds for
 * another claimant to finish. A guard older than ten seconds is a crashed
 * claimant's and is removed (the critical section takes milliseconds).
 */
function takeGuard(guard) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000) {
        unlinkSync(guard);
        continue;
      }
    } catch {
      // Released between the create and the look: try again.
      continue;
    }
    if (Date.now() > deadline) return false;
    sleep(25);
  }
}

function release(sessionId) {
  const guard = `${files.lock()}.guard`;
  const guarded = takeGuard(guard);
  try {
    const lock = readJson(files.lock());
    if (lock && lock.sessionId === sessionId)
      writeJson(files.lock(), { ...lock, released: Date.now() });
  } finally {
    if (guarded)
      try {
        unlinkSync(guard);
      } catch {
        // Gone already.
      }
  }
}

/**
 * **What a planner's Stop hook does: the executor's rule, for briefs**
 * (plans/planner-continues.md, part 2, replacing plans/planner-queue.md's
 * one brief per planner). Nothing while a brief carries this session's live
 * Planning line (`current`), while paused, or when retired. With briefs
 * waiting that this session was not told of: one that has not compacted
 * takes the oldest, one that has compacted once the oldest related to its
 * plans, and one that has compacted twice, or once with nothing related
 * waiting, is retired for a fresh planner. With nothing waiting it stays
 * alive, idle and unretired, and a brief reaches it by message.
 */
export function decidePlannerStop({
  current = null,
  waiting = [],
  compactions = 0,
  told = [],
  paused = false,
  retired = false,
  usage = null,
  ceiling = REUSE_DEFAULT,
  now = Date.now(),
}) {
  if (retired || current || paused) return null;
  const fresh = waiting.filter((brief) => !told.includes(brief.path));
  // **A brief named and not taken goes to a fresh planner** (/code-review, 27
  // October): this live planner refuses every start, so the brief it
  // stopped without taking would otherwise wait for good.
  if (!fresh.length)
    return waiting.length ? { retire: true, related: false, declined: true } : null;
  const related = fresh.some((brief) => brief.related);
  const verdict = mayReuse({ compactions, related, usage, now, ceiling });
  if (!verdict.reuse) return { retire: true, related, why: verdict.why };
  const next = compactions === 0 ? fresh[0] : fresh.find((brief) => brief.related);
  return {
    refuse: true,
    told: [next.path],
    reason: `A brief is waiting and this session can take it: ${next.path}. Plan it by your agent file: the Planning line as your first edit, the research, the plan written over the brief, its decisions through the question tool in the same turn, the hand-off to the executor. What you wrote above this line was not a final message: the final message leads with every plan this session wrote, each with where it is and what it decides.`,
  };
}

/**
 * **A plan is taken once an executor has written on it**
 * (plans/planner-talks-until-built.md): a Building, Built, Handing over or
 * Resumed line, live or not, since a dead executor's work is on its branch.
 * From then on the plan is the executor's and its planner changes nothing.
 */
export function planTaken(text = "") {
  // The executor's own lines, dated, never a plan's "## Building it" section.
  return /^## (?:Building, |Resumed, |Handing over\b|Built(?:,|\s*$))/m.test(text);
}

/**
 * Who took a plan, for the planner's messages: "Executor 5 [b92bfc2b] on
 * 26 October 2026" (the live row's name, else "session b92bfc2b"), or
 * "built, commit <sha>" once it is built; "" when nothing took it.
 */
export function whoTook(text = "", live = null) {
  if (/^## Built(?:,|\s*$)/m.test(text)) {
    const sha = stateOf(text)?.sha || "";
    return sha ? `built, commit ${sha}` : "built";
  }
  const line = /^## (?:Building|Resumed|Handing over), ([^,\n]+)(?:, session ([^\s,]+))?/m.exec(
    text,
  );
  if (!line) return planTaken(text) ? "an executor" : "";
  const [, date, id = ""] = line;
  const row = id ? live?.find((r) => r.sessionId === id) : null;
  const who = row?.name
    ? `${row.name} [${id.slice(0, 8)}]`
    : id
      ? `session ${id.slice(0, 8)}`
      : "an executor";
  return `${who} on ${date.trim()}`;
}

/** "<brief> was taken by Executor 5 [...] on <date>", or "<brief> is built, commit <sha>". */
function takenBy(brief, text, live) {
  const who = whoTook(text, live) || "an executor";
  return who.startsWith("built") ? `${brief} is ${who}` : `${brief} was taken by ${who}`;
}

/**
 * Stops the queue's retired planners whose plan is `path`, once an executor
 * has taken it (plans/planner-talks-until-built.md): a background row the
 * queue counts as a planner, retired, its state naming the plan. the owner's own
 * planner chats are not the queue's. Asked once per half hour, so the
 * executor's sweep on every stop does not pile up timers.
 */
export function stopPlannersOn(
  path,
  live,
  {
    stateFor = readState,
    textOf = planText,
    stop = stopLater,
    write = writeJson,
    now = Date.now(),
  } = {},
) {
  for (const row of live || []) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null)) continue;
    // **Only when every plan of its own is taken** (plans/planner-continues.md,
    // part 5): an unretired planner is never stopped by a Building line, being
    // the warm context the next brief goes to.
    const plans = state?.plans || [];
    if (!state?.retired || !plans.includes(path)) continue;
    if (!plans.every((one) => one === path || planTaken(textOf(one)))) continue;
    if (state.stopAsked && now - state.stopAsked < 30 * MINUTE) continue;
    write(files.state(row.sessionId), { ...state, stopAsked: now });
    stop(row.sessionId, live);
  }
}

/** Stops every live retired planner of the queue but `except`: the next planner has started. */
export function stopRetiredPlanners(
  live,
  { except = "", stateFor = readState, stop = stopLater } = {},
) {
  for (const row of live || []) {
    if (row.sessionId === except) continue;
    const state = stateFor(row.sessionId);
    if (isSession("planner", row, state, null) && state?.retired) stop(row.sessionId, live);
  }
}

/**
 * The executor's sweep on every stop: each live retired planner whose plan
 * is taken (`planTaken`, the same rule its tool hook refuses by) is
 * stopped, once a Building line was written some other way than an Edit.
 */
export function stopTakenPlanners(
  live,
  { stateFor = readState, textOf = planText, ...options } = {},
) {
  const paths = new Set();
  for (const row of live || []) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null) || !state?.retired) continue;
    const plans = state.plans || [];
    if (plans.length && plans.every((one) => planTaken(textOf(one)))) paths.add(plans[0]);
  }
  for (const path of paths) stopPlannersOn(path, live, { stateFor, textOf, ...options });
}

/**
 * **A planner may still edit its own plans, and only them, until an
 * executor takes each** (plans/planner-open-decisions.md, widened by
 * plans/planner-talks-until-built.md and plans/planner-continues.md): the owner
 * goes on discussing a plan in its chat and the planner revises any section,
 * which the executor reads. True for Edit, Write or MultiEdit on one of
 * `plans` or the brief in hand (a plan is written over its brief) or under
 * its sketch folder (`plans/<topic>/`); a Bash command that writes one stays
 * refused.
 */
export function plannerMayEdit({
  plans = [],
  brief = "",
  toolName = "",
  filePath = "",
  base = root,
}) {
  if (!["Edit", "Write", "MultiEdit"].includes(toolName)) return false;
  return Boolean(planEdited({ plans: [...plans, brief], filePath, base }));
}

/** Which of `plans` an edit of `filePath` is to, itself or its sketch folder; "" for none. */
export function planEdited({ plans = [], filePath = "", base = root }) {
  if (!filePath) return "";
  const target = resolve(base, filePath);
  return (
    plans.filter(Boolean).find((one) => {
      const plan = resolve(base, one);
      return target === plan || target.startsWith(plan.replace(/\.md$/, "") + sep);
    }) || ""
  );
}

/** The text at a plan's path, or "" when it is gone. */
function planText(path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
}

/** A brief named in a prompt: a start prompt, or a message inside its wrapper. */
const PLANNER_PROMPT = /\bPlan (plans\/\S+\.md): it is a brief/;

/**
 * **What a planner holding plans is told on every prompt**, retired or not
 * (plans/planner-continues.md, part 5): where each of its plans stands, read
 * from the file at that moment, then where changes go, then whether it may
 * take the next brief.
 */
export function plannerContext(state, live = null, textOf = planText, options = {}) {
  const lines = (state?.plans || []).map((path) => {
    const text = textOf(path);
    if (!text) return `${path} is no longer in plans/.`;
    if (/^## Built(?:,|\s*$)/m.test(text)) return `${path} is ${whoTook(text, live)}.`;
    if (planTaken(text))
      return `${path} was taken by ${whoTook(text, live)}: it is the executor's, and no edit to it passes.`;
    const yours = `${path} is in the queue and still yours: talk it through with ${owner()} here and revise any section with Edit; an answer he gives goes in Decided with its reason; the executor reads the file when it starts it, so do not message it again. This chat ends on its own an hour after it goes quiet (the plan stands in the queue without it; a question left open keeps the chat alive, and the plan with it for thirty minutes).`;
    // **Asked once**: the plan's question holds it for thirty minutes.
    const plan = { path, ...stateOf(text) };
    if (plan.state !== "ready" || !plan.asks) return yours;
    const asking = askingIn(plan, live, options);
    return asking
      ? `${yours} It asks ${owner()} until ${hhmm(asking.until)}: his answer comes here, goes in Decided with its reason, and the plan is handed over by The final message; after that the executor takes it and builds the recommended options.`
      : `${yours} Its question went unanswered for thirty minutes: the executor takes it and builds the recommended options; an answer now that differs is a follow-up through the assistant's chat.`;
  });
  lines.push(
    `A change to a taken or built plan goes to the assistant's chat, which writes a follow-up plan or a brief: give ${owner()} the text to paste there, in a fenced block headed For the assistant's chat in Remote Control, under about 600 characters, naming the plan's path and the change in a line each. A new topic is the assistant's chat's: say so, and give nothing to run.`,
  );
  lines.push(
    state?.retired
      ? "This session is retired: it plans nothing more, and the next brief has a planner of its own."
      : "This session may take the next brief: one reaches it as a message, Plan plans/<x>.md: it is a brief, or the Stop hook names one that is waiting.",
  );
  return lines.join("\n");
}

/** Whether a planner is too tired for `brief`: two compactions, or one and the brief on other ground. */
function tiredFor(state, brief, textOf = planText) {
  const n = state.compactions || 0;
  if (n >= 2) return true;
  if (n < 1) return false;
  const plans = state.plans || [];
  return !relatedBrief(textOf(brief), plans.map(textOf), plans);
}

/** "plans/a.md" or "plans/a.md and plans/b.md", for a planner's messages. */
function ownWords(plans, brief) {
  const all = plans.length ? plans : brief ? [brief] : [];
  return all.length === 1
    ? `Only its own plan, ${all[0]}, and its sketch folder may still be edited, until an executor starts it.`
    : `Only its own plans, ${andList(all)}, and their sketch folders may still be edited, until an executor starts each.`;
}

/** A plan the brief in hand became, added to the session's list once its file no longer reads as a brief. */
function noteFinished(state, plans) {
  const inHand = state.brief ? plans.find((p) => p.path === state.brief) : null;
  if (!inHand || inHand.state === "brief" || inHand.state === "planning") return state;
  if (state.plans.includes(inHand.path)) return state;
  return { ...state, plans: [...state.plans, inHand.path], planned: true };
}

function plannerHook(mode, input, sessionId, statePath) {
  let state = readState(sessionId);
  state = { ...state, plans: state.plans || [] };
  if (mode === "tool") {
    const filePath = input.tool_input?.file_path;
    const editing = ["Edit", "Write", "MultiEdit"].includes(input.tool_name);
    // **A taken plan refuses every edit**, retired or not, one plan at a time:
    // an executor can take it while the planner is still in the turn that
    // handed it over (plans/planner-continues.md, part 5).
    const target = editing ? planEdited({ plans: [...state.plans, state.brief], filePath }) : "";
    if (target) {
      const text = planText(target);
      if (planTaken(text)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `${takenBy(target, text, null)}: the plan is the executor's now, and nothing in it changes from this session. Say so, and give ${owner()} the change as text for the assistant's chat, in a fenced block headed For the assistant's chat in Remote Control.`,
            },
          }),
        );
        return;
      }
    }
    if (!state.retired) return;
    const command = input.tool_name === "Bash" ? input.tool_input?.command || "" : null;
    if (command !== null && allowedWhileLocked(command)) return;
    // Only the plans this session wrote: a brief it was cut off on went to the next planner.
    if (plannerMayEdit({ plans: state.plans, toolName: input.tool_name, filePath })) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `This session is retired: its plans are in the queue. Do not plan again; say so, and stop. ${ownWords(state.plans, state.brief)}`,
        },
      }),
    );
    return;
  }
  const live = liveSessions();
  if (mode === "prompt") {
    const named = PLANNER_PROMPT.exec(String(input.prompt || ""))?.[1];
    if (state.retired) {
      writeJson(statePath, { ...state, agent: "planner" });
      const lines = [];
      if (named)
        lines.push(
          "This session is retired: the brief goes to `plans start --agent planner` in the assistant's chat.",
        );
      lines.push(
        state.plans.length
          ? plannerContext(state, live)
          : `This session is retired before it wrote its plan: its brief went to the next planner, and nothing in plans/ is this session's to change. Answer from what you know; a new topic or a change goes to the assistant's chat, as text for ${owner()} to paste there, in a fenced block headed For the assistant's chat in Remote Control.`,
      );
      hookOutput("UserPromptSubmit", lines.join("\n"));
      return;
    }
    // **The planner's hooks decide whether it has room** (part 4): a brief
    // named while it is tired is not taken, and its Stop hook retires it for
    // a fresh planner.
    const tired = named ? tiredFor({ ...state, agent: "planner" }, named) : false;
    // A brief named mid-plan does not replace the one in hand (/code-review, 27 October).
    const inHand = named
      ? readPlans(join(root, "plans"), liveIds(live)).some(
          (p) => p.state === "planning" && p.session === sessionId && p.path !== named,
        )
      : false;
    writeJson(statePath, {
      ...state,
      agent: "planner",
      ...(named && !tired && !inHand ? { brief: named } : {}),
    });
    const lines = [
      `Plans in the queue (plans):\n${list({ live })}\n\nThis session's id is ${sessionId}. It has compacted ${state.compactions} times.`,
    ];
    if (tired)
      lines.push(
        `This session is tired for ${named}: do not plan it. Say so, stop, and the Stop hook starts a fresh planner on it.`,
      );
    if (state.plans.length) lines.push(plannerContext(state, live));
    hookOutput("UserPromptSubmit", lines.join("\n\n"));
    return;
  }
  if (mode === "resumed") {
    countCompaction(state);
    writeJson(statePath, state);
    return;
  }
  const plans = readPlans(join(root, "plans"), liveIds(live));
  // The brief in hand is the one whose live Planning line names this session.
  const current = plans.find((p) => p.state === "planning" && p.session === sessionId) || null;
  if (current) state.brief = current.path;
  state = noteFinished(state, plans);
  if (mode === "cutoff") {
    if (input.error && input.error !== "rate_limit") return;
    // Only a brief in hand, unfinished, is handed on: an idle planner cut off
    // while talking about its plans stays the warm chat it is (the reviews of
    // 27 October).
    if (!current || state.retired) return;
    state.retired = true;
    // The plans written before the limit stay this session's own; the
    // unfinished brief goes to the next planner, whose plan this one may not write.
    state.planned = state.plans.length > 0;
    writeJson(statePath, state);
    let transcript = "";
    try {
      transcript = readFileSync(input.transcript_path, "utf8").slice(-200_000);
    } catch {
      // No transcript: the usage file alone says when.
    }
    const at = (resetTime(readJson(files.usage()), transcript) + AFTER_RESET) * 1000;
    // The brief stands, without this session's Planning line, for the next
    // planner.
    writeFileSync(current.file, current.text.replace(/^## Planning, [^\n]*\n\n?/m, ""));
    start([current.path], { agent: "planner", replace: sessionId, at });
    armEnd(sessionId, live);
    return;
  }
  if (mode === "stop") {
    // A planner the queue gave nothing (the owner's own) is left alone.
    if (!state.brief && !state.plans.length) return;
    const ownTexts = state.plans.map((path) => planText(path));
    const waiting = plans
      .filter((p) => p.state === "brief")
      .map((p) => ({ ...p, related: relatedBrief(p.text, ownTexts, state.plans) }));
    const decision = decidePlannerStop({
      current,
      waiting,
      compactions: state.compactions,
      told: state.told,
      paused: Boolean(pausedSince()),
      retired: state.retired,
      usage: sessionUsage(input.transcript_path),
      ceiling: proj().reuse,
    });
    if (!decision) {
      writeJson(statePath, state);
      // **A finished chat ends an hour after it goes quiet** (plans/idle-chats-end.md).
      armEnd(sessionId, live);
      return;
    }
    if (decision.refuse) {
      state.told = [...state.told, ...decision.told];
      // The brief named is the one in hand from here, so the plan written
      // over it joins the list even when its Planning line is gone by the
      // next Stop (Codex, 27 October).
      state.brief = decision.told[0];
      writeJson(statePath, state);
      process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
      return;
    }
    state.retired = true;
    state.planned = state.plans.length > 0;
    writeJson(statePath, state);
    const said = start([], { agent: "planner", replace: sessionId });
    armEnd(sessionId, live);
    // An executor can take a plan before this Stop: its Building line found
    // this planner unretired then, so the chat is stopped here.
    if (state.plans.length && state.plans.every((path) => planTaken(planText(path))))
      stopPlannersOn(state.plans[0], live);
    const n = state.compactions;
    const why = decision.declined
      ? "the brief named at the last stop is still waiting, untaken"
      : decision.why ||
        `this session has compacted ${n} time${n === 1 ? "" : "s"}${n === 1 && !decision.related ? ", and the brief waiting is on other ground" : ""}`;
    hookOutput(
      "Stop",
      `Retired: ${why}. ${said} Say so as the first line of your final message, send it as a push notification when PushNotification is in this session, and do not plan again in this session. This chat stays its plans': ${owner()} may go on discussing them here, and you revise each with Edit until an executor starts it, the next planner starts, or the chat has been quiet an hour, when this chat is stopped (its plans stand in the queue; a question left open keeps the chat alive, and the plan with it for thirty minutes).`,
    );
  }
}

function hook(mode, input) {
  // **A project with no project file is not the workflow's**: its own hooks,
  // if it has any, run alone (a project moving onto the plugin keeps its old
  // queue until its file lands).
  if (!proj().found) return;
  // A compaction drops the catalogue's rules from the context, so the
  // edit-time hook shows them in full again (in both forms).
  if (mode === "compact")
    try {
      unlinkSync(join(tmpdir(), `workflow-catalogue-${input.session_id}.json`));
    } catch {
      // None shown yet.
    }
  // **The compact form has no queue**: the maker is one chat, and the queue's
  // hooks do nothing (the catalogue's hooks run in both forms).
  if (proj().form === "compact") return;
  const sessionId = input.session_id;
  const executor = kindOf(input) === "executor";
  const statePath = files.state(sessionId);
  if (mode === "compact") {
    writeJson(statePath, countCompaction(readState(sessionId)));
    return;
  }
  // Only an executor's Building line takes a plan; any other session's edit returns at once.
  if (mode === "wrote" && !executor) return;
  if (kindOf(input) === "planner") {
    plannerHook(mode, input, sessionId, statePath);
    return;
  }
  if (!executor) return;
  if (mode === "wrote") {
    // **The Building line takes the plan from its planner**: a retired
    // planner whose plan this is has its chat stopped (decision 1 of
    // plans/planner-talks-until-built.md). Anything else returns at once.
    const building = new RegExp(`^## Building, [^,\\n]+, session ${sessionId}\\b`, "m");
    // **The batch starts at its first Building line**: written after the
    // batch's fetch, so `origin/<branch>` is current there, with no hook
    // touching the network. A later Building line leaves it alone, and a
    // missing ref leaves the first prompt's.
    const markBase = () => {
      const state = readState(sessionId);
      if (state.baseAt) return;
      const tip = branchTip();
      if (tip) writeJson(statePath, { ...state, base: tip, baseAt: "building" });
    };
    // A Building line written by a shell command: found by reading the
    // plans, once per session, until the base is marked.
    if (input.tool_name === "Bash") {
      if (readState(sessionId).baseAt) return;
      if (readPlans(join(root, "plans")).some((p) => building.test(p.text))) markBase();
      return;
    }
    const file = input.tool_input?.file_path;
    if (!file) return;
    const path = relative(root, resolve(root, file));
    if (!/^plans\/[^/]+\.md$/.test(path)) return;
    if (!building.test(planText(path))) return;
    markBase();
    stopPlannersOn(path, liveSessions());
    return;
  }
  const state = readState(sessionId);
  if (mode === "tool") {
    const command = input.tool_name === "Bash" ? input.tool_input?.command || "" : null;
    if (command !== null && allowedWhileLocked(command)) return;
    const lock = readJson(files.lock());
    let reason = "";
    if (lockHeldByOther(lock, sessionId)) reason = blockReason(lock);
    else if (state.retired)
      reason =
        "This session is retired: a fresh executor took the queue. Do not build; say so, and stop.";
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    return;
  }
  const live = liveSessions();
  if (mode === "prompt") {
    const lock = readJson(files.lock());
    if (lockHeldByOther(lock, sessionId, () => holderAlive(lock, live))) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: blockReason(lock) }));
      return;
    }
    if (state.retired) {
      hookOutput(
        "UserPromptSubmit",
        "This session is retired: a fresh executor took the queue. Do not build; answer from what you know, and say so.",
      );
      return;
    }
    if (!takeLock(sessionId, live)) {
      // Another prompt hook took it between the check above and the create.
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: blockReason(readJson(files.lock()) || {}) }),
      );
      return;
    }
    // An executor the owner started by hand has no `Executor n` name; this
    // marks it, and the first mark records where its batches start.
    if (state.agent !== "executor")
      writeJson(statePath, {
        ...state,
        agent: "executor",
        // A base a Building line marked is the batch's: never moved back.
        ...(state.baseAt ? {} : { base: branchTip() }),
      });
    hookOutput(
      "UserPromptSubmit",
      `Plans in the queue (plans):\n${list({ live })}\n\nThis session's id is ${sessionId}. It has compacted ${state.compactions} times; the rule is in your agent file under "Going on".`,
    );
    return;
  }
  if (mode === "resumed") {
    countCompaction(state);
    writeJson(statePath, state);
    const plans = readPlans(join(root, "plans"), liveIds(live));
    const plan = plans.find((p) => p.state === "building" && p.session === sessionId) || null;
    const text = decideResumed({ compactions: state.compactions, plan });
    if (text) hookOutput("SessionStart", text);
    return;
  }
  if (mode === "cutoff") {
    if (input.error && input.error !== "rate_limit") return;
    release(sessionId);
    state.retired = true;
    writeJson(statePath, state);
    armEnd(sessionId, live);
    const plans = readPlans(join(root, "plans"), liveIds(live));
    const plan = plans.find((p) => p.state === "building" && p.session === sessionId);
    if (!plan) return;
    let branch = "";
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    } catch {
      branch = "(unknown)";
    }
    writeFileSync(plan.file, cutoffEdit(plan.text, { sessionId, branch }));
    let transcript = "";
    try {
      transcript = readFileSync(input.transcript_path, "utf8").slice(-200_000);
    } catch {
      // No transcript: the usage file alone says when.
    }
    const at = (resetTime(readJson(files.usage()), transcript) + AFTER_RESET) * 1000;
    start([plan.path], { replace: sessionId, at });
    return;
  }
  if (mode === "stop") {
    const lock = readJson(files.lock());
    // **A finished chat ends an hour after it goes quiet** (plans/idle-chats-end.md):
    // every stop that does not block arms the end timer.
    if (lockHeldByOther(lock, sessionId, () => holderAlive(lock, live))) {
      armEnd(sessionId, live);
      return;
    }
    const plans = readPlans(join(root, "plans"), liveIds(live));
    // The sweep: a Building line written another way (a shell command, a
    // hook that failed) still stops the retired planner whose plan it took.
    stopTakenPlanners(live);
    const changed = changedFiles({ ...state, sessionId });
    // "Asked once": a plan its planner is still asking about is not named.
    const waiting = withAsking(
      plans.filter((p) => p.state === "ready"),
      live,
    )
      .filter((p) => !p.askingIn)
      .map((p) => ({ ...p, related: related(p.text, changed) }));
    const handed = plans.filter((p) => p.state === "handed");
    const decision = decideStop({
      current: plans.find((p) => p.state === "building" && p.session === sessionId) || null,
      compactions: state.compactions,
      waiting,
      handed,
      run: imageRun(),
      told: state.told,
      paused: Boolean(pausedSince()),
      retired: state.retired,
      continuing: Boolean(input.stop_hook_active),
      refusedRun: state.runRefused ?? null,
      usage: sessionUsage(input.transcript_path),
      ceiling: proj().reuse,
    });
    if (!decision) {
      armEnd(sessionId, live);
      return;
    }
    if (decision.refuse) {
      if (decision.runId) state.runRefused = decision.runId;
      if (decision.told) state.told.push(...decision.told);
      writeJson(statePath, state);
      process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
      return;
    }
    if (decision.context) {
      state.told.push(...decision.told);
      writeJson(statePath, state);
      armEnd(sessionId, live);
      hookOutput("Stop", decision.context);
      return;
    }
    const paths = decision.handover ? [decision.handover.path] : decision.paths;
    release(sessionId);
    state.retired = true;
    writeJson(statePath, state);
    const said = start(paths, { replace: sessionId });
    armEnd(sessionId, live);
    const started = /was started on/.test(said);
    const why = decision.handover
      ? `${decision.handover.path} was handed over`
      : decision.why || `this session has compacted ${state.compactions} times`;
    hookOutput(
      "Stop",
      started
        ? `Retired: ${why}. ${said} Say so as the first line of your final message, send it as a push notification when PushNotification is in this session, and do not build again in this session.`
        : `Retired: ${why}, but no executor was started: ${said} Put that line in your final message for ${owner()}, as a push notification too when PushNotification is in this session, and do not build again in this session.`,
    );
  }
}

/**
 * **`plans check` lints the `deny` key** (docs/workflow.md, "The project
 * file"), from `project()`'s one parse: a line under the key it could not
 * read, by line number; a list or a value with no agent's name over it; an
 * agent the plugin has no file for, or with no pattern; a pattern that does not compile alone; a
 * connector named alone, which the hook reads as its every tool; a pattern
 * that could match no MCP tool's name. One line per fault; an absent or
 * empty `deny` says nothing.
 */
export function checkDeny(project = proj(), agents = pluginAgents()) {
  const written = project.written?.deny;
  const lines = (project.written?.unread ?? [])
    .filter((at) => at.under === "deny")
    .map(
      (at) =>
        `deny: line ${at.line} is not read: ${at.text} (${at.item ? "an item goes under its agent's name, indented as deep or deeper" : 'an agent is "name:" with its patterns under it, or "name: pattern"'})`,
    );
  // A flat list or a value under `deny` denies nothing: say so, or a typo
  // turns every denial off unseen.
  if ((Array.isArray(written) && written.length) || (typeof written === "string" && written))
    lines.push(
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    );
  for (const [agent, patterns] of Object.entries(project.deny)) {
    if (!agents.includes(agent))
      lines.push(`deny: ${agent} is no agent of the plugin (${agents.join(", ")})`);
    if (!patterns.length) lines.push(`deny: ${agent}: no pattern under it, so it denies nothing`);
    for (const pattern of patterns) {
      if (!compiles(pattern)) lines.push(`deny: ${agent}: ${pattern} is not a regular expression`);
      else if (connectorAlone(pattern))
        lines.push(
          `deny: ${agent}: ${pattern} names a connector, not a tool: write \`${everyTool(pattern)}\``,
        );
      else if (!couldNameMcp(pattern))
        lines.push(
          `deny: ${agent}: ${pattern} names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only`,
        );
    }
  }
  return lines;
}

/**
 * **`plans check`**: every catalogue the project file names, linted. One line
 * per fault: an entry without its tier and date, an id used twice in one
 * catalogue, a project entry that says it overrides a `file#id` no inherited
 * catalogue has. Then the count.
 */
export function checkCatalogues(project = proj(), dir = root) {
  const locs = locations(project, dir);
  const named = [...project.inherits, project.catalogue].filter(Boolean);
  if (!named.length)
    return { text: "No catalogue: the project file names no catalogue or inherits.", faults: 0 };
  // A location the project file names that is not there is a fault.
  const lines = named
    .filter((p) => !locs.some((loc) => loc.label === p.replace(/\/$/, "")))
    .map((p) => `${p}: no such catalogue`);
  const inherited = new Set();
  let entries = 0;
  let fileCount = 0;
  const read = locs.map((loc) => {
    const files = catalogueFiles(loc.path).map((f) => ({
      ...f,
      text: readFileSync(f.path, "utf8"),
    }));
    fileCount += files.length;
    return { loc, files };
  });
  for (const { loc, files } of read) {
    const ids = new Map();
    for (const f of files) {
      const where = loc.path.endsWith(".md") ? loc.label : `${loc.label}/${f.name}`;
      for (const rule of untiered(f.text))
        lines.push(
          `${where}: no tier and date: ${rule.length > 80 ? `${rule.slice(0, 77)}...` : rule}`,
        );
      for (const { item, line } of paragraphs(f.text)) {
        entries++;
        const id = /^- `([\w.-]+)`/.exec(item)?.[1];
        if (!id) continue;
        if (ids.has(id))
          lines.push(
            `${where}:${line}: id ${id} is used twice in ${loc.label} (first ${ids.get(id)})`,
          );
        else ids.set(id, `${where}:${line}`);
        if (!loc.own) inherited.add(`${f.name.replace(/\.md$/, "")}#${id}`);
      }
    }
  }
  for (const { loc, files } of read.filter((r) => r.loc.own)) {
    for (const f of files) {
      const where = loc.path.endsWith(".md") ? loc.label : `${loc.label}/${f.name}`;
      for (const { item, line } of paragraphs(f.text))
        // The id ends at a word character: a sentence's full stop is not part of it.
        for (const m of item.matchAll(/\boverrides?\s+`?([\w./-]+#[\w.-]*[\w-])`?/gi))
          if (!inherited.has(m[1].replace(/\.md#/, "#")))
            lines.push(`${where}:${line}: overrides ${m[1]}, which no inherited catalogue has`);
    }
  }
  const tail = `${entries} entries in ${fileCount} file${fileCount === 1 ? "" : "s"}, ${lines.length ? `${lines.length} fault${lines.length === 1 ? "" : "s"}` : "no faults"}.`;
  return { text: [...lines, tail].join("\n"), faults: lines.length };
}

/**
 * **`plans chat`**: the maker in a compact project, else the assistant, with
 * the project's `mcp` configs (beside what the user settings load) and its
 * inherited catalogues as added directories.
 */
export function chatCommand(args = [], project = proj(), dir = root) {
  const at = (p) => (isAbsolute(p) ? p : resolve(dir, p));
  const agent = project.form === "compact" ? "maker" : "assistant";
  const effort = agent === "maker" ? agentEffort("maker") : "";
  // `--mcp-config` and `--add-dir` take every value up to the next flag, so
  // they come first and the owner's words after a flag of one value.
  return [
    ...project.mcp.flatMap((p) => ["--mcp-config", at(p)]),
    ...project.inherits.flatMap((p) => ["--add-dir", at(p)]),
    "--agent",
    `workflow:${agent}`,
    ...(effort ? ["--effort", effort] : []),
    ...args,
  ];
}

const USAGE = `plans                 the queue: briefs, asking, ready, building, built
plans --all           with the older plans listed by path
plans start [path...] start an executor on the waiting plans, or these
plans start --agent planner <brief>   start a planner on a brief
plans pause | resume  stop and restart starting sessions
plans end [id...]     end this queue's finished chats now, or these
plans sync            move a clean, detached checkout to the branch
plans init            write .claude/workflow.md for this project
plans check           lint the catalogues and the deny key the project file names
plans chat [--dry] [args...]  open the maker (compact) or the assistant here, with the project's mcp and inherits`;

export function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (!mode || mode === "list" || mode === "--all") {
    process.stdout.write(`${list({ all: args.includes("--all") })}\n`);
    return;
  }
  if (mode === "init") {
    process.stdout.write(`${init(root)}\n`);
    return;
  }
  if (mode === "check") {
    const denied = checkDeny();
    const { text, faults } = checkCatalogues();
    process.stdout.write(`${[...denied, text].join("\n")}\n`);
    if (faults || denied.length) process.exitCode = 1;
    return;
  }
  if (mode === "chat") {
    const dry = rest.includes("--dry");
    const command = chatCommand(rest.filter((a) => a !== "--dry"));
    process.stdout.write(
      `${dry ? "Would run" : "Running"}: claude ${command.map((a) => JSON.stringify(a)).join(" ")}\n`,
    );
    if (!dry) {
      const done = spawnSync(claudeBin(), command, {
        cwd: root,
        stdio: "inherit",
        env: sessionEnv(),
      });
      process.exitCode = done.status ?? 1;
    }
    return;
  }
  if (mode === "end") {
    const at = rest.indexOf("--timer");
    if (at >= 0) {
      // The end timer: a wait, then the rule, with no output.
      const when = Number(rest[at + 1]);
      const sessionId = rest.filter((_, i) => i !== at && i !== at + 1)[0];
      setTimeout(
        () => {
          try {
            if (sessionId) endSession(sessionId);
          } catch {
            // A timer that fails ends nothing: the supervisor's own clock remains.
          }
          // Fired, it is no timer of the session's any more, so its pid is not signalled.
          if (sessionId) clearEnd(sessionId);
        },
        Math.max(0, when - Date.now()),
      );
      return;
    }
    process.stdout.write(`${endCommand(rest)}\n`);
    return;
  }
  if (!["sync", "pause", "resume", "start", ...HOOK_MODES].includes(mode)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (mode === "sync") {
    process.stdout.write(`${sync()}\n`);
    return;
  }
  if (mode === "pause") {
    // **A pause holds the deferred starts**: each timer is killed and its
    // deferral kept, with no timer, for the resume to re-arm.
    const held = [];
    for (const kind of ["executor", "planner"]) {
      const deferred = readJson(files.deferred(kind));
      if (!deferred) continue;
      if (deferred.pid) {
        try {
          process.kill(deferred.pid);
        } catch {
          // The timer is gone already.
        }
        writeJson(files.deferred(kind), { ...deferred, pid: null });
      }
      held.push(deferredWords(deferred));
    }
    writeJson(files.pause(), {
      at: new Date().toString().slice(0, 21),
      by: process.env.CLAUDE_SESSION_ID || "",
    });
    process.stdout.write(
      `The queue is paused: no executor is started or handed plans until 'resume the queue' in any session.${held.length ? ` Held: ${held.join("; ")}.` : ""}\n`,
    );
    return;
  }
  if (mode === "resume") {
    try {
      unlinkSync(files.pause());
    } catch {
      // It was not paused.
    }
    const armed = [];
    for (const kind of ["executor", "planner"]) {
      const deferred = readJson(files.deferred(kind));
      if (!deferred) continue;
      // A timer at the later of its time and a minute from now.
      defer(deferred.until, deferred.why, deferred.paths || [], deferred.replace || "", kind);
      armed.push(deferredWords(readJson(files.deferred(kind)) || deferred));
    }
    process.stdout.write(
      `The queue is running again.${armed.length ? ` Re-armed: ${armed.join("; ")}.` : ""}\n`,
    );
    return;
  }
  if (mode === "start") {
    const paths = [];
    const options = {};
    let timer = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--dry") options.dry = true;
      else if (rest[i] === "--agent") options.agent = rest[++i];
      else if (rest[i] === "--at") options.at = Number(rest[++i]);
      else if (rest[i] === "--replace") options.replace = rest[++i];
      else if (rest[i] === "--timer") timer = Number(rest[++i]);
      else paths.push(rest[i]);
    }
    if (timer) {
      // The deferred start: a wait and then the same start, nothing else.
      setTimeout(
        () => {
          try {
            unlinkSync(files.deferred(options.agent === "planner" ? "planner" : "executor"));
          } catch {
            // Cleared already.
          }
          start(paths, { ...options, timer: true });
        },
        Math.max(0, timer - Date.now()),
      );
      return;
    }
    process.stdout.write(`${start(paths, options)}\n`);
    return;
  }
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  try {
    hook(mode, input);
  } catch (error) {
    process.stderr.write(`plan-queue ${mode}: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
