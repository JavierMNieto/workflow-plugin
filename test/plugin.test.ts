import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canStart,
  checkDeny,
  data,
  decideStop,
  isSession,
  machine,
  owner,
  parseName,
  sessionName,
  pathsIn,
  sessionEnv,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { FILES, missing, steps } from "../plugins/workflow/scripts/install-check.mjs";
import {
  defaultBranch,
  frontmatter,
  ignoreQueueFiles,
  init,
  kindOf,
  matches,
  project,
  QUEUE_IGNORES,
  QUEUE_KINDS,
} from "../plugins/workflow/scripts/project.mjs";
import {
  agentsChoice,
  globToRegExp,
  reasonFor,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";

// The end timer and the stops are recorded here, so no hook a test runs
// leaves a timer sleeping for an hour (plans/idle-chats-end.md).
process.env.WORKFLOW_STOP_LOG = join(tmpdir(), `workflow-stops-plugin-${process.pid}.log`);

const scripts = new URL("../plugins/workflow/scripts/", import.meta.url).pathname;
const made: string[] = [];
const dir = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
};
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

describe("the project file", () => {
  it("reads a backslashed value back as written", () => {
    const root = dir("note-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Paper\nnote: \\JaviAI   # the note command\nreply: \\javi\n---\n",
    );
    const text = readFileSync(join(root, ".claude", "workflow.md"), "utf8");
    expect(frontmatter(text)).toMatchObject({ note: "\\JaviAI", reply: "\\javi" });
  });

  it("reads name, branch, run, ui and catalogue", () => {
    const root = dir("project-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---
name: Docs   # the name in session names
branch: test
run: image.yml
ui:
  - "apps/*/src/**"
  - 'packages/ui/**'
catalogue: docs/patterns
---

# Body
`,
    );
    expect(project(root)).toMatchObject({
      name: "Docs",
      branch: "test",
      run: "image.yml",
      ui: ["apps/*/src/**", "packages/ui/**"],
      catalogue: "docs/patterns",
      found: true,
    });
    expect(project(root).body).toContain("# Body");
  });

  it("defaults the name to the directory and the branch to the remote's default, else main", () => {
    const root = dir("defaults-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "work");
    // At run time the branch checked out is a batch's: never the project's.
    expect(project(root)).toMatchObject({ branch: "main", run: "", ui: [], found: false });
    expect(project(root).name).toMatch(/^defaults-/);
    const origin = dir("origin-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "trunk"], { cwd: origin, stdio: "ignore" });
    git("remote", "add", "origin", origin);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(project(root).branch).toBe("trunk");
  });

  const gitIn =
    (root: string) =>
    (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

  it("a project with no remote takes the branch it is on", () => {
    const root = dir("master-");
    const g = gitIn(root);
    g("init", "-q", "-b", "master");
    g("commit", "-q", "--allow-empty", "-m", "one");
    expect(defaultBranch(root, { checkedOut: true })).toBe("master");
    expect(defaultBranch(root)).toBe("main");
    init(root);
    expect(readFileSync(join(root, ".claude", "workflow.md"), "utf8")).toMatch(/^branch: master$/m);
  });

  it("a remote's default branch still wins", () => {
    const root = dir("work-");
    const g = gitIn(root);
    g("init", "-q", "-b", "work");
    g("commit", "-q", "--allow-empty", "-m", "one");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(defaultBranch(root, { checkedOut: true })).toBe("main");
  });

  it("a remote without origin/HEAD writes main, not the branch checked out", () => {
    const root = dir("pushed-");
    const g = gitIn(root);
    g("init", "-q", "-b", "feature");
    g("remote", "add", "origin", dir("bare-"));
    expect(defaultBranch(root, { checkedOut: true })).toBe("main");
  });

  it("a repository with no commit takes the branch git names, and a folder with no git main", () => {
    const root = dir("unborn-");
    gitIn(root)("init", "-q", "-b", "trunk");
    expect(defaultBranch(root, { checkedOut: true })).toBe("trunk");
    expect(defaultBranch(dir("nogit-"), { checkedOut: true })).toBe("main");
  });

  it("ignores every file the queue keeps in .claude/, one line per kind, and the worktrees' folder", () => {
    expect(QUEUE_IGNORES).toEqual([
      ...QUEUE_KINDS.map((kind) => `.claude/${kind}.*`),
      ".claude/assistant.*",
      ".claude/worktrees/",
      ".claude/app-token.*",
      ".claude/github-*",
      ".claude/webhook.*",
    ]);
    // The names plan-queue.mjs writes there: its literal files and one per kind.
    const source = readFileSync(join(scripts, "plan-queue.mjs"), "utf8");
    const literal = [...source.matchAll(/join\(root, "\.claude", "([^"]+)"\)/g)].map((m) => m[1]);
    const perKind = [...source.matchAll(/join\(root, "\.claude", `\$\{kind\}(\.[a-z]+)`\)/g)].map(
      (m) => m[1],
    );
    expect(literal).toEqual(expect.arrayContaining(["executor.lock", "executor.pause"]));
    expect(perKind).toEqual(expect.arrayContaining([".deferred", ".started"]));
    const names = [
      ...literal.map((name) => (name === "worktrees" ? "worktrees/x/f" : name)),
      ...QUEUE_KINDS.flatMap((kind) => perKind.map((ext) => `${kind}${ext}`)),
      // An assistant chat's start (plans/project-follow-ups-reach-the-project.md).
      "assistant.started",
    ];
    const root = dir("ignores-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), `${QUEUE_IGNORES.join("\n")}\n`);
    const ignored = execFileSync(
      "git",
      ["check-ignore", "--no-index", ...names.map((name) => `.claude/${name}`)],
      { cwd: root, encoding: "utf8" },
    );
    expect(ignored.trim().split("\n").sort()).toEqual(
      names.map((name) => `.claude/${name}`).sort(),
    );
  });

  it("adds a missing queue line to .git/info/exclude once, even where the project's own rule overrides it", () => {
    const root = dir("exclude-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".claude/executor.*\n.claude/planner.*\n");
    expect(ignoreQueueFiles(root)).toBe(
      "Added .claude/asking.*, .claude/handed.*, .claude/assistant.*, .claude/worktrees/, .claude/app-token.*, .claude/github-*, .claude/webhook.* to .git/info/exclude.",
    );
    expect(ignoreQueueFiles(root)).toBe("");
    writeFileSync(join(root, ".gitignore"), "!.claude/**\n");
    expect(ignoreQueueFiles(root)).toBe(
      "Added .claude/executor.*, .claude/planner.* to .git/info/exclude.",
    );
    expect(ignoreQueueFiles(root)).toBe("");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n");
    for (const line of QUEUE_IGNORES) expect(exclude.filter((one) => one === line)).toHaveLength(1);
    expect(ignoreQueueFiles(dir("nogit-"))).toBe("");
  });

  it("init writes no ignore line the project already has another way", () => {
    const root = dir("init-ignored-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".claude/worktrees\n");
    init(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      ".claude/worktrees\n.claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n",
    );
  });

  it("writes the starter once, and refuses a second time", () => {
    const root = dir("init-");
    expect(init(root)).toBe("Wrote .claude/workflow.md: fill in each heading for this project.");
    const text = readFileSync(join(root, ".claude", "workflow.md"), "utf8");
    for (const heading of [
      "Before a build",
      "While working",
      "Before the push",
      "After the push",
      "Reading",
    ])
      expect(text).toContain(`## ${heading}`);
    expect(project(root).found).toBe(true);
    expect(init(root)).toBe(".claude/workflow.md exists already; edit it instead.");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      ".claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/worktrees/\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n",
    );
    expect(text).toContain(
      "# deny:                  MCP tools an agent here may never call, by agent (regular expressions)",
    );
  });

  /** A project whose frontmatter is `front`, read back through `project()`. */
  const withFront = (front: string) => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\n${front}---\n`);
    return project(root);
  };

  it("reads a map of lists: deny, by agent, each agent's patterns in order", () => {
    const front = `name: Lab
deny:                     # MCP tools an agent here may never call
  assistant:              # the owner's chat
    - "mcp__(claude_ai_)?lab-devops__.*"
    - mcp__lab__write_.*
  planner:
    - 'mcp__lab-personal__.*'
    - mcp__research__.*
branch: test
`;
    expect(frontmatter(`---\n${front}---\n`)).toMatchObject({
      deny: {
        assistant: ["mcp__(claude_ai_)?lab-devops__.*", "mcp__lab__write_.*"],
        planner: ["mcp__lab-personal__.*", "mcp__research__.*"],
      },
      branch: "test",
    });
    const proj = withFront(front);
    expect(proj.deny).toEqual({
      assistant: ["mcp__(claude_ai_)?lab-devops__.*", "mcp__lab__write_.*"],
      planner: ["mcp__lab-personal__.*", "mcp__research__.*"],
    });
    expect(proj.branch).toBe("test");
  });

  it("gives deny as {} when absent or a flat list, which names no agent", () => {
    expect(withFront("name: Lab\n").deny).toEqual({});
    expect(withFront('name: Lab\ndeny:\n  - "mcp__lab__.*"\n').deny).toEqual({});
    expect(withFront("name: Lab\ndeny: mcp__lab__.*\n").deny).toEqual({});
  });

  it("keeps a list's items when an indented name follows them, and reads no map as a list", () => {
    const kept = withFront('tools:\n  - "mcp__x__.*"\n  extra:\n  - "mcp__y__.*"\nbranch: test\n');
    expect(kept.tools).toEqual(["mcp__x__.*", "mcp__y__.*"]);
    expect(kept.branch).toBe("test");
    expect(withFront('tools:\n  extra:\n    - "mcp__x__.*"\n').tools).toEqual([]);
    // Patterns before the first agent's name keep the list flat, which names no agent.
    expect(withFront('deny:\n  - "mcp__lab__.*"\n  assistant:\n    - "mcp__x__.*"\n').deny).toEqual(
      {},
    );
  });
});

describe("the plugin's queue in any project", () => {
  it("names sessions by the project, and counts per name", () => {
    const log = [
      { at: 0, name: "Test Executor 1" },
      { at: 0, name: "Other Executor 9" },
    ];
    expect(canStart({ log, name: "Test" })).toMatchObject({ start: true, name: "Test Executor 2" });
    expect(canStart({ log, name: "Other" })).toMatchObject({ name: "Other Executor 10" });
    expect(canStart({ kind: "planner", log, name: "Test" })).toMatchObject({
      name: "Test Planner 1",
    });
  });

  // plans/collaborating-when-claude-writes-the-code.md, parts 1, 3 and 4.
  it("keeps another person's commit on a topic's branch, and says what a change is related to", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    const executor = text("docs/landing.md");
    expect(executor).toContain(
      "squashed back to the plan's tip, so a commit another person pushed stays theirs",
    );
    expect(executor).toContain("Related: #<n>. <- plans with a Related line only");
    // plans/pull-request-description-standard-follow-up.md: the description lists it under Also.
    expect(executor).toContain("- <The commit's title.> (<author>)");
    expect(executor).not.toContain("credited by GitHub's commits list");
    expect(executor).toContain("its link and what it was marked related to");
    for (const agent of ["planner", "assistant"])
      expect(text(`agents/${agent}.md`), agent).toContain("`Related: #31.`");
    const doc = text("docs/workflow.md");
    expect(doc).toContain("**A decision has a name; a part has none.**");
    expect(doc).toContain("**A change one person started is anyone's to go on with.**");
    // plans/also-lists-the-right-commits.md: Also holds other people's commits and no others.
    expect(executor).not.toContain("titled `Merge origin/<…> into <…>`");
    // plans/also-knows-whose-commit.md: the plans account for the queue's commits, by hash.
    expect(executor).toContain("that this checkout's plans do not account for");
    expect(executor).toContain("`git log --first-parent <tip>..HEAD --format=%H`");
    expect(executor).toContain("a merge this plan made before its tip");
    expect(executor).toContain("Nothing is left out by author or by title.");
    expect(executor).toContain("`Merged <base> <date>, commit <sha>: <files or none>`");
    expect(executor).toContain("`Refreshed <date>: merged <base>, commit <sha>,");
    expect(executor).not.toContain("^<its headRefOid>");
    expect(executor).not.toContain("git fetch origin pull/<n>/head");
    expect(executor).not.toContain("`git config user.name`");
    expect(doc).toContain("**The plans account for the queue's commits.**");
    // plans/also-knows-whose-commit-follow-up.md: every merged base down the stack, read in pages.
    expect(executor).toContain("each merged pull request down the stack");
    expect(executor).toContain("found by the `Builds on #<n>` line of its body");
    expect(executor).toContain(
      "`gh api --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`",
    );
    expect(executor).not.toContain("--json commits");
    expect(doc).toContain("the commits no plan here accounts for, with their author, under `Also`");
    expect(doc).not.toContain("another person's commits with their author");
    // plans/also-docs-match-the-rule.md: the docs and the opening sentence name the rule as built.
    expect(executor).toContain("the titles of the commits under `Also` aside");
    // plans/docs-as-a-prompt.md: the reason is the catalogue's entry, not the handbook's.
    expect(text("docs/decisions.md")).toContain(
      "no commit log, the commits no plan here accounts for aside",
    );
    expect(doc).toContain("and no merged pull request down the stack already showed");
  });

  // plans/try-it-is-one-line.md.
  it("keeps a pull request's To try it to the one line of how to try it", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8").replace(/\s+/g, " ");
    expect(executor).not.toContain("(plans/ is not tracked)");
    expect(executor).not.toContain("Checks: <the checks workflow's name>");
    expect(executor.match(/## To try it <One line\.> <the attribution lines/g)).toHaveLength(2);
  });

  // plans/pull-request-description-standard.md.
  it("a pull request's description is the catalogue's diff", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8");
    const mode = executor.slice(executor.indexOf("# Landing by pull request"));
    const [topic, fixes] = [...mode.matchAll(/^```\n([\s\S]*?)^```$/gm)]
      .map((m) => m[1])
      .filter((block) => block.includes("## To try it"));
    for (const heading of ["## New", "## Changed", "## Retired"]) expect(topic).toContain(heading);
    for (const block of [topic, fixes])
      for (const gone of ["## Decisions", "## Screenshots"]) expect(block).not.toContain(gone);
    // plans/pull-request-description-standard-follow-up.md: Also stays in a topic's, after Retired.
    expect(fixes).not.toContain("## Also");
    expect(topic.indexOf("## Also")).toBeGreaterThan(topic.indexOf("## Retired"));
    expect(topic.indexOf("## Also")).toBeLessThan(topic.indexOf("## To try it"));
    // The replaced line, struck through, one level in under the changed bullet.
    expect(topic).toMatch(/^- \*\*<The rule, as the entry words it\.>\*\*[^\n]*\n[^\n]*\n  - ~~/m);
    // A screenshot sits under its decision, one level in.
    expect(topic).toContain("\n  ![<the same line>](plans/<topic>/<file>.png)");
    expect(fixes).toMatch(/^## Fixes\n\n- <The commit's title\.>\n/m);
    expect(fixes).not.toContain("plans/<x>.md");
    const doc = readFileSync(join(plugin, "docs/workflow.md"), "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("**The description is the catalogue's diff**");
    expect(doc).not.toContain("the plan's path;");
    expect(readFileSync(join(plugin, "docs/decisions.md"), "utf8")).toContain(
      "the `Also` list kept",
    );
  });

  // plans/no-session-link-in-pull-requests.md.
  it("leaves the link to a Claude session out of a pull request's description", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8").replace(/\s+/g, " ");
    const ending =
      "<the attribution lines the session gives for a pull request, with any link to a Claude session left out>";
    expect(executor.split(ending)).toHaveLength(3);
    expect(executor).not.toContain("<the attribution lines the session gives for a pull request>");
    expect(executor).toContain("less any line with a `claude.ai/code/session_` address");
  });

  // plans/dropped-plan-state.md, part 3.
  it("names the Dropped section in the agents and the state in the doc's queue", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    for (const agent of ["planner", "assistant"])
      expect(text(`agents/${agent}.md`), agent).toContain(
        "`Dropped on ${user_config.owner}'s word:",
      );
    expect(text("agents/executor.md")).toContain("A plan with a `## Dropped` section is nobody's");
    const doc = text("docs/workflow.md");
    const queue = doc.slice(doc.indexOf("## The queue"));
    expect(queue).toContain(
      "`## Dropped, <date>`, written by the plan's author on the owner's word with one line of why, is dropped: never ready, never started, refused by path, out of the asking deferral",
    );
  });

  // plans/agents-pass-messages-directly.md, parts 1 to 4.
  it("passes the agents' messages to each other, never through the owner", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    const planner = text("agents/planner.md");
    expect(planner).toContain("follow-up plan you write yourself");
    expect(planner).toContain("A message that comes in");
    expect(planner).not.toContain("For the assistant's chat in Remote Control");
    const assistant = text("agents/assistant.md");
    expect(assistant).toContain("What crosses chats");
    expect(assistant).toContain("Change from ${user_config.owner}: plans/<x>.md.");
    expect(assistant).not.toContain("Change from Javi");
    expect(text("agents/executor.md")).toContain("idle first, else busy");
    const doc = text("docs/workflow.md");
    expect(doc).toContain("The chat he said it in writes it");
    expect(doc).toContain("Handed to the assistant");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of files(plugin))
      expect(readFileSync(file, "utf8").replace(/\s+/g, " "), file).not.toContain("to paste there");
  });

  it("reads the agent from a plugin's scoped name or a bare one", () => {
    expect(kindOf({ agent_type: "workflow:executor" })).toBe("executor");
    expect(kindOf({ agent_type: "executor" })).toBe("executor");
    expect(kindOf({ agent_type: "workflow:planner" })).toBe("planner");
    expect(kindOf({})).toBe("");
  });

  it("names the project's run in the Stop hook's refusal, and refuses on none without one", () => {
    const run = {
      id: 7,
      status: "in_progress",
      conclusion: null,
      onHead: true,
      workflow: "checks.yml",
    };
    expect(decideStop({ run })).toMatchObject({ refuse: true });
    expect((decideStop({ run }) as { reason: string }).reason).toContain(
      "The checks.yml run on your push (7)",
    );
    expect(decideStop({ run: null })).toBeNull();
  });

  it("reads the owner from the option, then the settings, then says the owner", () => {
    const settings = join(dir("settings-"), "settings.json");
    expect(owner({ CLAUDE_PLUGIN_OPTION_OWNER: "Ada" }, settings)).toBe("Ada");
    expect(owner({}, settings)).toBe("the owner");
    writeFileSync(
      settings,
      JSON.stringify({ pluginConfigs: { "workflow@workflow": { options: { owner: "Grace" } } } }),
    );
    expect(owner({}, settings)).toBe("Grace");
  });

  it("reads the machine from the option, then the settings, then the hostname", () => {
    const settings = join(dir("settings-"), "settings.json");
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "lab" }, settings)).toEqual({
      name: "lab",
      set: true,
      rejected: "",
    });
    expect(machine({}, settings)).toEqual({ name: hostname(), set: false, rejected: "" });
    writeFileSync(
      settings,
      JSON.stringify({ pluginConfigs: { "workflow@workflow": { options: { machine: "lab" } } } }),
    );
    expect(machine({}, settings)).toEqual({ name: "lab", set: true, rejected: "" });
    // A label that is not one is passed over for the next, then the hostname.
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" }, settings)).toEqual({
      name: "lab",
      set: true,
      rejected: "",
    });
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" }, `${settings}.none`)).toEqual({
      name: hostname(),
      set: false,
      rejected: "my box",
    });
  });

  it("names a session by project, kind, number and machine, and reads the name back", () => {
    const names: [string, { project?: string; machine?: string }][] = [
      ["Workflow Executor 2 (lab)", { project: "Workflow", machine: "lab" }],
      ["Workflow Executor 2", { project: "Workflow" }],
      ["Executor 2", {}],
    ];
    for (const [name, options] of names) {
      expect(sessionName("executor", 2, options)).toBe(name);
      expect(parseName(name)).toEqual({
        project: options.project || "",
        kind: "executor",
        n: 2,
        machine: options.machine || "",
      });
    }
    for (const name of ["Assistant", "Assistant (Anton merge)", "Executor", "Docs Assistant"])
      expect(parseName(name)).toBeNull();
    // plans/project-follow-ups-reach-the-project.md, part 6: the third kind.
    expect(parseName("Docs Assistant 4 (lab)")).toEqual({
      project: "Docs",
      kind: "assistant",
      n: 4,
      machine: "lab",
    });
    expect(sessionName("assistant", 4, { project: "Docs", machine: "lab" })).toBe(
      "Docs Assistant 4 (lab)",
    );
  });

  // plans/project-follow-ups-reach-the-project.md, part 6.
  it("starts an assistant chat only with none open, counted per project and machine, under the shared bounds", () => {
    const log = [
      { at: 0, name: "Docs Assistant 2 (lab)" },
      { at: 0, name: "Docs Executor 9 (lab)" },
      { at: 0, name: "Other Assistant 7 (lab)" },
    ];
    const base = { kind: "assistant", log, name: "Docs", machine: "lab", brief: "plans/a.md" };
    expect(canStart(base)).toMatchObject({ start: true, name: "Docs Assistant 3 (lab)" });
    for (const open of [["Docs Assistant"], ["Docs Assistant 2 (lab)"]])
      expect(canStart({ ...base, open })).toEqual({
        refuse: true,
        why: `${open[0]} is open: send it the message instead. Follow-ups ready: plans/a.md.`,
      });
    expect(canStart({ ...base, paused: "today" })).toMatchObject({ refuse: true });
    const now = Date.UTC(2026, 9, 31, 12);
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 90, resets_at: now / 1000 + 3600 },
    };
    expect(canStart({ ...base, usage, now })).toMatchObject({ defer: true });
    const busy = Array.from({ length: 24 }, (_, i) => ({
      at: now - i * 60_000 - 20 * 60_000,
      name: `Docs Assistant ${i + 1} (lab)`,
    }));
    expect(canStart({ ...base, log: busy, now, progressAt: now })).toMatchObject({
      refuse: true,
      why: expect.stringContaining("Twenty-four assistants"),
    });
    // A live executor of the project does not hold an assistant back.
    expect(
      canStart({
        ...base,
        sessions: [{ sessionId: "e", name: "Docs Executor 9 (lab)", status: "busy" }],
      }),
    ).toMatchObject({ start: true });
  });

  it("numbers a start per machine, from the log and the live list", () => {
    const log = [
      { at: 0, name: "Test Executor 1" },
      { at: 0, name: "Other Executor 9" },
    ];
    expect(canStart({ log, name: "Test", machine: "lab" })).toMatchObject({
      start: true,
      name: "Test Executor 2 (lab)",
    });
    expect(
      canStart({
        kind: "planner",
        log: [{ at: 0, name: "Workflow Planner 1 (lab)" }],
        taken: ["Workflow Planner 3 (lab)", "Workflow Executor 2 (lab)", "Assistant"],
        name: "Workflow",
        machine: "lab",
      }),
    ).toMatchObject({ start: true, name: "Workflow Planner 4 (lab)" });
  });

  it("tells the queue's sessions by name, with or without the machine", () => {
    expect(isSession("executor", { name: "Workflow Executor 2 (lab)" })).toBe(true);
    expect(isSession("executor", { name: "Workflow Executor 2" })).toBe(true);
    expect(isSession("planner", { name: "Workflow Planner 1 (lab)", kind: "background" })).toBe(
      true,
    );
    expect(isSession("executor", { name: "Assistant (Anton merge)" })).toBe(false);
  });

  it("says the machine in plans' first line, and how to name it while the hostname stands in", () => {
    const root = dir("machine-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: Lab\n---\n");
    const { CLAUDE_PLUGIN_OPTION_MACHINE: _, ...rest } = process.env;
    const plans = (env: Record<string, string>) =>
      execFileSync("node", [join(scripts, "plan-queue.mjs")], {
        encoding: "utf8",
        // A home of its own, so the user settings name no machine.
        env: { ...rest, HOME: root, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]", ...env },
      });
    const named = plans({ CLAUDE_PLUGIN_OPTION_MACHINE: "lab" });
    expect(named).toMatch(/^Plans on lab, /);
    expect(named).not.toContain("named by its hostname");
    expect(plans({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" })).toContain(
      `The plugin's "machine" option, "my box", is no label (letters, digits, underscores, dots and hyphens), so this machine is named by its hostname;`,
    );
    const unset = plans({});
    expect(unset.startsWith(`Plans on ${hostname()}, `)).toBe(true);
    expect(unset.trimEnd().split("\n").at(-1)).toBe(
      `This machine is named by its hostname; the plugin's "machine" option names it: /plugin configure workflow in a chat, or echo '{"machine":"<label>"}' | claude plugin configure workflow@workflow --values-stdin.`,
    );
  });

  it("finds the data directory from WORKFLOW_DATA, the cache path, or the default, never CLAUDE_PLUGIN_DATA", () => {
    expect(data({ WORKFLOW_DATA: "/w", CLAUDE_PLUGIN_DATA: "/d" })).toBe("/w");
    // Another plugin's directory, as the Bash tool carried it: never taken.
    expect(
      data(
        { CLAUDE_PLUGIN_DATA: "/h/.claude/plugins/data/codex-openai-codex" },
        "/h/.claude/plugins/cache/workflow/workflow/abc123/scripts",
      ),
    ).toBe("/h/.claude/plugins/data/workflow-workflow");
    expect(data({}, "/h/.claude/plugins/cache/workflow/workflow/abc123/scripts")).toBe(
      "/h/.claude/plugins/data/workflow-workflow",
    );
    expect(data({}, "/h/.claude/plugins/cache/mkt/tool/1.0.0/scripts")).toBe(
      "/h/.claude/plugins/data/tool-mkt",
    );
    expect(data({}, "/somewhere/else/scripts")).toMatch(
      /\.claude\/plugins\/data\/workflow-workflow$/,
    );
  });

  /** Two throwaway repositories, each with a project file and one plan of its own. */
  const twoProjects = () =>
    ["a", "b"].map((name) => {
      const root = dir(`queue-${name}-`);
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, ".claude"));
      mkdirSync(join(root, "plans"));
      mkdirSync(join(root, "deep"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Q${name}\n---\n`);
      writeFileSync(
        join(root, "plans", `only-in-${name}.md`),
        `# Plan ${name}\n\nShort plan, 27 October 2026.\n`,
      );
      return root;
    });
  const queueIn = (command: string, cwd: string, env: Record<string, string>) => {
    const { WORKFLOW_ROOT: _, ...rest } = process.env;
    return execFileSync("node", [command], {
      cwd,
      env: { ...rest, WORKFLOW_DATA: dir("queue-data-"), WORKFLOW_LIVE: "[]", ...env },
      encoding: "utf8",
    });
  };
  const bin = new URL("../plugins/workflow/bin/plans", import.meta.url).pathname;

  it("plans reads the folder it runs in, not the chat's project", () => {
    const [a, b] = twoProjects();
    const out = queueIn(bin, join(a, "deep"), { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-a.md");
    expect(out).not.toContain("plans/only-in-b.md");
  });

  it("plans in a linked worktree reads the checkout that holds plans/", () => {
    const [a, b] = twoProjects();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: a, stdio: "ignore" });
    git("add", ".claude");
    git("-c", "user.name=T", "-c", "user.email=t@example.org", "commit", "-qm", "start");
    git("worktree", "add", "-q", join(".claude", "worktrees", "w"));
    const out = queueIn(bin, join(a, ".claude", "worktrees", "w"), { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-a.md");
  });

  it("a hook, with no WORKFLOW_ROOT, still takes CLAUDE_PROJECT_DIR", () => {
    const [a, b] = twoProjects();
    const out = queueIn(join(scripts, "plan-queue.mjs"), a, { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-b.md");
    expect(out).not.toContain("plans/only-in-a.md");
  });

  it("starts a chat without the command's root or another project's directory", () => {
    expect(
      sessionEnv({
        WORKFLOW_ROOT: "/a",
        CLAUDE_PROJECT_DIR: "/b",
        CLAUDE_SESSION_ID: "s",
        CLAUDE_PLUGIN_ROOT: "/r",
        CLAUDE_PLUGIN_DATA: "/d",
        WORKFLOW_STARTED: "assistant",
        PATH: "/bin",
        HOME: "/h",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("starts a chat without the plugins' bin folders it inherited, so its plans is the installed one", () => {
    const old = "/home/u/.claude/plugins/cache/workflow/workflow/822635629e80/bin";
    const now = "/home/u/.claude/plugins/cache/workflow/workflow/73aa1d388dcc/bin";
    const path = (...dirs: string[]) => dirs.join(delimiter);
    expect(sessionEnv({ PATH: path(old, "/usr/bin", now, "/bin") }).PATH).toBe(
      path("/usr/bin", "/bin"),
    );
  });

  it("finds any path of two segments with an extension, and no address or plan", () => {
    expect(pathsIn("see src/a/b.ts and docs/x.md, not 192.0.2.1 or plans/p.md")).toEqual([
      "src/a/b.ts",
      "docs/x.md",
    ]);
    expect(pathsIn("https://example.org/a/b.md")).toEqual([]);
  });
});

describe("the turn audit's UI rule", () => {
  const ui = ["apps/*/src/{components,app}/**"].map(globToRegExp);
  it("asks for the catalogue only when the project names the paths and the catalogue", () => {
    const changed = ["apps/web/src/components/Button.tsx"];
    expect(reasonFor(changed, "x", "", { ui, catalogue: "docs/patterns" })).toContain(
      "nothing under docs/patterns did",
    );
    expect(reasonFor(changed, "x", "", { ui, catalogue: "" })).toBe("");
    expect(reasonFor(changed, "x", "", {})).toBe("");
    expect(
      reasonFor([...changed, "docs/patterns/buttons.md"], "x", "", {
        ui,
        catalogue: "docs/patterns",
      }),
    ).not.toContain("a user sees");
  });
});

describe("the turn audit's readers", () => {
  it("never judges the planner or the assistant, by a scoped name or a bare one", () => {
    const root = dir("audit-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: A\nbranch: test\n---\n");
    const audit = join(scripts, "turn-audit.mjs");
    for (const agent_type of ["workflow:planner", "planner", "workflow:assistant"]) {
      const session_id = `reader-${agent_type.replace(":", "-")}-${process.pid}`;
      const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
      const run = (mode: string, input: object) =>
        execFileSync("node", [audit, mode], {
          input: JSON.stringify(input),
          encoding: "utf8",
          env,
        });
      run("prompt", { session_id, agent_type, prompt: "Plan it." });
      for (const file of ["a.md", "b/c.md"]) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "x\n");
        run("tool", {
          session_id,
          tool_name: "Write",
          tool_input: { file_path: join(root, file) },
        });
      }
      expect(run("stop", { session_id, agent_type })).toBe("");
    }
  });
});

describe("the status line's copy", () => {
  it("copies itself into the data directory once, and again when it changes", () => {
    const target = dir("data-");
    const run = () =>
      execFileSync("node", [join(scripts, "statusline.mjs"), "install"], {
        env: { ...process.env, WORKFLOW_DATA: target },
      });
    run();
    const copy = join(target, "statusline.mjs");
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(scripts, "statusline.mjs"), "utf8"));
    writeFileSync(copy, "// old\n");
    run();
    expect(readFileSync(copy, "utf8")).not.toBe("// old\n");
    // The copy runs alone: it writes the usage beside itself.
    execFileSync("node", [copy], {
      input: JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 3, resets_at: 1 } },
      }),
      env: { ...process.env, WORKFLOW_DATA: "", CLAUDE_PLUGIN_DATA: "" },
    });
    expect(JSON.parse(readFileSync(join(target, "usage.json"), "utf8")).five_hour).toMatchObject({
      used_percentage: 3,
    });
  });
});

