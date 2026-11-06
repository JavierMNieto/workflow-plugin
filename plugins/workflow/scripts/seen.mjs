// **What the chat holds of each file, counted by its tool hook**
// (plans/shared-file-share.md, plans/shared-count-fixes.md;
// decisions.md#shared-is-what-is-held). A Read runs this script alone, not the
// queue: a bare node start rather than plan-queue.mjs loaded, after every Read
// in every session of every project with the plugin
// (decisions.md#reuse-check-cheap). The other tools' calls are counted by
// plan-queue.mjs's `wrote` mode, already loaded for them, with the same
// functions.
//
// The count is an append-only log, `workflow-seen-<id>.jsonl` in the temp
// folder, one short line per file per call: nothing is read before a write,
// and a short `O_APPEND` write lands whole beside another process's (POSIX
// open(2)), so parallel hooks lose nothing. `seenOf` sums it.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { kindOf } from "./project.mjs";

const here = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * The paths a brief or a planner's plan names: any path of two or more
 * segments with an extension, `plans/` and `.claude/` included
 * (plans/planner-continues.md, part 3), and a bare name whose extension
 * starts with a letter and has two characters or more, such as `CLAUDE.md`,
 * `vitest.config.ts` or `.mcp.json` (plans/shared-count-fixes.md, part 2),
 * so `5.1` and `e.g.` are not. The
 * callers keep only names that are files in the checkout, so a bare
 * `decisions.md` with no root file costs a stat and counts nothing.
 */
export function briefPaths(text) {
  const found = [
    ...(text.match(/(?<![\w/.:-])\.?[\w-]+(?:\/[\w.-]+)+\.\w+/g) || []),
    ...(text.match(/(?<![\w/.:-])\.?[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]\w+(?![\w/])/g) || []),
  ];
  return [...new Set(found)];
}

/** An absolute path with an extension in a shell command, for `seenIn`. */
const ABSOLUTE_PATH = /(?<![\w/.:-])\/(?:[\w.@+-]+\/)+[\w.@+-]*\.\w+/g;

/**
 * `path`, resolved from `cwd`, relative to `checkout` when it is a file there,
 * else "": a worktree's file under `.claude/worktrees/<name>/` by the path the
 * plans name it by.
 */
function fileIn(path, checkout, cwd = checkout) {
  if (typeof path !== "string" || !path) return "";
  const full = resolve(cwd, path);
  const rel = relative(checkout, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
  try {
    if (!statSync(full).isFile()) return "";
    return rel
      .split(sep)
      .join("/")
      .replace(/^\.claude\/worktrees\/[^/]+\//, "");
  } catch {
    // Named and not there: a ref, a pattern, a file not yet written.
    return "";
  }
}

/**
 * **This tool call's tokens, by file**: characters over four, credited to the
 * files its input names. A Read's text to its `file_path`; an Edit's
 * `old_string` and `new_string`, a MultiEdit's over its edits, a Write's
 * `content`, to their `file_path` (never the response, which may carry the
 * whole file); a Bash command's stdout and stderr split evenly among the
 * files the command names (an estimate: crediting the whole output to each
 * would overcount by their number). A path counts when, resolved from the
 * call's `cwd` and made relative to `checkout`, it is a file there. An image
 * or a PDF read counts nothing: its text is not what the chat holds. `{}`
 * when nothing is counted. No transcript is read and nothing reaches the
 * agent (decisions.md#reuse-check-cheap).
 */
export function seenIn(input = {}, { checkout = here() } = {}) {
  const args = input.tool_input || {};
  const response = input.tool_response;
  const size = (value) =>
    value == null ? 0 : typeof value === "string" ? value.length : JSON.stringify(value).length;
  const edit = (one) => size(one?.old_string) + size(one?.new_string);
  let chars = 0;
  let named = [args.file_path];
  const binary =
    /^(image|pdf)$/.test(String(response?.type || "")) || response?.file?.base64 != null;
  if (input.tool_name === "Read") chars = binary ? 0 : size(response?.file?.content ?? response);
  else if (input.tool_name === "Edit") chars = edit(args);
  else if (input.tool_name === "MultiEdit")
    chars = (args.edits || []).reduce((sum, one) => sum + edit(one), 0);
  else if (input.tool_name === "Write") chars = size(args.content);
  else if (input.tool_name === "Bash") {
    chars = size(response?.stdout) + size(response?.stderr);
    const command = String(args.command || "");
    named = [...briefPaths(command), ...(command.match(ABSOLUTE_PATH) || [])];
  } else return {};
  if (!(chars > 0)) return {};
  const cwd = input.cwd || checkout;
  const paths = [...new Set(named.map((path) => fileIn(path, checkout, cwd)).filter(Boolean))];
  const each = paths.length ? Math.round(chars / 4 / paths.length) : 0;
  if (!(each > 0)) return {};
  return Object.fromEntries(paths.map((path) => [path, each]));
}

/** The session's count, beside its state in the temp folder. */
export function seenFile(sessionId, dir = tmpdir()) {
  return join(dir, `workflow-seen-${sessionId || "unknown"}.jsonl`);
}

/**
 * Appends `map` to the session's log in one write, one line per path, each
 * under a hundred bytes for a path of ordinary length, so it lands whole
 * beside another hook's; nothing is read first. Nothing to append, nothing
 * written.
 */
export function noteSeen(sessionId, map = {}, dir = tmpdir()) {
  const lines = Object.entries(map)
    .filter(([, tokens]) => tokens > 0)
    .map(([p, t]) => `${JSON.stringify({ p, t })}\n`);
  if (lines.length) appendFileSync(seenFile(sessionId, dir), lines.join(""));
}

/** What the session read or wrote of each file, in tokens: its log summed per path; `{}` with none. */
export function seenOf(sessionId, dir = tmpdir()) {
  let text = "";
  try {
    text = readFileSync(seenFile(sessionId, dir), "utf8");
  } catch {
    return {};
  }
  const seen = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const { p, t } = JSON.parse(line);
      if (typeof p === "string" && t > 0) seen[p] = (seen[p] || 0) + t;
    } catch {
      // A line cut short: passed over.
    }
  }
  return seen;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  // A planner's or an executor's call only; a subagent's carries its own
  // `agent_type`, so it returns.
  const kind = kindOf(input);
  if (kind !== "planner" && kind !== "executor") return;
  try {
    noteSeen(input.session_id, seenIn(input, { checkout: here() }));
  } catch (error) {
    process.stderr.write(`seen: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
