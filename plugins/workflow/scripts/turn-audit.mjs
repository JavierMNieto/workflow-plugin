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
// nothing, and the planner and the assistant always, are not audited.
//
// The agent is the judge; the hook makes sure the question is asked. The
// refusal is one per turn: the second Stop passes (stop_hook_active, and the
// state's `audited` flag), so nothing can loop. No model call. State lives in
// the OS temp directory under the session id, never in the repository.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { project } from "./project.mjs";

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

/** The paths a user sees and the catalogue that records them, from the project file. */
function uiRule() {
  const { ui, catalogue } = project(root);
  return { ui: ui.map(globToRegExp), catalogue };
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
  for (const entry of out.split("\0").filter(Boolean)) {
    const path = entry.slice(3).split(" -> ").pop();
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

/** The agent a hook's input is for: the last part of `agent_type` (`workflow:planner`, `planner`). */
function kindOf(input) {
  return String(input?.agent_type || "")
    .split(":")
    .at(-1);
}

/** The editing tools, whose `file_path` is what they wrote. */
const EDITORS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * A command the reading sessions run, which writes nothing: a list, not a
 * parser, and anything it does not know counts as writing, which only makes
 * the audit run as it always did.
 */
const READ_ONLY =
  /^(cd|pwd|echo|cat|head|tail|sed -n|grep|rg|ls|wc|find|sort|uniq|cut|tr|jq|git (status|log|diff|show|branch|fetch|merge-base|rev-parse|ls-files|grep)|node --input-type=module|npm (ls|view))\b/;
const WRITES =
  />|\|\s*(tee|sed -i)|\bsed -i\b|\bmv |\bcp |\brm |-delete\b|-exec\b|\bnpm (run|install|ci)\b|\bnpx\b|\bgit (add|commit|push|switch|checkout|reset|rebase|stash|worktree)\b/;

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
export function recordTool(state, input, dir = root) {
  const name = input.tool_name;
  const args = input.tool_input || {};
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

/** The reason to refuse the stop, or "" to let it pass. */
export function reasonFor(changed, prompt, lastMessage, { ui: uiPaths = [], catalogue = "" } = {}) {
  const reasons = [];
  const outside = changed.length > 1 && changed.some((f) => dirname(f) !== dirname(changed[0]));
  if (changed.length > 1 || outside) {
    reasons.push(
      `This turn changed ${changed.length} files:\n${changed.map((f) => `- ${f}`).join("\n")}\n\nThe request was: "${prompt.slice(0, 400)}${prompt.length > 400 ? "..." : ""}"\n\nFor each file the request did not ask for, revert it, or say in your final message why the change was necessary. Change what was asked and keep the rest as it was.`,
    );
  }
  // Only for a project whose file names both the paths a user sees and its catalogue.
  const ui = catalogue ? changed.filter((f) => uiPaths.some((p) => p.test(f))) : [];
  const under = `${catalogue.replace(/\/$/, "")}/`;
  const recorded = changed.some((f) => f.startsWith(under));
  if (ui.length && !recorded && !/patterns: none/.test(lastMessage)) {
    reasons.push(
      `${ui.length} file${ui.length === 1 ? "" : "s"} a user sees changed (${ui.slice(0, 4).join(", ")}${ui.length > 4 ? ", ..." : ""}) and nothing under ${under} did. Add or update the entry there, as the catalogue's rules say, or say why not in your final message with the line: patterns: none (why)`,
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
    let files = {};
    try {
      files = treeFiles();
    } catch {
      return;
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
  try {
    for (const line of readFileSync(toolsPath(input.session_id), "utf8").split("\n")) {
      if (line) recordTool(state, JSON.parse(line));
    }
  } catch {
    // No tools ran this turn, or the log is gone: nothing more to fold in.
  }
  state.audited = true;
  writeFileSync(path, JSON.stringify(state));
  const reader = READERS.has(state.agent || kindOf(input));
  if (reader || (!state.shell && !(state.wrote || []).length)) return;
  let now;
  try {
    now = treeFiles();
  } catch {
    return;
  }
  const changed = listToJudge(state, now);
  const reason = reasonFor(changed, state.prompt, input.last_assistant_message || "", uiRule());
  if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
