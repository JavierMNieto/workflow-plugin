import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canStart,
  data,
  decideStop,
  kindOf,
  owner,
  pathsIn,
  sessionEnv,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { defaultBranch, frontmatter, init, project } from "../plugins/workflow/scripts/project.mjs";
import { globToRegExp, reasonFor, untiered } from "../plugins/workflow/scripts/turn-audit.mjs";

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
      ".claude/executor.*\n.claude/planner.*\n",
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
        PATH: "/bin",
        HOME: "/h",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
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

  it("has a maker agent, and every agent but the assistant names the design-research skill", () => {
    const agents = new URL("../plugins/workflow/agents/", import.meta.url).pathname;
    const maker = readFileSync(join(agents, "maker.md"), "utf8");
    for (const key of ["name: maker", "model: opus", "effort: high", "skills:"])
      expect(maker).toContain(key);
    for (const agent of ["maker", "planner", "executor"]) {
      const front = /^---\n([\s\S]*?)\n---/.exec(
        readFileSync(join(agents, `${agent}.md`), "utf8"),
      )![1];
      expect(front, agent).toMatch(/skills:\n {2}- design-research/);
    }
    const assistant = /^---\n([\s\S]*?)\n---/.exec(
      readFileSync(join(agents, "assistant.md"), "utf8"),
    )![1];
    expect(assistant).not.toContain("design-research");
    expect(
      existsSync(new URL("../plugins/workflow/skills/design-research/SKILL.md", import.meta.url)),
    ).toBe(true);
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
    expect(
      untiered("- **A rule.** (Mary Jane, 27 October)\n- **Another.** (José, 2 May)\n"),
    ).toEqual([]);
  });

  it("checks no README, and suggests a tier the check accepts", () => {
    const rule = {
      catalogue: "docs/patterns",
      texts: {
        "docs/patterns/README.md": "- **paths**: the globs a file governs\n",
        "docs/patterns/a.md": "- **No tier.**\n",
      },
      day: "27 October",
    };
    expect(reasonFor(["docs/patterns/README.md"], "", "", rule)).toBe("");
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
      writeFileSync(join(root, "decisions", "c.md"), "- **No tier.**\n");
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
    expect(bad.out).toContain("3 entries in 3 files, 2 faults.");
    const good = plansIn(linted(true), ["check"]);
    expect(good).toMatchObject({ code: 0 });
    expect(good.out).toContain("1 entries in 1 file, no faults.");
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
      "1 call to mcp__p__ppt_set_text was made, and nothing under decisions did. Add or update the entry in decisions in this turn, as the Decisions rules say, or say why not in your final message with the line: decisions: none (why).",
    );
    expect(run("stop", { session_id: `calls-a-${process.pid}`, stop_hook_active: true })).toBe("");
    expect(turn(`calls-b-${process.pid}`, "decisions: none (a bug)")).toBe("");
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

  it("has the setup skill at fable, and the kinds table's five rows of seven columns", () => {
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
    for (const row of rows) expect(row.split("|").length - 2, row).toBe(7);
    // The reading-tools trial's outcome (plans/reading-tools-trial.md, 5c): none for every kind.
    for (const row of rows) expect(row.split("|")[7].trim(), row).toBe("none");
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

describe("the reuse ceiling and the reviewer", () => {
  it("reads reuse, 200000 by default, and the starter names it", () => {
    const at = (front: string) => {
      const root = dir("reuse-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).reuse;
    };
    expect(at("")).toBe(200_000);
    expect(at("reuse: 120000\n")).toBe(120_000);
    const fresh = dir("reuse-init-");
    init(fresh);
    expect(readFileSync(join(fresh, ".claude", "workflow.md"), "utf8")).toContain(
      "# reuse: 200000",
    );
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
