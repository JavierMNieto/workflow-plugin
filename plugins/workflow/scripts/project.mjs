// **The project's part of the workflow** (docs/workflow.md, "The project
// file"): `.claude/workflow.md`, its frontmatter read here by the hooks,
// its body by the agents. The frontmatter holds four shapes only (a
// scalar, a list of strings, a map of lists, a comment after `#`), parsed by
// hand so the plugin needs no dependency.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_FILE = join(".claude", "workflow.md");

/**
 * The frontmatter's keys: `key: value`; `key:` followed by `  - item` lines;
 * or `key:` followed by indented `name:` lines, each with its own `- item`
 * lines indented as deep or deeper, or with one item on its own line (`name: item`), a
 * map of lists (`deny`). A top-level key closes the map.
 */
export function frontmatter(text) {
  return readFrontmatter(text).values;
}

/**
 * The frontmatter as `frontmatter()` reads it (`values`), with the lines it
 * could not read (`unread`): `{ line, text, under, item }`, `line` the file's
 * line number, `under` the key the line sits under, `item` whether it is a
 * `- item` line. Comments and blank lines are not lines here.
 */
export function readFrontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const out = {};
  const unread = [];
  let list = null;
  let sub = null;
  let subIndent = 0;
  block.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\s*(#|$)/.test(line)) return;
    // The opening `---` is the file's line 1.
    const at = { line: index + 2, text: line.trim(), under: list, item: /^\s*-\s/.test(line) };
    const indent = /^\s*/.exec(line)[0].length;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      // An item belongs to the agent above when indented as deep as the
      // agent's line or deeper, as YAML reads it; a shallower one would join
      // a list it is not under (the deny key's review, 27 October; Javi).
      if (sub && indent < subIndent) unread.push(at);
      else (sub ? out[list][sub] : out[list]).push(unquote(item[1].trim()));
      return;
    }
    // An indented `name:` under a key with no value opens a sub-list there;
    // the key's value becomes a map the first time, with no prototype, so a
    // name is only ever a name. Under a list that has items already, the line
    // is skipped, as before the map: no item is lost. `name: item` on one line
    // is a sub-list of that one item, or the agent would be dropped unseen.
    const nested = /^\s+([\w:-]+):(?:\s+(.*))?$/.exec(line);
    if (nested && list) {
      if (Array.isArray(out[list])) {
        if (out[list].length) return;
        out[list] = Object.create(null);
      }
      sub = nested[1];
      subIndent = indent;
      // An agent named twice keeps both lists, or the first would be lost.
      out[list][sub] ??= [];
      const one = nested[2]?.trim();
      // A flow list (`[a, b]`) is no pattern: a regular expression would
      // read it as one class.
      if (one?.startsWith("[")) unread.push(at);
      else if (one) out[list][sub].push(unquote(one));
      return;
    }
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!pair) {
      unread.push(at);
      return;
    }
    const [, key, value] = pair;
    sub = null;
    if (value.trim() === "") {
      out[key] = [];
      list = key;
    } else {
      out[key] = unquote(value.trim());
      list = null;
    }
  });
  return { values: out, unread };
}

