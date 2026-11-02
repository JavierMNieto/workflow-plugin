#!/usr/bin/env node
// Claude Code hook, PreToolUse on Edit, Write, MultiEdit and MCP tools
// (docs/workflow.md, "Decisions"): tells the agent which recorded design
// decisions cover what it is about to write, before the edit rather than in
// review. Nothing without a project file naming a `catalogue` or `inherits`;
// in both forms, full and compact.
//
// A catalogue is a directory of `.md` files (the README too, any depth) or
// one `.md` file. A file may carry a frontmatter with `paths`, the components
// and routes it governs, and `signals`, the words in code or in a tool call
// that mean the control is being drawn ("delete", "ConfirmButton", "<Tabs",
// "toast"). An entry is a bold list item with its tier, and may open with an
// id in backticks; the project's catalogue overrides an inherited entry of
// the same id. Three things are matched deterministically, and a fourth by a
// small model:
//
//   1. the edited file's path against every file's `paths` globs (the
//      project's own one-file catalogue with no `paths` governs every `ui`
//      path, so the list is kept once, in the project file),
//   2. the words of the file's name against the entries' text
//      (PlayCalculator finds the rules that say "calculator"),
//   3. the text being written (a Write's content, an Edit's new_string, a
//      tool call's inputs) against every file's `signals`, which is how a
//      delete button in a brand-new file still meets the rules for
//      destructive actions,
//   4. and, for an edit under `ui` whose text draws a control or carries
//      words a person could read, a small model's naming of the catalogue's
//      files (a directory) or `## ` sections (one file) the text touches
//      (plans/catch-inconsistent-ui-at-build.md): `claude -p --model haiku`
//      with no tools, no MCP servers and no hooks, one call per distinct text a session,
//      sixty a session at most, twenty seconds each, a line per attempt in
//      `catalogue-kinds.log` in the plugin's data directory. About 1.5k
//      tokens and seven seconds a call as measured on 2 November
//      (`total_cost_usd` 0.0003, `duration_api_ms` 872, wall 7.1 s, Haiku);
//      no `claude`, a failure or a timeout leaves the first three alone.
//
// It prints the rules a person decided first, each once per session, and its
// instruction once per session, then how many more there are and where.
// Nothing blocked: the agent reads it as context. It prints nothing for a file outside the
// project's `ui` paths, a call outside its `tools`, or nothing matching.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { catalogueFiles, globToRegExp, paragraphs, tierOf } from "./turn-audit.mjs";

export { catalogueFiles, paragraphs };
import { data } from "./plan-queue.mjs";
import { matches, owner, project } from "./project.mjs";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_RULES = 8; // rules listed in full
const MAX_FILES = 5; // catalogue files pointed at
const MAX_NAME_HITS = 6; // a name's word is specific when it names at most this many rules
const MAX_CALLS = 60; // model calls a session at most
const KINDS_TEXT = 4000; // characters of the text the model reads

/** The frontmatter's lists: {paths: [...], signals: [...]}. */
export function frontmatter(text) {
  const lists = { paths: [], signals: [] };
  if (!text.startsWith("---\n")) return lists;
  const end = text.indexOf("\n---", 4);
  let key = null;
  for (const line of text.slice(4, end).split("\n")) {
    const k = line.match(/^(\w+):\s*$/);
    if (k) {
      key = k[1] in lists ? k[1] : null;
      continue;
    }
    const m =
      line.match(/^\s*-\s*"(.*)"\s*$/) ||
      line.match(/^\s*-\s*'(.*)'\s*$/) ||
      line.match(/^\s*-\s*(\S.*?)\s*$/);
    if (m && key) lists[key].push(m[1]);
  }
  return lists;
}

/**
 * The catalogue's files: name, where it came from, paths globs, signal
 * patterns and entries ({id, rule, tag, key}). `locations` is a directory, or
 * a list of `{path, label, own}`, the inherited first and the project's own
 * last; a project entry whose id an inherited entry carries replaces it, and
 * says which it overrides.
 */
