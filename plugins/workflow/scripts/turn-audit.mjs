#!/usr/bin/env node
// Claude Code hook in three parts (docs/workflow.md, "The turn audit"):
//
//   turn-audit.mjs prompt   on UserPromptSubmit: remembers the prompt, the
//                           session's agent and a snapshot of the working
//                           tree's changed files
//   turn-audit.mjs tool     on PostToolUse: appends what this session's
//                           own tools could have written to its log
//   turn-audit.mjs stop     on Stop: once per turn, refuses the stop with a
//                           reason when the turn changed more than it was
//                           asked for, or changed a UI file without the
//                           catalogue
//
// **A session is charged only with its own writes**:
// the snapshot is of the tree, which every session in the checkout shares,
// so a planner stopping beside a building executor was once asked about the
// executor's files. The paths its editing tools wrote are judged; a shell
// command that could write makes it answer for the whole tree, as before,
// since only a building session does that; a session whose tools wrote
// nothing is asked only whether a request that read like a preference
// decided anything, and the planner and the assistant are never audited.
//
// The agent is the judge; the hook makes sure the question is asked. The
// refusal is one per turn: the second Stop passes (stop_hook_active, and the
// state's `audited` flag), so nothing can loop. No model call. State lives in
// the OS temp directory under the session id, never in the repository.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { kindOf, matches, owner, project } from "./project.mjs";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A path glob (`*`, `**`, `{a,b}`) as a regular expression over repository paths. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      re +=
        "(?:" +
        glob
          .slice(i + 1, end)
          .split(",")
          .map(escape)
          .join("|") +
        ")";
      i = end;
    } else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}

/** Whether a path is in a catalogue location: the file itself, or under the directory. */
function inCatalogue(path, location) {
  const at = location.replace(/\/$/, "");
  return Boolean(at) && (path === at || path.startsWith(`${at}/`));
}

/** The paths a user sees, the catalogue that records them and the catalogue's changed files' text. */
function uiRule(changed = []) {
  const { ui, catalogue, inherits } = project(root);
  const texts = {};
  for (const file of changed.filter((f) =>
    [catalogue, ...inherits].some((at) => inCatalogue(f, at)),
  )) {
    try {
      texts[file] = readFileSync(join(root, file), "utf8");
    } catch {
      // Deleted this turn: no rules to check.
    }
  }
  return { ui: ui.map(globToRegExp), catalogue, inherits, texts, who: owner() };
}

function statePath(sessionId) {
  return join(tmpdir(), `workflow-turn-${sessionId || "unknown"}.json`);
}

/**
 * The turn's tool events, one JSON line each, appended rather than read and
 * written back: tools run in parallel, and so do their hooks, so a shared
 * read-modify-write lost an event. Folded into the state at the stop.
 */
function toolsPath(sessionId) {
  return join(tmpdir(), `workflow-turn-${sessionId || "unknown"}.tools`);
}

/** Every changed or untracked file in the tree, with its size and mtime. */
export function treeFiles(dir = root) {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: dir,
    encoding: "utf8",
  });
  const files = {};
  // With -z, a rename or a copy is `R  <new>\0<old>\0`: the old path is the
  // next field, never ` -> ` (git-status, "Porcelain Format Version 1").
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    // In either status column: a rename against the index or the worktree.
    if (/^[RC]|^.[RC]/.test(entry)) i++;
    const path = entry.slice(3);
    try {
      const s = statSync(join(dir, path));
      files[path] = [s.size, Math.round(s.mtimeMs)];
    } catch {
      files[path] = [0, 0]; // deleted
    }
  }
  return files;
}

/** The files that differ from the snapshot: new, deleted, or changed in size or mtime. */
export function changedSince(snapshot, now) {
  const changed = new Set();
  for (const [p, v] of Object.entries(now))
    if (!snapshot[p] || snapshot[p][0] !== v[0] || snapshot[p][1] !== v[1]) changed.add(p);
  for (const p of Object.keys(snapshot)) if (!now[p]) changed.add(p);
  return [...changed].sort();
}

/** The sessions that only read and write `plans/`, which git does not see. */
const READERS = new Set(["planner", "assistant"]);

/** The editing tools, whose `file_path` is what they wrote. */
const EDITORS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * A command the reading sessions run, which writes nothing: a list, not a
 * parser, and anything it does not know counts as writing, which only makes
 * the audit run as it always did.
 */
const READ_ONLY =
  /^(cd|pwd|echo|cat|head|tail|sed -n|grep|rg|ls|wc|find|sort|uniq|cut|tr|jq|git(?: -C \S+| --no-pager)* (status|log|diff|show|fetch|merge-base|rev-parse|ls-files|grep)|npm (ls|view))\b|^git(?: -C \S+| --no-pager)* branch(?: --show-current| --list| -[avr]+| --contains \S+| --merged)?\s*$/;
