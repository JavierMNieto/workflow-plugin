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
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { init, project } from "../plugins/workflow/scripts/project.mjs";
import { globToRegExp, reasonFor } from "../plugins/workflow/scripts/turn-audit.mjs";

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

  it("finds the data directory from the environment, the cache path, or the default", () => {
    expect(data({ CLAUDE_PLUGIN_DATA: "/d" })).toBe("/d");
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
