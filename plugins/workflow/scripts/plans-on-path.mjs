#!/usr/bin/env node
// The queue's command in the owner's own terminal. Claude Code puts a plugin's
// `bin/` on its Bash tool's PATH and nowhere else, so this SessionStart hook
// writes `plans` to `~/.local/bin`, where Claude Code's own installer puts
// `claude`: a shell wrapper that runs the copy Claude Code's install record
// names at each call (docs/workflow.md, "Installing").
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The install record's path and the plugin's key, from this script's own path
 * under `<plugins>/cache/<marketplace>/<plugin>/<version>/scripts`, as
 * `statusline.mjs`'s `data()` reads it; else the user's default record, left
 * unexpanded so the wrapper works for whoever runs it.
 */
export function source(scriptDir = here) {
  const cached = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]scripts$/.exec(
    scriptDir,
  );
  if (!cached) {
    return {
      record: "$HOME/.claude/plugins/installed_plugins.json",
      key: "workflow@workflow",
    };
  }
  // Inside the wrapper's double quotes these four would be read by the shell.
  const record = join(cached[1], "installed_plugins.json").replace(/[\\"$`]/g, "\\$&");
  return { record, key: `${cached[3]}@${cached[2]}` };
}

/** The wrapper's text, with the record's path and the plugin's key filled in. */
export const WRAPPER = (record, key) => `#!/bin/sh
# The workflow plugin's \`plans\`, written by its SessionStart hook
# (scripts/plans-on-path.mjs), which rewrites it when this text changes.
# It runs the copy installed now, read from Claude Code's install record
# at each call, so a plugin update never leaves it on an old copy.
record="${record}"
key="${key}"
command -v node >/dev/null 2>&1 || {
  echo "plans needs Node.js: node is not on this terminal's PATH." >&2
  exit 127
}
dir=$(node -e '
  const [record, key] = process.argv.slice(1);
  let entry;
  try {
    const j = JSON.parse(require("node:fs").readFileSync(record, "utf8"));
    entry = (j.plugins || j)[key];
  } catch {}
  if (Array.isArray(entry)) entry = entry[0];
  if (!entry || !entry.installPath) process.exit(1);
  process.stdout.write(entry.installPath);
' "$record" "$key") || {
  echo "The workflow plugin is not installed on this machine: $record names no $key. Install it with: claude plugin install $key" >&2
  exit 1
}
[ -f "$dir/bin/plans" ] || {
  echo "The workflow plugin's installed copy is gone: $record names $dir, which has no bin/plans. Install it again with: claude plugin update $key" >&2
  exit 1
}
exec node "$dir/bin/plans" "$@"
`;

/** Where the command goes: `WORKFLOW_BIN` (the tests), else `~/.local/bin`. */
export const binDir = (env = process.env) => env.WORKFLOW_BIN || join(homedir(), ".local", "bin");

const defaultText = () => {
  const { record, key } = source();
  return WRAPPER(record, key);
};

/**
 * Writes `<dir>/plans` when it is missing, or differs and is the plugin's (it
 * reads Claude Code's install record and runs a copy's `bin/plans`, as this
 * wrapper and the hand-written one before it do): "written"; "same" when the
 * text is already there; "foreign" when another program's file is there,
 * which is left as it is. A file it cannot read throws, and is left as well.
 */
export function install(dir = binDir(), text = defaultText()) {
  const target = join(dir, "plans");
  let old = null;
  try {
    old = readFileSync(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // No command there yet.
  }
  if (old === text) return "same";
  const ours = (t) => t.includes("installed_plugins.json") && t.includes("bin/plans");
  if (old !== null && !ours(old)) return "foreign";
  mkdirSync(dir, { recursive: true });
  // A terminal running `plans` at this instant gets the old file or the new, whole.
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return "written";
}

/** Whether `dir` is one of PATH's entries, as written (`~` is not expanded). */
export function onPath(dir, pathEnv = process.env.PATH || "") {
  const trim = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  return pathEnv.split(delimiter).some((entry) => entry && trim(entry) === trim(dir));
}

const PATH_LINE =
  '`plans` is a command at ~/.local/bin/plans, but ~/.local/bin is not on PATH in the terminal this chat was started from. To run it from a terminal, add `export PATH="$HOME/.local/bin:$PATH"` to your shell\'s startup file (~/.zshrc or ~/.bashrc), then open a new terminal.';
const FOREIGN_LINE =
  "~/.local/bin/plans exists and is not the workflow plugin's, so it was left as it is; the queue's command is still plans in a chat.";
const AGENT = "Say this line to the owner in a sentence, then go on with the work.";

function main() {
  const dir = binDir();
  let result;
  try {
    result = install(dir);
  } catch {
    // A write that failed leaves what was there, and nothing is said: the
    // behavior without the hook.
    return;
  }
  let text = null;
  if (result === "foreign") text = FOREIGN_LINE;
  // A line said once can land in a chat nobody reads, so the PATH line is said
  // at each start while PATH lacks the directory, and only in the owner's own
  // chats: one the queue started (marked WORKFLOW_STARTED by launch()) is read
  // by nobody.
  else if (!process.env.WORKFLOW_STARTED && !onPath(dir)) text = PATH_LINE;
  if (!text) return;
  // The owner sees the line; the agent gets the line and what to do with it.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${text}\n\n${AGENT}`,
      },
      systemMessage: text,
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