describe("the two forms", () => {
  const compact = () => {
    const root = dir("compact-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: Slides\nform: compact\n---\n");
    return root;
  };
  const queue = (root: string, args: string[], input?: object) =>
    execFileSync("node", [join(scripts, "plan-queue.mjs"), ...args], {
      input: input ? JSON.stringify(input) : "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]" },
    });
  const line =
    "This project is in the compact form (form: compact): one chat decides and builds, and there is no queue.";

  it("reads form: compact, and the full form when absent", () => {
    expect(project(compact()).form).toBe("compact");
    const full = dir("full-");
    expect(project(full).form).toBe("full");
    init(full);
    expect(readFileSync(join(full, ".claude", "workflow.md"), "utf8")).toContain(
      "# form: compact          one chat decides and builds; omit for the full queue",
    );
  });

  it("has no queue in the compact form: plans says so, a start refuses, a prompt hook is silent", () => {
    const root = compact();
    expect(queue(root, []).trim()).toBe(line);
    expect(queue(root, ["start", "--dry", "plans/x.md"]).trim()).toBe(line);
    expect(queue(root, ["prompt"], { session_id: "compact-1", agent_type: "executor" })).toBe("");
  });

  it("has a maker agent, and every agent names the design-research skill", () => {
    const agents = new URL("../plugins/workflow/agents/", import.meta.url).pathname;
    const maker = readFileSync(join(agents, "maker.md"), "utf8");
    for (const key of ["name: maker", "model: opus", "effort: high", "skills:"])
      expect(maker).toContain(key);
    for (const agent of ["maker", "planner", "executor", "assistant"]) {
      const front = /^---\n([\s\S]*?)\n---/.exec(
        readFileSync(join(agents, `${agent}.md`), "utf8"),
      )![1];
      expect(front, agent).toMatch(/skills:\n {2}- design-research/);
    }
    expect(
      existsSync(new URL("../plugins/workflow/skills/design-research/SKILL.md", import.meta.url)),
    ).toBe(true);
  });
});

