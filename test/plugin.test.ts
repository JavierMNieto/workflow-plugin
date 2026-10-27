import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { init, project } from "../plugins/workflow/scripts/project.mjs";
import {
  globToRegExp,
  preferenceIn,
  reasonFor,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";

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

  it("defaults the name to the directory and the branch to the remote's default", () => {
    const root = dir("defaults-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    expect(project(root)).toMatchObject({ branch: "main", run: "", ui: [], found: false });
    expect(project(root).name).toMatch(/^defaults-/);
    const origin = dir("origin-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "trunk"], { cwd: origin, stdio: "ignore" });
    git("remote", "add", "origin", origin);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(project(root).branch).toBe("trunk");
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
      "nothing under docs/patterns/ did",
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

describe("the audit's preference check", () => {
  it("reads a preference or a correction, and not a plain request", () => {
    expect(preferenceIn("from now on the title slide is centered")).toBe("from now on");
    expect(preferenceIn("no, not like that")).not.toBe("");
    expect(preferenceIn("I prefer the darker blue")).toBe("I prefer");
    expect(preferenceIn("change the second slide's title")).toBe("");
    expect(preferenceIn("I'd prefer a smaller font")).toBe("I'd prefer");
    expect(preferenceIn("Fix the build:\nNo such file or directory")).toBe("");
  });

  it("asks once when a preference turn left the catalogue untouched, and passes a decision: none", () => {
    const root = dir("prefs-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "docs", "patterns"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Prefs\nui:\n  - "src/**"\ncatalogue: docs/patterns\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_OWNER: "Javi" },
      });
    const turn = (id: string, last: string) => {
      run("prompt", { session_id: id, prompt: "From now on the title slide is centered" });
      return run("stop", { session_id: id, stop_hook_active: false, last_assistant_message: last });
    };
    const first = turn(`prefs-a-${process.pid}`, "Done.");
    expect(JSON.parse(first).reason).toContain(
      'The request reads like a preference or a correction ("From now on").',
    );
    expect(JSON.parse(first).reason).toContain("under Javi's name");
    expect(run("stop", { session_id: `prefs-a-${process.pid}`, stop_hook_active: true })).toBe("");
    expect(turn(`prefs-b-${process.pid}`, "decision: none (a one-off)")).toBe("");
    expect(
      turn(`prefs-c-${process.pid}`, "Recorded: docs/patterns/slides.md: titles centered"),
    ).toBe("");
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
});