// What runs other code or writes by a flag also counts as writing: command
// substitution and process substitution, `eval`, `exec`, `source` and `.`,
// `--output`, `sort -o`, and find's `-execdir`, `-ok` and `-fprint`; `node`
// is not on the list at all, since it runs whatever it is given.
const WRITES =
  />|\|\s*(tee|sed -i)|\bsed -i\b|\bmv |\bcp |\brm |-delete\b|-exec\b|-execdir\b|-ok(dir)?\b|-fprint|\$\(|`|<\(|\beval\b|\bexec\b|\bsource\b|^\s*\.\s|--output|\bsort\b[^|;&\n]*\s-o\b|\bnpm (run|install|ci)\b|\bnpx\b|\bgit (add|commit|push|switch|checkout|reset|rebase|stash|worktree)\b/m;

/** Whether a shell command could write to the tree: every command of a pipeline or a list must read only. */
export function shellWrites(command) {
  if (WRITES.test(command)) return true;
  const parts = command
    .split(/\|\||&&|;|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return !parts.every((part) => READ_ONLY.test(part));
}

/** A tool this session ran, remembered in its state: the path an editing tool wrote, or a writing shell. */
export function recordTool(state, input, dir = root, tools = []) {
  const name = input.tool_name;
  const args = input.tool_input || {};
  // **A tool call is a change** when the project's `tools` names it: the
  // audit counts it as it counts a `ui` path.
  if (name && matches(tools, name)) {
    state.calls = [...(state.calls || []), name];
    return state;
  }
  if (EDITORS.has(name)) {
    const file = args.file_path || args.notebook_path;
    if (file) {
      const path = relative(dir, resolve(dir, file));
      state.wrote = state.wrote || [];
      if (!state.wrote.includes(path)) state.wrote.push(path);
    }
  } else if (name === "Bash" && shellWrites(args.command || "")) {
    state.shell = true;
  }
  return state;
}

/**
 * The files this session answers for: the whole tree's changes when it ran
 * a writing shell command, else those of its changes its own editing tools
 * wrote, else none.
 */
export function listToJudge(state, now) {
  const changed = changedSince(state.files, now);
  if (state.shell) return changed;
  const wrote = new Set(state.wrote || []);
  return changed.filter((file) => wrote.has(file));
}

/** A rule's tier and date, as the catalogue writes them (the first project's check). */
const TIER =
  /\((?:\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'-]+)*|as .+? do(?:es)?|per .+?|observed in .+?|the agent's choice), (?:\d{1,2} [A-Z][a-z]+(?: \d{4})?|\d{4}-\d{2}-\d{2})(?:,[^)]*)?\)/u;

/**
 * The rules of a catalogue file without their tier and date: each rule is a
 * list item opening with bold text, read as its first paragraph (its
 * continuation lines, up to a nested item).
 */
export function untiered(text) {
  const lines = text.split("\n");
  const missing = [];
  lines.forEach((line, i) => {
    // A rule may open with its id in backticks: - `id` **Rule.** (tier, date)
    if (!/^- (?:`[\w.-]+` )?\*\*/.test(line)) return;
    let rule = line;
    for (
      let j = i + 1;
      j < lines.length && /^ {2}\S/.test(lines[j]) && !/^ {2}- /.test(lines[j]);
      j++
    )
      rule += " " + lines[j].trim();
    if (!TIER.test(rule)) missing.push(rule.slice(2));
  });
  return missing;
}

/** Today as a catalogue entry writes it: "27 October". */
function entryDay(now = new Date()) {
  return now.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/** The reason to refuse the stop, or "" to let it pass. */
export function reasonFor(
  changed,
  prompt,
  lastMessage,
  {
    ui: uiPaths = [],
    catalogue = "",
    inherits = [],
    texts = {},
    who = "the owner",
    day = entryDay(),
    calls = [],
    wrote = [],
  } = {},
) {
  const reasons = [];
  const outside = changed.length > 1 && changed.some((f) => dirname(f) !== dirname(changed[0]));
  if (changed.length > 1 || outside) {
    reasons.push(
      `This turn changed ${changed.length} files:\n${changed.map((f) => `- ${f}`).join("\n")}\n\nThe request was: "${prompt.slice(0, 400)}${prompt.length > 400 ? "..." : ""}"\n\nFor each file the request did not ask for, revert it, or say in your final message why the change was necessary. Change what was asked and keep the rest as it was.`,
    );
  }
  // **The stop check is on effect**: a path a user sees changed, or a tool
  // that changes what they see was called, and nothing in the catalogue was
  // written, is asked once; `decisions: none (why)` answers it.
  const under = catalogue.replace(/\/$/, "");
  const ui = catalogue ? changed.filter((f) => uiPaths.some((p) => p.test(f))) : [];
  const made = catalogue ? calls : [];
  const recorded = [...changed, ...wrote].some((f) =>
    [catalogue, ...inherits].some((at) => inCatalogue(f, at)),
  );
  if ((ui.length || made.length) && !recorded && !/decisions: none/.test(lastMessage)) {
    const parts = [];
    if (ui.length)
      parts.push(
        `${ui.length} file${ui.length === 1 ? "" : "s"} a user sees changed (${ui.slice(0, 4).join(", ")}${ui.length > 4 ? ", ..." : ""})`,
      );
    if (made.length)
      parts.push(
        `${made.length} call${made.length === 1 ? "" : "s"} to ${[...new Set(made)].slice(0, 4).join(", ")} ${made.length === 1 ? "was" : "were"} made`,
      );
    reasons.push(
      `${parts.join(" and ")}, and nothing under ${under} did. Add or update the entry in ${under} in this turn, as the Decisions rules say, or say why not in your final message with the line: decisions: none (why).`,
    );
  }
  // **Every rule carries its tier and date**: a catalogue file this turn
  // changed, with a rule that does not, is asked for them.
  // The README explains the format and holds no tiered rules of its own.
  const ruleFiles = catalogue
    ? [...new Set([...changed, ...wrote])].filter(
        (f) =>
          [catalogue, ...inherits].some((at) => inCatalogue(f, at)) && basename(f) !== "README.md",
      )
    : [];
  // The name the tier suggests is one the check accepts.
  const person = /^\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'-]+)*$/u.test(who) ? who : "<a person's name>";
  for (const file of ruleFiles) {
    const missing = untiered(texts[file] || "");
    if (!missing.length) continue;
    const first = missing[0].length > 80 ? `${missing[0].slice(0, 77)}...` : missing[0];
    reasons.push(
      `${file} has ${missing.length} rule${missing.length === 1 ? "" : "s"} without a tier and date: "${first}". Every rule ends with who it rests on and when: (${person}, ${day}), (as GitHub does, ${day}) or (the agent's choice, ${day}).`,
    );
  }
  return reasons.join("\n\n");
}