describe("every string rests on what produced it", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  it("the planner, the assistant, the executor and the reviewer name the plan's Words; the skill no longer skips the research", () => {
    for (const agent of ["planner", "assistant", "executor", "reviewer"])
      expect(readFileSync(join(plugin, "agents", `${agent}.md`), "utf8"), agent).toContain("Words");
    expect(
      readFileSync(join(plugin, "skills", "design-research", "SKILL.md"), "utf8"),
    ).not.toContain("needs no question");
  });

  it("the skill's question and the edit-time line name one boundary, a new screen or flow", () => {
    const skill = readFileSync(join(plugin, "skills", "design-research", "SKILL.md"), "utf8");
    const step2 = /^2\. [\s\S]*?(?=^3\. )/m.exec(skill)![0];
    expect(step2).toContain("A new screen or flow: ask, once, with two choices");
    expect(step2).toContain("A detail no product settles is free");
    expect(step2).not.toContain("you choose");
    // The skill no longer offers the retired tier.
    expect(skill).not.toContain("(the agent's choice,");
    expect(readFileSync(join(plugin, "agents", "maker.md"), "utf8")).toContain(
      "a new screen or flow is asked about",
    );
  });

  it("the audit's tier hint offers the tiers that stand, never the retired agent's choice", () => {
    const hint = reasonFor(["docs/patterns/a.md"], "", "", {
      catalogue: "docs/patterns",
      texts: { "docs/patterns/a.md": "- **No tier.**\n" },
      day: "27 October",
      who: "Javi",
    });
    expect(hint).toContain(
      "(Javi, 27 October), (as GitHub does, 27 October) or (per <source>, 27 October).",
    );
    expect(hint).not.toContain("the agent's choice");
  });
});