function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/** A plugin option's values, first that wins: exported to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`, then the user settings' `pluginConfigs`; the unset ones left out. */
function optionValues(key, env, settings) {
  let read = null;
  try {
    read = JSON.parse(readFileSync(settings, "utf8"));
  } catch {
    // No settings: unset there.
  }
  return [
    env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`],
    read?.pluginConfigs?.["workflow@workflow"]?.options?.[key],
  ]
    .filter(Boolean)
    .map(String);
}

/**
 * **The person the agents work for**, by the plugin's `owner` option:
 * exported to hooks as `CLAUDE_PLUGIN_OPTION_OWNER`, else read from the user
 * settings' `pluginConfigs`, else "the owner".
 */
export function owner(env = process.env, settings = USER_SETTINGS) {
  return optionValues("owner", env, settings)[0] || "the owner";
}

/**
 * **This machine's name in session names**, by the plugin's `machine`
 * option, read as `owner` is; unset, the hostname, which is what Claude
 * Code names a Remote Control session by. `{ name, set, rejected }`: the
 * first value of a hostname's characters (letters, digits, underscores,
 * dots and hyphens) is used; one that is not is passed over and named in
 * `rejected`, and the hostname gets the same characters, so a name the
 * queue gives is always one it reads back.
 */
export function machine(env = process.env, settings = USER_SETTINGS) {
  const values = optionValues("machine", env, settings);
  const label = values.find((one) => /^[\w.-]+$/.test(one));
  if (label) return { name: label, set: true, rejected: "" };
  return {
    name: hostname().replace(/[^\w.-]+/g, "-") || "this-machine",
    set: false,
    rejected: values[0] || "",
  };
}

/** This plugin's name, its agents' prefix (`workflow:executor`), from its manifest beside `scripts/`. */
export function pluginName(dir = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  try {
    return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name;
  } catch {
    return "workflow";
  }
}

/** Read once: the hooks ask on every call. */
const PLUGIN = pluginName();

/**
 * The plugin's agent a hook's input is for: `workflow:executor` or a bare
 * `executor` is "executor". Another plugin's agent of the same short name
 * (`other:reviewer`) is none of this plugin's, so "", and no list here holds
 * it (the deny key's review, 27 October).
 */
export function kindOf(input, plugin = PLUGIN) {
  const type = String(input?.agent_type || "");
  const colon = type.lastIndexOf(":");
  if (colon < 0) return type;
  return type.slice(0, colon) === plugin ? type.slice(colon + 1) : "";
}

/**
 * Whether a pattern compiles alone. One that does has its parentheses
 * balanced outside escapes and classes, so wrapped in `^(?:...)$` it cannot
 * close the group early and match more than whole names (`mcp__a)|(.*`, the
 * deny key's review, 27 October).
 */
export function compiles(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Whether one of `patterns` matches `name` whole, as `tools` and `deny` are read; a pattern that does not compile alone never matches. */
export function matches(patterns, name) {
  return patterns.some((pattern) => compiles(pattern) && new RegExp(`^(?:${pattern})$`).test(name));
}

/**
 * One alternative at the top of a `deny` pattern widened to its connector's
 * every tool, when it names a connector alone, the old `disallowedTools`
 * form (`mcp__claude_ai_lab`, `^mcp__lab$`): literal characters, groups and
 * alternatives only between optional anchors, a name starting `mcp__`, and
 * no `__` once that start is set aside, so no tool's name
 * (`mcp__<server>__<tool>`) matches it whole. An `mcp__` inside a server's
 * name (`mcp__github_mcp__delete`) is no start. Else null.
 */
function connectorPart(alt) {
  const [, open, core, close] = /^(\^?)(.*?)(\$?)$/.exec(alt);
  const alone =
    /^[\w\-()|?:]+$/.test(core) &&
    /(^|[(|:])mcp__/.test(core) &&
    !core.replace(/(^|[(|:])mcp__/g, "$1").includes("__");
  return alone ? `${open}${core}__.*${close}` : null;
}

/** Whether a `deny` pattern, or one of its alternatives at the top, names a connector alone. */
export function connectorAlone(pattern) {
  return alternatives(pattern).some((alt) => connectorPart(alt) !== null);
}

/** A `deny` pattern as the hook reads it: each alternative naming a connector alone widened to `<it>__.*`, its every tool. */
export function everyTool(pattern) {
  return alternatives(pattern)
    .map((alt) => connectorPart(alt) ?? alt)
    .join("|");
}

/**
 * Whether a pattern could match an MCP tool's name (`mcp__...`): some way
 * through it agrees with `mcp__` as far as both go. Read left to right, a
 * literal must be the next character of `mcp__`, a group is read through
 * each of its alternatives, and anything else (a wildcard, a class, an
 * escape, a quantifier, a lookaround) could, so the pattern passes. An
 * alternation (`(mcp__a|mcp__b)__.*`) passes; `Bash` or `(Bash|Read)` does
 * not. For a pattern that compiles alone.
 */
export function couldNameMcp(pattern) {
  return alternatives(pattern).some((alt) => reaches(alt, "mcp__"));
}

const QUANTIFIER = "?*+{";
const META = "\\^$.|?*+()[]{}";

function reaches(alt, want) {
  for (let i = 0; i < alt.length; i++) {
    if (!want) return true;
    const c = alt[i];
    const quantified = QUANTIFIER.includes(alt[i + 1] ?? "x");
    if (c === "(") {
      const end = closing(alt, i);
      if (end < 0 || QUANTIFIER.includes(alt[end + 1] ?? "x")) return true;
      let inner = alt.slice(i + 1, end);
      if (inner.startsWith("?:")) inner = inner.slice(2);
      else if (/^\?<[^=!]/.test(inner)) inner = inner.replace(/^\?<[^>]*>/, "");
      else if (inner.startsWith("?")) return true;
      const rest = alt.slice(end + 1);
      return alternatives(inner).some((one) => reaches(one + rest, want));
    }
    if (c === "^") continue;
    if (META.includes(c) || quantified) return true;
    if (c !== want[0]) return false;
    want = want.slice(1);
  }
  return !want;
}

/** The index of the `]` closing the class opened at `open`, past escapes. */
function classEnd(s, open) {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "]") return i;
  }
  return s.length;
}

/** The index of the `)` closing the group opened at `open`, past escapes and classes; -1 when none. */
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") i = classEnd(s, i);
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** A pattern's alternatives at the top, past escapes, classes and groups. */
function alternatives(s) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") i = classEnd(s, i);
    else if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "|" && !depth) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

/** The plugin's agents, by their files in `agents/` beside `scripts/`, sorted: a new agent needs no edit here. */
export function pluginAgents(dir = join(dirname(fileURLToPath(import.meta.url)), "..", "agents")) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => basename(name, ".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The remote's default branch (`origin/HEAD`), else "main". With
 * `checkedOut`, when the file is written (`plans init`): in the folder's own
 * repository with no remote at all, the branch checked out (a new
 * repository's too, before its first commit), since it is the only one
 * there is. Never at run time, where the branch checked out is a batch's.
 */
export function defaultBranch(root, { checkedOut = false } = {}) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const remoteDefault = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(
    /^origin\//,
    "",
  );
  if (remoteDefault) return remoteDefault;
  if (checkedOut && existsSync(join(root, ".git")) && !git("remote"))
    return git("symbolic-ref", "--short", "HEAD") || "main";
  return "main";
}

/**
 * `{ name, branch, run, land, ui, catalogue, inherits, tools, mcp, deny,
 * written, form, reuse, reviews, body, found }` for the project
 * at `root`: the name defaults to the directory's, the branch to the
 * remote's default (else main; `plans init` writes the branch checked out
 * in a repository with no remote), `run`, `ui` and `catalogue` to none, `land` to
 * "push" ("pull-request" when the frontmatter says so: the executor opens a
 * pull request to the branch instead of pushing it), `form` to "full"
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
  const { values: front, unread } = readFrontmatter(text);
  // A map where a list belongs is no list.
  const list = (value) =>
    Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
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
    land: front.land === "pull-request" ? "pull-request" : "push",
    ui: list(front.ui),
    // A directory or one `.md` file; `inherits` the catalogues it overrides
    // by id, farthest first; `tools` the tool names (regular expressions)
    // whose calls change what a person sees; `mcp` the MCP configs every chat
    // here gets, from `plans chat` or `plans start`.
    catalogue: typeof front.catalogue === "string" ? front.catalogue : "",
    inherits: list(front.inherits),
    tools: list(front.tools),
    mcp: list(front.mcp),
    // `deny`: the MCP tool names (regular expressions) an agent here may
    // never call, by agent; a flat list under the key names no agent.
    deny:
      front.deny && typeof front.deny === "object" && !Array.isArray(front.deny)
        ? Object.fromEntries(
            Object.entries(front.deny).map(([agent, patterns]) => [agent, list(patterns)]),
          )
        : {},
    // The key as written beside the map above, and the lines the parser could
    // not read, for `plans check`: the file is parsed once.
    written: { deny: front.deny, unread },
    form: front.form === "compact" ? "compact" : "full",
    // The context, in tokens, above which a finished session retires.
    reuse: Number(front.reuse) > 0 ? Number(front.reuse) : 200_000,
    // The reviews before a push: all three in the full form, none in the
    // compact form, unless the project names its own.
    reviews: front.reviews
      ? list(front.reviews)
      : front.form === "compact"
        ? []
        : ["plan", "code-review", "codex"],
    body: text.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    found: Boolean(text),
  };
}

/** The starter file `plans init` writes, for a project with none. */
export function starter(root) {
  return `---