export function readCatalogue(locations) {
  const list =
    typeof locations === "string" ? [{ path: locations, label: "", own: true }] : locations;
  const files = [];
  for (const { path, label = "", own = true } of list) {
    for (const { path: full, name } of catalogueFiles(path)) {
      const text = readFileSync(full, "utf8");
      const { paths, signals } = frontmatter(text);
      const cite = name.replace(/\.md$/, "");
      // The title and each line's `## ` section, in one pass that skips the
      // frontmatter and fenced examples, as `paragraphs` does.
      const lines = text.split("\n");
      let title = "";
      const sections = [];
      let current = "";
      let fence = "";
      let front = lines[0] === "---";
      lines.forEach((l, i) => {
        if (front) {
          if (i > 0 && l === "---") front = false;
        } else {
          const open = /^ {0,3}(`{3,}|~{3,})/.exec(l);
          if (open && (!fence || open[1][0] === fence[0])) fence = fence ? "" : open[1];
          else if (!fence && /^# /.test(l) && !title) title = l.slice(2).trim();
          else if (!fence && /^## /.test(l)) current = l.slice(3).trim();
        }
        sections[i] = current;
      });
      title ||= name;
      const sectionAt = (index) => sections[index] || "";
      const entries = [];
      // Each rule as its first paragraph, its continuation lines joined, so a
      // rule whose bold text wraps is read as the audit reads it.
      for (const { item, line } of paragraphs(text)) {
        // An entry is a rule with its tier, read as the audit reads it.
        const m = tierOf(item);
        if (m)
          entries.push({
            id: m.id,
            rule: m.statement,
            tag: m.tag,
            key: `${label || cite}#${m.id || `${cite}:${line}`}`,
            cite: m.id ? `${cite}#${m.id}` : "",
            section: sectionAt(line - 1),
          });
      }
      files.push({
        name,
        label: path.endsWith(".md") ? label : label ? `${label}/${name}` : name,
        own,
        title,
        single: path.endsWith(".md"),
        paths,
        globs: paths.map(globToRegExp),
        // A signal that is not a valid pattern is matched as the plain word.
        signals: signals.map((s) => {
          try {
            return new RegExp(s, "i");
          } catch {
            return new RegExp(escapeRe(s), "i");
          }
        }),
        entries,
      });
    }
  }
  // **The project overrides by id**: an inherited entry whose id the
  // project's catalogue carries is replaced in its place by the project's,
  // which the inherited file's `paths` and `signals` then find, and which
  // names the one it overrides. The same entry in two files is listed once.
  const ownIds = new Map();
  for (const f of files.filter((f) => f.own))
    for (const e of f.entries) if (e.id) ownIds.set(e.id, e);
  for (const f of files.filter((f) => !f.own)) {
    f.entries = f.entries.map((e) => {
      const mine = e.id && ownIds.get(e.id);
      if (!mine) return e;
      mine.overrides = e.cite;
      return mine;
    });
  }
  return files;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words of a file name worth matching: CamelCase parts, or an all-caps name, of five letters or more. */
export function nameWords(file) {
  const stem = basename(file).replace(/\.[^.]+$/, "");
  return [
    ...new Set(
      stem
        // A capital after a lower-case letter or a digit starts a word, as
        // does the last capital of a run before lower case (URLInput) and a
        // digit after a letter (Step2Toolbar); an all-caps name (INSTALL,
        // README) stays one word.
        .split(/(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)|[-_. ]/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 5)
        .map(escapeRe),
    ),
  ];
}

/** Whether the text being written draws something a user sees: a JSX element. */
export function draws(text) {
  return /<[A-Za-z][\w.]*(\s|>|\/)/.test(text);
}

/** Whether the text says something a person could read: it draws a control, or carries three words in a row. */
export function reads(text) {
  return draws(text) || /\b[A-Za-z][a-z']+(?: [a-z][a-z']+){2,}/.test(text);
}

/**
 * **The kinds a small model names** (plans/catch-inconsistent-ui-at-build.md):
 * the parts of the catalogue a model may name, `{name, line, alias}`: a
 * directory catalogue's files but the README, `<label>: <title>`, labelled
 * as the hook labels them, the file's own name an alias when no other
 * file shares it (an answer may give `toasts.md` for `docs/ui/toasts.md`); a one-file
 * catalogue's `## ` sections that hold an entry, `<heading>: <its first
 * entry's statement>`. The inherited catalogues' files are among them.
 */
export function menuOf(files) {
  const menu = [];
  for (const f of files) {
    if (f.single) {
      const seen = new Set();
      for (const e of f.entries) {
        if (!e.section || seen.has(e.section)) continue;
        seen.add(e.section);
        const rule = e.rule.length > 80 ? `${e.rule.slice(0, 77)}...` : e.rule;
        menu.push({ name: e.section, line: `${e.section}: ${rule}` });
      }
    } else if (!/(^|\/)README\.md$/i.test(f.name) && f.entries.length) {
      const shared = files.filter((x) => !x.single && x.name === f.name).length > 1;
      menu.push({ name: f.label, alias: shared ? "" : f.name, line: `${f.label}: ${f.title}` });
    }
  }
  return menu;
}

const KINDS_SYSTEM =
  "You name which parts of a design catalogue an edit to a user interface touches: the part whose rules govern what the edit draws or says, such as a message after an action, a confirmation, an empty state, an error, a button. Answer with names from the list only, one per line, the most likely first, or the word none.";

/** The model call, as the hook makes it: `claude -p` on haiku, no tools, no hooks, no session kept, out of the project. */
function askClaude(prompt) {
  const out = execFileSync(
    "claude",
    [
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "--disallowedTools",
      "*",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "--system-prompt",
      KINDS_SYSTEM,
    ],
    {
      input: prompt,
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: Number(process.env.WORKFLOW_KINDS_TIMEOUT_MS) || 20000,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  return JSON.parse(out);
}

/**
 * The menu's names a model finds in `text`, in its answer's order, read
 * leniently (an answer that chatters before the names still names them);
 * `[]` for `none` or no name. `{names, cost}`, or `{names: null, reason}`
 * when the call failed, timed out or found no `claude`.
 */
export function kindsFor(text, menu, ask = askClaude) {
  if (!menu.length) return { names: [], cost: null };
  const prompt = `The catalogue's parts:\n${menu.map((m) => m.line).join("\n")}\n\nThe edit writes:\n${text.slice(0, KINDS_TEXT)}`;
  let answer;
  try {
    answer = ask(prompt);
  } catch (e) {
    const reason = e.code === "ENOENT" ? "no claude" : e.signal ? "timeout" : "failed";
    return { names: null, reason };
  }
  if (!answer || answer.is_error || typeof answer.result !== "string")
    return { names: null, reason: "no answer" };
  const result = answer.result;
  // Each name where it stands, longest first, so a name inside a longer one
  // the answer gave ("Errors" in "Errors in forms") is not taken for it.
  const spans = [];
  const found = menu
    .flatMap((m) =>
      [m.name, ...(m.alias ? [m.alias, m.alias.replace(/\.md$/, "")] : [])].map((said) => ({
        name: m.name,
        said,
      })),
    )
    .sort((a, b) => b.said.length - a.said.length)
    .map(({ name, said }) => {
      const re = new RegExp(`(?<![\\w./-])${escapeRe(said)}(?![\\w-]|\\.md\\b)`, "gi");
      for (const hit of result.matchAll(re)) {
        const end = hit.index + said.length;
        if (spans.some(([a, b]) => hit.index >= a && end <= b)) continue;
        spans.push([hit.index, end]);
        return { name, at: hit.index };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.name)
    .filter((name, i, all) => all.indexOf(name) === i);
  return { names: found, cost: answer.total_cost_usd ?? null };
}

function nothingCovers(catalogue, who) {
  return [
    `No recorded design decision covers what you are writing here (nothing in ${catalogue} matches this file, its name, or the text).`,
    `It is free unless it carries a decision. Did ${who} say how it should work and look? Then it is their call: build it and record it under their name. A control, flow or string people know from a product is looked up (the design-research skill: name the product, match the nearest pattern this project has, keep its look) and recorded as that product's; a new screen or flow is asked about first, by the skill. Anything else, a tooltip's words, an icon among a set, spacing, a line kept or cut, is free: build it by the catalogue's everywhere rules and the nearest pattern, record nothing, ask nothing, and end the turn with the line decisions: none (free: <the rule it follows>).`,
  ].join("\n");
}

/** Whether a tier is a person's: not a product's (`as X does`, `per <source>`, `observed in <x>`) or the agent's choice. */
export function isPerson(tag) {
  return !/^(?:as .+ does|per .+|observed in .+|the agent's choice)\b/.test(tag);
}

/** A signal's word as a prefix to find in an entry: "delete" becomes "delet", which "Deleting" and "deleted" carry. */
export function stem(signalSource) {
  const word = signalSource
    .replace(/\\b/g, "")
    .replace(/^[<\\]+/, "")
    .replace(/[^\w].*$/, "");
  return word.length > 5 ? word.slice(0, 5) : word;
}

/** Every string value of a tool call's input, joined by newlines, as the matching text. */
export function flatten(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("\n");
  if (value && typeof value === "object") return flatten(Object.values(value));
  return "";
}

/**
 * The context to add for writing `text` into `rel` (a path relative to the
 * project's root; "" for a tool call, matched by its signals alone), or ""
 * for none. `ui` is the project file's globs as regular expressions,
 * `catalogue` its name as the lines say it, `who` the owner, `shown` the
 * keys of the entries this session has already been shown in full, which
 * are counted instead and to which the ones printed now are added, `kinds`
 * the catalogue's files or sections a small model named for the text.
 */
export function contextFor(
  rel,
  text,
  files,
  { ui = [], catalogue = "", who = "the owner", shown = new Set(), kinds = [] } = {},
) {
  const call = rel === "";
  if (!call && !ui.some((p) => p.test(rel))) return "";
  // A word of the file's name counts only when it is specific: an ordinary
  // word ("remove", "member") names rules in a dozen files and would drown
  // the ones that matter.
  const all = files.flatMap((f) => f.entries);
  const anyWords = call ? [] : nameWords(rel);
  const words = anyWords.filter(
    (w) => all.filter((e) => new RegExp(`\\b${w}`, "i").test(e.rule)).length <= MAX_NAME_HITS,
  );
  const people = [];
  const seen = new Set();
  const pointers = []; // files to open, with why
  let others = 0;
  const take = (entry) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    if (isPerson(entry.tag) && !shown.has(entry.key)) people.push(entry);
    else others++;
  };
  // Files found by the text's signals or by path come first, then those
  // whose rules name the file; the project's before the inherited at the
  // same rank; the rules listed follow the same order.
  // **One list, in the project file** (plans/catalogue-hook-and-audit.md):
  // the project's own catalogue, when it is one `.md` file with no `paths`,
  // governs every `ui` path, which `rel` is already inside by here; a
  // directory's files are found by their own `paths` as before.
  const governs = (f) => f.globs.some((g) => g.test(rel)) || (f.own && f.single && !f.paths.length);
  const named = new Set(kinds.map((k) => k.toLowerCase()));
  const found = files
    .map((f) => {
      const byPath = !call && governs(f);
      // A file the model named whole, or the sections of it it named.
      const kindFile = !f.single && named.has(f.label.toLowerCase());
      const kindSections = [
        ...new Set(f.entries.map((e) => e.section).filter((x) => x && named.has(x.toLowerCase()))),
      ];
      const kindEntries = kindFile
        ? f.entries
        : f.entries.filter((e) => kindSections.includes(e.section));
      const kindWhy = kindFile ? f.title : kindSections[0];
      const signal = f.signals.find((s) => s.test(text));
      // Inside a file that governs this path, any word of the name ranks its
      // rules ("calculator" within chat.md); across files only a specific one does.
      const nameHit = (e) =>
        (byPath ? anyWords : words).some((w) => new RegExp(`\\b${w}`, "i").test(e.rule));
      const signalHit = (e) => signal && new RegExp(`\\b${stem(signal.source)}`, "i").test(e.rule);
      const hits = f.entries.filter((e) => nameHit(e) || signalHit(e));
      // A file the model named is found beside a path match, and first among them.
      const rank = signal ? 0 : kindEntries.length ? 1 : byPath ? 1.5 : hits.length ? 2 : 3;
      return { f, byPath, signal, hits, kindEntries, kindWhy, rank };
    })
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank || Number(b.f.own) - Number(a.f.own))
    .slice(0, MAX_FILES);
  for (const { f, byPath, signal, hits, kindEntries, kindWhy } of found) {
    hits.forEach(take);
    kindEntries.forEach(take);
    const why = signal
      ? `the text you are writing looks like ${signal.source.replace(/\\b|\\/g, "")}`
      : kindEntries.length
        ? `the text you are writing reads as ${kindWhy}`
        : byPath
          ? "it governs this file"
          : "its rules name this control";
    pointers.push(`${f.label} (${f.entries.length} rules; ${why})`);
    if (byPath && !hits.length && !kindEntries.length) f.entries.forEach(take);
  }
  if (!pointers.length) return !call && draws(text) ? nothingCovers(catalogue, who) : "";
  const lines = [
    `Recorded design decisions cover ${call ? "this call" : `\`${rel}\``}. Open before changing the control: ${pointers.join("; ")}.`,
  ];
  const listed = people.slice(0, MAX_RULES);
  for (const e of listed) {
    const rule = e.rule.length > 180 ? e.rule.slice(0, 177) + "..." : e.rule;
    const where = [e.cite, e.overrides ? `overrides ${e.overrides}` : ""].filter(Boolean);
    lines.push(`- ${e.tag}: ${rule}${where.length ? ` (${where.join("; ")})` : ""}`);
    shown.add(e.key);
  }
  const more = people.length - listed.length + others;
  if (more)
    lines.push(
      `- and ${more} more rule${more === 1 ? "" : "s"} there (shown already this session, or a product's or a source's).`,
    );
  // **The hook says its piece once**: the instruction is printed with the
  // session's first context and counted as shown after, as an entry is; the
  // header and the count say which file governs this edit, so they stay.
  if (!shown.has("instruction")) {
    shown.add("instruction");
    lines.push(
      "A rule with a person's name is their call: do not change it or build against it; bring the reason to them and leave the control as it is, or, if they gave the new call in this session, update the entry with today's date and keep the old line struck through. A new control follows the rules above; one that carries a decision gets its entry in the same change, and a free detail gets none.",
    );
  }
  return lines.join("\n");
}

/** The entries this session has been shown in full, in the OS temp directory as the audit keeps its state; none without a session. */
function shownPath(sessionId) {
  return sessionId ? join(tmpdir(), `workflow-catalogue-${sessionId}.json`) : "";
}

/** The project's catalogue locations, the inherited first: `{path, label, own}`. */
export function locations(proj, dir = root) {
  const at = (p) => (isAbsolute(p) ? p : resolve(dir, p));
  const label = (p) => p.replace(/\/$/, "");
  return [
    ...proj.inherits.map((p) => ({ path: at(p), label: label(p), own: false })),
    ...(proj.catalogue
      ? [{ path: at(proj.catalogue), label: label(proj.catalogue), own: true }]
      : []),
  ].filter(({ path }) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The names for this text: the session's answer for it, or one call while
 * the session has calls left, every attempt a line in the log.
 */
function kindsOnce(rel, text, files, state, session) {
  const hash = createHash("sha1").update(text).digest("hex");
  const started = Date.now();
  let names = [];
  let what;
  let cost = null;
  if (state.answers[hash]) {
    names = state.answers[hash];
    what = "cached";
  } else if (state.calls >= MAX_CALLS) {
    what = "budget";
  } else {
    state.calls++;
    const got = kindsFor(text, menuOf(files));
    if (got.names === null) {
      // A failure is the session's answer for this text too, so it is not
      // asked again; the deterministic context stands.
      state.answers[hash] = [];
      what = `not run: ${got.reason}`;
    } else {
      names = got.names;
      cost = got.cost;
      state.answers[hash] = names;
      what = names.length ? names.join(",") : "none";
    }
  }
  try {
    const dir = data();
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "catalogue-kinds.log"),
      `${new Date().toISOString()} ${session} ${rel} ${Date.now() - started} ${cost ?? "-"} ${what}\n`,
    );
  } catch {
    // No log: the context is the same.
  }
  return names;
}

function main() {
  const proj = project(root);
  if (!proj.found || (!proj.catalogue && !proj.inherits.length)) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const args = input.tool_input || {};
  let rel = "";
  let text = "";
  if (["Edit", "Write", "MultiEdit"].includes(input.tool_name)) {
    const file = args.file_path;
    if (!file) return;
    rel = relative(root, file).replaceAll("\\", "/");
    if (rel.startsWith("..")) return;
    // A Write's content, an Edit's new_string, or every MultiEdit replacement.
    text =
      args.content ??
      args.new_string ??
      (args.edits || []).map((e) => e.new_string || "").join("\n");
  } else {
    // **A tool call is watched like a path** when the project's `tools` names
    // it: a read-only call, or one outside the list, returns at once.
    const name = String(input.tool_name || "");
    if (!matches(proj.tools, name)) return;
    text = flatten(args);
  }
  let files;
  try {
    files = readCatalogue(locations(proj));
  } catch {
    return;
  }
  const statePath = shownPath(input.session_id);
  // `{shown, calls, answers}`; an array is an older session's `shown`.
  let state = { shown: [], calls: 0, answers: {} };
  try {
    if (statePath) {
      const read = JSON.parse(readFileSync(statePath, "utf8"));
      state = Array.isArray(read) ? { ...state, shown: read } : { ...state, ...read };
    }
  } catch {
    // First time this session.
  }
  const shown = new Set(state.shown);
  const ui = proj.ui.map(globToRegExp);
  let kinds = [];
  if (rel && statePath && ui.some((p) => p.test(rel)) && reads(text))
    kinds = kindsOnce(rel, text, files, state, input.session_id);
  const context = contextFor(rel, text, files, {
    ui,
    catalogue: proj.catalogue || proj.inherits.at(-1),
    who: owner(),
    shown,
    kinds,
  });
  try {
    if (statePath) writeFileSync(statePath, JSON.stringify({ ...state, shown: [...shown] }));
  } catch {
    // No state: the next call shows them again, and asks again, as before.
  }
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