describe("the handbook holds every rule the plugin cites", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const handbook = readFileSync(join(plugin, "docs", "workflow.md"), "utf8");
  // A rule's name is its bold statement, read outside the fenced examples, on one line.
  const prose = handbook.replace(/```[\s\S]*?```/g, "");
  const bold = [...prose.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) =>
    m[1].replace(/\s+/g, " ").replace(/\.$/, ""),
  );
  // A cited section is a heading of the handbook or of the landing steps the executor reads.
  const landing = readFileSync(join(plugin, "docs", "landing.md"), "utf8");
  const headings = [...`${handbook}\n${landing}`.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  // The names the agent files, the scripts, the skills and the tests cite in
  // quotation marks, collected by hand on 2 November (plans/docs-as-a-prompt.md).
  const NAMES = [
    "A behavior is written as a scenario",
    "A brief or a plan is a prompt for the agent that reads it",
    "A change one person started is anyone's to go on with",
    "A change the plugin leaves for the project it came from goes back as a brief",
    "A decision has a name; a part has none",
    "A second model reviews every plan's diff",
    "A string rests on what produced it",
    "A topic's pull request opens as a draft and stays one until its owner has reviewed it himself",
    "After the push",
    "Asked in plain words",
    "Asked once",
    "Before a build",
    "Before the push",
    "Briefs are queued like plans",
    "Handed to the assistant",
    "Reading beside a build",
    "The audit's checks",
    "The catalogue is the record",
    "The chat he said it in writes it",
    "The group's message",
    "The plans account for the queue's commits",
    "The tier says who may change a rule",
    "The turn audit",
    "Which session a topic goes to",
    "While working",
    "`land: pull-request` lands by pull request",
  ];
  const SECTIONS = [
    "The three agents",
    "The project file",
    "Decisions",
    "The queue",
    "Changing the workflow",
    "Installing",
  ];

  it("holds each cited name as the opening of a bold statement", () => {
    for (const name of NAMES)
      expect(
        bold.some((b) => b.startsWith(name)),
        name,
      ).toBe(true);
  });

  it("ends every rule's paragraph with its entry in decisions.md, and cites every entry", () => {
    const decisions = readFileSync(join(plugin, "docs", "decisions.md"), "utf8");
    const ids = new Set([...decisions.matchAll(/^- `([\w.-]+)` \*\*/gm)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThanOrEqual(60);
    const cited = new Set<string>();
    for (const para of prose.split(/\n\s*\n/)) {
      const text = para.trim();
      if (!/^(- )?\*\*/.test(text)) continue;
      const refs = [...text.matchAll(/decisions\.md#([\w.-]+)/g)].map((m) => m[1]);
      expect(refs.length, text.slice(0, 60)).toBeGreaterThan(0);
      for (const id of refs) {
        expect(ids.has(id), id).toBe(true);
        cited.add(id);
      }
    }
    // A paragraph with no bold lead-in may cite an entry too (the Installing line).
    for (const m of prose.matchAll(/decisions\.md#([\w.-]+)/g)) cited.add(m[1]);
    for (const id of ids) expect(cited.has(id), id).toBe(true);
  });

  it("holds each cited section as a heading", () => {
    for (const section of SECTIONS) expect(headings, section).toContain(section);
  });

  // plans/simpler-agent-files.md: an agent file cites a rule by its name, never by one gone.
  it("every rule an agent file cites is in the handbook", () => {
    const flatProse = prose.replace(/\s+/g, " ");
    let cited = 0;
    for (const agent of readdirSync(join(plugin, "agents"))) {
      const text = readFileSync(join(plugin, "agents", agent), "utf8");
      const flat = text.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ");
      const own = [
        ...[...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
        ...[...flat.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) => m[1]),
      ];
      for (const [, name] of flat.matchAll(/(?:the docs' |the handbook's |\()"([A-Z`][^"]+?)"/g)) {
        cited++;
        expect(
          flatProse.includes(`**${name}`) ||
            headings.includes(name) ||
            own.some((lead) => lead.startsWith(name)),
          `${agent}: "${name}"`,
        ).toBe(true);
      }
    }
    expect(cited).toBeGreaterThan(20);
  });
});

describe("a brief or a plan is a prompt", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const agent = (name: string) => readFileSync(join(plugin, "agents", `${name}.md`), "utf8");
  // A rule's wording runs across hand-wrapped lines; read it as one line.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const PARTS = ["What was asked", "Decided", "Done when", "Where to look"];

  it("the docs hold the rule and an example brief whose headings are the four parts in order", () => {
    const docs = readFileSync(join(plugin, "docs", "workflow.md"), "utf8");
    expect(docs).toContain("**A brief or a plan is a prompt for the agent that reads it**");
    const rule = docs.slice(docs.indexOf("**A brief or a plan is a prompt"));
    const example = /For example, the brief that asked for this rule:\n\n```\n([\s\S]*?)\n```/.exec(
      rule,
    )![1];
    const headings = [...example.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/,.*/, ""));
    // Decided is left out of a brief when nothing is settled; the rest are always there.
    expect(headings).toEqual(PARTS.filter((part) => headings.includes(part)));
    for (const part of ["What was asked", "Done when", "Where to look"])
      expect(headings).toContain(part);
    // No longer than the brief it rewrites (1,917 characters).
    expect(example.length).toBeLessThanOrEqual(1917);
  });

  it("the assistant's brief and short plan each hold Done when and no Tests", () => {
    const text = agent("assistant");
    const blocks = [...text.matchAll(/```\n(\s*# <Title[\s\S]*?)```/g)].map((m) => m[1]);
    const brief = blocks.find((b) => b.includes("Brief for the planner"))!;
    const short = blocks.find((b) => b.includes("Short plan, <date>"))!;
    for (const block of [brief, short]) {
      expect(block).toMatch(/^ *## Done when$/m);
      expect(block).not.toMatch(/^ *## Tests$/m);
    }
    const order = (block: string) =>
      PARTS.map((part) => block.search(new RegExp(`^ *## ${part}`, "m"))).filter((i) => i >= 0);
    expect(order(brief)).toHaveLength(4);
    expect(order(brief)).toEqual([...order(brief)].sort((a, b) => a - b));
  });

  it("the planner's shape names Done when, and neither What the products do nor Tests as a section", () => {
    const text = agent("planner");
    const shape = /^## The plan's shape\n[\s\S]*?(?=^## )/m.exec(text)![0];
    expect(shape).toMatch(/^\d+\. \*\*Done when\*\*/m);
    expect(shape).not.toContain("What the products do");
    expect(shape).not.toMatch(/^\d+\. \*\*Tests\*\*/m);
    expect(text).not.toContain("usual size");
  });

  it("the executor's Built rule and its four-part rule, and the reviewer's second check, name Done when", () => {
    const executor = flat(agent("executor"));
    // Each rule read to its end: the Built bullet to the next bullet, the four-part rule to its last sentence.
    const built = /\*\*"Built"\*\*.*? - \*\*/.exec(executor)![0];
    expect(built).toContain('"Done when"');
    // The four parts, done when among them, are the handbook rule the brief names.
    const brief = /A brief has the four parts of .*?three hundred words\./.exec(executor)![0];
    expect(brief).toContain("A brief or a plan is a prompt for the agent that reads it");
    expect(executor).toContain('its "Done when" is what you check before "Built".');
    const reviewer = flat(agent("reviewer"));
    const second = /2\. \*\*([^*]+)\*\*/.exec(reviewer)![1];
    expect(second).toContain('"Done when"');
  });

  // plans/behavior-as-when-then.md: a behavior a person sees is When … then ….
  it("the docs and the agents that write or check a Done when hold When … then …, the example brief too", () => {
    const docs = flat(readFileSync(join(plugin, "docs", "workflow.md"), "utf8"));
    const rule =
      /\*\*A behavior is written as a scenario\*\*.*?\(decisions\.md#behavior-as-scenario\)/.exec(
        docs,
      )![0];
    expect(rule).toContain("When <what the person does>, then <what they see>");
    expect(rule).toMatch(/"\*\*When\*\* I connect Google[^"]*, \*\*then\*\* a toast/);
    expect(rule).toContain("names the test that checks it");
    const plain = /\*\*Asked in plain words\.\*\*.*?\(decisions\.md#asked-in-plain-words\)/.exec(
      docs,
    )![0];
    expect(plain).toContain("A behavior is described as When … then …");
    const example = /For example, the brief that asked for this rule: ```(.*?)```/.exec(docs)![1];
    const done = example.slice(
      example.indexOf("## Done when"),
      example.indexOf("## Where to look"),
    );
    expect(done).toMatch(/- When [^,]+, then /);
    const assistant = flat(agent("assistant"));
    expect(assistant).toMatch(
      /"Done when" \(the checks he would run[^)]*When <what he does>, then <what he sees>/,
    );
    expect(assistant).toMatch(
      /the test files and cases to add among them; a behavior a person sees is a scenario/,
    );
    expect(assistant).toMatch(/## The final message [^#]*When <what he does>, then <what he sees>/);
    const planner = flat(agent("planner"));
    expect(planner).toMatch(/4\. \*\*Done when\*\*[^*]*When <what they do>, then <what they see>/);
    expect(planner).toMatch(/Lead in plain words.{0,220}When <what he does>, then <what he sees>/);
    const executor = flat(agent("executor"));
    expect(executor).toContain(
      'Give each When … then … line of "Done when" the test it names, one per scenario',
    );
    expect(executor).toMatch(/\*\*The final message\*\*.{0,120}as When … then …/);
    // The reviewer checks the scenarios rather than writing them: its check 2, to check 3.
    const check = flat(
      /2\. \*\*Every line of its "Done when"[^]*?(?=\n3\. )/.exec(agent("reviewer"))![0],
    );
    expect(check).toContain("a When … then … line by the test it names");
    expect(check).toContain('the screenshot named for it, read with Read, shows its "then"');
    expect(check).toContain("is a gap when none is named");
    const perScenario = /Give each When … then … line.*? - /.exec(executor)![0];
    expect(perScenario).toContain("screenshotted to `plans/<topic>/<file>.png`");
    expect(flat(agent("reviewer"))).toContain("a scenario's screenshot is check 2's");
    expect(rule).toContain(
      "for one looked at on screen the executor names the screenshot that shows it",
    );
    expect(executor).toContain(
      "each screenshot by path with what it shows and its When … then … line",
    );
  });
});

// plans/ask-before-briefing.md
describe("an idea is asked about before anything is written", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8");

  it("opens the assistant's exits with the question, before exit 1, and asks nothing of a fix", () => {
    const exits = /^## Where each topic ends\n([\s\S]*?)(?=^## )/m.exec(
      read("agents/assistant.md"),
    )![1];
    const first = exits.trim().split("\n\n")[0].replace(/\s+/g, " ");
    expect(first).toMatch(/^\*\*An idea is asked about first\.\*\*/);
    expect(first).toContain("ask with the question tool what it becomes before writing anything");
    expect(first).toContain(
      '`Make it an issue`, "Shared with the others to discuss and come back to another day; nothing is planned yet" (in a project with an Issues heading)',
    );
    expect(first).toContain(
      '`Brief it`, "A planner plans it now; the plan waits for your word to build, as usual"',
    );
    expect(first).toContain('`Not yet`, "Nothing is written; keep talking it through"');
    expect(first).toContain("Nothing is written on Not yet.");
    expect(first).toContain(
      "A clear bug or an objective fix asks nothing; when unsure which it is, ask.",
    );
    expect(exits.indexOf("An idea is asked about first")).toBeLessThan(
      exits.indexOf("1. **Answered.**"),
    );
  });

  it("has the handbook say the same, pointing at the assistant and citing its entry", () => {
    const docs = read("docs/workflow.md").replace(/\s+/g, " ");
    const rule =
      /\*\*An idea is asked about before anything is written\*\*.*?\(decisions\.md#idea-asked-first\)/.exec(
        docs,
      )![0];
    expect(rule).toContain(
      "an issue (in a project with an Issues heading), a brief or nothing yet",
    );
    expect(rule).toContain(
      "a clear bug, an objective fix or a request to build, plan or file asks nothing",
    );
    expect(rule).toContain('(the assistant\'s "Where each topic ends")');
    expect(read("docs/decisions.md")).toContain("- `idea-asked-first` **An idea is asked about");
  });

  it("writes an issue nobody plans yet with no label and no plan line", () => {
    const issues = /^## GitHub issues\n([\s\S]*?)(?=^## )/m
      .exec(read("agents/assistant.md"))![1]
      .replace(/\s+/g, " ");
    expect(issues).toContain(
      'An issue alone, `Make it an issue` with no brief, leaves out the line "The plan behind this: the first comment." and takes no label until a brief carries its number; the topic ends as answered, with its address.',
    );
    expect(issues).toContain('--label "status: planning"`, the label left out for an issue alone.');
    expect(issues).toContain(
      '`status: planning` with the brief, added (`plans gh issue edit <n> --add-label "status: planning"`) when a brief takes the number of an issue that has no label',
    );
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "**An issue nobody plans yet carries no status label and no plan line** until a brief carries its number, and its topic ends as answered, with the issue's address. (decisions.md#issue-alone)",
    );
  });
});

// plans/messages-for-people-only-on-request.md
describe("a message for another person only when the owner asks", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");

  it("has the planner's shape hold no For the group section, and a message drafted only on request", () => {
    const planner = readFileSync(join(plugin, "agents", "planner.md"), "utf8");
    const shape = /^## The plan's shape\n[\s\S]*?(?=^## )/m.exec(planner)![0];
    expect(shape).not.toContain("For the group");
    expect(shape).toContain("`Touches <name>'s part (<what>).`");
    const flat = read("agents/planner.md");
    expect(flat).not.toContain("For the group");
    expect(flat).toContain("**A message for another person only when asked.**");
    expect(flat).toContain('in this chat or in the brief\'s "Decided"');
  });

  it("has the docs and the assistant draft a person's message only when the owner asks", () => {
    const docs = read("docs/workflow.md");
    const rule = /\*\*The group's message\.\*\*.*?\(decisions\.md#group-message\)/.exec(docs)![0];
    expect(rule).toContain("No agent drafts a message for another person unless the owner asked");
    expect(rule).not.toContain("For the group");
    expect(docs).toContain(
      "a call for a person the project names, said in a line, with a message drafted only when the owner asks",
    );
    const assistant = read("agents/assistant.md");
    expect(assistant).toContain("say in a line whose call it is and what to ask them");
    expect(assistant).toContain("only when ${user_config.owner} asks for one");
    expect(assistant).toContain(
      'when ${user_config.owner} asks for a message, it goes in the brief\'s "Decided" for the planner',
    );
  });
});

describe("the audit's tier check", () => {
  it("finds a rule without its tier and passes one with each of the three", () => {
    const text = `# Buttons

- **Icon buttons carry a tooltip.** (Javi, 3 September)
- **Load more sits under the feed.** (as GitHub does, 10 October) The reason.
- **Keys are drawn as a grid,
  four to a row.** (the agent's choice, 11 October)
- **A button with no tier.** It says why.
- ~~**A struck rule.**~~ (retired)
`;
    expect(untiered(text)).toEqual(["**A button with no tier.** It says why."]);
    // An entry at the retired tier has its tier and date: its fault is its own kind.
    expect(agentsChoice(text)).toEqual([
      "**Keys are drawn as a grid, four to a row.** (the agent's choice, 11 October)",
    ]);
    expect(
      untiered("- **A rule.** (Mary Jane, 27 October)\n- **Another.** (José, 2 May)\n"),
    ).toEqual([]);
  });

  it("checks the README's rules, not its prose, and suggests a tier the check accepts", () => {
    const rule = {
      catalogue: "docs/patterns",
      texts: {
        "docs/patterns/README.md":
          "# Patterns\n\nThe rules for everywhere.\n\n| File | Governs |\n| --- | --- |\n| a.md | buttons |\n\n- **Bare.**\n",
        "docs/patterns/a.md": "- **No tier.**\n",
      },
      day: "27 October",
    };
    expect(reasonFor(["docs/patterns/README.md"], "", "", rule)).toContain(
      'docs/patterns/README.md has 1 rule without a tier and date: "**Bare.**"',
    );
    const prose = { ...rule, texts: { "docs/patterns/README.md": "# Patterns\n\nProse only.\n" } };
    expect(reasonFor(["docs/patterns/README.md"], "", "", prose)).toBe("");
    expect(reasonFor(["docs/patterns/a.md"], "", "", { ...rule, who: "the owner" })).toContain(
      "(<a person's name>, 27 October)",
    );
    expect(reasonFor(["docs/patterns/a.md"], "", "", { ...rule, who: "Javi" })).toContain(
      "(Javi, 27 October)",
    );
  });

  it("refuses a stop once when a catalogue file changed with an untiered rule", () => {
    const root = dir("tiers-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "docs", "patterns"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Tiers\nui:\n  - "src/**"\ncatalogue: docs/patterns\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_OWNER: "Javi" },
      });
    const id = `tiers-${process.pid}`;
    run("prompt", { session_id: id, prompt: "Record the rule" });
    const file = join(root, "docs", "patterns", "buttons.md");
    writeFileSync(file, "# Buttons\n\n- **A button with no tier.**\n");
    run("tool", { session_id: id, tool_name: "Write", tool_input: { file_path: file } });
    const first = run("stop", { session_id: id, stop_hook_active: false });
    expect(JSON.parse(first).reason).toContain(
      'docs/patterns/buttons.md has 1 rule without a tier and date: "**A button with no tier.**". Every rule ends with who it rests on and when: (Javi,',
    );
    expect(run("stop", { session_id: id, stop_hook_active: true })).toBe("");
  });
});

describe("the writing plugin", () => {
  const top = new URL("../", import.meta.url).pathname;
  const skills = join(top, "plugins", "writing", "skills");
  const SKILLS = ["review", "edit", "draft", "proof", "sources", "figures"];
  const front = (name: string) =>
    /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(skills, name, "SKILL.md"), "utf8"))?.[1] ?? "";

  it("is the marketplace's second plugin", () => {
    const market = JSON.parse(
      readFileSync(join(top, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(market.plugins.map((p: { name: string }) => p.name)).toEqual(["workflow", "writing"]);
    const manifest = JSON.parse(
      readFileSync(join(top, "plugins", "writing", ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("writing");
  });

  it("has six skills, each with a name, a description and paths; review and proof fork", () => {
    for (const name of SKILLS) {
      const head = front(name);
      expect(head, name).toMatch(new RegExp(`^name: ${name}$`, "m"));
      expect(head, name).toMatch(/^description: \S/m);
      expect(head, name).toMatch(/^paths:/m);
      expect(/^context: fork$/m.test(head), name).toBe(name === "review" || name === "proof");
    }
  });

  it("has every reference file a skill names, and each skill under 500 lines", () => {
    for (const name of SKILLS) {
      const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
      expect(text.split("\n").length, name).toBeLessThan(500);
      for (const [, file] of text.matchAll(/\]\(([\w-]+\.md)\)/g))
        expect(existsSync(join(skills, name, file)), `${name}/${file}`).toBe(true);
    }
    const names = (name: string) =>
      [...readFileSync(join(skills, name, "SKILL.md"), "utf8").matchAll(/\]\(([\w-]+\.md)\)/g)].map(
        (m) => m[1],
      );
    expect(names("review")).toEqual(["semantic-review.md", "narrative-and-pedagogy.md"]);
    expect(names("edit")).toEqual(["copyedit-and-grammar.md", "latex-style.md"]);
    expect(names("draft")).toEqual(["prose-drafting.md"]);
  });

  it("names no person's note commands but in the one example sentence", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(join(top, "plugins", "writing"))) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /JaviAI|\\javi\b/.test(line));
      for (const line of lines) expect(line, file).toContain("note: \\JaviAI");
    }
  });
});

describe("the catalogue follow-up", () => {
  it("accepts ISO dates, per and observed-in tiers, and an id", () => {
    expect(
      untiered(`- \`a\` **One.** (Javi, 2026-10-21)
- **Two.** (per Wheeler, 3 October) [S1] why.
- \`c\` **Three.** (observed in Limits deck, 2026-10-21)
- \`d\` **No tier.**
`),
    ).toEqual(["`d` **No tier.**"]);
  });

  it("reads inherits, tools, mcp and a file catalogue", () => {
    const root = dir("keys-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---\nname: Talk\ncatalogue: _talk/decisions.md\ninherits:\n  - ../.claude/decisions\ntools:\n  - "mcp__p__ppt_set_.*"\nmcp:\n  - ../.ppt/mcp.json\n---\n`,
    );
    expect(project(root)).toMatchObject({
      catalogue: "_talk/decisions.md",
      inherits: ["../.claude/decisions"],
      tools: ["mcp__p__ppt_set_.*"],
      mcp: ["../.ppt/mcp.json"],
    });
  });

  /** A project with a catalogue of three files: one untiered entry, one duplicate id, one clean. */
  const linted = (clean = false) => {
    const root = dir("check-");
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "decisions"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Check\ncatalogue: decisions\n---\n",
    );
    writeFileSync(join(root, "decisions", "a.md"), "- `x` **One.** (Javi, 2026-10-21)\n");
    if (!clean) {
      writeFileSync(join(root, "decisions", "b.md"), "- `x` **Two.** (Javi, 2026-10-21)\n");
      writeFileSync(
        join(root, "decisions", "c.md"),
        "- **No tier.**\n- **Bare choice.** (the agent's choice, 2026-10-21)\n- **Reasoned choice.** (the agent's choice, 2026-10-21, Gmail differs)\n",
      );
    }
    return root;
  };
  const plansIn = (root: string, args: string[]) => {
    try {
      return {
        out: execFileSync("node", [join(scripts, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]" },
        }),
        code: 0,
      };
    } catch (error) {
      const e = error as { stdout: string; status: number };
      return { out: e.stdout, code: e.status };
    }
  };

  it("plans check prints each fault and exits 1, and reports none on a clean catalogue", () => {
    const bad = plansIn(linted(), ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("decisions/c.md: no tier and date: **No tier.**");
    expect(bad.out).toContain("id x is used twice in decisions");
    expect(bad.out).toContain(
      "decisions/c.md: the agent's choice, retired: **Bare choice.** (the agent's choice, 2026-10-21)",
    );
    expect(bad.out).toContain(
      "decisions/c.md: the agent's choice, retired: **Reasoned choice.** (the agent's choice, 2026-10-21, Gmail differs)",
    );
    expect(bad.out).toContain("5 entries in 3 files, 4 faults.");
    const good = plansIn(linted(true), ["check"]);
    expect(good).toMatchObject({ code: 0 });
    expect(good.out).toContain("1 entries in 1 file, no faults.");
  });

  it("plans check reads a catalogue's README: an entry at the retired tier there is a fault", () => {
    const root = linted(true);
    writeFileSync(
      join(root, "decisions", "README.md"),
      "# Decisions\n\nThe rules for everywhere.\n\n- **Everywhere.** (the agent's choice, 2026-10-21)\n",
    );
    const bad = plansIn(root, ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(
      "decisions/README.md: the agent's choice, retired: **Everywhere.** (the agent's choice, 2026-10-21)",
    );
    expect(bad.out).toContain("2 entries in 2 files, 1 fault.");
  });

  it("plans check lints deny: an agent the plugin has not, a pattern that is no regular expression or no MCP name", () => {
    const root = linted(true);
    const file = (deny: string) =>
      writeFileSync(
        join(root, ".claude", "workflow.md"),
        `---\nname: Check\ncatalogue: decisions\n${deny}---\n`,
      );
    file('deny:\n  gardener:\n    - "mcp__lab__.*"\n  assistant:\n    - "mcp__["\n    - Bash\n');
    const bad = plansIn(root, ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n").slice(0, 3)).toEqual([
      "deny: gardener is no agent of the plugin (assistant, executor, maker, planner, reviewer)",
      "deny: assistant: mcp__[ is not a regular expression",
      "deny: assistant: Bash names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only",
    ]);
    file('deny:\n  - "mcp__lab__.*"\n');
    const flat = plansIn(root, ["check"]);
    expect(flat.code).toBe(1);
    expect(flat.out).toContain(
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    );
    file('deny:\n  workflow:assistant:\n    - "mcp__lab__.*"\n');
    expect(plansIn(root, ["check"]).out).toContain(
      "deny: workflow:assistant is no agent of the plugin (assistant, executor, maker, planner, reviewer)",
    );
    file('deny:\n  assistant:\n    - "mcp__server__write_.*"\n');
    const good = plansIn(root, ["check"]);
    expect(good).toMatchObject({ code: 0 });
    expect(good.out).toBe("1 entries in 1 file, no faults.\n");
  });

  /** The check's output on a project whose frontmatter adds `deny`. */
  const checkWith = (deny: string) => {
    const root = linted(true);
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---\nname: Check\ncatalogue: decisions\n${deny}---\n`,
    );
    return plansIn(root, ["check"]);
  };
  /** The deny hook on a project whose frontmatter adds `deny`: its stdout. */
  const hookWith = (deny: string, mode: string, input: object) => {
    const root = dir("hook-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Lab\n${deny}---\n`);
    return execFileSync("node", [join(scripts, "tool-denials.mjs"), mode], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  };

  it("an agent with its pattern on one line is read", () => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\ndeny:\n  assistant: "mcp__lab__.*"   # the owner\'s chat\n  planner:\n    - mcp__x__.*\n---\n',
    );
    expect(project(root).deny).toEqual({ assistant: ["mcp__lab__.*"], planner: ["mcp__x__.*"] });
    const bad = checkWith('deny:\n  assistant "mcp__lab__.*"\n');
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe(
      'deny: line 5 is not read: assistant "mcp__lab__.*" (an agent is "name:" with its patterns under it, or "name: pattern")',
    );
  });

  it("a mis-indented item is reported", () => {
    // At the agent's indent, an item is the agent's, as YAML reads it.
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\ndeny:\n    assistant:\n    - "mcp__a__.*"\n  - "mcp__b__.*"\n---\n',
    );
    expect(project(root).deny).toEqual({ assistant: ["mcp__a__.*"] });
    const bad = checkWith(
      'deny:\n    assistant:\n    - "mcp__a__.*"\n  - "mcp__b__.*"\n- "mcp__c__.*"\n',
    );
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n").slice(0, 2)).toEqual([
      'deny: line 7 is not read: - "mcp__b__.*" (an item goes under its agent\'s name, indented as deep or deeper)',
      'deny: line 8 is not read: - "mcp__c__.*" (an item goes under its agent\'s name, indented as deep or deeper)',
    ]);
  });

  it("a pattern cannot escape the anchors", () => {
    expect(matches(["mcp__a)|(.*"], "Bash")).toBe(false);
    expect(matches(["mcp__a)|(.*"], "mcp__a")).toBe(false);
    expect(matches(["mcp__a__(x|y)"], "mcp__a__y")).toBe(true);
    const bad = checkWith('deny:\n  assistant:\n    - "mcp__a)|(.*"\n');
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe("deny: assistant: mcp__a)|(.* is not a regular expression");
  });

  it("a connector named alone denies its every tool", () => {
    const deny = 'deny:\n  assistant:\n    - "mcp__(claude_ai_)?lab"\n';
    for (const tool_name of ["mcp__claude_ai_lab__delete", "mcp__lab__delete"])
      expect(hookWith(deny, "tool", { agent_type: "workflow:assistant", tool_name })).toContain(
        '"permissionDecision":"deny"',
      );
    expect(
      hookWith(deny, "tool", { agent_type: "workflow:assistant", tool_name: "mcp__labs__x" }),
    ).toBe("");
    const bad = checkWith(deny);
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe(
      "deny: assistant: mcp__(claude_ai_)?lab names a connector, not a tool: write `mcp__(claude_ai_)?lab__.*`",
    );
  });

  it("a connector named alone is read at its start only, between anchors, in an alternation", () => {
    const denied = (pattern: string, tool_name: string) =>
      hookWith(`deny:\n  assistant:\n    - "${pattern}"\n`, "tool", {
        agent_type: "workflow:assistant",
        tool_name,
      }).includes('"permissionDecision":"deny"');
    // An `mcp__` inside a server's name is no start: this names a tool.
    expect(denied("mcp__github_mcp__delete", "mcp__github_mcp__delete")).toBe(true);
    expect(denied("mcp__github_mcp__delete", "mcp__github_mcp__delete__x")).toBe(false);
    expect(denied("^mcp__lab$", "mcp__lab__x")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__a__x")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__b__c")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__b__d")).toBe(false);
    expect(checkWith('deny:\n  assistant:\n    - "mcp__github_mcp__delete"\n').code).toBe(0);
    expect(checkWith('deny:\n  assistant:\n    - "^mcp__lab$"\n').out.split("\n")[0]).toBe(
      "deny: assistant: ^mcp__lab$ names a connector, not a tool: write `^mcp__lab__.*$`",
    );
  });

  it("an agent named twice keeps both lists; a flow list or an empty agent is reported", () => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\ndeny:\n  executor: mcp__a__x\n  executor: mcp__b__y\n---\n",
    );
    expect(project(root).deny).toEqual({ executor: ["mcp__a__x", "mcp__b__y"] });
    const flow = checkWith("deny:\n  executor: [mcp__a__x, mcp__b__y]\n");
    expect(flow.code).toBe(1);
    expect(flow.out.split("\n")[0]).toBe(
      'deny: line 5 is not read: executor: [mcp__a__x, mcp__b__y] (an agent is "name:" with its patterns under it, or "name: pattern")',
    );
    expect(checkWith("deny:\n  executor:\n").out.split("\n")[0]).toBe(
      "deny: executor: no pattern under it, so it denies nothing",
    );
  });

  it("an alternation passes the lint", () => {
    expect(checkWith('deny:\n  assistant:\n    - "(mcp__a|mcp__b)__.*"\n')).toMatchObject({
      code: 0,
    });
    expect(checkWith('deny:\n  assistant:\n    - "mcp__(a|b)__.*"\n')).toMatchObject({ code: 0 });
    const bad = checkWith('deny:\n  assistant:\n    - "(Bash|Read)"\n');
    expect(bad.out.split("\n")[0]).toBe(
      "deny: assistant: (Bash|Read) names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only",
    );
  });

  it("the deny key is parsed once", () => {
    // The lint reads the project it is handed, not the file under the root.
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), '---\ndeny:\n  - "mcp__lab__.*"\n---\n');
    expect(checkDeny(project(root), ["assistant"])).toEqual([
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    ]);
  });

  it("another plugin's agent of the same name is not held to these lists", () => {
    const deny = 'deny:\n  assistant:\n    - "mcp__lab__.*"\n';
    const call = (agent_type: string) =>
      hookWith(deny, "tool", { agent_type, tool_name: "mcp__lab__delete" });
    expect(call("other:assistant")).toBe("");
    expect(call("workflow:assistant")).toContain('"permissionDecision":"deny"');
    expect(call("assistant")).toContain('"permissionDecision":"deny"');
  });

  it("plans check reads an override ending a sentence, and faults a catalogue that is not there", () => {
    const root = dir("override-");
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "ws", "decisions"), { recursive: true });
    mkdirSync(join(root, "_talk"));
    writeFileSync(join(root, "ws", "decisions", "title.md"), "- `x` **One.** (Javi, 2026-10-21)\n");
    writeFileSync(
      join(root, "_talk", "decisions.md"),
      "- `x` **Mine.** (Javi, 2026-10-22) overrides title#x.\n",
    );
    const file = (extra: string) =>
      writeFileSync(
        join(root, ".claude", "workflow.md"),
        `---\nname: O\ncatalogue: _talk/decisions.md\ninherits:\n  - ws/decisions\n${extra}---\n`,
      );
    file("");
    expect(plansIn(root, ["check"])).toMatchObject({ code: 0 });
    file("  - gone/decisions\n");
    const missing = plansIn(root, ["check"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("gone/decisions: no such catalogue");
  });

  it("plans chat --dry prints the maker's command with the project's mcp and inherits", () => {
    const root = dir("chat-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Talk\nform: compact\ninherits:\n  - ../ws/decisions\nmcp:\n  - .ppt/mcp.json\n---\n",
    );
    const { out } = plansIn(root, ["chat", "--dry", "Change slide 3"]);
    expect(out).toContain('"--agent" "workflow:maker" "--effort" "high" "Change slide 3"');
    expect(out).toContain(`"--mcp-config" "${join(root, ".ppt", "mcp.json")}"`);
    expect(out).not.toContain("--strict-mcp-config");
    expect(out).toContain(`"--add-dir" "${join(root, "..", "ws", "decisions")}"`);
    expect(out).toContain('"Change slide 3"');
    // The several-value flags come first, so the owner's words follow a flag of one value.
    expect(out.indexOf('"--agent"')).toBeGreaterThan(out.lastIndexOf('"--add-dir"'));
    expect(out.trim().endsWith('"Change slide 3"')).toBe(true);
  });

  it("refuses a turn that called a writing tool and recorded nothing, once, and passes decisions: none", () => {
    const root = dir("calls-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "decisions"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Calls\ncatalogue: decisions\ntools:\n  - "mcp__p__ppt_set_.*"\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
    const turn = (id: string, last: string) => {
      run("prompt", { session_id: id, prompt: "Make the title bigger" });
      run("tool", { session_id: id, tool_name: "mcp__p__ppt_set_text", tool_input: {} });
      run("tool", { session_id: id, tool_name: "mcp__p__ppt_get_slide", tool_input: {} });
      return run("stop", { session_id: id, stop_hook_active: false, last_assistant_message: last });
    };
    const first = turn(`calls-a-${process.pid}`, "Done.");
    expect(JSON.parse(first).reason).toBe(
      "1 call to mcp__p__ppt_set_text was made, and nothing under decisions did. Add or update the entry in decisions in this turn, as the Decisions rules say, or say why not in your final message with the line: decisions: none (why). A free detail, one nobody decided for a reason, gets no entry: decisions: none (free: <the rule it follows>).",
    );
    expect(run("stop", { session_id: `calls-a-${process.pid}`, stop_hook_active: true })).toBe("");
    expect(turn(`calls-b-${process.pid}`, "decisions: none (a bug)")).toBe("");
    expect(turn(`calls-c-${process.pid}`, "decisions: none (free: tooltips are short)")).toBe("");
  });

  it("audits a writing call in a project with no git", () => {
    const root = dir("nogit-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: NoGit\nform: compact\ncatalogue: decisions.md\ntools:\n  - "mcp__p__ppt_set_.*"\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
    const id = `nogit-${process.pid}`;
    run("prompt", { session_id: id, prompt: "Bigger title" });
    run("tool", { session_id: id, tool_name: "mcp__p__ppt_set_text", tool_input: {} });
    expect(run("stop", { session_id: id, stop_hook_active: false })).toContain(
      "1 call to mcp__p__ppt_set_text was made",
    );
  });
});