function main() {
  const mode = process.argv[2];
  // A project with no project file is not the workflow's (as the queue's hooks).
  if (!project(root).found) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const path = statePath(input.session_id);
  if (mode === "prompt") {
    // Outside git (a compact project may have none) the snapshot is empty,
    // and the turn is judged on its own writes and calls.
    let files = {};
    try {
      files = treeFiles();
    } catch {
      files = {};
    }
    writeFileSync(
      path,
      JSON.stringify({
        prompt: input.prompt || "",
        agent: kindOf(input),
        files,
        audited: false,
        wrote: [],
        shell: false,
      }),
    );
    writeFileSync(toolsPath(input.session_id), "");
    return;
  }
  if (mode === "tool") {
    const { tool_name, tool_input } = input;
    // An MCP call counts only in a project whose `tools` names some.
    if (String(tool_name || "").startsWith("mcp__") && !project(root).tools.length) return;
    const { file_path, notebook_path, command } = tool_input || {};
    appendFileSync(
      toolsPath(input.session_id),
      `${JSON.stringify({ tool_name, tool_input: { file_path, notebook_path, command } })}\n`,
    );
    return;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  if (mode !== "stop" || input.stop_hook_active || state.audited) return;
  const { tools } = project(root);
  try {
    for (const line of readFileSync(toolsPath(input.session_id), "utf8").split("\n")) {
      if (line) recordTool(state, JSON.parse(line), root, tools);
    }
  } catch {
    // No tools ran this turn, or the log is gone: nothing more to fold in.
  }
  state.audited = true;
  writeFileSync(path, JSON.stringify(state));
  const reader = READERS.has(state.agent || kindOf(input));
  if (reader) return;
  // A turn whose tools wrote nothing may still have called a tool that
  // changes what a person sees.
  if (!state.shell && !(state.wrote || []).length && !(state.calls || []).length) return;
  let changed = [];
  if (state.shell || (state.wrote || []).length) {
    try {
      changed = listToJudge(state, treeFiles());
    } catch {
      // No git: the paths its own editing tools wrote.
      changed = [...(state.wrote || [])].sort();
    }
  }
  const reason = reasonFor(changed, state.prompt, input.last_assistant_message || "", {
    ...uiRule([...new Set([...changed, ...(state.wrote || [])])]),
    calls: state.calls || [],
    wrote: state.wrote || [],
  });
  if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
