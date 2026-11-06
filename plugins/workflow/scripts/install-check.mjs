#!/usr/bin/env node
// An installed copy of the plugin can be cut off partway (2 November: three
// directories and five scripts missing, and nothing said so), so the plugin
// checks itself at every session's start (a SessionStart hook declared in
// the manifest) and before `plans` imports anything. It must stand alone,
// importing `node:` modules only, since any other file may be the missing one
// (docs/workflow.md, "Installing"; decisions.md#install-checks-itself).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
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
  "docs/landing.md",
  "docs/workflow.md",
  "hooks/hooks.json",
  "scripts/catalogue-context.mjs",
  "scripts/codex-review.sh",
  "scripts/cost.mjs",
  "scripts/github-app.mjs",
  "scripts/github-webhook.mjs",
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

const FOLDER =
  "This copy is loaded from a folder, not the plugins cache: put them back in that folder, " +
  "then start a new chat.";
const OLDER = "This copy is an older version that new chats do not load: start a new chat.";

/**
 * The line's last sentence for a copy at `root`, decided four ways in this
 * order. A root outside `<plugins>/cache/<marketplace>/<plugin>/<version>`
 * (`--plugin-dir`, a checkout: its root is a source) gets no command. A root
 * the install record beside the cache does not name is an older version,
 * which new chats do not load, and gets no command. With the marketplace's
 * clone at the copy's own commit, the files are put back from it in place,
 * deleting nothing, so chats running on the copy work again at their next
 * hook; else the newer version is installed beside it. The cache path is read
 * as `statusline.mjs`'s `data()` reads it, and the plugin's path in the
 * repository is `plugins/<plugin>`, as `marketplace.json`'s `source`
 * (`./plugins/workflow`) has it. `bin/plans` and the manifest's shell decide
 * the same way when this file is the one missing; a test holds the three.
 */
export function fix(root) {
  const cached = cache(root);
  if (!cached) return FOLDER;
  const { plugins, marketplace, plugin, version } = cached;
  if (!installed(plugins, root)) return OLDER;
  const clone = join(plugins, "marketplaces", marketplace);
  let head = "";
  try {
    head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    // No clone, or no git: the update form.
  }
  const command =
    head && head.startsWith(version)
      ? `git -C "${clone}" archive ${version}:plugins/${plugin} | tar -x -C "${root}"`
      : `claude plugin update ${plugin}@${marketplace}`;
  return `The fix: ${command}, then start a new chat.`;
}

/** The parts of a root under `<plugins>/cache/<marketplace>/<plugin>/<version>`, or null. */
function cache(root) {
  const parts = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(root);
  if (!parts) return null;
  const [, plugins, marketplace, plugin, version] = parts;
  return { plugins, marketplace, plugin, version };
}

/**
 * Whether the record beside the cache holds `root` as a path, matched as text
 * (the root as its JSON string), as the manifest's shell matches it with
 * `grep -F`; true with no record, so a plugins directory without one goes on
 * to the clone.
 */
function installed(plugins, root) {
  let record;
  try {
    record = readFileSync(join(plugins, "installed_plugins.json"), "utf8");
  } catch {
    return true;
  }
  if (record.includes(JSON.stringify(root))) return true;
  // Node gives this script its path with symlinks resolved, and the record
  // keeps the path as Claude Code wrote it: a folder above the cache that is a
  // symlink is the same copy, read both ways.
  try {
    const real = realpathSync(root);
    const paths = [...record.matchAll(/"installPath":\s*("(?:[^"\\]|\\.)*")/g)].map((m) =>
      JSON.parse(m[1]),
    );
    return paths.some((path) => {
      try {
        return realpathSync(path) === real;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** The line said when files are missing (plans/install-fix-every-path.md, The words, row 1). */
export function message(root, gone) {
  return (
    `The workflow plugin's installed copy is incomplete: ${gone.length} of its ${FILES.length} ` +
    `files ${gone.length === 1 ? "is" : "are"} missing from ${root}, and what is missing does not run in this chat. ` +
    `Missing: ${gone.join(", ")}. ${fix(root)}`
  );
}

/**
 * What the agent does with the line, said once here rather than in each agent
 * file (decisions.md#install-checks-itself): the question, its two options
 * with the description for the fix this copy gets, the check to run after it
 * and the words for each outcome. With no fix, say the line and stop.
 */
const QUESTION =
  "Some of the workflow plugin's files are missing from this machine's copy, so the queue's hooks and checks do not run in chats started now. Install the workflow plugin again?";

export function steps(root) {
  const stop =
    "Then stop: nothing else is done in this chat, since without the plugin's hooks there is " +
    "no lock, no audit and no Stop hook; the plan or brief this chat was started on waits for a new chat.";
  const how = fix(root);
  if (!how.startsWith("The fix: ")) return `Say this line to the owner in its own words. ${stop}`;
  const git = how.startsWith("The fix: git ");
  const { plugins, marketplace, plugin } = cache(root);
  const yes = git
    ? "Puts the missing files back into this copy from the marketplace's clone. Nothing is deleted, " +
      "and chats already running on this copy work again from their next hook. Then start a new " +
      "chat: this one may have loaded without the plugin's hooks."
    : "Installs the newer version beside this copy, which stays as it is: chats running on it, this " +
      "one too, keep failing at each hook until they are restarted. Nothing is deleted. Then start " +
      "a new chat, which loads the new version.";
  const after = git
    ? `\`node "${join(root, "scripts", "install-check.mjs")}"\``
    : `\`node <installPath>/scripts/install-check.mjs\`, the \`installPath\` that ` +
      `${join(plugins, "installed_plugins.json")} gives \`${plugin}@${marketplace}\` once the update is done`;
  const done = git
    ? `Put back: all ${FILES.length} files are there in ${root}. Start a new chat; this one may have loaded without the plugin's hooks.`
    : `Installed <version>: all ${FILES.length} files are there in <installPath>. Start a new chat; this one keeps running on the old copy.`;
  return (
    "Say this line to the owner in its own words first. Then ask once with the question tool, " +
    `headed "Install": "${QUESTION}", with the options "Yes, install it again (Recommended)" ` +
    `(${yes}) and "No, leave it" (Nothing is changed. The workflow's hooks do not run until the ` +
    `files are back.). On yes, run the fix, then ${after}. When it prints nothing, say "${done}"` +
    (git ? "" : " (<version> the new copy's last path segment)") +
    '; when it prints a line, say "The fix ran, but the copy is still incomplete:", then that ' +
    'line, then what the fix printed, a line each. On no, say "Left as it is. Start a new chat ' +
    `once the files are back." ${stop}`
  );
}

function main() {
  try {
    const root = join(here, "..");
    const gone = missing(root);
    if (!gone.length) return;
    const text = message(root, gone);
    // The owner sees the line; the agent gets the line and the steps.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `${text}\n\n${steps(root)}`,
        },
        systemMessage: text,
      }),
    );
  } catch {
    // A check that cannot run says nothing, which is the behavior without it.
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