describe("the setup interview", () => {
  it("reads reviews, defaulting by form, and the starter names the key", () => {
    const at = (front: string) => {
      const root = dir("reviews-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).reviews;
    };
    expect(at("")).toEqual(["plan", "code-review", "codex"]);
    expect(at("form: compact\n")).toEqual([]);
    expect(at("reviews:\n  - code-review\n")).toEqual(["code-review"]);
    const fresh = dir("reviews-init-");
    init(fresh);
    expect(readFileSync(join(fresh, ".claude", "workflow.md"), "utf8")).toContain(
      "# reviews:               the reviews before a push: plan, code-review, codex, or a plugin skill; omit for all three",
    );
  });

  it("has the setup skill at fable, and the kinds table's five rows of eight columns", () => {
    const skill = new URL("../plugins/workflow/skills/setup/", import.meta.url).pathname;
    const text = readFileSync(join(skill, "SKILL.md"), "utf8");
    expect(text).toMatch(/^model: fable$/m);
    expect(text).toMatch(/^description: Sets a project up for the workflow in a short interview/m);
    const rows = readFileSync(join(skill, "kinds.md"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !/^\| (Kind|---)/.test(line));
    expect(rows.map((r) => r.split("|")[1].trim())).toEqual([
      "Web app or service",
      "Paper",
      "Talk",
      "Personal tool or script",
      "Something else",
    ]);
    for (const row of rows) expect(row.split("|").length - 2, row).toBe(8);
    // The reading-tools trial's outcome (plans/reading-tools-trial.md, 5c): none for every kind.
    for (const row of rows) expect(row.split("|")[7].trim(), row).toBe("none");
    // Every kind recommends its connectors: a "Connectors" column, filled in every row.
    const header = readFileSync(join(skill, "kinds.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| Kind |"));
    expect(header?.split("|")[8].trim()).toBe("Connectors");
    for (const row of rows) expect(row.split("|")[8].trim(), row).not.toBe("");
  });

  it("has the setup turn off the connectors a project does not use, by whole connector", () => {
    const skills = new URL("../plugins/workflow/skills/", import.meta.url).pathname;
    const text = readFileSync(join(skills, "setup", "SKILL.md"), "utf8");
    expect(text).toContain("permissions.deny");
    expect(text).toContain("mcp__claude_ai_<connector>");
    expect(text).toContain("Connectors: <chosen> on here; <denied> off (permissions.deny).");
    // Javi, 27 October: the denies go to settings.local.json where settings.json is public or shared.
    expect(text).toContain(".claude/settings.local.json");
    expect(text).toContain("gh repo view --json visibility");
    // A connector some agents need and others must not reach is the project file's.
    expect(text).toContain("the project file's `deny` key");
    // The GitHub token reaches the container through containerEnv (plans/github-token-in-containers.md).
    expect(text).toContain('"GH_TOKEN": "${localEnv:GH_TOKEN}"');
    expect(text).toContain("containerEnv");
    expect(text).toContain("gh auth status --hostname github.com");
    for (const line of [
      "GitHub: GH_TOKEN reaches this container (containerEnv); gh is signed in as <login>.",
      "GitHub: GH_TOKEN added to devcontainer.json (containerEnv); rebuild the container with GH_TOKEN set on the host, then gh signs in with it.",
      "GitHub: no gh in this container; the dotfiles install it and wire it to git when GH_TOKEN is set.",
      "GitHub: no .devcontainer here; GH_TOKEN must be in the shell that starts the queue's chats.",
    ])
      expect(text).toContain(line);
    expect(text.indexOf("## 6. The GitHub token")).toBeGreaterThan(-1);
    expect(text.indexOf("## 9. The final message")).toBeGreaterThan(
      text.indexOf("## 6. The GitHub token"),
    );
    expect(text).not.toMatch(
      /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
    );
    // No connector of the owner's is named in a skill or an agent file (CLAUDE.md: nothing
    // from a project is in the plugin); the public check covers the rest.
    const agents = new URL("../plugins/workflow/agents/", import.meta.url).pathname;
    const named = [
      ...(readdirSync(skills, { recursive: true }) as string[]).map((path) => join(skills, path)),
      ...readdirSync(agents).map((path) => join(agents, path)),
    ]
      .filter((path) => path.endsWith(".md"))
      .filter((path) => /homelab/i.test(readFileSync(path, "utf8")));
    expect(named).toEqual([]);
  });

  it("passes the project's mcp to a started chat", () => {
    const root = dir("start-mcp-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: M\nbranch: test\nmcp:\n  - .mcp/server.json\n---\n",
    );
    const out = execFileSync(
      "node",
      [join(scripts, "plan-queue.mjs"), "start", "--dry", "plans/x.md"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          WORKFLOW_LIVE: "[]",
          WORKFLOW_STARTS_LOG: join(root, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(root, ".claude", "usage.json"),
        },
      },
    );
    expect(out).toContain(
      `Would run: claude "--mcp-config" "${join(root, ".mcp", "server.json")}" "--bg"`,
    );
  });
});

describe("a plan still asking, whoever names it", () => {
  const agent = (name: string) =>
    readFileSync(new URL(`../plugins/workflow/agents/${name}.md`, import.meta.url), "utf8");

  it("has the executor run plans before a plan named by a path, and wait on one asking", () => {
    const sources = /## The plans you build\n\n[\s\S]*?\n\n/
      .exec(agent("executor"))![0]
      .replace(/\s+/g, " ");
    expect(sources).toContain("Run `plans` before building a plan named by a path");
    expect(sources).toContain('"Asking ${user_config.owner}" waits until the time it prints');
  });

  it("has the assistant hold back a plan still asking", () => {
    const handOver = /3\. \*\*A short plan for the executor\.\*\*[\s\S]*?\n4\. /.exec(
      agent("assistant"),
    )![0];
    expect(handOver).toContain('lists under "Asking ${user_config.owner}" is not sent');
  });
});

describe("a pull request stacked only on one it cannot be built without", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../plugins/workflow/${path}`, import.meta.url), "utf8");

  it("has the executor stack on use, never on a shared file, and refresh a conflicting pull request", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*"Before the push"/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    expect(mode).not.toContain("--name-only");
    expect(mode).toContain("it uses what an earlier plan adds");
    expect(mode).toContain(
      "only changes a file an open pull request changes is neither joined to it nor stacked on it",
    );
    expect(mode).toContain("`mergeable` `CONFLICTING`");
    // From the head as GitHub has it, its own base merged in, a plain push.
    expect(mode).toContain("`git switch -C <head branch> origin/<head branch>`");
    expect(mode).toContain("Merge its base, `origin/<baseRefName>`, in");
    expect(mode).toContain("push it with `git push origin <head branch>`, never to the branch");
  });

  // plans/refresh-by-merge.md: a branch is brought up to date by merging, never force-pushed.
  it("has the executor merge a branch up to date and never force-push", () => {
    const text = read("docs/landing.md");
    const flat = read("agents/executor.md").replace(/\s+/g, " ");
    expect(text).not.toContain("--force-with-lease");
    expect(text).not.toContain("git rebase --onto");
    expect(flat).toContain("nothing is force-pushed, ever");
    const mode = /# Landing by pull request[\s\S]*?\n\*\*The description\*\*/
      .exec(text)![0]
      .replace(/\s+/g, " ");
    const part = (from: string, to: string) => {
      const [start, end] = [mode.indexOf(from), mode.indexOf(to)];
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return mode.slice(start, end);
    };
    // One merge, defined once: no editor, the attribution, a plain push retried after a merge.
    const merge = part("**A branch is brought up to date by a merge**", "**A topic's branch**");
    expect(merge).toContain(
      '`git merge --no-edit -m "Merge origin/<base> into <name>" -m "<the session\'s attribution lines>" origin/<base>`',
    );
    expect(merge).toContain("`git commit --no-edit`");
    expect(merge).toContain("Push it to that branch only");
    expect(merge).toContain(
      "merge `origin/<name>` the same way, run the checks and push once more",
    );
    // The refresh, the waiting topic and the day's fixes branch merge, then push plainly.
    const refresh = part("**Then a conflicting pull request is refreshed**", '**"Before the push"');
    expect(refresh).toContain("Merge its base, `origin/<baseRefName>`, in");
    expect(refresh).toContain("`git push origin <head branch>`, never to the branch");
    expect(refresh).toContain("`Refreshed <date>: merged <base>, commit <sha>, <files>`"); // plans/also-knows-whose-commit.md
    const waiting = part("**A waiting branch**", "**An open pull request's branch**");
    expect(waiting).toContain("then its base merged in");
    expect(waiting).not.toContain("rebase");
    const topic = part("**A topic's plan**", "**Waiting, no pull request**");
    expect(topic).toContain("`git push -u origin <name>`, retried as for a merge");
    const fixes = part("**A fix**, `Lands: fix.`", "**A fix wanted now**");
    expect(fixes).toContain("`origin/<branch>` merged in");
    expect(fixes).toContain("one commit pushed with `git push -u origin fixes-<yyyy-mm-dd>`");
    expect(fixes).toContain(
      "The squash goes back to the tip the day's branch had once taken and merged",
    );
    expect(fixes).not.toContain("rebase");
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "A branch is brought up to date by merging, never force-pushed",
    );
  });

  // plans/refresh-only-your-own.md: only this person's pull requests, with the checks alone.
  it("has the executor refresh and retarget only its own person's pull requests, with the checks", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*"Before the push"/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    // plans/plans-as-github-issues.md: the pull requests open as the project's
    // app, so the plans' naming, never a Related line's, tells the queue's own.
    const own =
      "The queue's own pull requests are the open ones a plan in this checkout's `plans/` names as its own, by its \"Built\" or its `Lands` topic; a `Related` line names another's";
    const start = mode.slice(mode.indexOf("**At a batch's start**"));
    const refresh = mode.slice(mode.indexOf("**Then a conflicting pull request is refreshed**"));
    expect(start.slice(0, start.indexOf("**Then a conflicting"))).toContain(own);
    expect(refresh).toContain("each of the queue's own that GitHub reports as conflicting");
    expect(refresh).toContain(
      "run the project's checks, not the suites, since its CI runs on the push",
    );
    expect(mode).not.toContain("checks and suites run again");
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "The executor refreshes only the queue's own pull requests, with the checks alone**: those a plan in its `plans/` names as its own",
    );
  });

  it("has the docs, the planner and the assistant name a plan rested on only when it is used", () => {
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "A plan that rests on an open draft pull request of the queue's own lands in it; one that rests on a pull request marked ready, or someone else's, is stacked on it; one that only changes the same file is neither.",
    );
    for (const agent of ["planner", "assistant"])
      expect(read(`agents/${agent}.md`).replace(/\s+/g, " ")).toContain(
        "only when it uses what that plan adds, never for a shared file",
      );
  });

  // plans/draft-takes-its-follow-ups.md: a plan resting on an open draft of
  // the queue's own lands in it, listed with that draft's topic, not a new one.
  it("lands a plan resting on the queue's own open draft in that draft, and stacks it on any other", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*"Before the push"/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    const rests = mode.slice(
      mode.indexOf("**A plan that rests on an open pull request**"),
      mode.indexOf("**No branch yet**"),
    );
    expect(rests).toContain("`gh pr view <n> --json isDraft,headRefName`");
    expect(rests).toContain("**A draft of this queue's own** takes it");
    expect(rests).toContain(
      "the plan lands in that pull request whatever its `Lands` line names, its topic that head branch",
    );
    expect(rests).toContain("One marked ready, or another person's, is stacked on");
    // A plan written for a draft since marked ready gets a topic of its own, not the ready one.
    expect(rests).toContain(
      "as `topic <the plan's file name without .md>` (with `-2` when that is the head branch) when its `Lands` line names that pull request's topic",
    );
    // The plan is listed where it lands, so its old topic is not taken for opened.
    expect(rests).toContain("A plan sent to another topic has its `Lands` line rewritten to it");
    const fresh = mode.slice(
      mode.indexOf("**No branch yet**"),
      mode.indexOf("**A waiting branch**"),
    );
    expect(fresh).toContain("Stacked: `git switch -c <name> <that head branch>`");
    expect(fresh).not.toContain("that plan's pull request is open: then");
    for (const agent of ["planner", "assistant"]) {
      const text = read(`agents/${agent}.md`).replace(/\s+/g, " ");
      expect(text).toContain(
        'an open draft of this queue\'s own it lands in ("lands in #<n>", its `Lands` that draft\'s topic), one marked ready or another person\'s it is stacked on ("stacked on #<n>")',
      );
      expect(text).not.toContain("build it on #<n>'s branch");
    }
    const entry = read("docs/decisions.md").replace(/\s+/g, " ");
    expect(entry).toContain(
      "~~A plan that rests on an open pull request (uses what it adds) is stacked on it; one that only changes the same file is not.~~ (Javi, 30 October)",
    );
  });
});