name: ${basename(root)}
branch: ${defaultBranch(root, { checkedOut: true })}
# run: checks.yml        the Actions workflow read after a push; omit for none
# land: pull-request    the executor opens a pull request to the branch instead of pushing it; omit to push
# ui:                    paths a user sees, for the turn audit; omit for none
#   - "src/components/**"
# catalogue: docs/patterns   the design catalogue the audit asks for; omit for none
# inherits:              catalogues this one overrides by id, farthest first
#   - ../.claude/decisions
# tools:                 tool names whose calls change what a person sees
#   - "mcp__server__write_.*"
# mcp:                   MCP configs every chat here gets (plans chat, plans start)
#   - .mcp/server.json
# deny:                  MCP tools an agent here may never call, by agent (regular expressions)
#   assistant:
#     - "mcp__server__write_.*"
# form: compact          one chat decides and builds; omit for the full queue
# reuse: 200000          the context, in tokens, above which a finished session retires (the cost wash is near 100000)
# reviews:               the reviews before a push: plan, code-review, codex, or a plugin skill; omit for all three
#   - code-review
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

/**
 * **The queue's kinds of file**, its deferrals: `<kind>.deferred` in a
 * project's `.claude/` for each (`plan-queue.mjs` reads, pauses and re-arms
 * every one), with `executor.lock`, `executor.pause` and the agents'
 * `executor.started` and `planner.started` under the same names. A kind
 * here is a deferral; `QUEUE_IGNORES` keeps all of their files out of git.
 */
