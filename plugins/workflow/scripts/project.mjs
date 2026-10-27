// **The project's part of the workflow** (docs/workflow.md, "The project
// file"): `.claude/workflow.md`, its frontmatter read here by the hooks,
// its body by the agents. The frontmatter holds three shapes only (a
// scalar, a list of strings, a comment after `#`), parsed by hand so the
// plugin needs no dependency.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const PROJECT_FILE = join(".claude", "workflow.md");

/** The frontmatter's keys: `key: value`, or `key:` followed by `  - item` lines. */
export function frontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const out = {};
  let list = null;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      out[list].push(unquote(item[1].trim()));
      continue;
    }
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value.trim() === "") {
      out[key] = [];
      list = key;
    } else {
      out[key] = unquote(value.trim());
      list = null;
    }
  }
  return out;
}

function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/**
 * **The person the agents work for**, by the plugin's `owner` option:
 * exported to hooks as `CLAUDE_PLUGIN_OPTION_OWNER`, else read from the user
 * settings' `pluginConfigs`, else "the owner".
 */
export function owner(env = process.env, settings = join(homedir(), ".claude", "settings.json")) {
  if (env.CLAUDE_PLUGIN_OPTION_OWNER) return env.CLAUDE_PLUGIN_OPTION_OWNER;
  let read = null;
  try {
    read = JSON.parse(readFileSync(settings, "utf8"));
  } catch {
    // No settings: the default.
  }
  return read?.pluginConfigs?.["workflow@workflow"]?.options?.owner || "the owner";
}

/** The remote's default branch (`origin/HEAD`), or "main". */
export function defaultBranch(root) {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return ref.replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

/**
 * `{ name, branch, run, ui, catalogue, form, body, found }` for the project
 * at `root`: the name defaults to the directory's, the branch to the
 * remote's default, `run`, `ui` and `catalogue` to none, `form` to "full"
 * ("compact" when the frontmatter says so: one chat, no queue).
 */
export function project(root) {
  const file = join(root, PROJECT_FILE);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // No project file: the defaults.
  }
  const front = frontmatter(text);
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  // The remote's default is asked of git only when a caller reads the branch:
  // every hook reads `found`, in every session (/code-review, 27 October).
  let branch = typeof front.branch === "string" && front.branch ? front.branch : null;
  return {
    name: typeof front.name === "string" && front.name ? front.name : basename(root),
    get branch() {
      branch ??= defaultBranch(root);
      return branch;
    },
    run: typeof front.run === "string" ? front.run : "",
    ui: list(front.ui),
    catalogue: typeof front.catalogue === "string" ? front.catalogue : "",
    form: front.form === "compact" ? "compact" : "full",
    body: text.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    found: Boolean(text),
  };
}

/** The starter file `plans init` writes, for a project with none. */
export function starter(root) {
  return `---
name: ${basename(root)}
branch: ${defaultBranch(root)}
# run: checks.yml        the Actions workflow read after a push; omit for none
# ui:                    paths a user sees, for the turn audit; omit for none
#   - "src/components/**"
# catalogue: docs/patterns   the design catalogue the audit asks for; omit for none
# form: compact          one chat decides and builds; omit for the full queue
---

# This project's part of the workflow

## Before a build

What a fresh branch needs before the first edit: installs, generated code.

## While working

Which tests to run for one change, and how.

## Before the push

The screenshots, checks and suites, in order, once per batch.

## After the push

What to watch once the push is in: the run, the deploy.

## Reading

Which tools read code and docs here, if the project has a rule.
`;
}

/** Writes the starter file, or says why not. One line either way. */
/** The queue's own files in a project's `.claude/`, which git must not see. */
export const QUEUE_IGNORES = [".claude/executor.*", ".claude/planner.*"];

export function init(root) {
  const file = join(root, PROJECT_FILE);
  if (existsSync(file)) return `${PROJECT_FILE} exists already; edit it instead.`;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(file, starter(root));
  // The lock, the pause and the deferrals stay out of git, or a clean start
  // finds them (the Claude review, 27 October).
  const ignore = join(root, ".gitignore");
  let text = "";
  try {
    text = readFileSync(ignore, "utf8");
  } catch {
    // No .gitignore yet.
  }
  const missing = QUEUE_IGNORES.filter((line) => !text.split("\n").includes(line));
  if (missing.length)
    writeFileSync(
      ignore,
      `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  return `Wrote ${PROJECT_FILE}: fill in each heading for this project.`;
}
