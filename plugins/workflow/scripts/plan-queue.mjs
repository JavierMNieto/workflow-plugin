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
//                            the lock, or after retiring, and its Building
//                            line on a plan still asking; a planner's edit to
//                            a taken plan; a planner's question records its
//                            time and defers a start of the plan it asks about
//   plan-queue.mjs stop      on Stop: the project's run on the push, or the
//                            checks on its pull requests, then the waiting
//                            plans (built here while the context is fresh,
//                            or a fresh executor started when tired)
//   plan-queue.mjs wrote     on PostToolUse (Edit, Write, Bash): an executor's
//                            Building line stops the retired planner of it;
//                            one a shell wrote on a plan still asking is
//                            taken out again
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
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsChoice, shellWrites, untiered } from "./turn-audit.mjs";
import { catalogueFiles, locations, paragraphs } from "./catalogue-context.mjs";
import {
  PROJECT_FILE,
  QUEUE_KINDS,
  compiles,
  connectorAlone,
  couldNameMcp,
  everyTool,
  ignoreQueueFiles,
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
  // One deferral per kind, so a planner's never drops an executor's; the
  // thirty minutes of "Asked once" have their own (`asking`), so a question
  // never moves a usage limit's restart.
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

/** The queue's own status lines, dated, never a plan's "## Building it" section. */
const STATUS_HEADING = /^## (?:Planning, |Building, |Resumed, |Handing over\b)/;
/**
 * A plan's dated header line or a brief's line: where a status section above
 * it ends. Dated, so a body line that only starts with the words does not end it.
 */
const HEADER_LINE = new RegExp(
  `^(?:(?:Plan only|Short plan), (?:${DAY})|Brief for the planner\\b)`,
);
/** A plan's dated header line, as `stateOf` reads it. */
const PLAN_HEADER = new RegExp(`^(?:Plan only|Short plan), (?:${DAY})`);

/**
 * **A plan's text without the queue's status sections**
 * (plans/handed-plan-stays-in-queue.md): each Planning, Building, Resumed or
 * Handing over line with its body, up to the next `## ` or the header line.
 * A hand-over written between the title and the header pushed the header past
 * the lines `stateOf` reads, and the plan fell out of every list.
 */
export function withoutStatus(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (STATUS_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^## /.test(line) || HEADER_LINE.test(line))) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * **Where a plan lands**, from its `Lands` line (plans/pull-requests-by-
 * topic.md, part 1): `{ kind: "fix", now }` or `{ kind: "topic", name, ready
 * }`, read from the text before the plan's first `## ` heading, past its
 * status sections; null with none, as a plan in the push mode or an older
 * plan has.
 */
export function landsOf(text = "") {
  const lines = withoutStatus(text).split("\n");
  const end = lines.findIndex((line) => /^## /.test(line));
  const head = (end < 0 ? lines : lines.slice(0, end)).join("\n");
  // Hand-wrapped prose: the line may wrap anywhere a space is (/code-review).
  const m =
    /^Lands:\s+(?:fix(,\s+now)?|topic\s+([a-z0-9]+(?:-[a-z0-9]+)*),\s+(waiting|ready))\.?[ \t]*$/m.exec(
      head,
    );
  if (!m) return null;
  if (m[2]) return { kind: "topic", name: m[2], ready: m[3] === "ready" };
  return { kind: "fix", now: Boolean(m[1]) };
}

/**
 * One item of a `Related` line: `#<n>`, or `branch <name>`: a topic's name, or
 * another person's branch in Git's shape (`fix/pictures`, `v1.2`), a dot only
 * inside it, so the line's full stop is not the name's (Codex, 30 October).
 */
const RELATED_ITEM = "(?:#\\d+|branch\\s+[\\w-]+(?:[/.][\\w-]+)*)";

/**
 * **What the author marked a plan or a brief related to**, from its `Related`
 * line (plans/collaborating-when-claude-writes-the-code.md, part 3): `Related:
 * #31.`, `Related: #31 and branch outside-pictures-kept.`, read as `landsOf`
 * reads `Lands`, from the text before the first `## `, past the status
 * sections and outside a fenced block; a list of `{ kind: "pull", number }`
 * and `{ kind: "branch", name }`, or null with none.
 */
export function relatedOf(text = "") {
  const lines = withoutStatus(text).split("\n");
  const end = lines.findIndex((line) => /^## /.test(line));
  const head = (end < 0 ? lines : lines.slice(0, end)).join("\n").replace(/^```[\s\S]*?^```/gm, "");
  const m = new RegExp(
    `^Related:[ \\t]+(${RELATED_ITEM}(?:(?:,\\s+and\\s+|,\\s+|\\s+and\\s+)${RELATED_ITEM})*)\\.?[ \\t]*$`,
    "m",
  ).exec(head);
  if (!m) return null;
  return [...m[1].matchAll(new RegExp(RELATED_ITEM, "g"))].map(([item]) =>
    item.startsWith("#")
      ? { kind: "pull", number: Number(item.slice(1)) }
      : { kind: "branch", name: item.replace(/^branch\s+/, "") },
  );
}

/**
 * A project's name in a `From` line or a `For` heading: anything up to the
 * line's delimiter, as a project file's `name` or a directory's may be
 * (`my_docs`), never a comma, a colon or a line break (Codex and /code-review).
 */
const PROJECT_WORDS = "[^\\s,:][^\\n,:]*?";

/**
 * **Where a brief from `/workflow:change` came from**, its `From: <Project>,
 * <path>.` line (plans/project-follow-ups-reach-the-project.md, part 4): read
 * as `landsOf` reads `Lands`, from the text before the first `## `, past the
 * status sections and outside a fenced block; the path absolute, the full
 * stop optional, the line wrapped at the comma or not. `{ project, path }`,
 * or null with none.
 */
export function fromOf(text = "") {
  const lines = withoutStatus(text).split("\n");
  const end = lines.findIndex((line) => /^## /.test(line));
  const head = withoutFences((end < 0 ? lines : lines.slice(0, end)).join("\n"));
  // The path runs to the line's end, spaces and all (`/Users/j/My Projects/docs`).
  const m = new RegExp(`^From:[ \\t]+(${PROJECT_WORDS}),\\s+(\\/[^\\n]*?)\\.?[ \\t]*$`, "mu").exec(
    head,
  );
  return m ? { project: m[1].trim(), path: m[2] } : null;
}

/**
 * **The briefs a plan carries to the project it came from**, its `## For
 * <Project>: plans/<topic>.md` sections outside fenced blocks
 * (plans/project-follow-ups-reach-the-project.md, part 4): `[{ project, file
 * }]`, the file as written; `[]` with none.
 */
export function carriesOf(text = "") {
  const heading = new RegExp(`^## For (${PROJECT_WORDS}): (plans\\/[^\\s/]+\\.md)[ \\t]*$`, "gmu");
  return [...withoutFences(text).matchAll(heading)].map((m) => ({
    project: m[1].trim(),
    file: m[2],
  }));
}

/** A `Related` line's items in words, for a Ready row: "#31 and branch a-b"; "" with none. */
export function relatedWords(related) {
  if (!related?.length) return "";
  return andList(
    related.map((one) => (one.kind === "pull" ? `#${one.number}` : `branch ${one.name}`)),
  );
}

/**
 * A text without its fenced blocks, backticks or tildes, three or more, the
 * closing fence of the same character and at least as long (CommonMark), so
 * a plan that shows a section in an example does not read as having it
 * (Codex, 30 October).
 */
export function withoutFences(text = "") {
  const kept = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        mark &&
        mark[0] === fence[0] &&
        mark.length >= fence.length &&
        !line.trim().slice(mark.length).trim()
      )
        fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * **A plan or a brief dropped on the owner's word** (plans/dropped-plan-
 * state.md): its `## Dropped, <date>` section, outside a fenced block, as
 * `{ droppedDay, why }`, the why its first paragraph with the `Dropped on
 * <owner>'s word: ` lead-in and the full stop taken off; null with none.
 */
export function droppedOf(text = "") {
  if (!/^## Dropped/m.test(text)) return null;
  const prose = withoutFences(text);
  const heading = /^## Dropped(?:, ([^\n]+?))?[ \t]*$/m.exec(prose);
  if (!heading) return null;
  const body = prose.slice(heading.index + heading[0].length);
  const end = body.search(/^## /m);
  const paragraph = (end < 0 ? body : body.slice(0, end)).trim().split(/\n\s*\n/)[0] || "";
  const why = paragraph
    .replace(/\s+/g, " ")
    .replace(/^Dropped on [^:]*'s word:\s*/, "")
    .replace(/\.$/, "");
  return { droppedDay: (heading[1] || "").trim(), why };
}

/**
 * A plan's place in the queue, read from its text. `live` is the live
 * sessions' ids, or null when they could not be listed, which counts every
 * Building line as live: the safe side.
 */
export function stateOf(text, { mtime = 0, live = null } = {}) {
  // **A plan is a plan before it is a brief**: its header is read first, and
  // the brief's line only at a line's start, so a plan whose first lines
  // mention the brief it replaced reads as the plan. Both are looked for past
  // the queue's own status sections, wherever an agent wrote them; the
  // status checks below read the whole text.
  const lines = withoutStatus(text).split("\n");
  const header = new RegExp(`^(Plan only|Short plan), (${DAY})`, "m").exec(
    lines.slice(0, 12).join("\n"),
  );
  const head = lines.slice(0, 6).join("\n");
  const dropped = droppedOf(text);
  // **A brief is queued like a plan** (plans/planner-queue.md): one a
  // planner is working on carries its Planning line, live while its session is.
  const brief = header ? null : new RegExp(`^Brief for the planner(?:, (${DAY}))?`, "m").exec(head);
  if (brief) {
    const day = brief[1] || "";
    const base = {
      kind: "Brief",
      day,
      date: day ? parseDay(day) : 0,
      mtime,
      relatedTo: relatedOf(text),
    };
    if (dropped) return { ...base, state: "dropped", ...dropped };
    const planning = /^## Planning, ([^,\n]+), session ([^\s,]+)/m.exec(text);
    if (planning && (live === null || live.includes(planning[2])))
      return { ...base, state: "planning", session: planning[2], since: planning[1] };
    return { ...base, state: "brief", stale: Boolean(planning) };
  }
  if (!header) return null;
  const plan = {
    kind: header[1],
    day: header[2],
    date: parseDay(header[2]),
    mtime,
    lands: landsOf(text),
    relatedTo: relatedOf(text),
    from: fromOf(text),
    carries: carriesOf(text),
  };
  // Dropped before built: nobody writes both, and the drop is the last word.
  if (dropped) return { ...plan, state: "dropped", ...dropped };
  const built = /^## Built(?:, ([^\n]+))?/m.exec(text);
  if (built) {
    // The commit is the hash written after "commit", else the section's first eight-hex word.
    const section = sectionAfter(text, /^## Built/m);
    const named = /\bcommit `?([0-9a-f]{8})[0-9a-f]*`?/.exec(section);
    const sha = named ? named[1] : (/\b[0-9a-f]{8}\b/.exec(section)?.[0] ?? "");
    // **A plan landed by pull request** (`land: pull-request`) names it, on
    // the first line or on the line a topic's later opening adds.
    const pr = Number(/^Pull request #(\d+)/m.exec(section)?.[1] || 0);
    // The section's first line says how the plan landed when it was not by
    // a pull request: a fix pushed straight, or a topic waiting for one.
    const opening =
      section
        .split("\n")
        .slice(1)
        .find((line) => line.trim()) || "";
    const fix = /^Pushed straight to /.test(opening);
    const topic = /^On topic ([^\s,]+)/.exec(opening)?.[1] || "";
    return { ...plan, state: "built", builtDay: (built[1] || "").trim(), sha, pr, fix, topic };
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
 * **A plan file the queue cannot read is listed, never dropped**
 * (plans/handed-plan-stays-in-queue.md): the `plans/*.md` with neither a
 * plan's header nor a brief's line where `stateOf` looks (`headless`), and
 * those that could not be read at all (`failed`, Codex, 28 October), by path.
 * One gone between the listing and the read is gone, not failed.
 */
export function unreadPlans(dir = join(root, "plans")) {
  const unread = { headless: [], failed: [] };
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return unread;
  }
  for (const name of names.sort()) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") unread.failed.push(`plans/${name}`);
      continue;
    }
    if (!stateOf(text)) unread.headless.push(`plans/${name}`);
  }
  return unread;
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

/**
 * The branch a session works on: its worktree's, from `git worktree list`,
 * else what `git branch --show-current` says there; "(unknown)" when neither
 * names one. The hand-overs write it for the next executor to check out.
 */
function branchOf(cwd = root) {
  const tree = treeOf(cwd || root, worktrees());
  if (tree?.branch) return tree.branch;
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: tree?.path || root,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || "(unknown)";
  } catch {
    return "(unknown)";
  }
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
  // **An assistant chat is the queue's by its numbered name alone**
  // (plans/project-follow-ups-reach-the-project.md, part 6): the owner's own
  // `<Project> Assistant` is his.
  if (kind === "assistant") return named;
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
export const SESSION_NAME = /^(?:(.+) )?(Executor|Planner|Assistant) (\d+)(?: \(([\w.-]+)\))?$/;

/** The name the queue gives a session it starts. */
export function sessionName(kind, n, { project = "", machine = "" } = {}) {
  const word = { planner: "Planner", assistant: "Assistant" }[kind] || "Executor";
  return [project, word, n, machine && `(${machine})`].filter(Boolean).join(" ");
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
  const working = { planner: "planning", executor: "building" }[kind] || "";
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
          (working &&
            plans.find((plan) => plan.state === working && plan.session === row.sessionId)?.path) ||
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
                    { self: row.sessionId, stateFor },
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
  if (one.kind === "assistant")
    return [
      `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
      one.status,
      usageWords(one),
      endsWords(one),
    ]
      .filter(Boolean)
      .join(", ");
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
  const word = kind === "executor" ? "executor" : kind;
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

/**
 * **No agent marks a pull request ready for review** (plans/no-agent-marks-
 * ready.md): whether a shell command calls `gh pr ready` without `--undo`.
 * The command is split into simple commands on `&&`, `||`, `;`, `|`, `&`,
 * new lines, parentheses and backquotes outside quotes, and each one's
 * words are read with their quotes taken off, so a quoted string naming it
 * (a commit message) is no call. A comment, a heredoc's body and a
 * backslash before a new line are passed over (Codex); leading `NAME=value`
 * words, the shell's keywords (`if`, `then`, `do`, ...) and the wrappers
 * that run a command (`env`, `command`, `xargs`, ...) are skipped, and `gh`
 * is known by its file name. `gh api` with GitHub's mutation for it,
 * `markPullRequestReadyForReview`, is the same act (`/code-review`).
 */
export function marksReady(command) {
  const parts = [[]];
  const heredocs = [];
  let word = null;
  let quote = "";
  const end = () => {
    if (word !== null) parts.at(-1).push(word);
    word = null;
  };
  const split = () => {
    end();
    parts.push([]);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && command[i + 1] === "\n") i++;
    else if (c === "\\" && i + 1 < command.length) word = (word ?? "") + command[++i];
    else if (c === "#" && word === null) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // A heredoc: its delimiter read now, its body passed over at the new line.
      end();
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      const at = command.slice(j).match(/^(['"]?)([^\s'";&|<>()]+)\1/);
      if (at) {
        heredocs.push({ delimiter: at[2], strip });
        j += at[0].length;
      }
      i = j - 1;
    } else if (c === "\n") {
      split();
      // Each heredoc started on the line ends at its delimiter's own line.
      for (const { delimiter, strip } of heredocs.splice(0)) {
        let next = command.indexOf("\n", i + 1);
        while (true) {
          const line = command.slice(i + 1, next === -1 ? undefined : next);
          i = next === -1 ? command.length : next;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter || next === -1) break;
          next = command.indexOf("\n", i + 1);
        }
      }
    } else if (/\s/.test(c)) end();
    else if (";&|()`".includes(c)) split();
    else word = (word ?? "") + c;
  }
  end();
  const skipped = new Set([
    ...["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"],
    ...["env", "command", "exec", "nohup", "sudo", "xargs"],
  ]);
  return parts.some((words) => {
    const call = words.slice(words.findIndex((w) => !skipped.has(w) && !/^[A-Za-z_]\w*=/.test(w)));
    if (call.length < 3 || call[0].split("/").pop() !== "gh") return false;
    if (call[1] === "api") return call.some((w) => w.includes("markPullRequestReadyForReview"));
    return call[1] === "pr" && call[2] === "ready" && !call.some((w) => /^--undo(=|$)/.test(w));
  });
}

const READY_REFUSED =
  "Marking a pull request ready for review is its owner's step on GitHub (the Ready for review button), never an agent's. `gh pr ready --undo` is allowed.";

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
 * How long after the window closes its deferred start runs: a timer can fire
 * a millisecond early, and a start that still found the plan held would drop it.
 */
const WINDOW_SLACK = 5000;
/** The agent a deferral's timer starts. */
const agentOfDeferral = (file) => (file === "planner" ? "planner" : "executor");

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
 * state names the plan (its `brief`, or one of its `plans`) and whose window
 * on it opened under `ANSWER_WINDOW` before `now`: `{ row, until }`, `until`
 * the time the window closes. The window opens at the plan's question, which
 * the planner's tool hook records per plan (`asked`), so talking does not
 * restart it; before any question it opens when the plan was written
 * (`mtime`), since the planner writes the plan and then asks. Null otherwise.
 */
export function askingIn(plan, live, { stateFor = readState, now = Date.now() } = {}) {
  if (!plan || plan.state !== "ready" || !plan.asks || !live) return null;
  for (const row of live) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null)) continue;
    if (state?.brief !== plan.path && !(state?.plans || []).includes(plan.path)) continue;
    const at = windowOpened(state, plan);
    if (at && now - at < ANSWER_WINDOW) return { row, until: at + ANSWER_WINDOW };
  }
  return null;
}

/** When a plan's window opened: its question, or before any, when the plan was written. */
function windowOpened(state, plan) {
  return state?.asked?.[plan.path] || plan.mtime || 0;
}

/** A plan's modification time, or 0 when it is gone. */
function mtimeOf(path) {
  try {
    return statSync(join(root, path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The plans with `askingIn` set on each, for the callers that have the live rows in hand. */
export function withAsking(plans, live, options = {}) {
  return plans.map((plan) => ({ ...plan, askingIn: askingIn(plan, live, options) }));
}

/**
 * The text an Edit, Write or MultiEdit leaves in a file whose text is
 * `before`; `before` when an edit's old string is not there, since that edit
 * fails and changes nothing.
 */
export function editedText(toolName, toolInput = {}, before = "") {
  if (toolName === "Write") return String(toolInput?.content ?? before);
  const edits =
    toolName === "MultiEdit" ? toolInput?.edits || [] : toolName === "Edit" ? [toolInput] : [];
  let text = before;
  for (const edit of edits) {
    const from = String(edit?.old_string ?? "");
    const to = String(edit?.new_string ?? "");
    if (!from) {
      // An empty old string writes a new file, and only a new one.
      if (text) return before;
      text = to;
      continue;
    }
    if (!text.includes(from)) return before;
    text = edit.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return text;
}

const BUILDING_LINE = /^## Building, [^\n]*/gm;
/** A Building line with its line end, to take it out. */
const BUILDING_WHOLE = /^## Building, [^\n]*\n?/gm;

/** The Building lines `after` has that `before` has not. */
export function buildingAdded(before = "", after = "") {
  const had = new Set(before.match(BUILDING_LINE) || []);
  return (after.match(BUILDING_LINE) || []).filter((line) => !had.has(line));
}

/**
 * **A plan still asking is not taken, even by mistake**
 * (plans/asking-plan-guarded.md): `askingIn` on the plan as it would stand
 * without its Building lines, so the line under judgement does not make it
 * "building" and let itself through. A "Decided" section lets it go, as it
 * does every other hold. `{ row, until }` or null.
 */
export function heldFromBuilding(path, text, live, { mtime = 0, ...options } = {}) {
  const state = stateOf(text.replace(BUILDING_WHOLE, ""), { mtime });
  return state ? askingIn({ path, ...state }, live, options) : null;
}

/** The refusal of a Building line on a plan still asking, its time the one `plans` prints. */
export function stillAskingWords(path, { until }) {
  const at = hhmm(until);
  return `${path} is still asking ${owner()} (its planner's until ${at}): build the other plans first, and come back to it after ${at}, or when ${owner()} says in this chat to build it now. Once he has, write his word in its "Decided" section first: that lets the plan go.`;
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
 * `force` (`plans end`) ends a warm one too. **`immediate` (`plans end <id>
 * --now`) ends any background session of the queue, whatever its state**
 * (plans/end-a-stuck-chat.md): a chat stuck in a turn could never be ended
 * otherwise; the plan or brief it has under way comes back as `on`, for the
 * caller to hand over. `{ end: true, on? }` or `{ end: false, why }`.
 */
export function decideEnd({
  row,
  usage = null,
  on = "",
  now = Date.now(),
  force = false,
  immediate = false,
}) {
  if (!row || row.kind !== "background")
    return { end: false, why: "it is not a background session of the queue" };
  if (immediate) return on ? { end: true, on } : { end: true };
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
  land = "push",
  carry = [],
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
    // **A pull request's checks, in the pull request mode** (`land:
    // pull-request`): the same rule, read off the pull request.
    if (run.pull) {
      const n = run.pull.number;
      return {
        refuse: true,
        runId: run.id,
        reason: `The checks on pull request #${n} (${run.pull.url}) are ${run.status === "completed" ? "failing" : "still running"}. Read them before you stop: \`gh pr checks ${n} --watch --fail-fast\`, then on a failure the job's log (\`gh run view <run id> --log-failed\`, the id from \`gh pr checks ${n} --json link\`), fix it, push the branch, and read the new checks.${run.pull.also?.length ? ` ${run.pull.also.length === 1 ? "Pull request" : "Pull requests"} ${andList(run.pull.also.map((m) => `#${m}`))} ${run.pull.also.length === 1 ? "is" : "are"} not green either.` : ""}${run.pull.run ? ` The ${run.pull.run.workflow || "Actions"} run on your push (${run.pull.run.id}) is ${run.pull.run.status === "completed" ? "failed" : "in progress"} too: \`gh run watch ${run.pull.run.id} --exit-status\`.` : ""} An open pull request is not done until its checks are green.`,
      };
    }
    return {
      refuse: true,
      runId: run.id,
      reason: `The ${run.workflow || "Actions"} run on your push (${run.id}) is ${how}. Read it before you stop: \`gh run watch ${run.id} --exit-status\`, then on a failure the job's log (\`gh api repos/{owner}/{repo}/actions/jobs/<job>/logs\`), fix it, push, and read the new run. A green push is not a deploy until the run says so.`,
    };
  }
  // **A brief for the project a plan came from is written before the stop**
  // (plans/project-follow-ups-reach-the-project.md, part 4), refused once
  // per section, as "The audit's checks" are.
  const owed = carry.find((one) => one.missing && !told.includes(`for:${one.path}:${one.file}`));
  if (owed)
    return {
      refuse: true,
      told: [`for:${owed.path}:${owed.file}`],
      reason: owed.missing === "from" ? fromMissingWords(owed) : briefMissingWords(owed),
    };
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
  const how =
    land === "pull-request"
      ? `each by its Lands line: a fix into the day's fixes pull request, or pushed straight to origin/${branch()} and its run read, a topic's plans on the topic's branch and its pull request when the topic is ready (stacked only on the open pull request it rests on), Building lines, the suites before each plan's push or pull request, one commit per plan`
      : `a new branch off origin/${branch()}, Building lines, the suites once at the end, one commit per plan, the push`;
  return {
    refuse: true,
    told: paths,
    reason: `Plans are waiting and this session can take them: ${fresh.map(annotate).join(", ")}. Build them as a new batch by your agent file: ReadNotifications first, ${how}. If ${owner()} told you to stop after this batch, say so in your final message and stop.`,
  };
}

/** The Stop hook's words when a plan's brief for its project is not in that project's `plans/`. */
export function briefMissingWords({ path, project, file, checkout }) {
  const there = checkout.replace(/\/+$/, "");
  return `${path} leaves work for ${project} (its section "For ${project}: ${file}") and ${there}/${file} is not written. Write the brief there from the section, by your agent file, and start that queue: cd ${there} && plans start --agent planner ${file}, or the message it prints for a live planner; then say so in "Built". A change the plugin leaves for the project it came from goes back as a brief.`;
}

/** The Stop hook's words when a plan's `For` section has no `From` line naming its project. */
export function fromMissingWords({ path, project, file }) {
  return `${path} leaves work for ${project} (its section "For ${project}: ${file}") but names no checkout for it: no From line, or one for another project. Add "From: ${project}, <path>." under the plan's header paragraph when the brief says where it came from, else hand the section to the assistant as a "Needs a decision" item sized assistant, and say so in "Built".`;
}

/**
 * Whether a brief naming `path` is in `checkout`: at `file`, or, when that
 * name is another's, at the first `<topic>-<n>.md` the executor wrote
 * instead. A file of the name that does not name the plan is no brief of
 * its (Codex and /code-review); nothing else is read from the other checkout.
 */
export function briefThere(checkout, file, path, read = (at) => readFileSync(at, "utf8")) {
  const stem = file.replace(/\.md$/, "");
  for (let n = 1; n <= 20; n++) {
    let text;
    try {
      text = read(join(checkout, n === 1 ? file : `${stem}-${n}.md`));
    } catch {
      return false;
    }
    if (text.includes(path)) return true;
  }
  return false;
}

/**
 * **The briefs this session's built plans owe their projects**
 * (plans/project-follow-ups-reach-the-project.md, part 4): one entry per
 * `For` section, `missing` "from" with no `From` line for its project, "file"
 * while no brief naming the plan is in that checkout's `plans/`, else "".
 */
export function carryOf(plans, { read } = {}) {
  return plans.flatMap((plan) =>
    (plan.carries || []).map(({ project, file }) => {
      const from = plan.from && plan.from.project === project ? plan.from : null;
      const checkout = from?.path || "";
      const missing = !from ? "from" : briefThere(checkout, file, plan.path, read) ? "" : "file";
      return { path: plan.path, project, file, checkout, missing };
    }),
  );
}

/** The words after a compaction: hand the plan over at the third, unless it is stuck (the Stop hook says what then). */
export function decideResumed({ compactions = 0, plan = null }) {
  if (compactions < HANDOVER_AT || !plan || plan.stuck) return "";
  return `This session has compacted ${compactions} times inside ${plan.path}. Hand it over: finish the step in hand, commit what is done on the branch (a work commit is fine; the next executor squashes), write a "Handing over, ${today()}" section after the plan's header paragraph (its "Short plan" or "Plan only" lines, not between the title and the header) whose first line is "Step in hand: <n>" in the plan's "Building it" numbering (then the branch, the steps done, the step in progress and what failed in it, what is left, the specs run and their counts), take out the Building line, and stop. The hook starts a fresh executor on it.`;
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
  unwatched = false,
  open = [],
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
  // **An assistant chat is started only when none is open**
  // (plans/project-follow-ups-reach-the-project.md, part 6): this project's,
  // the owner's or the queue's, idle or busy, is sent the message instead,
  // and an assistant is never replaced.
  if (kind === "assistant") {
    if (open.length)
      return {
        refuse: true,
        why: `${open[0]} is open: send it the message instead. ${followUpsMessage(brief)}`,
      };
    sessions = [];
  }
  // **Any live, unretired session of the kind refuses a start, lock or not**
  // (plans/queue-counts-any-executor.md, plans/planner-queue.md). The lock
  // below is an executor's only evidence when the sessions cannot be read.
  // **A stale session does not block its successor** (cache-aware queue):
  // one whose context is over the reuse ceiling, or cold, is replaced when
  // idle; a busy planner so is left to finish, and a fresh one starts beside
  // it. A busy executor, or any session still worth reusing, refuses as before.
  // A session with a plan or a brief under way (its Building or Planning
  // line) is never stale: replacing it would orphan that work.
  // **A start nobody is watching** (`unwatched`, a timer's) replaces an idle
  // executor whatever its warmth: no command can message a session, so the
  // plans it is started for would otherwise wait on a chat nobody prompts.
  const idle = (one) => /^idle\b/.test(one.status || "");
  const stale = (one) =>
    one.on
      ? { reuse: true }
      : unwatched && idle(one)
        ? {
            reuse: false,
            why: "idle while a plan's thirty minutes ran out, and the queue cannot message it",
          }
        : mayReuse({ usage: one.usage, now, ceiling });
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
      why: `The last ${kind} (${last.name}) ended within ten minutes with nothing ${{ planner: "planned", assistant: "written" }[kind] || "built"}, and usage was not the cause; starting another would repeat it. ${owner()} decides.`,
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

/**
 * The hook's Handing over section for a session the usage limit cut off, the
 * plan's Building line taken out. **It goes after the header paragraph**, as
 * the executor's does (plans/handed-plan-stays-in-queue.md), wherever the
 * Building line was; with no header found, in the Building line's place.
 */
export function cutoffEdit(text, { sessionId, branch, day = today() }) {
  return handOverEdit(
    text,
    `## Handing over, ${day}, by the hook\n\nStep in hand: unknown, the usage limit cut session ${sessionId} off on branch \`${branch}\`. Read the branch's commits and the task list's state in the final messages above.\n`,
  );
}

/**
 * What `plans end <id> --now` writes into the plan or brief the ended session
 * had under way (plans/end-a-stuck-chat.md), so the queue resumes it: a plan
 * gets a Handing over section in place of its Building line and reads
 * `handed`; a brief only loses its Planning line and is a brief again, since
 * a Handing over line would read as an executor's taking (`planTaken`).
 * Text with no such line of the session's is returned as it is.
 */
export function endedEdit(text, { sessionId, by, branch = "", day = today() }) {
  const planning = new RegExp(
    `^## Planning, [^\\n]*session ${sessionId}[^\\n]*(?:\\n[ \\t]*(?=\\n))?\\n?`,
    "m",
  );
  if (planning.test(text)) return text.replace(planning, "");
  if (!new RegExp(`^## Building, [^\\n]*session ${sessionId}`, "m").test(text)) return text;
  const where = branch ? ` on branch \`${branch}\`` : "";
  return handOverEdit(
    text,
    `## Handing over, ${day}, ended by ${by}\n\nStep in hand: unknown, ${by} ended session ${sessionId} with \`plans end --now\`${where} in the middle of its work. Read the branch's commits for what it did.\n`,
  );
}

/**
 * A hand-over `section` in place of the Building line. **It goes after the
 * header paragraph**, as the executor's does
 * (plans/handed-plan-stays-in-queue.md), wherever the Building line was; with
 * no header found, in its place.
 */
function handOverEdit(text, section) {
  const building = /^## Building, [^\n]*(?:\n[ \t]*(?=\n))?\n?/m;
  const lines = text.replace(building, "").split("\n");
  const header = lines.findIndex((line) => PLAN_HEADER.test(line));
  if (header < 0) {
    if (building.test(text)) return text.replace(building, `${section}\n`);
    return `${text.replace(/\n*$/, "\n\n")}${section}`;
  }
  // The header paragraph ends at a blank line, or at a heading written straight under it.
  const at = lines.findIndex((line, i) => i > header && (line.trim() === "" || /^## /.test(line)));
  if (at < 0) lines.push("", section);
  else if (lines[at].trim() === "") lines.splice(at + 1, 0, section);
  else lines.splice(at, 0, "", section);
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

/**
 * The executor's message to an assistant chat on a built plan's follow-ups
 * (`executor.md`, "After"), which a start beside an open chat prints.
 */
export function followUpsMessage(path) {
  return `Follow-ups ready: ${path}, "Built", "Needs a decision", the items marked assistant and planner. Write a short plan for the assistant items and a brief for the planner items, then tick the to-do item.`;
}

/**
 * What an assistant chat the queue starts is told
 * (plans/project-follow-ups-reach-the-project.md, part 6): the plan whose
 * "Built" holds the items, and its agent file's way through them.
 */
export function assistantPrompt(path) {
  return `Follow-ups ready: ${path}, "Built", "Needs a decision", the items marked assistant and planner. Read the plan whole, write a short plan for the assistant items and a brief for the planner items, hand each on by your agent file, and end this chat by "The final message". ${owner()} reads this chat in Remote Control.`;
}

/**
 * The newest brief or waiting plan: what an assistant writes, its progress
 * for the quick-death rule. A built plan is not one: the executor writes its
 * "Built" just before it starts an assistant (/code-review).
 */
function writtenAt(plans) {
  return Math.max(
    0,
    ...plans
      .filter((plan) => ["brief", "planning", "ready"].includes(plan.state))
      .map((plan) => plan.mtime || 0),
  );
}

/**
 * This project's assistant chats open on this machine, by name: the owner's
 * `<Project> Assistant` and the queue's numbered ones, any state, never a
 * Remote Control row, which is another machine's chat.
 */
function openAssistants(rows, project) {
  return (rows || [])
    .filter((row) => !/remote/i.test(row.kind || ""))
    .map((row) => row.name || "")
    .filter((name) => {
      const parsed = parseName(name);
      return (
        name === `${project} Assistant` ||
        (parsed?.kind === "assistant" && parsed.project === project)
      );
    });
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
 * **Nor the plugins' `bin` folders on its PATH**: Claude Code adds each
 * enabled plugin's after the PATH it inherits, so a chat started from one
 * that began on an older version ran that version's `plans` first, and its
 * start never cleared the asking deferral, which it did not know
 * (plans/research-order-and-asking-cleared.md).
 */
export function sessionEnv(env = process.env) {
  const {
    WORKFLOW_ROOT: _root,
    CLAUDE_PROJECT_DIR: _project,
    CLAUDE_PLUGIN_ROOT: _pluginRoot,
    CLAUDE_PLUGIN_DATA: _pluginData,
    CLAUDE_SESSION_ID: _session,
    WORKFLOW_STARTED: _started,
    ...rest
  } = env;
  if (rest.PATH)
    rest.PATH = rest.PATH.split(delimiter)
      .filter((dir) => !PLUGIN_BIN.test(dir))
      .join(delimiter);
  return rest;
}

/** A plugin's `bin` folder in Claude Code's cache: `<plugins>/cache/<marketplace>/<plugin>/<version>/bin`. */
const PLUGIN_BIN = /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]bin[\\/]?$/;

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
      // An assistant chat is marked as the queue's, for its own Stop hook.
      env: { ...sessionEnv(), ...(kind === "assistant" ? { WORKFLOW_STARTED: "assistant" } : {}) },
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
 * Ends the tmux server a session's subagents run in
 * (`tmux -L claude-swarm-<pid>`), which `claude stop` leaves running; a
 * missing one is no fault. The tests' log records it instead.
 */
function endSwarm(pid) {
  if (!pid) return;
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `tmux claude-swarm-${pid}\n`);
    return;
  }
  try {
    execFileSync("tmux", ["-L", `claude-swarm-${pid}`, "kill-server"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // No swarm, or no tmux: nothing of the session's is left there.
  }
}

/**
 * **Ends one session by the rule** (`decideEnd`), from the live rows, its
 * state, the plans and its transcript: `claude stop` on an end, its subagents'
 * tmux server ended, the state's timer cleared. `immediate` ends it whatever
 * it is doing, its plan or brief under way handed over first. One line either
 * way: `Ended <name> [<8 hex>]: done, <usage>.` or `Not ended: <name> [<8
 * hex>], <why>.`; `ended` says which.
 */
export function endSession(
  sessionId,
  { force = false, immediate = false, live = liveSessions({ fresh: true }) } = {},
) {
  const row = live?.find((r) => r.sessionId === sessionId) || null;
  const state = readState(sessionId);
  const who = `${row?.name || String(sessionId).slice(0, 8)} [${String(sessionId).slice(0, 8)}]`;
  if (!row) return { ended: false, line: `Not ended: ${who}, it is no live session.` };
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const plan = plans.find(
    (one) => (one.state === "building" || one.state === "planning") && one.session === sessionId,
  );
  const on = plan?.path || "";
  const usage = sessionUsage(transcriptOf(row));
  const verdict = decideEnd({ row, usage, on, force, immediate });
  if (!verdict.end) return { ended: false, line: `Not ended: ${who}, ${verdict.why}.` };
  // A failed stop keeps the timer, and says so.
  if (!stopNow(row.id || sessionId))
    return { ended: false, line: `Not ended: ${who}, claude stop failed.` };
  endSwarm(row.pid);
  killTimer(state.end?.pid, sessionId);
  clearEnd(sessionId, null);
  const words = [row.state, usageWords({ usage, ceiling: proj().reuse })].filter(Boolean);
  const line = `Ended ${who}: ${words.join(", ")}.`;
  if (!verdict.on || !plan) return { ended: true, line };
  // **The plan under way is handed over once its session is stopped**, read
  // again so nothing it wrote while stopping is lost, and the queue resumes it
  // now: the lock released, a fresh executor or planner started in its place.
  release(sessionId);
  let text = plan.text;
  try {
    text = readFileSync(plan.file, "utf8");
  } catch {
    // Gone: nothing to hand over.
    return { ended: true, line };
  }
  writeFileSync(plan.file, endedEdit(text, { sessionId, by: owner(), branch: branchOf(row.cwd) }));
  const agent = plan.state === "planning" ? "planner" : "executor";
  const started = start([plan.path], { replace: sessionId, agent });
  return { ended: true, line: `${line} ${plan.path} is handed over.\n${started}` };
}

/**
 * **`plans end [id...] [--now]`**: this queue's finished chats now, warm or
 * not (`force`), or the ones named, by session id, background id or the eight
 * hex `plans` prints. `immediate` (`--now`) ends the named ones whatever they
 * are doing, and only named ones. One line per session.
 */
export function endCommand(ids = [], { immediate = false } = {}) {
  if (immediate && !ids.length)
    return "Not ended: name the chat to end now (plans end <id> --now); plans lists them.";
  const live = liveSessions({ fresh: true });
  if (!live) return "claude agents could not be read, so nothing is ended.";
  const lock = readJson(files.lock());
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const ours = ["executor", "planner", "assistant"].flatMap((kind) =>
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
    lines.push(endSession(sessionId, { force: true, immediate, live }).line);
  // Each line above says why a session was not ended; with none alive, this says so.
  if (!ids.length && !targets.length)
    lines.push("Nothing to end: no finished chat of this queue is alive.");
  return lines.join("\n");
}

/**
 * Takes `paths` out of a deferral, and the file when none is left. Its
 * timer stays: firing, it starts only what is still waiting. **A plan leaves
 * the asking deferral once it is decided or taken** ("Asked once"): the
 * planner's write of its "Decided", an executor's Building line and a start
 * each call this.
 */
function dropDeferred(file, paths) {
  const deferred = readJson(files.deferred(file));
  if (!deferred) return;
  const rest = (deferred.paths || []).filter((path) => !paths.includes(path));
  if (rest.length === (deferred.paths || []).length) return;
  if (rest.length) writeJson(files.deferred(file), { ...deferred, paths: rest });
  else
    try {
      unlinkSync(files.deferred(file));
    } catch {
      // Gone already.
    }
}

/**
 * Defers a start to `until` (ms): one timer per deferral file (`file`, the
 * agent's by default, or `asking` for the window's), the deferral written
 * where `plans` shows it. **Paused, the deferral is held**: the file is
 * written with no timer (`pid: null`), and `resume` re-arms it.
 */
function defer(until, why, paths, replace = "", agent = "executor", file = agent) {
  const old = readJson(files.deferred(file));
  if (old?.pid) {
    try {
      process.kill(old.pid);
    } catch {
      // The old timer is gone already.
    }
  }
  // One timer for every deferred plan, at the later time, so a new
  // deferral never drops a pending one; and never in the past, so a timer
  // cannot fire straight into another deferral. The window's is at the
  // earlier time: its start re-arms the plans still held, each at its own.
  const all = [...new Set([...(old?.paths || []), ...paths])];
  const when =
    file === "asking"
      ? Math.max(Math.min(until, old?.until || Infinity), Date.now() + MINUTE)
      : Math.max(until, old?.until || 0, Date.now() + MINUTE);
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
          ...(file === agent ? [] : ["--deferral", file]),
          ...all,
        ],
        { ...process.env, WORKFLOW_ROOT: root },
      );
  writeJson(files.deferred(file), { until: when, why, paths: all, pid, replace: stop });
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
  // One that does not sync still ignores the queue's files, so the
  // executor it starts finds the checkout clean.
  const synced = options.dry
    ? ""
    : options.timer || options.at > Date.now()
      ? ignoreQueueFiles(primaryCheckout())
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

/** `plans start`'s refusal of a dropped plan's path. */
export function droppedWords(plan) {
  return `${plan.path} is dropped${plan.droppedDay ? ` (${plan.droppedDay})` : ""}: nothing to build.`;
}

function startHere(
  paths,
  { replace = "", dry = false, agent = "executor", at = 0, timer = false, deferral = "" } = {},
) {
  if (!proj().found) return NO_PROJECT;
  // A path as the queue writes it, so `./plans/x.md` or an absolute one is
  // judged as `plans/x.md` (Codex, 30 October).
  paths = paths.map((path) => {
    const inside = relative(root, resolve(root, path));
    return inside && !inside.startsWith("..") && !isAbsolute(inside)
      ? inside.split(sep).join("/")
      : path;
  });
  const live = liveSessions();
  // **Asked once**: a plan whose planner is asking the owner is that chat's
  // for thirty minutes, neither taken by default nor accepted by path.
  const plans = withAsking(readPlans(join(root, "plans"), liveIds(live)), live);
  const kind = agent === "planner" || agent === "assistant" ? agent : "executor";
  // **A planner takes one brief, the oldest** (plans/planner-queue.md); an
  // executor every plan waiting.
  if (!paths.length && kind === "assistant")
    return "A built plan's path is needed: plans start --agent assistant plans/<x>.md; plans shows the built plans.";
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
    // **A dropped plan is nobody's to build** (plans/dropped-plan-state.md):
    // named by path it is refused whole, with nothing started; a timer drops it below.
    const dropped = plans.filter((p) => p.state === "dropped" && paths.includes(p.path));
    if (dropped.length && !timer) return dropped.map(droppedWords).join("\n");
    const held = plans.filter((p) => p.askingIn && paths.includes(p.path));
    // Refused whole, so nothing is half started; a deferred start, which
    // nobody is watching, starts the rest and leaves the held ones to the queue.
    if (held.length && !timer) return held.map(askingWords).join("\n");
    paths = paths.filter((path) => !held.some((p) => p.path === path));
    // A timer's held plans, asked again since it was armed, get the window's
    // deferral back at the earliest of their windows.
    if (timer && held.length && !dry)
      defer(
        Math.min(...held.map((p) => p.askingIn.until)) + WINDOW_SLACK,
        `${owner()} has thirty minutes to answer`,
        held.map((p) => p.path),
        "",
        "executor",
        "asking",
      );
    if (!paths.length) return held.map(askingWords).join("\n");
    // **A timer's start takes only what is still waiting**: a plan being
    // built or built since the timer was armed, or gone, is dropped, and with
    // none left nothing starts. A plan answered and still waiting is started.
    if (timer) {
      paths = paths.filter((path) =>
        plans.some((p) => p.path === path && ["ready", "handed", "old"].includes(p.state)),
      );
      if (!paths.length) return "Nothing is waiting in the queue.";
    }
  }
  if (kind === "planner") {
    // A planner is started on one brief, waiting or left by a session that is gone.
    const asked = paths[0];
    if (!plans.some((p) => p.path === asked && p.state === "brief"))
      return `${asked} is not a brief waiting for a planner; plans shows the briefs.`;
    paths = [asked];
  }
  if (kind === "assistant") {
    // An assistant is started on one built plan, whose "Built" holds the items.
    const asked = paths[0];
    if (!plans.some((p) => p.path === asked && p.state === "built"))
      return `${asked} is not a built plan with follow-ups; plans shows the built plans.`;
    paths = [asked];
  }
  const paused = pausedSince();
  // Paused, the deferral is held (no timer), so the resume re-arms it.
  if (at && at > Date.now())
    return defer(at, `the usage limit cut the last ${kind} off`, paths, replace, kind);
  const probe = !["executor", "planner", "assistant"].includes(agent);
  const decision = probe
    ? { start: true, name: `Probe ${Date.now() % 1000}`, note: "" }
    : canStart({
        kind,
        lock: readJson(files.lock()),
        alive: () => holderAlive(readJson(files.lock()), live),
        log: readLog(),
        progressAt:
          kind === "planner"
            ? plannedAt(plans)
            : kind === "assistant"
              ? writtenAt(plans)
              : progressAt(plans),
        paused,
        usage: readJson(files.usage()),
        // The session being replaced and retired ones do not block their successor.
        sessions:
          kind === "assistant"
            ? []
            : sessionsOf(kind, live, readJson(files.lock()), {
                plans,
                ceiling: proj().reuse,
              }).filter((one) => one.sessionId !== replace && !one.retired),
        brief: kind === "executor" ? "" : paths[0],
        // This checkout's chats only: one in another checkout reads another queue (Codex).
        open: kind === "assistant" ? openAssistants(live, proj().name) : [],
        name: proj().name,
        ceiling: proj().reuse,
        taken: liveNames(),
        machine: machine().name,
        // Only the window's timer: a usage limit's restart refuses beside a live executor as before.
        unwatched: timer && deferral === "asking",
      });
  if (decision.refuse) return decision.why;
  // An assistant is never deferred: its items wait in the plan for the next start.
  if (decision.defer && kind === "assistant")
    return `No assistant chat was started: ${decision.why}.`;
  // The window's start, deferred by usage, stays the window's, so at the reset
  // it still replaces an idle executor.
  if (decision.defer)
    return defer(
      decision.until,
      decision.why,
      paths,
      replace,
      kind,
      deferral === "asking" ? "asking" : kind,
    );
  const prompt = probe
    ? "Reply with the single word ok"
    : kind === "planner"
      ? plannerPrompt(paths[0])
      : kind === "assistant"
        ? assistantPrompt(paths[0])
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
  // The deferrals keep the paths this start did not take, and their timers.
  for (const file of { executor: ["executor", "asking"], planner: ["planner"] }[kind] || [])
    dropDeferred(file, paths);
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

/**
 * The pull requests' states, by number, in lower case (`draft`, `open`,
 * `merged`, `closed`), from one `gh pr list --state all`; null when `gh`
 * cannot be read. An open draft is `draft`: it waits on its owner's review
 * (plans/owner-reviews-before-anyone-else.md).
 */
function pullStates() {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,isDraft"],
      { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Map(
      JSON.parse(out).map((pull) => [
        pull.number,
        pull.state === "OPEN" && pull.isDraft === true ? "draft" : String(pull.state).toLowerCase(),
      ]),
    );
  } catch {
    return null;
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

/** The primary checkout, the one the hooks run from, even from inside a worktree; else the root. */
function primaryCheckout() {
  try {
    const first = git(["worktree", "list", "--porcelain"])
      .split("\n")
      .find((line) => line.startsWith("worktree "));
    if (first) return first.slice(9);
  } catch {
    // Not a repository's worktree list: the root it was given.
  }
  return root;
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
  const cwd = primaryCheckout();
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
  // A kind of queue file new since the project was set up is ignored
  // before the checkout is called clean; not in a repository the queue is not in.
  const added = proj().found ? ignoreQueueFiles(cwd) : "";
  if (added) note += `${added} `;
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

/**
 * The table `plans` prints. `related: false` from the hooks, so a prompt
 * reads nothing from the network; `readers`, what `relatedReaders` returns,
 * for the tests.
 */
export function list({ all = false, live, related = true, readers = null } = {}) {
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
  // **The assistant line**, only while a chat the queue started is alive
  // (plans/project-follow-ups-reach-the-project.md, part 6).
  const assistants = live
    ? sessionsOf("assistant", live, lock, { trees, plans, ceiling: proj().reuse })
    : [];
  if (assistants.length) out.push(sessionsLine("assistant", assistants));
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
  for (const kind of QUEUE_KINDS) {
    const deferred = readJson(files.deferred(kind));
    if (deferred)
      out.push(
        `Deferred until ${new Date(deferred.until).toTimeString().slice(0, 5)}: ${deferred.why ? `${deferred.why}; ` : ""}${deferred.paths.join(", ")}${deferred.pid ? "" : ", held while the queue is paused"}`,
      );
  }
  const width = Math.max(40, ...plans.map((p) => p.path.length + 2));
  const row = (path, rest) => `  ${path.padEnd(width)} ${rest}`;
  // **What each brief and ready plan looks related to**, in the pull request
  // mode (plans/collaborating-when-claude-writes-the-code.md, part 2): read
  // once, and only when such a row exists, as `pullStates` is.
  const byPull = proj().land === "pull-request";
  const briefRows = plans.filter((p) => p.state === "brief" || p.state === "planning");
  const readyRows = plans.filter(
    (p) => (p.state === "ready" || p.state === "handed") && !p.askingIn,
  );
  const readRelated = byPull && related && (briefRows.length || readyRows.length);
  const work = readRelated ? readers || relatedReaders() : null;
  let unreadSaid = false;
  // Two spaces past the path's column; the line that `gh` was not read, once.
  const own = work ? ownOf(plans) : null;
  const relatedUnder = (plan) => {
    if (!work) return [];
    // A ready plan's own topic: its Lands line's, or its file name's.
    const topic =
      plan.state === "brief" || plan.state === "planning"
        ? ""
        : plan.lands?.kind === "fix"
          ? ""
          : plan.lands?.name || basename(plan.path, ".md");
    const lines = relatedLines(plan.text, plans, work, { topic, own });
    if (!work.pulls && !unreadSaid) {
      unreadSaid = true;
      lines.unshift("related work not read (gh)");
    }
    return lines.map((line) => `    ${line}`);
  };
  const group = (title, items, rest, under = () => []) => {
    if (!items.length) return;
    out.push("", title);
    for (const plan of items) out.push(row(plan.path, rest(plan)), ...under(plan));
  };
  group(
    "Building",
    plans.filter((p) => p.state === "building"),
    (p) => `${nameOf(p.session)}, since ${p.since}`,
  );
  group(
    "Briefs, oldest first",
    briefRows,
    (p) =>
      p.state === "planning"
        ? `${nameOf(p.session)}, since ${p.since}`
        : [
            `brief${p.day ? `, ${p.day.replace(/ \d{4}$/, "")}` : ""}`,
            p.stale ? "(a Planning line from a session that is gone)" : "",
          ]
            .filter(Boolean)
            .join(" "),
    relatedUnder,
  );
  // **Asked once**: a plan its planner is asking about, with the chat to
  // answer in and the time the executor takes over.
  group(
    `Asking ${owner()}, oldest first`,
    plans.filter((p) => p.askingIn),
    (p) =>
      `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}, in ${p.askingIn.row.name || "a planner"} [${String(p.askingIn.row.sessionId).slice(0, 8)}], ${statusOf(p.askingIn.row)}, the executor decides at ${hhmm(p.askingIn.until)}`,
  );
  // **Where each lands**, in the pull request mode, before the build, and
  // what its author marked it related to.
  group(
    "Ready, oldest first",
    readyRows,
    (p) =>
      [
        `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}`,
        // A plan with no Lands line is a topic of its own, ready.
        byPull
          ? landsWords(p.lands || { kind: "topic", name: basename(p.path, ".md"), ready: true })
          : "",
        byPull && p.relatedTo ? `related: ${relatedWords(p.relatedTo)}` : "",
        p.state === "handed" ? "handed over, resume" : "",
        p.asks ? "unanswered, the executor decides" : "",
        p.stuck ? `stuck, asks ${owner()}` : "",
        p.stale ? "(a Building line from a session that is gone)" : "",
      ]
        .filter(Boolean)
        .join(", "),
    relatedUnder,
  );
  const built = plans.filter((p) => p.state === "built");
  const shown = all ? built : built.filter((p) => p.builtDay.startsWith(today(now)));
  // A plan landed by pull request is listed by it, its state from one `gh`
  // call, made only when a row names one.
  const states = shown.some((p) => p.pr) ? pullStates() : null;
  group(all ? "Built" : "Built today", shown, (p) =>
    p.pr
      ? [`#${p.pr}`, states?.get(p.pr)].filter(Boolean).join(", ")
      : p.topic
        ? `topic ${p.topic}, waiting`
        : [p.sha, onWhere(p.sha), p.fix ? "a fix" : ""].filter(Boolean).join(", "),
  );
  // **A dropped plan is on screen only on its day** (plans/dropped-plan-
  // state.md), with its date and its why; every one with `--all`.
  const dropped = plans.filter((p) => p.state === "dropped");
  group(
    all ? "Dropped" : "Dropped today",
    // By the calendar day, so a drop dated 2026-10-30 is today's too (Codex).
    all ? dropped : dropped.filter((p) => parseDay(p.droppedDay) === parseDay(today(now))),
    (p) =>
      `dropped${p.droppedDay ? `, ${p.droppedDay.replace(/ \d{4}$/, "")}` : ""}${p.why ? `: ${p.why}` : ""}`,
  );
  // **The topics built and waiting for their pull request**, oldest first:
  // a topic none of whose built plans names one yet.
  // The ready plan's Built names the pull request, not the topic: its
  // `Lands` line does (/code-review).
  const opened = new Set(
    built.filter((p) => p.pr).flatMap((p) => [p.topic, p.lands?.name].filter(Boolean)),
  );
  const topics = new Map();
  for (const p of built)
    if (p.topic && !p.pr && !opened.has(p.topic))
      topics.set(p.topic, [...(topics.get(p.topic) || []), p.path]);
  if (topics.size)
    out.push(
      "",
      "Topics waiting for a pull request",
      ...[...topics].map(([name, paths]) => `  ${name}: ${paths.join(", ")}`),
    );
  const old = plans.filter((p) => p.state === "old").length;
  if (old)
    out.push(
      "",
      `Older, by path only: ${old} plan${old === 1 ? "" : "s"} dated before 24 October with no Built`,
    );
  const unread = unreadPlans();
  if (unread.headless.length || unread.failed.length) out.push("");
  if (unread.headless.length)
    out.push(`Not read by the queue (no header found): ${unread.headless.join(", ")}`);
  if (unread.failed.length)
    out.push(`Not read by the queue (the file could not be read): ${unread.failed.join(", ")}`);
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

/**
 * The project's run on its branch (`run` in the project file); null with
 * none, or unread. With `only`, the commits a fix pushed straight landed
 * (their Built lines' eight-hex shas): null unless HEAD is one of them, so
 * the pull request mode never answers for a run another person's merge set off.
 */
function imageRun({ only = null } = {}) {
  const workflow = proj().run;
  if (!workflow) return null;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (only && !only.some((sha) => head.startsWith(sha))) return null;
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

/**
 * **The pull requests' checks, then the run of a fix pushed straight**, as
 * one answer for `decideStop`: the pull request is named first, and a run
 * not green on HEAD rides along in its words and its id, so the loop guard
 * does not let a continued stop pass a run never named (/code-review).
 */
export function pullThenRun(pull, run) {
  const green = (r) => r.status === "completed" && r.conclusion === "success";
  if (!pull) return run;
  if (!run || !run.onHead || green(run)) return pull;
  return { ...pull, id: `${pull.id},run ${run.id}`, pull: { ...pull.pull, run } };
}

/** A check run's conclusions that make a pull request's checks red. */
const RED_CONCLUSIONS = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
];

/**
 * **The verdict on a pull request's checks**, from `gh pr list --json
 * statusCheckRollup`: "red" when a check run concluded in failure (any of
 * `RED_CONCLUSIONS`) or a status context's state is FAILURE or ERROR,
 * "running" when a check run is not COMPLETED or a context is PENDING or
 * EXPECTED, else "green", an empty rollup included: a project with no checks
 * has nothing to wait for. Red beats running.
 */
export function checksVerdict(rollup = []) {
  let running = false;
  for (const check of rollup || []) {
    if (!check) continue;
    const context =
      check.__typename === "StatusContext" || (!("status" in check) && "state" in check);
    if (context) {
      const state = String(check.state || "").toUpperCase();
      if (state === "FAILURE" || state === "ERROR") return "red";
      if (state === "PENDING" || state === "EXPECTED") running = true;
      continue;
    }
    if (RED_CONCLUSIONS.includes(String(check.conclusion || "").toUpperCase())) return "red";
    if (String(check.status || "").toUpperCase() !== "COMPLETED") running = true;
  }
  return running ? "running" : "green";
}

/**
 * **The checks on this checkout's pull requests** (`land: pull-request`): the
 * open pull requests whose head branch is a local branch here at the same
 * commit, from one `gh pr list`; the first whose checks are not green, in the
 * run's shape (`id` its number and commit, so a push is asked about again),
 * for `decideStop`. Null when all are green, none is this checkout's, or `gh`
 * cannot be read.
 */
function pullChecks() {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        // Past fifty, so a busy repository's own pull request is still read.
        "--limit",
        "200",
        "--json",
        "number,url,headRefName,headRefOid,statusCheckRollup",
      ],
      { cwd: root, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
    );
    // The local branches at their commits, in one call; a pull request whose
    // head is none of them is another person's.
    const local = new Map(
      git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], {
        timeout: 4000,
      })
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
    );
    const open = JSON.parse(out)
      .filter((pull) => local.get(pull.headRefName) === pull.headRefOid)
      .map((pull) => ({ ...pull, verdict: checksVerdict(pull.statusCheckRollup) }))
      .filter((pull) => pull.verdict !== "green");
    if (!open.length) return null;
    const [first, ...rest] = open;
    return {
      // Every pull request not green is in the id, so the loop guard lets a
      // continued stop pass only once all of them were named.
      id: open.map((pull) => `${pull.number}@${pull.headRefOid}`).join(","),
      status: first.verdict === "red" ? "completed" : "in_progress",
      conclusion: first.verdict === "red" ? "failure" : null,
      onHead: true,
      pull: { number: first.number, url: first.url, also: rest.map((pull) => pull.number) },
    };
  } catch {
    process.stderr.write("plan-queue: the pull requests' checks could not be read (gh)\n");
    return null;
  }
}

/** Related work names three at most, as GitHub's duplicate detection suggests three. */
const RELATED_MAX = 3;
/** A pushed branch is read when its tip is under thirty days old, twenty at most. */
const BRANCH_DAYS = 30;
const BRANCHES_MAX = 20;

/**
 * **What a brief or a plan looks related to** (plans/collaborating-when-
 * claude-writes-the-code.md, part 2): the open pull requests (`pulls`,
 * `{number, title, author, headRefName, files}`) and the pushed branches with
 * none (`branches`, `{name, author, title, files}`) whose changed files
 * include a path in `paths`, the test Gerrit's `conflicts:` makes. A path
 * named matches a changed file equal to it or ending with `/<path>`, since a
 * brief names `scripts/x.mjs` where the repository has
 * `plugins/workflow/scripts/x.mjs`. The most files in common first, a pull
 * request before a branch at the same count, three at most; `own` maps a pull
 * request's number, or a branch or topic name, to the plan of this queue that
 * holds it. Pure, so a project's own hook can copy it.
 */
export function relatedWork(paths = [], { pulls = [], branches = [], own = new Map() } = {}) {
  const common = (files = []) =>
    files.filter((file) => paths.some((path) => file === path || file.endsWith(`/${path}`)));
  const found = [
    ...(pulls || []).map((pull) => ({
      kind: "pull",
      number: pull.number,
      title: pull.title || "",
      author: pull.author || "",
      files: common(pull.files),
      own: own.get(pull.number) || own.get(pull.headRefName) || "",
    })),
    ...(branches || []).map((one) => ({
      kind: "branch",
      name: one.name,
      title: one.title || "",
      author: one.author || "",
      files: common(one.files),
      own: own.get(one.name) || "",
    })),
  ].filter((one) => one.files.length);
  // A stable sort: input order within a count and a kind.
  return found
    .sort(
      (a, b) =>
        b.files.length - a.files.length || Number(a.kind !== "pull") - Number(b.kind !== "pull"),
    )
    .slice(0, RELATED_MAX);
}

/**
 * **This queue's pull requests and topics**, from the plans read already: a
 * built plan's pull request and its topic, and a ready, handed or building
 * plan's topic, each to the plan's path.
 */
export function ownOf(plans = []) {
  const own = new Map();
  for (const plan of plans) {
    if (plan.state === "built") {
      if (plan.pr) own.set(plan.pr, plan.path);
      for (const name of [plan.topic, plan.lands?.name]) if (name) own.set(name, plan.path);
    } else if (["ready", "handed", "building"].includes(plan.state) && plan.lands?.name) {
      own.set(plan.lands.name, plan.path);
    }
  }
  return own;
}

/** The time left before `deadline`, as a child's timeout: at most `most`, at least 1 ms. */
const left = (deadline, most) => Math.max(1, Math.min(most, deadline - Date.now()));

/**
 * **The open pull requests with their files**, from one `gh pr list`; null
 * when `gh` cannot be read. GitHub lists up to a hundred files per pull
 * request, enough for a file in common.
 */
export function openPulls({ run = execFileSync, timeout = 10_000 } = {}) {
  try {
    const out = run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,author,headRefName,files",
      ],
      { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out).map((pull) => ({
      number: pull.number,
      title: pull.title || "",
      author: pull.author?.login || "",
      headRefName: pull.headRefName || "",
      files: (pull.files || []).map((file) => file.path).filter(Boolean),
    }));
  } catch {
    return null;
  }
}

/**
 * **The merged pull requests' heads**, each branch name to the commit it was
 * merged at, from one `gh pr list --state merged`: a branch squash-merged and
 * not deleted still has files past the branch (/code-review, 30 October), so
 * one whose tip is still that commit is no open work. Empty when unread.
 */
export function mergedHeads({ run = execFileSync, timeout = 10_000 } = {}) {
  try {
    const out = run(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "100", "--json", "headRefName,headRefOid"],
      { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Map(JSON.parse(out).map((pull) => [pull.headRefName, pull.headRefOid]));
  } catch {
    return new Map();
  }
}

/**
 * **The pushed branches with no open pull request**, with the files each
 * changes past the project's branch: a fetch first (remote-tracking refs
 * only; on a failure, what was fetched already), left out with `fetch:
 * false`, then the remote branches but `HEAD`, the project's branch, `main`,
 * the open pull requests' heads (`heads`) and a merged pull request's head
 * still at the commit it was merged at (`merged`), whose tip is under thirty
 * days old, twenty at most, newest first. A branch with no file past the
 * branch (merged and not deleted) is dropped. Nothing is read past
 * `deadline`, and what was read by then is the answer. `run` is `git(args,
 * options)`, a seam for the tests.
 */
export function pushedBranches({
  run = git,
  base = branch(),
  heads = [],
  merged = new Map(),
  now = Date.now(),
  fetch = true,
  fetchTimeout = 8000,
  deadline = Infinity,
} = {}) {
  if (fetch) {
    try {
      run(["fetch", "--prune", "--quiet", "origin"], { timeout: left(deadline, fetchTimeout) });
    } catch {
      // Offline, or no origin: what was fetched already.
    }
  }
  let refs = "";
  try {
    if (Date.now() >= deadline) return [];
    refs = run(
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(authorname)%09%(subject)",
        "refs/remotes/origin",
      ],
      { timeout: left(deadline, 4000) },
    );
  } catch {
    return [];
  }
  const skip = new Set(["HEAD", base, "main", ...heads]);
  const since = now / 1000 - BRANCH_DAYS * 24 * 60 * 60;
  const candidates = String(refs)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", at = "0", author = "", ...subject] = line.split("\t");
      return { ref, sha, at: Number(at), author, title: subject.join("\t") };
    })
    // `origin/HEAD` reads as `origin` in its short form.
    .filter((one) => one.ref.startsWith("origin/"))
    .map((one) => ({ ...one, name: one.ref.slice("origin/".length) }))
    .filter(
      (one) =>
        !skip.has(one.name) && one.at > since && !(one.sha && merged.get(one.name) === one.sha),
    )
    .slice(0, BRANCHES_MAX);
  const out = [];
  for (const one of candidates) {
    if (Date.now() >= deadline) break;
    let files = [];
    try {
      files = String(
        run(["diff", "--name-only", `origin/${base}...origin/${one.name}`], {
          timeout: left(deadline, 4000),
        }),
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }
    if (files.length) out.push({ name: one.name, author: one.author, title: one.title, files });
  }
  return out;
}

/**
 * What `relatedLines` reads: the open pull requests (null when unread) and the
 * pushed branches, inside one `budget` of milliseconds. No fetch while an
 * executor holds the lock, which fetches and pushes in this checkout itself
 * (/code-review, 30 October): the branches are then as last fetched.
 */
export function relatedReaders({ budget = 25_000 } = {}) {
  const deadline = Date.now() + budget;
  const pulls = openPulls({ timeout: left(deadline, 10_000) });
  const merged = pulls ? mergedHeads({ timeout: left(deadline, 5000) }) : new Map();
  const heads = (pulls || []).map((pull) => pull.headRefName).filter(Boolean);
  const lock = readJson(files.lock());
  return {
    pulls,
    branches: pushedBranches({ heads, merged, deadline, fetch: !(lock && !lock.released) }),
  };
}

/**
 * **The related lines for a text**, in "The words" of
 * plans/collaborating-when-claude-writes-the-code.md: one per match of
 * `relatedWork`, the pull request by its number and title, a branch by its
 * name and its last commit's title, then whose it is and two files at most.
 * A plan's own topic (`topic`, its branch and its pull request's head) is
 * never related to it (/code-review, 30 October); `own` is `ownOf(plans)`,
 * built once by a caller with many rows.
 */
export function relatedLines(
  text,
  plans = [],
  { pulls = [], branches = [] } = {},
  { topic = "", own = ownOf(plans) } = {},
) {
  const others = {
    pulls: (pulls || []).filter((pull) => !topic || pull.headRefName !== topic),
    branches: (branches || []).filter((one) => !topic || one.name !== topic),
  };
  return relatedWork(pathsIn(text), { ...others, own }).map((one) => {
    const files =
      one.files.length > 2
        ? `${one.files.slice(0, 2).join(", ")} and ${one.files.length - 2} more`
        : one.files.join(", ");
    const whose = one.own ? `this queue's, ${one.own}` : one.author;
    const what =
      one.kind === "pull" ? `#${one.number} "${one.title}"` : `branch ${one.name}, "${one.title}"`;
    return `looks related to ${what} (${whose ? `${whose}; ` : ""}both name ${files})`;
  });
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
 * Whether a retired planner is done with a plan: taken by an executor, or
 * dropped on the owner's word (plans/dropped-plan-state.md), which nobody takes.
 */
function doneWith(text = "") {
  return planTaken(text) || Boolean(droppedOf(text));
}

/** A plan's `Lands` line in words, for a Ready row; "" with none. */
export function landsWords(lands) {
  if (!lands) return "";
  if (lands.kind === "fix") return lands.now ? "a fix, now" : "a fix";
  return `topic ${lands.name}, ${lands.ready ? "ready" : "waiting"}`;
}

/**
 * Who took a plan, for the planner's messages: "Executor 5 [b92bfc2b] on
 * 26 October 2026" (the live row's name, else "session b92bfc2b"), or
 * "built, commit <sha>" once it is built ("built, pull request #<n>" when it
 * landed by one, "built, straight to <branch>" for a fix pushed straight,
 * "built, on topic <name>" for a topic waiting); "" when nothing took it.
 */
export function whoTook(text = "", live = null) {
  if (/^## Built(?:,|\s*$)/m.test(text)) {
    const built = stateOf(text);
    if (built?.pr) return `built, pull request #${built.pr}`;
    if (built?.fix)
      return `built, straight to ${/^Pushed straight to (\S+) as a fix/m.exec(text)?.[1] || branch()}`;
    if (built?.topic) return `built, on topic ${built.topic}`;
    const sha = built?.sha || "";
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
    if (!plans.every((one) => one === path || doneWith(textOf(one)))) continue;
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
    if (plans.length && plans.every((one) => doneWith(textOf(one)))) paths.add(plans[0]);
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
    const dropped = droppedOf(text);
    if (dropped)
      return `${path} is dropped${dropped.droppedDay ? ` (${dropped.droppedDay})` : ""}: it stands as the record of why; nothing more is done with it.`;
    if (/^## Built(?:,|\s*$)/m.test(text)) return `${path} is ${whoTook(text, live)}.`;
    if (planTaken(text))
      return `${path} was taken by ${whoTook(text, live)}: it is the executor's, and no edit to it passes.`;
    const yours = `${path} is in the queue and still yours: talk it through with ${owner()} here and revise any section with Edit; an answer he gives goes in Decided with its reason; the executor reads the file when it starts it, so do not message it again. This chat ends on its own an hour after it goes quiet (the plan stands in the queue without it; a question left open keeps the chat alive, and the plan with it for thirty minutes).`;
    // **Asked once**: the plan's question holds it for thirty minutes.
    const plan = { path, ...stateOf(text, { mtime: mtimeOf(path) }) };
    if (plan.state !== "ready" || !plan.asks) return yours;
    const asking = askingIn(plan, live, options);
    return asking
      ? `${yours} It asks ${owner()} until ${hhmm(asking.until)}: his answer comes here, goes in Decided with its reason, and the plan is handed over by The final message; after that the executor takes it and builds the recommended options.`
      : `${yours} Its question went unanswered for thirty minutes: the executor takes it and builds the recommended options; an answer now that differs is ${state?.retired ? "a change sent to the assistant's chat by message" : "a follow-up plan you write yourself"}.`;
  });
  // **The chat he said it in writes it**: a retired chat writes nothing new,
  // so its change goes to the assistant's chat by message, as a new topic does.
  lines.push(
    state?.retired
      ? `A change to a taken or built plan of this chat, or a new topic, is the assistant's chat's: send it there ${byMessage()}, headed Change from ${owner()} or New topic from ${owner()}, and say so; never text for him to paste.`
      : `A change to a taken or built plan of this chat is a follow-up plan you write yourself, plans/<x>-follow-up.md, handed over as any plan; a new topic is the assistant's chat's: send it there ${byMessage()} and say so. A message from an Assistant headed Change from ${owner()} is put to him with the question tool before it goes in Decided.`,
  );
  lines.push(
    state?.retired
      ? "This session is retired: it plans nothing more, and the next brief has a planner of its own."
      : "This session may take the next brief: one reaches it as a message, Plan plans/<x>.md: it is a brief, or the Stop hook names one that is waiting.",
  );
  return lines.join("\n");
}

/** **Handed to the assistant**, as the planner's hook strings say it, one wording for every one; another project's assistant writes in another checkout. */
function byMessage() {
  const name = proj().name;
  return `by one message (${name ? `the ${name} Assistant` : "this project's Assistant"} on this machine, by ListAgents)`;
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

/**
 * **What a brief handed to a planner looks related to** (plans/collaborating-
 * when-claude-writes-the-code.md, part 2), in the pull request mode: `text`,
 * the heading and the related lines, or "" with none; `read`, whether the
 * pull requests were read, so a brief is said once only when they were. One
 * budget of eight seconds, inside the prompt hook's twenty with the sessions
 * read before it (Codex and /code-review, 30 October).
 */
function briefRelated(path, plans) {
  if (proj().land !== "pull-request") return { text: "", read: true };
  const brief = planText(path);
  if (!brief) return { text: "", read: true };
  const readers = relatedReaders({ budget: 8000 });
  const lines = relatedLines(brief, plans, readers);
  return {
    text: lines.length ? `The brief looks related to:\n${lines.join("\n")}` : "",
    read: readers.pulls !== null,
  };
}

/** A plan the brief in hand became, added to the session's list once its file no longer reads as a brief. */
function noteFinished(state, plans) {
  const inHand = state.brief ? plans.find((p) => p.path === state.brief) : null;
  if (!inHand || inHand.state === "brief" || inHand.state === "planning") return state;
  if (state.plans.includes(inHand.path)) return state;
  return { ...state, plans: [...state.plans, inHand.path], planned: true };
}

/**
 * **A decided or dropped plan stops asking**: a planner's write that gives it a
 * "Decided" covering every decision, or a planner's or the assistant's write
 * of its `## Dropped` section (plans/dropped-plan-state.md), takes it out of
 * the asking deferral, so `plans` no longer prints it as waiting on the
 * owner. A shell command names no file, so every plan the deferral holds is read.
 */
/**
 * **The chat he said it in writes it** (plans/agents-pass-messages-directly.md):
 * a new plan a planner writes of its own, a follow-up to a taken plan, joins
 * the session's list as it is written, so its question holds it ("Asked
 * once") and an executor's Building line closes it to this chat, as for the
 * plan of a brief. `content` is the new file's text: only a plan (a "Plan
 * only" or "Short plan" header) joins, never a brief, and never by a retired
 * chat, which writes nothing new.
 */
export function noteWritten(state, path, content) {
  if (!path || state?.retired) return state;
  const plans = state?.plans || [];
  if (plans.includes(path) || path === state?.brief) return state;
  const plan = stateOf(content);
  if (!plan || plan.kind === "Brief") return state;
  return { ...state, plans: [...plans, path], planned: true };
}

function leaveAsking(input) {
  const written = planPath(input.tool_input?.file_path);
  const held = written
    ? [written]
    : input.tool_name === "Bash"
      ? readJson(files.deferred("asking"))?.paths || []
      : [];
  const decided = held.filter((path) => {
    const text = planText(path);
    const plan = stateOf(text, { mtime: mtimeOf(path) });
    return plan?.state === "dropped" || (/^## Decided/m.test(text) && plan?.asks === false);
  });
  if (decided.length) dropDeferred("asking", decided);
}

function plannerHook(mode, input, sessionId, statePath) {
  // **A decided plan stops asking**: the write that gives it a "Decided"
  // covering every decision takes it out of the asking deferral, so `plans`
  // no longer prints it as waiting on the owner.
  // A shell command names no file, so every plan the deferral holds is read.
  if (mode === "wrote") {
    leaveAsking(input);
    return;
  }
  let state = readState(sessionId);
  state = { ...state, plans: state.plans || [] };
  if (mode === "tool" && input.tool_name === "Write") {
    const path = planPath(input.tool_input?.file_path);
    const noted =
      path && !existsSync(join(root, path))
        ? noteWritten(state, path, String(input.tool_input?.content || ""))
        : state;
    if (noted !== state) writeJson(statePath, (state = noted));
  }
  if (mode === "tool") {
    // **The window starts at the question** ("Asked once"): its time goes in
    // the state, which `askingIn` reads, and a start of each plan it asks
    // about is deferred to the window's end, so an unanswered plan is built
    // with nobody watching. The question goes ahead; the plain-words hook
    // judges its words.
    if (input.tool_name === "AskUserQuestion") {
      const now = Date.now();
      const asked = { ...(state.asked || {}) };
      const opened = [];
      for (const path of new Set([state.brief, ...state.plans].filter(Boolean))) {
        const plan = { path, ...stateOf(planText(path), { mtime: mtimeOf(path) }) };
        if (plan.state !== "ready" || !plan.asks) continue;
        // A plan whose window ran out is the executor's: a question about
        // another plan does not hold it again.
        const at = windowOpened(state, plan);
        if (at && now - at >= ANSWER_WINDOW) continue;
        asked[path] = now;
        opened.push(path);
      }
      writeJson(statePath, { ...state, asked });
      if (opened.length)
        defer(
          now + ANSWER_WINDOW + WINDOW_SLACK,
          `${owner()} has thirty minutes to answer`,
          opened,
          "",
          "executor",
          "asking",
        );
      return;
    }
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
              permissionDecisionReason: `${takenBy(target, text, null)}: the plan is the executor's now, and nothing in it changes from this session. ${state.retired ? `A retired session writes nothing new: say so, and send the change to the assistant's chat ${byMessage()}, its first line Change from ${owner()}: ${target}.` : `Say so, and write the change as a follow-up plan, ${target.replace(/\.md$/, "")}-follow-up.md (or another name not yet in plans/), handed over as any plan.`}`,
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
          : `This session is retired before it wrote its plan: its brief went to the next planner, and nothing in plans/ is this session's to change. Answer from what you know; a new topic or a change goes to the assistant's chat ${byMessage()}, headed New topic from ${owner()} or Change from ${owner()}, never as text for him to paste.`,
      );
      hookOutput("UserPromptSubmit", lines.join("\n"));
      return;
    }
    // **The planner's hooks decide whether it has room** (part 4): a brief
    // named while it is tired is not taken, and its Stop hook retires it for
    // a fresh planner.
    const tired = named ? tiredFor({ ...state, agent: "planner" }, named) : false;
    const queued = named ? readPlans(join(root, "plans"), liveIds(live)) : [];
    // A brief named mid-plan does not replace the one in hand (/code-review, 27 October).
    const inHand = queued.some(
      (p) => p.state === "planning" && p.session === sessionId && p.path !== named,
    );
    const taking = Boolean(named && !tired && !inHand);
    // **What the brief looks related to**, once per brief.
    const said = state.relatedSaid || [];
    const found = taking && !said.includes(named) ? briefRelated(named, queued) : null;
    const relatedText = found?.text || "";
    writeJson(statePath, {
      ...state,
      agent: "planner",
      ...(taking ? { brief: named } : {}),
      ...(found?.read ? { relatedSaid: [...said, named] } : {}),
    });
    const lines = [
      `Plans in the queue (plans):\n${list({ live, related: false })}\n\nThis session's id is ${sessionId}. It has compacted ${state.compactions} times.`,
    ];
    if (tired)
      lines.push(
        `This session is tired for ${named}: do not plan it. Say so, stop, and the Stop hook starts a fresh planner on it.`,
      );
    if (relatedText) lines.push(relatedText);
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
      const said = state.relatedSaid || [];
      const found = said.includes(state.brief) ? null : briefRelated(state.brief, plans);
      const relatedText = found?.text || "";
      if (found?.read) state.relatedSaid = [...said, state.brief];
      writeJson(statePath, state);
      const reason = relatedText ? `${decision.reason}\n\n${relatedText}` : decision.reason;
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
      return;
    }
    state.retired = true;
    state.planned = state.plans.length > 0;
    writeJson(statePath, state);
    const said = start([], { agent: "planner", replace: sessionId });
    armEnd(sessionId, live);
    // An executor can take a plan before this Stop: its Building line found
    // this planner unretired then, so the chat is stopped here.
    if (state.plans.length && state.plans.every((path) => doneWith(planText(path))))
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

/** A path under the root as `plans/<x>.md`, or "" for any other file. */
function planPath(file) {
  if (!file) return "";
  const path = relative(root, resolve(root, file));
  return /^plans\/[^/]+\.md$/.test(path) ? path : "";
}

/**
 * **The executor's tool hook refuses a Building line on a plan still asking**
 * (plans/asking-plan-guarded.md): an Edit, Write or MultiEdit to a plan whose
 * new text adds a Building line, while `askingIn` holds the plan. The live
 * sessions are read only then, so every other edit costs nothing.
 */
function buildingRefusal(input, statePath) {
  if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name)) return "";
  const path = planPath(input.tool_input?.file_path);
  if (!path) return "";
  const before = planText(path);
  const after = editedText(input.tool_name, input.tool_input, before);
  if (!buildingAdded(before, after).length) return "";
  // **A dropped plan is nobody's to build** (plans/dropped-plan-state.md), whoever named it.
  const dropped = droppedOf(before);
  if (dropped) return droppedWords({ path, ...dropped });
  const live = liveSessions({ timeout: 4000 });
  const asking = heldFromBuilding(path, after, live, { mtime: mtimeOf(path) });
  if (asking) return stillAskingWords(path, asking);
  // Judged with the sessions in hand, the plan is not judged again by the
  // shell's check; unjudged (no sessions read), the next shell command's
  // check reads them again (Codex, 28 October).
  if (live) {
    const state = readState(input.session_id);
    if (!(state.taken || []).includes(path))
      writeJson(statePath, { ...state, taken: [...(state.taken || []), path] });
  }
  return "";
}

/** Each plan's modification time, before a shell command that may write one. */
function planTimes(dir = join(root, "plans")) {
  const times = {};
  try {
    for (const name of readdirSync(dir))
      if (name.endsWith(".md")) times[`plans/${name}`] = statSync(join(dir, name)).mtimeMs;
  } catch {
    // No plans.
  }
  return times;
}

function hook(mode, input) {
  // **No agent marks a pull request ready**, in every session with the
  // plugin, whatever its project or agent (plans/no-agent-marks-ready.md).
  if (
    mode === "tool" &&
    input.tool_name === "Bash" &&
    marksReady(input.tool_input?.command || "")
  ) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: READY_REFUSED,
        },
      }),
    );
    return;
  }
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
  // Only an executor's Building line takes a plan, and only a planner's
  // "Decided" lets one go; any other session's edit returns at once.
  if (mode === "wrote" && kindOf(input) === "assistant") {
    leaveAsking(input);
    return;
  }
  if (mode === "wrote" && !executor && kindOf(input) !== "planner") return;
  // **An assistant chat the queue started ends an hour after it goes quiet**
  // (plans/project-follow-ups-reach-the-project.md, part 6), by its numbered
  // name; the owner's own assistant chat is never the queue's to end.
  if (mode === "stop" && kindOf(input) === "assistant") {
    // Only a chat the queue launched carries the mark, so the owner's own
    // chat never waits on `claude agents` at its stops (/code-review).
    if (process.env.WORKFLOW_STARTED !== "assistant") return;
    const live = liveSessions();
    const row = live?.find((r) => r.sessionId === sessionId);
    if (parseName(row?.name || "")?.kind === "assistant") armEnd(sessionId, live);
    return;
  }
  if (kindOf(input) === "planner") {
    plannerHook(mode, input, sessionId, statePath);
    return;
  }
  if (!executor) return;
  // The question tool reaches the tool hook for the planner's sake; the lock
  // never refuses an executor's question.
  if (mode === "tool" && input.tool_name === "AskUserQuestion") return;
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
    // **Every plan this session took, kept past its Building line**
    // (plans/project-follow-ups-reach-the-project.md, part 4): "Built" takes
    // the line out, and the Stop hook still asks what the built plan owes.
    const hold = (paths) => {
      const state = readState(sessionId);
      const held = [...new Set([...(state.held || []), ...paths])];
      if (held.length !== (state.held || []).length) writeJson(statePath, { ...state, held });
    };
    // A Building line written by a shell command: found by reading the plans
    // after the fact, since no tool hook could refuse it. **On a plan still
    // asking it is taken out again** (plans/asking-plan-guarded.md), with the
    // tool hook's words. A plan judged once (`taken`) is not judged again, so
    // the live sessions are read once per plan; one whose line is gone drops
    // from the list. Before any question the window opens at the plan's time
    // before the command (`plansAt`, which the tool hook records), since the
    // command has just written the file.
    if (input.tool_name === "Bash") {
      const mine = readPlans(join(root, "plans")).filter((p) => building.test(p.text));
      const state = readState(sessionId);
      const taken = (state.taken || []).filter((path) => mine.some((p) => p.path === path));
      const unjudged = mine.filter((p) => !taken.includes(p.path));
      const said = [];
      const newly = [];
      if (unjudged.length) {
        const live = liveSessions({ timeout: 4000 });
        const own = new RegExp(`${building.source}[^\\n]*\\n?`, "gm");
        for (const plan of unjudged) {
          const mtime = state.plansAt?.[plan.path] || 0;
          const asking = heldFromBuilding(plan.path, plan.text, live, { mtime });
          // No sessions read is the hook doing nothing, as when it fails:
          // judged, so a failing list is not asked again on every command.
          if (!asking) {
            taken.push(plan.path);
            newly.push(plan.path);
            continue;
          }
          writeFileSync(plan.file, plan.text.replace(own, ""));
          said.push(`${stillAskingWords(plan.path, asking)} Its Building line was taken out.`);
        }
      }
      if (String(taken) !== String(state.taken || []))
        writeJson(statePath, { ...readState(sessionId), taken });
      // The batch starts at a Building line that stays, and the plan stops
      // asking; one the asking check took out is not this session's (/code-review).
      if (taken.length) hold(taken);
      if (taken.length) markBase();
      if (newly.length) dropDeferred("asking", newly);
      if (said.length)
        process.stdout.write(JSON.stringify({ decision: "block", reason: said.join("\n") }));
      return;
    }
    const path = planPath(input.tool_input?.file_path);
    if (!path) return;
    if (!building.test(planText(path))) return;
    hold([path]);
    markBase();
    dropDeferred("asking", [path]);
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
    else reason = buildingRefusal(input, statePath);
    // A writing command may write a Building line: the plans' times before it,
    // for the wrote hook's judgement.
    if (!reason && command !== null) writeJson(statePath, { ...state, plansAt: planTimes() });
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
      `Plans in the queue (plans):\n${list({ live, related: false })}\n\nThis session's id is ${sessionId}. It has compacted ${state.compactions} times; the rule is in your agent file under "Going on".`,
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
    writeFileSync(plan.file, cutoffEdit(plan.text, { sessionId, branch: branchOf(input.cwd) }));
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
    const building = new RegExp(`^## Building, [^,\\n]+, session ${sessionId}\\b`, "m");
    const carry = carryOf(
      plans.filter(
        (p) =>
          p.state === "built" &&
          p.carries?.length &&
          ((state.held || []).includes(p.path) || building.test(p.text)),
      ),
    );
    const decision = decideStop({
      carry,
      current: plans.find((p) => p.state === "building" && p.session === sessionId) || null,
      compactions: state.compactions,
      waiting,
      handed,
      // The pull request mode reads its pull requests' checks, then the run a
      // fix pushed straight sets off; the push mode its run.
      run:
        proj().land === "pull-request"
          ? pullThenRun(
              pullChecks(),
              imageRun({
                only: plans.filter((p) => p.state === "built" && p.fix && p.sha).map((p) => p.sha),
              }),
            )
          : imageRun(),
      told: state.told,
      paused: Boolean(pausedSince()),
      retired: state.retired,
      continuing: Boolean(input.stop_hook_active),
      refusedRun: state.runRefused ?? null,
      usage: sessionUsage(input.transcript_path),
      ceiling: proj().reuse,
      land: proj().land,
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
 * per fault: an entry without its tier and date, every entry at the retired
 * agent's choice (old or new: each is a detail with no well-formed opinion
 * behind it, free and not the catalogue's), an id used twice in one
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
      for (const rule of agentsChoice(f.text))
        lines.push(
          `${where}: the agent's choice, retired: ${rule.length > 80 ? `${rule.slice(0, 77)}...` : rule}`,
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
plans start --agent assistant <plan>  start an assistant chat on a built plan's follow-ups
plans pause | resume  stop and restart starting sessions
plans end [id...] [--now]  end this queue's finished chats, or these; --now ends a named one whatever it is doing
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
    process.stdout.write(
      `${endCommand(
        rest.filter((a) => a !== "--now"),
        { immediate: rest.includes("--now") },
      )}\n`,
    );
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
    for (const kind of QUEUE_KINDS) {
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
    for (const kind of QUEUE_KINDS) {
      const deferred = readJson(files.deferred(kind));
      if (!deferred) continue;
      // A timer at the later of its time and a minute from now.
      defer(
        deferred.until,
        deferred.why,
        deferred.paths || [],
        deferred.replace || "",
        agentOfDeferral(kind),
        kind,
      );
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
      else if (rest[i] === "--deferral") options.deferral = rest[++i];
      else paths.push(rest[i]);
    }
    if (timer) {
      // The deferred start: a wait and then the same start, nothing else.
      // **A timer clears only its own deferral**: one whose plans were all
      // decided or taken lost its file, and a newer deferral with another
      // timer may stand there now.
      setTimeout(
        () => {
          const file = files.deferred(
            options.deferral || (options.agent === "planner" ? "planner" : "executor"),
          );
          if (readJson(file)?.pid === process.pid)
            try {
              unlinkSync(file);
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
