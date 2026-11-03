#!/usr/bin/env node
// An installed copy of the plugin can be cut off partway (2 November: three
// directories and five scripts missing, and nothing said so), so the plugin
// checks itself at every session's start (a SessionStart hook declared in
// the manifest) and before `plans` imports anything. It must stand alone,
// importing `node:` modules only, since any other file may be the missing one
// (docs/workflow.md, "Installing"; decisions.md#install-checks-itself).
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Every tracked file of `plugins/workflow`; `test/plugin.test.ts` fails while
// this differs from `git ls-files plugins/workflow`.
export const FILES = [
  ".claude-plugin/plugin.json",
  "agents/assistant.md",
  "agents/executor.md",
  "agents/maker.md",
  "agents/planner.md",
  "agents/reviewer.md",
  "bin/plans",
  "docs/decisions.md",
  "docs/workflow.md",
  "hooks/hooks.json",
  "scripts/catalogue-context.mjs",
  "scripts/codex-review.sh",
  "scripts/install-check.mjs",
  "scripts/plain-words.mjs",
  "scripts/plan-queue.d.mts",
  "scripts/plan-queue.mjs",
  "scripts/project.mjs",
  "scripts/statusline.d.mts",
  "scripts/statusline.mjs",
  "scripts/tool-denials.mjs",
  "scripts/turn-audit.d.mts",
  "scripts/turn-audit.mjs",
  "settings.json",
  "skills/change/SKILL.md",
  "skills/design-research/SKILL.md",
  "skills/setup/SKILL.md",
  "skills/setup/kinds.md",
];

/** The paths of `FILES` that are not a file of size above zero under `root`; `[]` when whole. */
export function missing(root = join(here, "..")) {
  return FILES.filter((path) => {
    try {
      const stat = statSync(join(root, path));
      return !stat.isFile() || stat.size === 0;
    } catch {
      return true;
    }
  });
}

/** The fix command for a copy at `root`. */
export const FIX = (root) => `rm -r "${root}" && claude plugin install workflow@workflow`;

/** The line said when files are missing (plans/install-checks-itself.md, The words, row 1). */
export function message(root, gone) {
  return (
    `The workflow plugin's installed copy is incomplete: ${gone.length} of its ${FILES.length} ` +
    `files are missing from ${root}, and what is missing does not run in this chat. ` +
    `Missing: ${gone.join(", ")}. Install it again: ${FIX(root)}, then start a new chat.`
  );
}

function main() {
  try {
    const root = join(here, "..");
    const gone = missing(root);
    if (!gone.length) return;
    const text = message(root, gone);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
        systemMessage: text,
      }),
    );
  } catch {
    // A check that cannot run says nothing, which is the behavior without it.
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
