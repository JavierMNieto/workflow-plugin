#!/usr/bin/env node
// Claude Code hook, PreToolUse on Edit, Write and MultiEdit (docs/workflow.md,
// "Decisions"): tells the agent which recorded design decisions cover what it
// is about to write, before the edit rather than in review. Nothing without a
// project file naming a `catalogue`; in both forms, full and compact.
//
// Each file of the catalogue (`<catalogue>/*.md`, the README aside) carries a
// frontmatter with `paths`, the components and routes it governs, and
// `signals`, the words in code that mean the control is being drawn
// ("delete", "ConfirmButton", "<Tabs", "toast"). Three things are matched,
// all deterministic:
//
//   1. the edited file's path against every file's `paths` globs,
//   2. the words of the file's name against the entries' text
//      (PlayCalculator finds the rules that say "calculator"),
//   3. the text being written (a Write's content, an Edit's new_string)
//      against every file's `signals`, which is how a delete button in a
//      brand-new file still meets the rules for destructive actions.
//
// It prints the rules a person decided first, then how many more there are
// and where. No model call, nothing blocked: the agent reads it as context.
// It prints nothing for a file outside the project's `ui` paths or with
// nothing matching.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { globToRegExp } from "./turn-audit.mjs";
import { owner, project } from "./project.mjs";

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

/** The catalogue's files: name, paths globs, signal patterns and entries (rule, tag). */
export function readCatalogue(dir) {
  const files = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const text = readFileSync(join(dir, name), "utf8");
    const { paths, signals } = frontmatter(text);
    const entries = [];
    // Each rule as its first paragraph, its continuation lines joined, so a
    // rule whose bold text wraps is read as the audit reads it.
    for (const item of paragraphs(text)) {
      const m = /^- \*\*(.+?)\*\* \(([^)]*)\)/s.exec(item);
      if (m) entries.push({ rule: m[1], tag: m[2] });
    }
    files.push({
      name,
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
  return files;
}

/** A catalogue file's list items that open with bold text, each its first paragraph on one line. */
export function paragraphs(text) {
  const lines = text.split("\n");
  const items = [];
  lines.forEach((line, i) => {
    if (!/^- \*\*/.test(line)) return;
    let item = line;
    for (
      let j = i + 1;
      j < lines.length && /^ {2}\S/.test(lines[j]) && !/^ {2}- /.test(lines[j]);
      j++
    )
      item += " " + lines[j].trim();
    items.push(item);
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
    `No recorded design decision covers what you are writing here (nothing in ${catalogue}/ matches this file, its name, or the text).`,
    `Before building a control nothing covers: did ${who} say how it should work and look? If not, ask them with one question and three choices: research how the product people already know does it (the design-research skill: name the product, match the nearest pattern this project has, keep its look), let them decide, or make your own call. Whatever is chosen, add the entry to ${catalogue}/ with its tier (a person's name, \`as <product> does\`, or \`the agent's choice\`) and today's date in the same change, and add the control's word to that file's \`signals\`.`,
  ].join("\n");
}

export function isPerson(tag) {
  return !/^as .+ does\b/.test(tag) && !/^the agent's choice\b/.test(tag);
}

/** A signal's word as a prefix to find in an entry: "delete" becomes "delet", which "Deleting" and "deleted" carry. */
export function stem(signalSource) {
  const word = signalSource
    .replace(/\\b/g, "")
    .replace(/^[<\\]+/, "")
    .replace(/[^\w].*$/, "");
  return word.length > 5 ? word.slice(0, 5) : word;
}

/**
 * The context to add for writing `text` into `rel` (a path relative to the
 * project's root), or "" for none. `ui` is the project file's globs as
 * regular expressions, `catalogue` its directory, `who` the owner.
 */
export function contextFor(rel, text, files, { ui = [], catalogue = "", who = "the owner" } = {}) {
  if (!ui.some((p) => p.test(rel))) return "";
  // A word of the file's name counts only when it is specific: an ordinary
  // word ("remove", "member") names rules in a dozen files and would drown
  // the ones that matter.
  const all = files.flatMap((f) => f.entries);
  const anyWords = nameWords(rel);
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
    if (isPerson(entry.tag)) people.push(entry);
    else others++;
  };
  // Files found by the text's signals or by path come first, then those
  // whose rules name the file; the rules listed follow the same order.
  const found = files
    .map((f) => {
      const byPath = f.globs.some((g) => g.test(rel));
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
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_FILES);
  for (const { f, byPath, signal, hits } of found) {
    hits.forEach(take);
    const why = signal
      ? `the text you are writing looks like ${signal.source.replace(/\\b|\\/g, "")}`
      : byPath
        ? "it governs this file"
        : "its rules name this control";
    pointers.push(`${catalogue}/${f.name} (${f.entries.length} rules; ${why})`);
    if (byPath && !hits.length) f.entries.forEach(take);
  }
  if (!pointers.length) return draws(text) ? nothingCovers(catalogue, who) : "";
  const lines = [
    `Recorded design decisions cover \`${rel}\`. Open before changing the control: ${pointers.join("; ")}.`,
  ];
  for (const e of people.slice(0, MAX_RULES)) {
    const rule = e.rule.length > 180 ? e.rule.slice(0, 177) + "..." : e.rule;
    lines.push(`- ${e.tag}: ${rule}`);
  }
  const more = Math.max(0, people.length - MAX_RULES) + others;
  if (more)
    lines.push(
      `- and ${more} more rule${more === 1 ? "" : "s"} there (a product's or the agent's choice).`,
    );
  lines.push(
    "A rule with a person's name is their call: do not change it or build against it; bring the reason to them and leave the control as it is, or, if they gave the new call in this session, update the entry with today's date and keep the old line struck through. A new control follows the rules above and gets its entry in the same change.",
  );
  return lines.join("\n");
}

function main() {
  const { found, catalogue, ui } = project(root);
  if (!found || !catalogue) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const file = input.tool_input?.file_path;
  if (!file) return;
  const rel = relative(root, file).replaceAll("\\", "/");
  if (rel.startsWith("..")) return;
  // A Write's content, an Edit's new_string, or every MultiEdit replacement.
  const text =
    input.tool_input.content ??
    input.tool_input.new_string ??
    (input.tool_input.edits || []).map((edit) => edit.new_string || "").join("\n");
  const dir = catalogue.replace(/\/$/, "");
  let files;
  try {
    files = readCatalogue(join(root, dir));
  } catch {
    return;
  }
  const context = contextFor(rel, text, files, {
    ui: ui.map(globToRegExp),
    catalogue: dir,
    who: owner(),
  });
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context },
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