describe("a pull request per topic", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../plugins/workflow/${path}`, import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );

  it("has the executor land a fix in the day's pull request or straight, and a topic when it is ready", () => {
    const text = read("docs/landing.md");
    const mode = /# Landing by pull request[\s\S]*/.exec(text)![0];
    // A fix: the day's branch and title.
    expect(mode).toContain("**A fix**, `Lands: fix.`");
    expect(mode).toContain("`fixes-<yyyy-mm-dd>`");
    expect(mode).toContain('--title "Small fixes, <d Month yyyy>"');
    expect(mode).toContain("--head fixes-<yyyy-mm-dd>");
    // A fix after the day's pull request merged waits for tomorrow's (Javi, 30 October).
    expect(mode).toContain("the fix **waits for tomorrow**");
    expect(mode).toContain("`fixes-<the next day's yyyy-mm-dd>`, pushed, no pull request");
    // A fix wanted now: the fast-forward push to the branch, then the Already on list.
    expect(mode).toContain("**A fix wanted now**, `Lands: fix, now.`");
    expect(mode).toContain("`git push origin HEAD:<branch>` as a fast-forward");
    expect(mode).toContain("under `Already on <branch>`");
    // A topic: its name is the branch, its pull request opens with the first ready plan.
    expect(mode).toContain("**A topic's branch** is the topic's name");
    expect(mode).toContain("written from every plan of the topic so far, oldest first");
    expect(mode).toContain("runs `gh pr ready --undo <n>` before its commit is pushed");
    // plans/joined-pull-request-no-comment.md: a plan joining an open pull request posts nothing.
    expect(mode).not.toContain("one comment");
    // plans/owner-reviews-before-anyone-else.md: a topic's pull request opens as a draft.
    expect(mode).toContain("gh pr create --draft --base");
    expect(mode).toContain("no `gh pr ready` without `--undo`");
    // plans/draft-says-nothing-about-itself.md: GitHub already shows a draft as one.
    expect(mode).not.toContain("Opened as a draft");
    expect(read("docs/workflow.md")).not.toContain("The draft's first line says so");
    // plans/joined-pull-request-no-comment.md: the screenshots go in by `gh pr edit --attach`.
    expect(mode).not.toContain("gh pr comment");
    expect(mode).not.toContain("in the comment below");
    expect(mode).toContain(
      "gh pr edit <n> --body-file plans/<this plan>/pull-request.md \\ --attach plans/<topic>/<file>.png#<the line>",
    );
    expect(mode).toContain("No comment: the description is the record");
    expect(mode).toContain("set it without `--attach`");
    expect(mode).toContain("description rewritten by `gh pr edit` with `--attach`");
    // The Codex review of it: a partly refused edit is set again from the body gh left.
    expect(mode).toContain("is read back (`gh pr view <n> --json body`) and set again");
    // Javi, 30 October: the comment says nothing of the draft either.
    expect(mode).not.toContain("a draft again until");
    expect(mode).not.toContain("its comment says so");
    // The shorter description: plans/pull-request-description-standard.md.
    expect(mode).not.toContain("None: no rule changed");
  });

  it("has the docs, the assistant and the planner say where a plan lands", () => {
    // plans/docs-as-a-prompt.md: the reason and the date are the catalogue's entry.
    expect(read("docs/decisions.md").replace(/\s+/g, " ")).toContain(
      "A pull request per topic when the topic has its central decision or two substantial ones; the fixes, with no decision, one pull request a day; one wanted at once straight to the branch.",
    );
    expect(read("docs/workflow.md")).toContain(
      "A topic's pull request opens as a draft and stays one until its owner has reviewed it himself",
    );
    expect(read("docs/workflow.md")).not.toContain("in this mode the queue reads no run");
    // plans/joined-pull-request-no-comment.md: the docs carry the rule, the old one quoted.
    expect(read("docs/decisions.md").replace(/\s+/g, " ")).toContain(
      "its screenshots attached with `gh pr edit --attach`, and nothing is posted.** (Javi, 31 October)",
    );
    expect(read("docs/workflow.md")).not.toContain("written again and one comment says");
    expect(read("docs/workflow.md")).toContain(
      "`gh pr create --attach` and `gh pr edit --attach`, which need gh 2.99",
    );
    expect(read("agents/assistant.md")).toContain(
      "Lands: <fix | fix, now | topic <name>, waiting | topic <name>, ready>.",
    );
    expect(read("agents/assistant.md")).toContain("`Lands: fix, now.` only when");
    expect(read("agents/planner.md")).toContain(
      "`Lands: topic <name>, ready.` or `Lands: topic <name>, waiting.`",
    );
    expect(read("skills/setup/SKILL.md")).toContain(
      "Small fixes with no decision in them come as one pull request a day.",
    );
  });
});