export const QUEUE_KINDS = ["executor", "planner", "asking"];

/** The queue's own files in a project's `.claude/`, which git must not see: one line per kind. */
export const QUEUE_IGNORES = QUEUE_KINDS.map((kind) => `.claude/${kind}.*`);

/**
 * **A project set up earlier learns a new kind of file**: the
 * `QUEUE_IGNORES` lines git does not ignore yet in the checkout at `cwd`
 * go into the repository's `.git/info/exclude`, which git reads and never
 * tracks, so the line leaves the checkout clean. "Added <lines> to
 * .git/info/exclude." or "" (nothing missing, or not a repository).
 */
export function ignoreQueueFiles(cwd) {
  const run = (args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  const sample = (line) => line.replace("*", "x");
  const ignored = run(["check-ignore", "--no-index", ...QUEUE_IGNORES.map(sample)]);
  // 0: some are ignored, 1: none are; anything else is no repository.
  if (ignored.status !== 0 && ignored.status !== 1) return "";
  const seen = new Set(ignored.stdout.split("\n").map((line) => line.trim()));
  const unignored = QUEUE_IGNORES.filter((line) => !seen.has(sample(line)));
  if (!unignored.length) return "";
  const where = run(["rev-parse", "--git-path", "info/exclude"]);
  if (where.status !== 0) return "";
  const file = resolve(cwd, where.stdout.trim());
  try {
    mkdirSync(dirname(file), { recursive: true });
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // No exclude file yet.
    }
    // A line there already that git still does not honour is overridden by
    // the project's own rule (a `!.claude/**` in its .gitignore): written
    // once, never again.
    const missing = unignored.filter((line) => !text.split("\n").includes(line));
    if (!missing.length) return "";
    writeFileSync(
      file,
      `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
    return `Added ${missing.join(", ")} to .git/info/exclude.`;
  } catch {
    return "";
  }
}

/** Writes the starter file, or says why not. One line either way. */
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
