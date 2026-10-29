#!/usr/bin/env node
// Claude Code hook, PreToolUse on Edit, Write, MultiEdit and MCP tools
// (docs/workflow.md, "Decisions"): tells the agent which recorded design
// decisions cover what it is about to write, before the edit rather than in
// review. Nothing without a project file naming a `catalogue` or `inherits`;
// in both forms, full and compact.
//
// A catalogue is a directory of `.md` files (the README aside, any depth) or
// one `.md` file. A file may carry a frontmatter with `paths`, the components
// and routes it governs, and `signals`, the words in code or in a tool call
// that mean the control is being drawn ("delete", "ConfirmButton", "<Tabs",
// "toast"). An entry is a bold list item with its tier, and may open with an
// id in backticks; the project's catalogue overrides an inherited entry of
// the same id. Three things are matched, all deterministic:
//
//   1. the edited file's path against every file's `paths` globs,
//   2. the words of the file's name against the entries' text
//      (PlayCalculator finds the rules that say "calculator"),
//   3. the text being written (a Write's content, an Edit's new_string, a
//      tool call's inputs) against every file's `signals`, which is how a
//      delete button in a brand-new file still meets the rules for
//      destructive actions.
//
// It prints the rules a person decided first, each once per session, then
// how many more there are and where. No model call, nothing blocked: the
// agent reads it as context. It prints nothing for a file outside the
// project's `ui` paths, a call outside its `tools`, or nothing matching.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { globToRegExp } from "./turn-audit.mjs";
import { matches, owner, project } from "./project.mjs";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_RULES = 8; // rules listed in full
const MAX_FILES = 5; // catalogue files pointed at
const MAX_NAME_HITS = 6; // a name's word is specific when it names at most this many rules

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

/** One entry: `- \`id\` **Rule.** (tier, date)`, the id optional. */
const ENTRY = /^- (?:`([\w.-]+)` )?\*\*(.+?)\*\* \(([^)]*)\)/s;

/** The `.md` files of a catalogue location, a directory at any depth (the README aside) or one file. */
export function catalogueFiles(path) {
  if (path.endsWith(".md")) return existsSync(path) ? [{ path, name: basename(path) }] : [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md") && e.name !== "README.md")
        out.push({ path: full, name: relative(path, full).replaceAll("\\", "/") });
    }
  };
  walk(path);
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
      const entries = [];
      // Each rule as its first paragraph, its continuation lines joined, so a
      // rule whose bold text wraps is read as the audit reads it.
      for (const { item, line } of paragraphs(text)) {
        const m = ENTRY.exec(item);
        if (m)
          entries.push({
            id: m[1] || "",
            rule: m[2],
            tag: m[3],
            key: `${label || cite}#${m[1] || `${cite}:${line}`}`,
            cite: m[1] ? `${cite}#${m[1]}` : "",
          });
      }
      files.push({
        name,
        label: path.endsWith(".md") ? label : label ? `${label}/${name}` : name,
        own,
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

/** A catalogue file's list items that open with bold text (an id may come first), each its first paragraph on one line, with its line number. */
export function paragraphs(text) {
  const lines = text.split("\n");
  const items = [];
  lines.forEach((line, i) => {
    if (!/^- (?:`[\w.-]+` )?\*\*/.test(line)) return;
    let item = line;
    for (
      let j = i + 1;
      j < lines.length && /^ {2}\S/.test(lines[j]) && !/^ {2}- /.test(lines[j]);
      j++
    )
      item += " " + lines[j].trim();
    items.push({ item, line: i + 1 });
  });
  return items;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words of a file name worth matching: CamelCase parts of five letters or more. */
export function nameWords(file) {
  const stem = basename(file).replace(/\.[^.]+$/, "");
  return [
    ...new Set(
      stem
        .split(/(?=[A-Z])|[-_. ]/)
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

function nothingCovers(catalogue, who) {
  return [
    `No recorded design decision covers what you are writing here (nothing in ${catalogue} matches this file, its name, or the text).`,
    `Before building a control nothing covers: did ${who} say how it should work and look? If not, look it up (the design-research skill: name the product people already know, match the nearest pattern this project has, keep its look) and record what you followed; a small choice skips the question, never the research. Ask ${who} only when the research leaves a choice the house rules do not settle; for a new screen or flow, the skill's question comes first. Whatever is followed, add the entry to ${catalogue} with its tier (a person's name, \`as <product> does\`, \`per <source>\`, or \`the agent's choice\` with what was looked at) and today's date in the same change, and add the control's word to that file's \`signals\`.`,
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
 * are counted instead and to which the ones printed now are added.
 */
export function contextFor(
  rel,
  text,
  files,
  { ui = [], catalogue = "", who = "the owner", shown = new Set() } = {},
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
  const found = files
    .map((f) => {
      const byPath = !call && f.globs.some((g) => g.test(rel));
      const signal = f.signals.find((s) => s.test(text));
      // Inside a file that governs this path, any word of the name ranks its
      // rules ("calculator" within chat.md); across files only a specific one does.
      const nameHit = (e) =>
        (byPath ? anyWords : words).some((w) => new RegExp(`\\b${w}`, "i").test(e.rule));
      const signalHit = (e) => signal && new RegExp(`\\b${stem(signal.source)}`, "i").test(e.rule);
      const hits = f.entries.filter((e) => nameHit(e) || signalHit(e));
      return { f, byPath, signal, hits, rank: signal ? 0 : byPath ? 1 : hits.length ? 2 : 3 };
    })
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank || Number(b.f.own) - Number(a.f.own))
    .slice(0, MAX_FILES);
  for (const { f, byPath, signal, hits } of found) {
    hits.forEach(take);
    const why = signal
      ? `the text you are writing looks like ${signal.source.replace(/\\b|\\/g, "")}`
      : byPath
        ? "it governs this file"
        : "its rules name this control";
    pointers.push(`${f.label} (${f.entries.length} rules; ${why})`);
    if (byPath && !hits.length) f.entries.forEach(take);
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
      `- and ${more} more rule${more === 1 ? "" : "s"} there (shown already this session, a product's or the agent's choice).`,
    );
  lines.push(
    "A rule with a person's name is their call: do not change it or build against it; bring the reason to them and leave the control as it is, or, if they gave the new call in this session, update the entry with today's date and keep the old line struck through. A new control follows the rules above and gets its entry in the same change.",
  );
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
  let shown = new Set();
  try {
    if (statePath) shown = new Set(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    // First time this session.
  }
  const context = contextFor(rel, text, files, {
    ui: proj.ui.map(globToRegExp),
    catalogue: proj.catalogue || proj.inherits.at(-1),
    who: owner(),
    shown,
  });
  if (!context) return;
  try {
    if (statePath) writeFileSync(statePath, JSON.stringify([...shown]));
  } catch {
    // No state: the next call shows them again, as before.
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