describe("the reuse ceiling and the reviewer", () => {
  it("has the executor stop at one retry of a push refused for credentials", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/agents/executor.md", import.meta.url),
      "utf8",
    );
    expect(text).toContain("Not pushed: <cause>");
    expect(text.replace(/\s+/g, " ")).toContain("Never a token in a URL, a remote or a config");
  });

  it("reads land, push by default, and the starter names it", () => {
    const at = (front: string) => {
      const root = dir("land-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).land;
    };
    expect(at("")).toBe("push");
    expect(at("land: pull-request\n")).toBe("pull-request");
    expect(at("land: merge\n")).toBe("push");
    const fresh = dir("land-init-");
    init(fresh);
    expect(readFileSync(join(fresh, ".claude", "workflow.md"), "utf8")).toContain(
      "# land: pull-request    a pull request per topic and one a day for small fixes; omit to push everything",
    );
  });

  it("reads reuse per agent, 200k for an executor and 160k or 480k for a planner by default, and the starter names it", () => {
    const at = (front: string) => {
      const root = dir("reuse-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).reuse;
    };
    const defaults = {
      executor: { any: 200_000, related: 200_000 },
      planner: { any: 160_000, related: 480_000 },
    };
    expect(at("")).toEqual(defaults);
    expect(at("reuse: nothing\n")).toEqual(defaults);
    // A number holds every agent to it, both cases.
    expect(at("reuse: 120000\n")).toEqual({
      executor: { any: 120_000, related: 120_000 },
      planner: { any: 120_000, related: 120_000 },
    });
    // The map sets each; a missing one is the default.
    expect(
      at(
        "reuse:\n  executor: 150000\n  executor-related: 250000\n  planner: 100000\n  planner-related: 300000\n",
      ),
    ).toEqual({
      executor: { any: 150_000, related: 250_000 },
      planner: { any: 100_000, related: 300_000 },
    });
    expect(at("reuse:\n  executor: 150000\n")).toEqual({
      executor: { any: 150_000, related: 150_000 },
      planner: { any: 160_000, related: 480_000 },
    });
    // Related work is never held to less than any work.
    expect(at("reuse:\n  planner-related: 100000\n  executor-related: 10\n")).toEqual({
      executor: { any: 200_000, related: 200_000 },
      planner: { any: 160_000, related: 160_000 },
    });
    expect(at("reuse:\n  planner: 600000\n").planner).toEqual({
      any: 600_000,
      related: 600_000,
    });
    const fresh = dir("reuse-init-");
    init(fresh);
    const text = readFileSync(join(fresh, ".claude", "workflow.md"), "utf8");
    for (const line of [
      "# reuse: 200000          the context, in tokens, above which a finished session retires: one number for every agent, or",
      "#   executor: 200000     the executor's (default 200000)",
      "#   planner: 160000      the planner's for a brief on other ground (default 160000)",
      "#   planner-related: 480000  the planner's for a brief related to its plans (default 480000)",
    ])
      expect(text).toContain(line);
  });

  it("has the reviewer agent, read-only", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/agents/reviewer.md", import.meta.url),
      "utf8",
    );
    for (const line of [
      "name: reviewer",
      "model: opus",
      "effort: medium",
      "tools: Read, Grep, Glob, Bash",
    ])
      expect(text).toContain(line);
  });
});

describe("the reading-tools trial", () => {
  const trial = new URL("../trials/reading-tools/", import.meta.url).pathname;

  it("prints the pilot's four commands on --dry and runs nothing", () => {
    const results = join(dir("trial-"), "results.jsonl");
    const out = execFileSync("node", [join(trial, "run.mjs"), "--pilot", "--dry"], {
      encoding: "utf8",
      env: { ...process.env, READING_TRIAL_RESULTS: results },
    });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines)
      expect(line).toMatch(
        /\) claude -p --output-format stream-json --verbose --max-budget-usd 1 /,
      );
    expect(lines.filter((l) => l.includes("--mcp-config"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("--append-system-prompt"))).toHaveLength(2);
    expect(existsSync(results)).toBe(false);
  });

  it("passes every task's oracle answer and fails an empty answer and the prompt itself", async () => {
    const { check, readTasks } = await import("../trials/reading-tools/run.mjs");
    const tasks = readTasks();
    expect(tasks).toHaveLength(24);
    for (const repo of ["plugin", "project"]) {
      const own = tasks.filter((t: { repo: string }) => t.repo === repo);
      expect(own.filter((t: { kind: string }) => t.kind === "code")).toHaveLength(6);
      expect(own.filter((t: { kind: string }) => t.kind === "docs")).toHaveLength(6);
    }
    for (const task of tasks) {
      expect(check(task, task.oracle), task.id).toBe(true);
      expect(check(task, ""), task.id).toBe(false);
      expect(check(task, null), task.id).toBe(false);
      expect(check(task, task.prompt), task.id).toBe(false);
    }
  });

  it("orders every task and rep for both arms, alternating which goes first", async () => {
    const { schedule } = await import("../trials/reading-tools/run.mjs");
    const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const runs = schedule(tasks, { reps: 2 });
    expect(runs).toHaveLength(12);
    expect(runs.map((r: { arm: string }) => r.arm).slice(0, 4)).toEqual([
      "native",
      "tools",
      "tools",
      "native",
    ]);
    expect(schedule(tasks, { reps: 2 })).toEqual(runs);
    expect(schedule(tasks, { reps: 1, arms: ["tools"] })).toHaveLength(3);
  });

  it("reports the means, the medians and the delta from eight lines", async () => {
    const { summarize, format } = await import("../trials/reading-tools/report.mjs");
    const run = (arm: string, ok: boolean, creation: number, input: number, cost: number) => ({
      kind: "run",
      repo: "plugin",
      arm,
      id: "x",
      rep: 1,
      ok,
      cost,
      usage: { input, cache_read: 1000, cache_creation: creation, output: 100 },
      turns: 4,
      seconds: 10,
      error: null,
    });
    const lines = [
      run("native", true, 10_000, 0, 0.2),
      run("native", true, 12_000, 0, 0.2),
      run("native", true, 14_000, 0, 0.2),
      run("native", false, 16_000, 0, 0.2),
      run("tools", true, 6_000, 0, 0.1),
      run("tools", true, 8_000, 0, 0.1),
      run("tools", true, 10_000, 0, 0.1),
      run("tools", true, 12_000, 0, 0.1),
      { ...run("tools", true, 1, 0, 9), pilot: true },
      {
        kind: "index",
        repo: "plugin",
        seconds: { code: 1, docs: 2 },
        bytes: { code: 2048, docs: 1024 },
      },
    ];
    const summary = summarize(lines);
    const r = summary.repos.plugin;
    expect(r.native.runs).toBe(4);
    expect(r.tools.runs).toBe(4);
    expect(r.native.T.mean).toBe(13_000);
    expect(r.tools.T.mean).toBe(9_000);
    expect(r.native.T.median).toBe(13_000);
    expect(r.delta.T).toBeCloseTo(-30.77, 1);
    expect(r.delta.cost).toBeCloseTo(-50, 5);
    expect(r.delta.success).toBe(25);
    expect(r.noise).toBe(50);
    expect(summary.outcome).toBe("everywhere");
    const text = format(summary);
    expect(text).toContain("| T | 13,000 (median 13,000) | 9,000 (median 9,000) | -30.8% |");
    expect(text).toContain("| success | 75% | 100% | +25.0 points |");
    expect(text).toContain("| plugin | 1 s, 2 KB | 2 s, 1 KB |");
    expect(text).toContain("**Outcome by the rule: everywhere.**");
  });
});

describe("the reading-tools trial's stream", () => {
  it("reads the result line and counts the tools a run called", async () => {
    const { readStream } = await import("../trials/reading-tools/run.mjs");
    const tool = (name: string) => ({ type: "tool_use", name });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [tool("Grep"), tool("Read")] } }),
      JSON.stringify({ type: "assistant", message: { content: [tool("mcp__jcodemunch__order")] } }),
      JSON.stringify({ type: "assistant", message: { content: [tool("Read"), { type: "text" }] } }),
      JSON.stringify({ type: "result", result: "decideStop", total_cost_usd: 0.1 }),
      '{"type":"assist',
    ].join("\n");
    const { result, tools } = readStream(stream);
    expect(result.result).toBe("decideStop");
    expect(tools).toEqual({ Grep: 1, Read: 2, mcp__jcodemunch__order: 1 });
    expect(readStream("")).toEqual({ result: null, tools: {} });
  });
});

describe("the reading-tools trial's guards", () => {
  it("says the outcome is incomplete when an arm has no runs", async () => {
    const { summarize } = await import("../trials/reading-tools/report.mjs");
    const run = { kind: "run", repo: "plugin", arm: "native", id: "x", rep: 1, ok: true };
    const summary = summarize([{ ...run, cost: 0.1, usage: null, turns: 2, seconds: 5 }]);
    expect(summary.repos.plugin.delta.success).toBeNull();
    expect(summary.repos.plugin.keeps).toBe(false);
    expect(summary.outcome).toBe("incomplete: an arm has no runs");
  });

  it("reads the window from usage.json and says when the reading is stale", async () => {
    const { windowOf } = await import("../trials/reading-tools/run.mjs");
    const path = join(dir("usage-"), "usage.json");
    const now = Date.UTC(2026, 9, 27, 15);
    const at = (minutesAgo: number, used: number) =>
      writeFileSync(
        path,
        JSON.stringify({
          at: now / 1000 - minutesAgo * 60,
          five_hour: { used_percentage: used, resets_at: now / 1000 + 3600 },
        }),
      );
    at(1, 61);
    expect(windowOf(path, now)).toEqual({ over: 61, stale: false });
    at(1, 40);
    expect(windowOf(path, now)).toEqual({ over: null, stale: false });
    at(45, 40);
    expect(windowOf(path, now)).toEqual({ over: null, stale: true });
    expect(windowOf(join(path, "missing"), now)).toEqual({ over: null, stale: true });
  });
});

