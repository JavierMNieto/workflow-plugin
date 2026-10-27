#!/usr/bin/env node
// Claude Code's status line (the `statusLine` user setting), for every
// session alike: one short line, `<model> · context <n>% · 5h <n>% · 7d <n>%`,
// and the subscription's usage written to `usage.json` in the plugin's data
// directory, which the plan queue reads before it starts a session
// (docs/workflow.md, "The queue"). The status line's JSON is the one
// documented place a script gets these numbers; `rate_limits` appears only
// after a session's first model call, and until then the file is left as it
// was.
//
// A plugin cannot set `statusLine`, and its own path changes with every
// version, so `statusline.mjs install` (a SessionStart hook) copies this
// script into the data directory, a path that does not change, and the user
// setting runs that copy.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The plugin's data directory, as `plan-queue.mjs`'s `data()` finds it, never
 * from `CLAUDE_PLUGIN_DATA` (which can name another plugin's); kept here so
 * the copy in that directory needs nothing beside it.
 */
function data(env = process.env, scriptDir = here) {
  if (env.WORKFLOW_DATA) return env.WORKFLOW_DATA;
  const cached = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]scripts$/.exec(
    scriptDir,
  );
  if (cached) return join(cached[1], "data", `${cached[3]}-${cached[2]}`);
  return join(homedir(), ".claude", "plugins", "data", "workflow-workflow");
}

/** Run from the data directory, the file beside it; else the data directory's. */
const usageFile = () =>
  process.env.WORKFLOW_USAGE_FILE ||
  join(basename(here) === "scripts" ? data() : here, "usage.json");

/** Copies this script to `<data>/statusline.mjs` when the two differ; true when it copied. */
export function install(dir = data(), self = fileURLToPath(import.meta.url)) {
  const target = join(dir, "statusline.mjs");
  let same = false;
  try {
    same = readFileSync(target, "utf8") === readFileSync(self, "utf8");
  } catch {
    // No copy yet.
  }
  if (same) return false;
  mkdirSync(dir, { recursive: true });
  copyFileSync(self, target);
  return true;
}

const pct = (n) => `${Math.round(n)}%`;

/** The line to print, and the usage to write or null, from the status line's JSON. */
export function statusFrom(input, now = Date.now()) {
  const parts = [input.model?.display_name || "Claude"];
  const context = input.context_window?.used_percentage;
  if (typeof context === "number") parts.push(`context ${pct(context)}`);
  const limits = input.rate_limits || {};
  const five = limits.five_hour;
  const seven = limits.seven_day;
  if (five) parts.push(`5h ${pct(five.used_percentage)}`);
  if (seven) parts.push(`7d ${pct(seven.used_percentage)}`);
  const usage =
    five || seven
      ? {
          at: Math.round(now / 1000),
          ...(five && { five_hour: five }),
          ...(seven && { seven_day: seven }),
        }
      : null;
  return { line: parts.join(" · "), usage };
}

function main() {
  if (process.argv[2] === "install") {
    try {
      install();
    } catch {
      // A copy that failed leaves the old one, or none: the line is not drawn.
    }
    return;
  }
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Nothing readable: print the bare line.
  }
  const { line, usage } = statusFrom(input);
  if (usage) {
    try {
      const file = usageFile();
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(usage));
      renameSync(temp, file);
    } catch {
      // The line still prints; the queue reads the usage as unknown.
    }
  }
  process.stdout.write(`${line}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