/** plans/owner-questions-plain-and-once.md, part 3: the hooks manifest runs the plain-words check. */
describe("the hooks manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../plugins/workflow/hooks/hooks.json", import.meta.url), "utf8"),
  );
  const commands = (event: string, matcher?: string) =>
    manifest.hooks[event]
      .filter((entry: { matcher?: string }) => entry.matcher === matcher)
      .flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((h) => h.command));

  it("checks every question to the owner, and resets the count at each prompt", () => {
    expect(commands("PreToolUse", "AskUserQuestion")).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/plain-words.mjs" question',
    ]);
    expect(commands("UserPromptSubmit")).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/plain-words.mjs" prompt',
    );
    expect(manifest.description).toContain("the plain-words check of every question");
  });
  // plans/catch-inconsistent-ui-at-build.md: room for the small model's one call.
  it("gives the catalogue hook thirty seconds, for its model call", () => {
    const entry = manifest.hooks.PreToolUse.flatMap((e: { hooks: object[] }) => e.hooks).find(
      (h: { command: string }) => h.command.includes("catalogue-context.mjs"),
    );
    expect(entry.timeout).toBe(30);
  });
  it("runs the queue's tool hook on the question tool, for the window's time", () => {
    const tool = manifest.hooks.PreToolUse.find((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some((h) => h.command.endsWith('plan-queue.mjs" tool')),
    );
    expect(tool.matcher.split("|")).toContain("AskUserQuestion");
  });
});

describe("installing by asking Claude", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(repo, path), "utf8");
  const prompt =
    "Install the workflow plugin from https://github.com/JavierMNieto/workflow-plugin by following its INSTALL.md.";
  /** The first ```json block of a Markdown text. */
  const jsonBlock = (text: string) => /```json\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1] ?? "";
  /** The first plain ``` block of a Markdown text: the commands. */
  const commands = (text: string) => /```\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1] ?? "";
  const installing = () => {
    const docs = read("plugins/workflow/docs/workflow.md");
    return docs.slice(docs.indexOf("\n## Installing\n"));
  };

  it("holds the settings the docs' Installing section holds, so the two cannot drift", () => {
    const install = JSON.parse(jsonBlock(read("INSTALL.md")));
    // The docs show the keys as a fragment of the settings file, without its braces.
    const fromDocs = JSON.parse(`{${jsonBlock(installing())}}`);
    expect(Object.keys(fromDocs)).toEqual([
      "extraKnownMarketplaces",
      "enabledPlugins",
      "statusLine",
      "worktree",
      "env",
    ]);
    expect(install).toEqual(fromDocs);
  });
  it("runs the two commands the docs' Installing section names", () => {
    const fromDocs = commands(installing());
    expect(fromDocs).toContain("claude plugin marketplace add JavierMNieto/workflow-plugin#main");
    expect(fromDocs).toContain('claude plugin install workflow@workflow --config owner="<name>"');
    expect(commands(read("INSTALL.md"))).toBe(fromDocs);
  });
  it("opens the README with the line a person pastes", () => {
    const readme = read("README.md");
    const first = readme.split(/^## /m)[1];
    expect(first.startsWith("Install\n")).toBe(true);
    expect(first.split("\n").filter(Boolean)[1]).toBe(`> ${prompt}`);
  });
});

// plans/install-checks-itself.md: an incomplete copy is said plainly.
// plans/install-fix-safe.md: its fix puts the files back and deletes nothing.
describe("the install check", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const plugin = join(repo, "plugins", "workflow");
  /** A copy of `plugins/workflow` in a temp dir, outside any cache, with the paths given removed. */
  const copy = (...remove: string[]) => {
    const root = join(dir("workflow-copy-"), "workflow");
    cpSync(plugin, root, { recursive: true });
    for (const path of remove) rmSync(join(root, path), { recursive: true, force: true });
    return root;
  };
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  /**
   * A plugins directory as Claude Code lays it out: the marketplace's clone,
   * `<tmp>/marketplaces/workflow`, one commit holding `plugins/workflow`, and
   * the copy at `<tmp>/cache/workflow/workflow/<version>`, the paths given removed.
   */
  const cache = (...remove: string[]) => {
    const tmp = dir("workflow-plugins-");
    const clone = join(tmp, "marketplaces", "workflow");
    mkdirSync(clone, { recursive: true });
    gitIn(clone, "init", "-q", "-b", "main");
    cpSync(plugin, join(clone, "plugins", "workflow"), { recursive: true });
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "one");
    const version = gitIn(clone, "rev-parse", "--short=12", "HEAD");
    const root = join(tmp, "cache", "workflow", "workflow", version);
    cpSync(plugin, root, { recursive: true });
    for (const path of remove) rmSync(join(root, path), { recursive: true, force: true });
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: { "workflow@workflow": [{ scope: "user", installPath: root, version }] },
        },
        null,
        2,
      ),
    );
    return { tmp, clone, root, version };
  };
  /** The record names another version directory: the copy is an older one. */
  const older = (tmp: string) =>
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "workflow@workflow": [
              {
                scope: "user",
                installPath: join(tmp, "cache", "workflow", "workflow", "ffffffffffff"),
                version: "ffffffffffff",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  const OLDER = "This copy is an older version that new chats do not load: start a new chat.";
  const FOLDER =
    "This copy is loaded from a folder, not the plugins cache: put them back in that folder, " +
    "then start a new chat.";
  const broken = ["hooks/hooks.json", "scripts/project.mjs", "skills"];
  const brokenList =
    "hooks/hooks.json, scripts/project.mjs, skills/change/SKILL.md, " +
    "skills/design-research/SKILL.md, skills/setup/SKILL.md, skills/setup/kinds.md";
  /** The manifest's SessionStart command, the one declared inline. */
  const manifestCommand = () => {
    const manifest = JSON.parse(
      readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const [entry] = manifest.hooks.SessionStart;
    expect(entry.matcher).toBe("startup|resume|clear");
    return entry.hooks[0].command as string;
  };
  /** The check run on a copy, its JSON's text, or "" when it printed nothing. */
  const check = (root: string) => {
    const run = spawnSync("node", [join(root, "scripts", "install-check.mjs")], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    if (!run.stdout) return "";
    const out = JSON.parse(run.stdout);
    // The owner sees the line; the agent gets the line and what to do with it.
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: `${out.systemMessage}\n\n${steps(root)}`,
    });
    return out.systemMessage as string;
  };
  /** `plans` in a throwaway git repository, on the copy's `bin/plans`. */
  const plans = (root: string) => {
    const cwd = dir("workflow-plans-");
    execFileSync("git", ["init", "-q"], { cwd });
    return spawnSync("node", [join(root, "bin", "plans")], { cwd, encoding: "utf8" });
  };
  /** The command after `The fix: `, up to `, then start a new chat.` */
  const fixIn = (text: string) => /The fix: (.*), then start a new chat\./.exec(text)?.[1];
  const head = (root: string, gone: string) =>
    `The workflow plugin's installed copy is incomplete: 6 of its ${FILES.length} files are missing ` +
    `from ${root}, and what is missing does not run in this chat. Missing: ${gone}. `;

  it("lists every tracked file of the plugin, so a new file without a line fails here", () => {
    const tracked = execFileSync("git", ["ls-files", "plugins/workflow"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice("plugins/workflow/".length));
    expect(FILES, "FILES in scripts/install-check.mjs differs from git ls-files").toEqual(tracked);
  });
  it("When a complete copy starts a session, then the check prints nothing", () => {
    expect(check(copy())).toBe("");
  });
  it("When a cached copy lacks files and the clone is at its commit, then the fix is git archive", () => {
    const { clone, root, version } = cache(...broken);
    expect(check(root)).toBe(
      head(root, brokenList) +
        `The fix: git -C "${clone}" archive ${version}:plugins/workflow | tar -x -C "${root}", ` +
        "then start a new chat.",
    );
  });
  it("When that fix is run, then the copy is whole again, bin/plans executable", () => {
    const { root } = cache(...broken, "bin/plans");
    const command = fixIn(check(root));
    expect(command).toMatch(/ archive /);
    const run = spawnSync("sh", ["-c", command as string], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(missing(root)).toEqual([]);
    expect(statSync(join(root, "bin", "plans")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(root, "scripts", "project.mjs"), "utf8")).toBe(
      readFileSync(join(plugin, "scripts", "project.mjs"), "utf8"),
    );
    expect(check(root)).toBe("");
  });
  it("When the clone has moved on from the copy's commit, then the fix is plugin update", () => {
    const { clone, root } = cache(...broken);
    writeFileSync(join(clone, "later.txt"), "later\n");
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "two");
    expect(check(root)).toBe(
      head(root, brokenList) +
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
    );
  });
  it("When the clone is absent, then the fix is plugin update", () => {
    const { clone, root } = cache(...broken);
    rmSync(clone, { recursive: true, force: true });
    expect(check(root)).toBe(
      head(root, brokenList) +
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
    );
  });
  it("When the copy is not in a plugins cache, then the line names no command", () => {
    const root = copy(...broken);
    expect(check(root)).toBe(
      head(root, brokenList) +
        "This copy is loaded from a folder, not the plugins cache: put them back in that folder, " +
        "then start a new chat.",
    );
  });
  it("When plans runs on an incomplete copy, then it says the same line and exits 1", () => {
    const root = copy(...broken);
    const text = check(root);
    expect(text).toContain("This copy is loaded from a folder");
    const run = plans(root);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`${text}\n`);
  });
  it("When the copy is an older version than the installed one, then the line names no command", () => {
    const { tmp, root } = cache(...broken);
    older(tmp);
    const text = check(root);
    expect(text).toBe(head(root, brokenList) + OLDER);
    const run = plans(root);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`${text}\n`);
  });
  it("When a folder above the cache is a symlink, then the installed copy is still the installed one", () => {
    const { tmp, clone, root, version } = cache(...broken);
    const link = `${tmp}-link`;
    symlinkSync(tmp, link);
    made.push(link);
    const linked = join(link, "cache", "workflow", "workflow", version);
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: { "workflow@workflow": [{ scope: "user", installPath: linked, version }] },
        },
        null,
        2,
      ),
    );
    // Node resolves the script's path, so the check reads the real root.
    const run = spawnSync("node", [join(linked, "scripts", "install-check.mjs")], {
      encoding: "utf8",
    });
    expect(JSON.parse(run.stdout).systemMessage).toBe(
      head(root, brokenList) +
        `The fix: git -C "${clone}" archive ${version}:plugins/workflow | tar -x -C "${root}", ` +
        "then start a new chat.",
    );
    const one = cache("scripts/install-check.mjs", "skills");
    const oneLink = `${one.tmp}-link`;
    symlinkSync(one.tmp, oneLink);
    made.push(oneLink);
    const oneLinked = join(oneLink, "cache", "workflow", "workflow", one.version);
    writeFileSync(
      join(one.tmp, "installed_plugins.json"),
      JSON.stringify({ plugins: { "workflow@workflow": [{ installPath: oneLinked }] } }, null, 2),
    );
    const cwd = dir("workflow-plans-");
    execFileSync("git", ["init", "-q"], { cwd });
    const plansRun = spawnSync("node", [join(oneLinked, "bin", "plans")], {
      cwd,
      encoding: "utf8",
    });
    expect(plansRun.stderr).toContain("The fix: git -C");
  });
  it("When one file is missing, then the line says it is", () => {
    const root = copy("settings.json");
    expect(check(root)).toContain(`1 of its ${FILES.length} files is missing from ${root}`);
  });
  it("When a copy lacks the check itself, then the manifest and plans decide as the check does", () => {
    const first =
      "The workflow plugin's installed copy is incomplete: scripts/install-check.mjs is missing, " +
      "and maybe more. ";
    const atCommit = cache("scripts/install-check.mjs");
    const movedOn = cache("scripts/install-check.mjs");
    writeFileSync(join(movedOn.clone, "later.txt"), "later\n");
    gitIn(movedOn.clone, "add", "-A");
    gitIn(movedOn.clone, "commit", "-q", "-m", "two");
    const old = cache("scripts/install-check.mjs");
    older(old.tmp);
    const folder = copy("scripts/install-check.mjs");
    // The manifest's line carries the agent's steps; plans prints the line alone.
    const ask =
      ' Say this line to the owner, then ask once with the question tool, headed "Install", ' +
      "whether to run the fix; on yes run it, then say to start a new chat; on no, say nothing " +
      "is changed. Then stop.";
    const say = " Say this line to the owner, then stop.";
    const layouts: [string, string, string][] = [
      [
        atCommit.root,
        `The fix: git -C "${atCommit.clone}" archive ${atCommit.version}:plugins/workflow | ` +
          `tar -x -C "${atCommit.root}", then start a new chat.`,
        ask,
      ],
      [
        movedOn.root,
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
        ask,
      ],
      [old.root, OLDER, say],
      [folder, FOLDER, say],
    ];
    for (const [root, last, steps] of layouts) {
      const fallback = `${first}${last}\n`;
      const env = { ...process.env, HOME: dir("workflow-home-"), CLAUDE_PLUGIN_ROOT: root };
      const hook = spawnSync("sh", ["-c", manifestCommand()], { encoding: "utf8", env });
      expect(hook.status, root).toBe(0);
      expect(hook.stdout, root).toBe(`${first}${last}${steps}\n`);
      const cwd = dir("workflow-plans-");
      execFileSync("git", ["init", "-q"], { cwd });
      const run = spawnSync("node", [join(root, "bin", "plans")], { cwd, encoding: "utf8", env });
      expect(run.status, root).toBe(1);
      expect(run.stdout, root).toBe("");
      expect(run.stderr, root).toBe(fallback);
    }
  });
  it("says what the agents do with the line in the same words in all four", () => {
    const paragraph = (agent: string) =>
      /\*\*An incomplete install comes first\.\*\*[\s\S]*?\n\n/.exec(
        readFileSync(join(plugin, "agents", `${agent}.md`), "utf8"),
      )?.[0];
    const assistant = paragraph("assistant");
    expect(assistant).toContain("The workflow plugin's installed copy is incomplete");
    for (const agent of ["planner", "executor", "maker"]) expect(paragraph(agent)).toBe(assistant);
  });
});
