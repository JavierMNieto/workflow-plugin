// The design catalogue's hooks (docs/contributing.md):
// the edit-time context and the once-per-turn audit, run as the real scripts
// against a throwaway git repository.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listToJudge,
  recordTool,
  shellWrites,
  treeFiles,
} from "../plugins/workflow/scripts/turn-audit.mjs";
import {
  allowedWhileLocked,
  agentEffort,
  canStart,
  changedFiles,
  decidePlannerStop,
  plannerPrompt,
  sessionsOf,
  versionLine,
  countCompaction,
  cutoffEdit,
  decideResumed,
  decideStop,
  inThisRepo,
  lockHeldByOther,
  ownRows,
  takeLock,
  parseDay,
  pathsIn,
  plannerMayEdit,
  planTaken,
  readPlans,
  plannerContext,
  briefPaths,
  relatedBrief,
  withPlans,
  describeSession,
  stopPlannersOn,
  stopRetiredPlanners,
  stopTakenPlanners,
  whoTook,
  related,
  resetTime,
  stateOf,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { statusFrom } from "../plugins/workflow/scripts/statusline.mjs";

const here = new URL("../plugins/workflow/scripts/", import.meta.url).pathname;
const audit = join(here, "turn-audit.mjs");

// The plugin's `owner` option, as Claude Code exports it to a hook.
process.env.CLAUDE_PLUGIN_OPTION_OWNER = "Javi";

/** What the session's own Write tool did, as `PostToolUse` reports it. */
function wrote(sessionId: string, path: string) {
  run(audit, ["tool"], {
    session_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: join(repo, path) },
  });
}

let repo: string;

function run(script: string, args: string[], input: object, env: Record<string, string> = {}) {
  return execFileSync("node", [script, ...args], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "workflow-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "workflow.md"),
    `---
name: Test
branch: test
run: image.yml
ui:
  - "apps/*/src/{components,app}/**"
  - "packages/{ui,editor,player}/src/**"
catalogue: docs/patterns
---

# Test
`,
  );
  mkdirSync(join(repo, "docs", "patterns"), { recursive: true });
  mkdirSync(join(repo, "packages", "player", "src", "components"), { recursive: true });
  mkdirSync(join(repo, "apps", "forum", "src", "components"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "patterns", "chat.md"),
    `---
paths:
  - "packages/player/src/components/{ChatBox,Keypad}.tsx"
---

# The chat box and the calculator

- **The calculator opens in the field's place.** (Javi, 11 October) One place to work.
- **Keys are drawn as a grid.** (the agent's choice, 17 September)
- **The chat has a Stop button.** (as ChatGPT does, 1 October)
`,
  );
  writeFileSync(
    join(repo, "docs", "patterns", "buttons.md"),
    `# Buttons

- **Icon buttons carry a tooltip.** (Javi, 3 September)
`,
  );
  writeFileSync(
    join(repo, "docs", "patterns", "destructive.md"),
    `---
signals:
  - "\\bdelete\\b"
  - "<ConfirmButton\\b"
---

# Destructive actions

- **Deleting asks to confirm with the consequence named, through ConfirmButton.** (Javi, 3 September)
- **Undo where it is cheap.** (as Gmail does, 5 September)
`,
  );
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("turn-audit", () => {
  const session = { session_id: "t1" };

  it("lets a turn that changed one file stop, after it changed the catalogue too", () => {
    run(audit, ["prompt"], { ...session, prompt: "Fix the keypad" });
    writeFileSync(join(repo, "packages/player/src/components/Keypad.tsx"), "export {}\n");
    writeFileSync(
      join(repo, "docs/patterns/chat.md"),
      "# The chat box\n\n- **Keys are big.** (Javi, 15 October)\n",
    );
    wrote("t1", "packages/player/src/components/Keypad.tsx");
    wrote("t1", "docs/patterns/chat.md");
    const out = run(audit, ["stop"], {
      ...session,
      stop_hook_active: false,
      last_assistant_message: "Done.",
    });
    expect(JSON.parse(out).reason).toContain("changed 2 files");
    expect(JSON.parse(out).reason).not.toContain("nothing under docs/patterns/");
  });

  it("refuses once when a UI file changed and the catalogue did not, then lets the second stop pass", () => {
    run(audit, ["prompt"], { session_id: "t2", prompt: "Make the chat box taller" });
    writeFileSync(join(repo, "packages/player/src/components/ChatBox.tsx"), "export {}\n");
    wrote("t2", "packages/player/src/components/ChatBox.tsx");
    const first = run(audit, ["stop"], {
      session_id: "t2",
      stop_hook_active: false,
      last_assistant_message: "Done.",
    });
    const reason = JSON.parse(first).reason as string;
    expect(reason).toContain("nothing under docs/patterns/ did");
    expect(reason).not.toContain("changed 1 files");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: true })).toBe("");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: false })).toBe("");
  });

  it("accepts a patterns: none line in the final message", () => {
    run(audit, ["prompt"], { session_id: "t3", prompt: "Fix a typo" });
    writeFileSync(join(repo, "apps/forum/src/components/Composer.tsx"), "export {}\n");
    wrote("t3", "apps/forum/src/components/Composer.tsx");
    const out = run(audit, ["stop"], {
      session_id: "t3",
      stop_hook_active: false,
      last_assistant_message: "patterns: none (a typo)",
    });
    expect(out).toBe("");
  });

  it("stays quiet for a turn that changed nothing", () => {
    run(audit, ["prompt"], { session_id: "t4", prompt: "Explain the keypad" });
    expect(run(audit, ["stop"], { session_id: "t4", stop_hook_active: false })).toBe("");
  });
});

/**
 * **A session answers only for its own writes** (docs/contributing.md): the
 * planner and the assistant read beside a building executor in one checkout,
 * and were asked about the executor's files.
 */
describe("turn-audit, whose files they are", () => {
  const fresh = () => ({ files: {}, wrote: [] as string[], shell: false });

  it("remembers the path an Edit wrote, relative to the project", () => {
    const state = recordTool(
      fresh(),
      { tool_name: "Edit", tool_input: { file_path: "/repo/apps/forum/src/a.ts" } },
      "/repo",
    );
    expect(state.wrote).toEqual(["apps/forum/src/a.ts"]);
    expect(state.shell).toBe(false);
  });

  it("takes a reading shell command as writing nothing", () => {
    const state = recordTool(fresh(), {
      tool_name: "Bash",
      tool_input: { command: "cat docs/editor.md | grep -n R3 && git diff --stat" },
    });
    expect(state.shell).toBe(false);
  });

  it("takes sed -i as writing the tree", () => {
    const state = recordTool(fresh(), {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' apps/forum/src/a.ts" },
    });
    expect(state.shell).toBe(true);
  });

  it("judges nothing when its tools wrote nothing, though the tree changed", () => {
    const state = { ...fresh(), files: {} };
    expect(listToJudge(state, { "apps/forum/src/a.ts": [1, 1] })).toEqual([]);
  });

  it("judges only the changed files its editing tools wrote", () => {
    const state = { ...fresh(), wrote: ["a.ts"] };
    expect(listToJudge(state, { "a.ts": [1, 1], "b.ts": [1, 1] })).toEqual(["a.ts"]);
  });

  it("judges the whole tree after a writing shell command", () => {
    const state = { ...fresh(), shell: true };
    expect(listToJudge(state, { "a.ts": [1, 1], "b.ts": [1, 1] })).toEqual(["a.ts", "b.ts"]);
  });

  it("lets a stop pass for a session whose tools wrote nothing beside another's changes", () => {
    run(audit, ["prompt"], { session_id: "t5", prompt: "Plan the next change" });
    writeFileSync(join(repo, "apps/forum/src/components/Feed.tsx"), "export {}\n");
    writeFileSync(join(repo, "apps/forum/src/components/Nav.tsx"), "export {}\n");
    run(audit, ["tool"], {
      session_id: "t5",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });
    expect(run(audit, ["stop"], { session_id: "t5", stop_hook_active: false })).toBe("");
  });

  it("never audits the planner or the assistant", () => {
    for (const [id, agent] of [
      ["t6", "planner"],
      ["t6a", "assistant"],
    ]) {
      run(audit, ["prompt"], { session_id: id, prompt: "Write the plan", agent_type: agent });
      writeFileSync(join(repo, "apps/forum/src/components/Plan.tsx"), "export {}\n");
      wrote(id, "apps/forum/src/components/Plan.tsx");
      run(audit, ["tool"], {
        session_id: id,
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
      });
      expect(run(audit, ["stop"], { session_id: id, stop_hook_active: false })).toBe("");
    }
  });

  it("takes tools run at once each into account", () => {
    run(audit, ["prompt"], { session_id: "t7", prompt: "Two files at once" });
    writeFileSync(join(repo, "apps/forum/src/components/One.tsx"), "export {}\n");
    writeFileSync(join(repo, "apps/forum/src/components/Two.tsx"), "export {}\n");
    wrote("t7", "apps/forum/src/components/One.tsx");
    wrote("t7", "apps/forum/src/components/Two.tsx");
    const out = run(audit, ["stop"], {
      session_id: "t7",
      stop_hook_active: false,
      last_assistant_message: "patterns: none (a test)",
    });
    expect(JSON.parse(out).reason).toContain("changed 2 files");
  });

  it("stays quiet for a tool event and a stop with no prompt before them", () => {
    wrote("t8", "apps/forum/src/components/Stray.tsx");
    expect(run(audit, ["stop"], { session_id: "t8", stop_hook_active: false })).toBe("");
  });
});

describe("plan-queue", () => {
  const header = (day: string) =>
    `# A plan\n\nPlan only, ${day}, for Javi; the executor builds it.\n\n`;
  const plan = (path: string, extra: object = {}) => ({
    path,
    related: false,
    asks: false,
    ...extra,
  });

  describe("stateOf", () => {
    // plans/queue-reads-iso-dates.md: a plan or brief dated 2026-10-24 is listed.
    it("reads an ISO date like a written one", () => {
      const date = parseDay("24 October 2026");
      expect(stateOf(header("2026-10-24"))).toMatchObject({ state: "ready", date });
      expect(stateOf("# B\n\nBrief for the planner, 2026-10-24.\n")).toMatchObject({
        state: "brief",
        date,
      });
      expect(
        stateOf(`${header("2026-10-24")}## Built, 26 October 2026\n\nCommit 1234abcd.\n`),
      ).toMatchObject({ state: "built", date });
      expect(parseDay("2026-13-01")).toBeNaN();
      // Codex, 26 October: a date that does not parse is not ready.
      expect(stateOf(header("2026-13-01"))).toMatchObject({ state: "old" });
      expect(parseDay("2026-10-26x")).toBeNaN();
    });

    it("reads a brief, a ready plan and one that asks", () => {
      expect(stateOf("# B\n\nBrief for the planner, 24 October 2026.\n")).toMatchObject({
        state: "brief",
        stale: false,
        day: "24 October 2026",
      });
      expect(stateOf(header("24 October 2026"))).toMatchObject({ state: "ready", asks: false });
      const asking = `${header("24 October 2026")}## Decisions for Javi\n\n1. **The shape.** One or two.\n`;
      expect(stateOf(asking)).toMatchObject({ state: "ready", asks: true });
      expect(stateOf(`${asking}\n## Decided, 24 October 2026\n\n- One.\n`)).toMatchObject({
        asks: false,
      });
      expect(stateOf(`${header("24 October 2026")}## Decisions for Javi\n\nNone.\n`)).toMatchObject(
        { asks: false },
      );
    });

    it("reads a Building line as building only while its session lives", () => {
      const text = `${header("24 October 2026")}## Building, 24 October 2026, session abc\n`;
      expect(stateOf(text, { live: ["abc"] })).toMatchObject({ state: "building", session: "abc" });
      expect(stateOf(text, { live: null })).toMatchObject({ state: "building" });
      expect(stateOf(text, { live: ["xyz"] })).toMatchObject({ state: "ready", stale: true });
    });

    it("reads Built with its commit, an old plan, and nothing for a note", () => {
      const built = `${header("24 October 2026")}## Built, 24 October 2026\n\nOn branch x, commit 61c4a812.\n`;
      expect(stateOf(built)).toMatchObject({
        state: "built",
        sha: "61c4a812",
        builtDay: "24 October 2026",
      });
      const named = `${header("24 October 2026")}## Built, 24 October 2026\n\nExecutor [8411646d], commit 0d3505f8.\n`;
      expect(stateOf(named)).toMatchObject({ sha: "0d3505f8" });
      expect(stateOf(header("20 October 2026"))).toMatchObject({ state: "old" });
      expect(stateOf("# Notes\n\nSome notes.\n")).toBeNull();
    });

    it("reads a handed-over plan, and calls it stuck at six or twice at one step", () => {
      const handed = `${header("24 October 2026")}## Handing over, 24 October 2026\n\nStep in hand: 4\n\nOn branch \`queue-work\`.\n`;
      expect(stateOf(handed)).toMatchObject({
        state: "handed",
        step: "4",
        branch: "queue-work",
        stuck: false,
      });
      const resumed = (steps: string[]) =>
        steps.map((n, i) => `## Resumed, 24 October 2026, session s${i}, at step ${n}\n`).join("");
      expect(stateOf(handed + resumed(["1", "2", "3", "4", "5", "6"]))).toMatchObject({
        stuck: true,
      });
      expect(stateOf(handed + resumed(["1", "2", "3", "4", "5"]))).toMatchObject({ stuck: false });
      expect(stateOf(handed + resumed(["3", "3"]))).toMatchObject({ stuck: true });
      expect(stateOf(handed + resumed(["3", "4"]))).toMatchObject({ stuck: false });
    });
  });

  it("finds the paths a plan names, once each, and not inside an address", () => {
    const text =
      "Change `apps/forum/src/x.ts` and packages/editor/src/y.tsx, read docs/editor.md. " +
      "Again `docs/editor.md`; see https://example.org/docs/a.md.";
    expect(pathsIn(text)).toEqual([
      "apps/forum/src/x.ts",
      "packages/editor/src/y.tsx",
      "docs/editor.md",
    ]);
    expect(related(text, ["docs/editor.md"])).toBe(true);
    expect(related(text, ["docs/copy.md"])).toBe(false);
  });

  describe("decideStop", () => {
    const failed = { id: 7, status: "completed", conclusion: "failure", onHead: true };

    it("refuses on a red or unfinished run of this push, and ignores another sha", () => {
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true });
      expect(decideStop({ run: failed })!.reason).toContain("(7) is failed");
      // A later turn's first stop refuses again: nothing remembers the run.
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true });
      expect(
        decideStop({ run: { ...failed, status: "in_progress", conclusion: null } })!.reason,
      ).toContain("in progress");
      expect(decideStop({ run: { ...failed, onHead: false } })).toBeNull();
      expect(decideStop({ run: { ...failed, conclusion: "success" } })).toBeNull();
    });

    it("lets a continued stop pass the run it was refused for, and no other", () => {
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true, runId: 7 });
      expect(decideStop({ run: failed, continuing: true, refusedRun: 7 })).toBeNull();
      // A new push in the continued turn: its run is asked about.
      expect(
        decideStop({ run: { ...failed, id: 8 }, continuing: true, refusedRun: 7 }),
      ).toMatchObject({ refuse: true, runId: 8 });
      const waiting = [plan("plans/a.md")];
      expect(decideStop({ run: failed, continuing: true, refusedRun: 7, waiting })).toMatchObject({
        refuse: true,
        told: ["plans/a.md"],
      });
    });

    it("names waiting plans to a fresh session, oldest first, and not twice", () => {
      const waiting = [plan("plans/a.md"), plan("plans/b.md", { asks: true })];
      const out = decideStop({ waiting });
      expect(out).toMatchObject({ refuse: true, told: ["plans/a.md", "plans/b.md"] });
      expect(out!.reason).toContain("plans/a.md, plans/b.md (asks Javi)");
      expect(decideStop({ waiting, told: ["plans/a.md", "plans/b.md"] })).toBeNull();
      expect(decideStop({})).toBeNull();
    });

    it("keeps a session with one compaction only for a related plan, and retires it at two", () => {
      expect(
        decideStop({ compactions: 1, waiting: [plan("plans/a.md", { related: true })] }),
      ).toMatchObject({
        refuse: true,
      });
      expect(decideStop({ compactions: 1, waiting: [plan("plans/a.md")] })).toEqual({
        retire: true,
        paths: ["plans/a.md"],
      });
      expect(
        decideStop({ compactions: 2, waiting: [plan("plans/a.md", { related: true })] }),
      ).toMatchObject({
        retire: true,
      });
      expect(decideStop({ retired: true, waiting: [plan("plans/a.md")], run: failed })).toBeNull();
    });

    it("starts a handed plan whatever the count, and asks about a stuck one instead", () => {
      const handed = { path: "plans/h.md", stuck: false, resumed: [] };
      expect(decideStop({ handed: [handed], waiting: [plan("plans/a.md")] })).toEqual({
        handover: handed,
      });
      const stuck = { path: "plans/h.md", stuck: true, resumed: ["3", "3"] };
      expect(decideStop({ handed: [stuck] })!.context).toContain("handed over twice at step 3");
      const six = { ...stuck, resumed: ["1", "2", "3", "4", "5", "6"] };
      expect(decideStop({ handed: [six] })!.context).toContain("handed over 6 times");
    });

    it("neither hands more nor retires a session with a plan of its own still being built", () => {
      const current = { path: "plans/mine.md" };
      expect(decideStop({ current, compactions: 2, waiting: [plan("plans/a.md")] })).toBeNull();
      expect(decideStop({ current, waiting: [plan("plans/a.md")] })).toBeNull();
      expect(decideStop({ current, run: failed })).toMatchObject({ refuse: true });
    });

    it("while paused, refuses only on the run", () => {
      expect(decideStop({ paused: true, waiting: [plan("plans/a.md")] })).toBeNull();
      expect(decideStop({ paused: true, run: failed })).toMatchObject({ refuse: true });
      expect(
        decideStop({ paused: true, handed: [{ path: "plans/h.md", stuck: false, resumed: [] }] }),
      ).toBeNull();
    });
  });

  it("asks for a handover at the third compaction inside a plan, and not otherwise", () => {
    const current = { path: "plans/x.md", stuck: false };
    expect(decideResumed({ compactions: 2, plan: current })).toBe("");
    expect(decideResumed({ compactions: 3, plan: current })).toContain("inside plans/x.md");
    expect(decideResumed({ compactions: 3, plan: current })).toContain("Step in hand");
    expect(decideResumed({ compactions: 3, plan: null })).toBe("");
    expect(decideResumed({ compactions: 4, plan: { ...current, stuck: true } })).toBe("");
  });

  it("counts a compaction once though two hooks report it", () => {
    const state = countCompaction({ compactions: 0 }, 1_000_000);
    countCompaction(state, 1_010_000);
    expect(state.compactions).toBe(1);
    countCompaction(state, 1_100_000);
    expect(state.compactions).toBe(2);
  });

  describe("canStart", () => {
    const now = Date.UTC(2026, 9, 24, 12);
    const usage = (five: number, seven = 10) => ({
      at: now / 1000 - 60,
      five_hour: { used_percentage: five, resets_at: now / 1000 + 3600 },
      seven_day: { used_percentage: seven, resets_at: now / 1000 + 86400 },
    });

    it("refuses while paused, and while an executor holds the lock", () => {
      expect(canStart({ now, paused: "today", usage: usage(10) })).toMatchObject({ refuse: true });
      const lock = { sessionId: "abc", pid: 1, name: "Executor 2" };
      expect(canStart({ now, lock, alive: () => true, usage: usage(10) }).why).toContain(
        "Executor 2",
      );
      expect(
        canStart({ now, lock: { ...lock, released: 1 }, alive: () => true, usage: usage(10) }),
      ).toMatchObject({
        start: true,
      });
      expect(canStart({ now, lock, alive: () => false, usage: usage(10) })).toMatchObject({
        start: true,
      });
    });

    it("defers to the window's reset when usage is high", () => {
      expect(canStart({ now, usage: usage(81) })).toMatchObject({
        defer: true,
        until: now + 3600_000 + 120_000,
        why: "the five-hour window is at 81 percent",
      });
      expect(canStart({ now, usage: usage(10, 96) })).toMatchObject({
        defer: true,
        until: now + 86400_000 + 120_000,
      });
      expect(canStart({ now, usage: usage(80, 95) })).toMatchObject({ start: true });
    });

    it("ignores a high number written before its window reset", () => {
      const past = { ...usage(99), five_hour: { used_percentage: 99, resets_at: now / 1000 - 60 } };
      expect(canStart({ now, usage: past })).toMatchObject({ start: true });
    });

    it("starts and says so when usage is unknown", () => {
      expect(canStart({ now }).note).toContain("Usage unknown");
      expect(canStart({ now, usage: { ...usage(99), at: now / 1000 - 3600 } })).toMatchObject({
        start: true,
      });
    });

    it("refuses after a quick death and at the tripwire, and names the next executor", () => {
      const last = { at: now - 5 * 60_000, name: "Executor 3" };
      expect(canStart({ now, log: [last], usage: usage(10) }).why).toContain("Executor 3");
      expect(
        canStart({ now, log: [last], progressAt: now - 60_000, usage: usage(10) }),
      ).toMatchObject({
        start: true,
        name: "Executor 4",
      });
      const day = Array.from({ length: 24 }, (_, i) => ({
        at: now - (i + 1) * 30 * 60_000,
        name: `Executor ${i + 2}`,
      }));
      expect(canStart({ now, log: day.reverse(), usage: usage(10) }).why).toContain("Twenty-four");
      expect(canStart({ now, usage: usage(10) })).toMatchObject({ name: "Executor 1" });
    });
  });

  it("lets only another live, unreleased session lock this one out, and reading through", () => {
    const lock = { sessionId: "other", pid: 5 };
    expect(lockHeldByOther(lock, "me", () => true)).toBe(true);
    expect(lockHeldByOther(lock, "me", () => false)).toBe(false);
    expect(lockHeldByOther({ ...lock, released: 1 }, "me", () => true)).toBe(false);
    expect(lockHeldByOther({ ...lock, sessionId: "me" }, "me", () => true)).toBe(false);
    expect(lockHeldByOther(null, "me", () => true)).toBe(false);
    expect(allowedWhileLocked("git status")).toBe(true);
    expect(allowedWhileLocked("plans")).toBe(true);
    expect(allowedWhileLocked("plans --all")).toBe(true);
    expect(allowedWhileLocked("plans start")).toBe(false);
    expect(allowedWhileLocked("npm run build")).toBe(false);
  });

  it("hands a cut-off plan over in place of its Building line, at the window's reset", () => {
    const text = `${header("24 October 2026")}## Building, 24 October 2026, session abc\n\n## What was asked\n`;
    const out = cutoffEdit(text, { sessionId: "abc", branch: "queue", day: "24 October 2026" });
    expect(out).not.toContain("## Building");
    expect(out).toContain("## Handing over, 24 October 2026, by the hook\n\nStep in hand: unknown");
    expect(out).toContain("branch `queue`");
    expect(stateOf(out)).toMatchObject({
      state: "handed",
      branch: "queue",
      step: expect.stringMatching(/^unknown/),
    });
    const high = {
      five_hour: { used_percentage: 100, resets_at: 2000 },
      seven_day: { used_percentage: 20, resets_at: 9000 },
    };
    expect(resetTime(high)).toBe(2000);
    expect(resetTime(null, '{"rate_limit_info":{"resetsAt":1500}}\n{"resetsAt":1700}')).toBe(1700);
  });

  it("prints the status line and keeps the usage, or leaves it before the first call", () => {
    const input = {
      model: { display_name: "Opus" },
      context_window: { used_percentage: 41.6 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    };
    const { line, usage } = statusFrom(input, 1_000_000);
    expect(line).toBe("Opus · context 42% · 5h 24% · 7d 41%");
    expect(usage).toEqual({
      at: 1000,
      five_hour: input.rate_limits.five_hour,
      seven_day: input.rate_limits.seven_day,
    });
    expect(statusFrom({ model: { display_name: "Opus" } })).toEqual({ line: "Opus", usage: null });
  });

  it("writes the usage file from the status line script", () => {
    const file = join(repo, "usage.json");
    execFileSync("node", [join(here, "statusline.mjs")], {
      input: JSON.stringify({
        model: { display_name: "Opus" },
        rate_limits: { five_hour: { used_percentage: 5, resets_at: 9 } },
      }),
      encoding: "utf8",
      env: { ...process.env, WORKFLOW_USAGE_FILE: file },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      five_hour: { used_percentage: 5 },
    });
  });

  it("puts a handed-over plan first, then the rest oldest first", () => {
    const dir = join(repo, "order-plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "later.md"), header("25 October 2026"));
    writeFileSync(join(dir, "earlier.md"), header("24 October 2026"));
    writeFileSync(
      join(dir, "handed.md"),
      `${header("26 October 2026")}## Handing over, 26 October 2026\n\nStep in hand: 2\n`,
    );
    expect(readPlans(dir).map((p) => p.path)).toEqual([
      "plans/handed.md",
      "plans/earlier.md",
      "plans/later.md",
    ]);
  });

  it("lists the queue under its headings, in order", () => {
    mkdirSync(join(repo, "plans"), { recursive: true });
    writeFileSync(join(repo, "plans", "ready.md"), header("24 October 2026"));
    writeFileSync(join(repo, "plans", "old.md"), header("20 October 2026"));
    writeFileSync(
      join(repo, "plans", "done.md"),
      `${header("24 October 2026")}## Built, ${new Date().getDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][new Date().getMonth()]} ${new Date().getFullYear()}\n\nCommit 0123abcd.\n`,
    );
    const out = execFileSync("node", [join(here, "plan-queue.mjs"), "list"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    expect(out).toMatch(/^Plans, .*The executor: none alive\./);
    expect(out.indexOf("Ready, oldest first")).toBeLessThan(out.indexOf("Built today"));
    expect(out).toContain("plans/ready.md");
    expect(out).toContain("0123abcd");
    expect(out).toContain("Older, by path only: 1 plan dated");
  });

  /**
   * **An executor in a worktree is alive** (plans/queue-sees-worktree-
   * executor.md): a background session is moved under `.claude/worktrees/`,
   * and the queue read it as gone.
   */
  describe("inThisRepo", () => {
    const paths = ["/w/project", "/w/project/.claude/worktrees/executor", "/w/sibling"];
    it("counts the checkout, its worktrees and their subdirectories", () => {
      expect(inThisRepo("/w/project", paths)).toBe(true);
      expect(inThisRepo("/w/project/.claude/worktrees/executor", paths)).toBe(true);
      expect(inThisRepo("/w/sibling", paths)).toBe(true);
      expect(inThisRepo("/w/project/.claude/worktrees/executor/apps/forum", paths)).toBe(true);
      expect(inThisRepo("/w/sibling/apps", paths)).toBe(true);
    });
    it("does not count a session with no working directory", () => {
      expect(inThisRepo(undefined, paths)).toBe(false);
      expect(inThisRepo("", paths)).toBe(false);
    });
    it("does not count another repository, or a path that only shares a prefix", () => {
      expect(inThisRepo("/w/elsewhere", paths)).toBe(false);
      expect(inThisRepo("/w/project-other", paths)).toBe(false);
    });
  });

  it("lists a live executor in a worktree as busy, its plan as building, and the worktree in use", () => {
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
      {
        cwd: repo,
      },
    );
    const tree = join(repo, ".claude", "worktrees", "executor");
    execFileSync("git", ["worktree", "add", "-q", "-b", "nine-work", tree, "HEAD"], { cwd: repo });
    const leftover = join(repo, ".claude", "worktrees", "leftover");
    execFileSync("git", ["worktree", "add", "-q", "--detach", leftover, "HEAD"], { cwd: repo });
    const session = "11111111-2222-3333-4444-555555555555";
    writeFileSync(
      join(repo, ".claude", "executor.lock"),
      JSON.stringify({ sessionId: session, name: "Executor 9", pid: process.pid }),
    );
    writeFileSync(
      join(repo, "plans", "busy.md"),
      `# Busy\n\n## Building, 26 October 2026, session ${session}\n\nPlan only, 26 October 2026.\n`,
    );
    const live = [
      { sessionId: session, name: "Executor 9", status: "busy", cwd: join(tree, "apps") },
    ];
    try {
      const out = listWith(live);
      expect(out).toMatch(
        /The executor: Executor 9 \[11111111\], busy, in executor on nine-work, holds the lock, building plans\/busy\.md\./,
      );
      expect(out).toMatch(/\nBuilding\n  plans\/busy\.md +Executor 9, since 26 October 2026/);
      expect(out).not.toMatch(/busy\.md[^\n]*gone/);
      expect(out).toMatch(
        /Worktrees under \.claude\/worktrees: .*executor on nine-work \(Executor 9\)/,
      );
      expect(out).toMatch(/leftover \(free\)/);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
      execFileSync("git", ["worktree", "remove", "--force", leftover], { cwd: repo });
      execFileSync("git", ["branch", "-D", "-q", "nine-work"], { cwd: repo });
      rmSync(join(repo, ".claude", "executor.lock"), { force: true });
      rmSync(join(repo, "plans", "busy.md"), { force: true });
    }
  });

  /**
   * **Any live executor counts** (plans/queue-counts-any-executor.md): the
   * executor line is read from the sessions, not from the lock.
   */
  describe("the executor line", () => {
    const ids = {
      four: "44444444-0000-0000-0000-000000000000",
      five: "55555555-0000-0000-0000-000000000000",
      hand: "66666666-0000-0000-0000-000000000000",
      chat: "77777777-0000-0000-0000-000000000000",
    };
    const stateFile = (id: string) => join(tmpdir(), `workflow-queue-${id}.json`);
    afterAll(() => {
      for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
      rmSync(join(repo, ".claude", "executor.lock"), { force: true });
    });

    it("lists an executor in the checkout with a released lock, and nothing more", () => {
      writeFileSync(
        join(repo, ".claude", "executor.lock"),
        JSON.stringify({ sessionId: ids.four, name: "Executor 4", released: 1 }),
      );
      const out = listWith([
        { sessionId: ids.four, name: "Executor 4", status: "busy", cwd: repo },
      ]);
      expect(out).toMatch(/The executor: Executor 4 \[44444444\], busy, in the checkout\.\n/);
    });

    it("says the executors, and retired on the retired one only", () => {
      writeFileSync(stateFile(ids.five), JSON.stringify({ retired: true }));
      const out = listWith([
        { sessionId: ids.four, name: "Executor 4", status: "idle", cwd: repo },
        { sessionId: ids.five, name: "Executor 5", status: "busy", cwd: repo },
      ]);
      expect(out).toMatch(
        /The executors: Executor 4 \[44444444\], idle, in the checkout; Executor 5 \[55555555\], busy, in the checkout, retired\./,
      );
    });

    it("says the plan a retired planner still holds, and the brief one is planning", () => {
      const p2 = "22222222-1111-0000-0000-000000000000";
      const p3 = "33333333-1111-0000-0000-000000000000";
      writeFileSync(
        stateFile(p2),
        JSON.stringify({ agent: "planner", retired: true, planned: true, brief: "plans/x.md" }),
      );
      writeFileSync(stateFile(p3), JSON.stringify({ agent: "planner", brief: "plans/y.md" }));
      mkdirSync(join(repo, "plans"), { recursive: true });
      writeFileSync(
        join(repo, "plans", "y.md"),
        `# Y\n\nBrief for the planner, 26 October 2026.\n\n## Planning, 26 October 2026, session ${p3}\n`,
      );
      try {
        const out = listWith([
          { sessionId: p2, name: "Planner 2", status: "idle", cwd: repo, kind: "background" },
          { sessionId: p3, name: "Planner 3", status: "busy", cwd: repo, kind: "background" },
        ]);
        expect(out).toContain("Planner 2 [22222222], idle, retired, its plan plans/x.md");
        expect(out).toContain("Planner 3 [33333333], busy, planning plans/y.md");
      } finally {
        rmSync(stateFile(p2), { force: true });
        rmSync(stateFile(p3), { force: true });
        rmSync(join(repo, "plans", "y.md"), { force: true });
      }
    });

    it("counts a session its prompt hook marked, and not an ordinary chat", () => {
      writeFileSync(stateFile(ids.hand), JSON.stringify({ agent: "executor" }));
      const out = listWith([
        { sessionId: ids.hand, status: "busy", cwd: repo, kind: "interactive" },
        { sessionId: ids.chat, name: "Assistant", status: "busy", cwd: repo, kind: "interactive" },
      ]);
      expect(out).toMatch(/The executor: 66666666 \[66666666\], busy, in the checkout\./);
      expect(out).not.toContain("77777777");
    });

    it("leaves out the session being replaced and the retired ones when starting", () => {
      const live = [
        { sessionId: ids.four, name: "Executor 4", status: "busy", cwd: repo },
        { sessionId: ids.five, name: "Executor 5", status: "busy", cwd: repo },
      ];
      const states: Record<string, { retired?: boolean }> = { [ids.five]: { retired: true } };
      const all = sessionsOf("executor", live, null, {
        trees: [{ path: repo, branch: "" }],
        stateFor: (id) => states[id] || null,
      });
      expect(all.map((one) => [one.name, one.retired])).toEqual([
        ["Executor 4", false],
        ["Executor 5", true],
      ]);
      const blocking = all.filter((one) => one.sessionId !== ids.four && !one.retired);
      expect(blocking).toEqual([]);
    });
  });

  describe("starting beside a live executor", () => {
    const one = {
      kind: "executor" as const,
      sessionId: "aacbea39-0000-0000-0000-000000000000",
      id: "bg-123",
      name: "Executor 2",
      status: "busy",
      where: "public-sources-edits",
      branch: "codex-answers",
      holdsLock: false,
      retired: false,
      on: "",
    };
    it("refuses while one is alive, whatever the lock", () => {
      const decision = canStart({ sessions: [one], lock: null });
      expect(decision).toMatchObject({ refuse: true });
      expect("why" in decision && decision.why).toBe(
        "An executor is alive: Executor 2 [aacbea39], busy, in public-sources-edits on codex-answers. Message it in Remote Control, or archive it in the Claude app's session list or have the assistant stop it (claude stop bg-123), then start again.",
      );
    });
    it("starts with none alive and a released lock", () => {
      const decision = canStart({
        sessions: [],
        lock: { sessionId: one.sessionId, released: 1 } as never,
      });
      expect(decision).toMatchObject({ start: true });
    });
  });

  /** **The checkout follows its branch**: `plans sync`. */
  describe("plans sync", () => {
    let origin: string;
    let clone: string;
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    const syncIn = (cwd: string) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "sync"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      }).trim();
    let first: string;

    beforeAll(() => {
      origin = mkdtempSync(join(tmpdir(), "queue-origin-"));
      g(origin, "init", "-q", "--bare");
      clone = mkdtempSync(join(tmpdir(), "queue-clone-"));
      g(clone, "init", "-q");
      g(clone, "remote", "add", "origin", origin);
      writeFileSync(join(clone, "README"), "one\n");
      mkdirSync(join(clone, ".claude"), { recursive: true });
      writeFileSync(join(clone, ".claude", "workflow.md"), "---\nname: Clone\nbranch: test\n---\n");
      g(clone, "add", ".");
      g(clone, "commit", "-q", "-m", "one");
      first = g(clone, "rev-parse", "HEAD");
      mkdirSync(join(clone, "scripts", "hooks"), { recursive: true });
      writeFileSync(join(clone, "scripts", "hooks", "x.mjs"), "// two\n");
      g(clone, "add", ".");
      g(clone, "commit", "-q", "-m", "two");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
    });
    afterAll(() => {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    });

    it("refuses on a branch", () => {
      expect(syncIn(clone)).toMatch(
        /^Not moved: the checkout is on branch \S+; it moves only when detached\.$/,
      );
    });
    it("names no queue in a project with no project file", () => {
      const bare = mkdtempSync(join(tmpdir(), "queue-bare-"));
      try {
        expect(listIn(bare, [])).toContain("No .claude/workflow.md here: plans init writes one.");
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
    it("refuses with a change, and when ahead", () => {
      g(clone, "fetch", "-q", "origin");
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(join(clone, "README"), "other\n");
      g(clone, "commit", "-q", "-am", "other");
      expect(syncIn(clone)).toBe(
        "Not moved: the checkout is ahead of test; push or drop its commits first.",
      );
      g(clone, "checkout", "-q", "--detach", first);
      writeFileSync(join(clone, "README"), "changed\n");
      expect(syncIn(clone)).toBe(
        "Not moved: the checkout has changes; commit, stash or discard them first.",
      );
      g(clone, "checkout", "-q", "--", "README");
    });
    it("moves a clean detached checkout behind test, then says it is there", () => {
      const test = g(clone, "rev-parse", "origin/test");
      expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
      expect(g(clone, "rev-parse", "HEAD")).toBe(test);
      expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
    });
    it("moves the primary checkout when run from a worktree, never the worktree", () => {
      g(clone, "checkout", "-q", "--detach", first);
      const tree = join(mkdtempSync(join(tmpdir(), "queue-tree-")), "w");
      g(clone, "worktree", "add", "-q", "--detach", tree, first);
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(tree)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(tree, "rev-parse", "HEAD")).toBe(first);
      } finally {
        g(clone, "worktree", "remove", "--force", tree);
      }
    });
    it("says a failed fetch on every answer", () => {
      g(clone, "remote", "set-url", "origin", join(origin, "gone"));
      try {
        g(clone, "switch", "-q", "-c", "side");
        expect(syncIn(clone)).toMatch(
          /^git fetch failed \(.+\), so this is test as last fetched\. Not moved: the checkout is on branch side;/,
        );
      } finally {
        g(clone, "checkout", "-q", "--detach", "origin/test");
        g(clone, "branch", "-D", "-q", "side");
        g(clone, "remote", "set-url", "origin", origin);
      }
    });
  });

  /** **The executors run at high effort** (part 4): the agent file's, on the command line. */
  it("passes the agent file's effort to a start, and none without one", () => {
    const agents = join(repo, "agents-fixture");
    mkdirSync(agents, { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
    };
    const dry = () =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "start", "--dry", "plans/x.md"], {
        encoding: "utf8",
        env,
      });
    try {
      // The plugin's own executor runs at high effort, scoped by the plugin's name.
      expect(dry()).toContain('"--agent" "workflow:executor" "--effort" "high"');
      writeFileSync(
        join(agents, "executor.md"),
        "---\nname: executor\neffort: high\n---\n\nBody.\n",
      );
      expect(agentEffort("executor", agents)).toBe("high");
      writeFileSync(join(agents, "executor.md"), "---\nname: executor\n---\n\neffort: low\n");
      expect(agentEffort("executor", agents)).toBe("");
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });
});

/**
 * **Briefs reach a fresh planner the way plans reach the executor**
 * (plans/planner-queue.md).
 */
describe("the planner queue", () => {
  const brief = (day: string, extra = "") =>
    `# A topic\n\nBrief for the planner, ${day}, by the assistant with Javi. The planner's plan replaces this file.\n${extra}\n## What was asked\n\nSomething.\n`;
  const ids = {
    p2: "22222222-aaaa-0000-0000-000000000000",
    gone: "99999999-aaaa-0000-0000-000000000000",
    javi: "33333333-aaaa-0000-0000-000000000000",
  };
  const plansDir = () => join(repo, "plans");
  const written: string[] = [];
  const put = (name: string, text: string) => {
    mkdirSync(plansDir(), { recursive: true });
    writeFileSync(join(plansDir(), name), text);
    written.push(join(plansDir(), name));
  };
  afterAll(() => {
    for (const file of written) rmSync(file, { force: true });
  });

  it("reads a brief being planned only while its session lives", () => {
    const text = brief(
      "26 October 2026",
      `\n## Planning, 26 October 2026 10:40, session ${ids.p2}\n`,
    );
    expect(stateOf(text, { live: [ids.p2] })).toMatchObject({
      state: "planning",
      session: ids.p2,
      since: "26 October 2026 10:40",
    });
    expect(stateOf(text, { live: ["other"] })).toMatchObject({ state: "brief", stale: true });
  });

  it("lists the briefs oldest first, and the queue's planner with its question", () => {
    put("q-old-brief.md", brief("24 October 2026"));
    put(
      "q-taken.md",
      brief("25 October 2026", `\n## Planning, 26 October 2026 10:40, session ${ids.p2}\n`),
    );
    put(
      "q-late.md",
      brief("26 October 2026", `\n## Planning, 26 October 2026 09:00, session ${ids.gone}\n`),
    );
    const out = listWith([
      {
        sessionId: ids.p2,
        name: "Planner 2",
        status: "waiting",
        waitingFor: "input needed",
        kind: "background",
        cwd: repo,
      },
      { sessionId: ids.javi, name: "Planner", status: "busy", kind: "interactive", cwd: repo },
    ]);
    expect(out).toMatch(
      /\nThe planner: Planner 2 \[22222222\], waiting for input, planning plans\/q-taken\.md\.\n/,
    );
    expect(out).not.toContain("33333333");
    const group = out.slice(out.indexOf("Briefs, oldest first"));
    expect(group.indexOf("q-old-brief.md")).toBeLessThan(group.indexOf("q-taken.md"));
    expect(group.indexOf("q-taken.md")).toBeLessThan(group.indexOf("q-late.md"));
    expect(group).toMatch(/q-old-brief\.md +brief, 24 October/);
    expect(group).toMatch(/q-taken\.md +Planner 2, since 26 October 2026 10:40/);
    expect(group).toMatch(
      /q-late\.md +brief, 26 October \(a Planning line from a session that is gone\)/,
    );
  });

  it("says none alive with no planner of the queue's", () => {
    expect(listWith([])).toMatch(/\nThe planner: none alive\.\n/);
  });

  it("names planners by their own count and refuses only beside a planner", () => {
    const log = [{ at: 0, name: "Executor 7" }];
    expect(canStart({ kind: "planner", log })).toMatchObject({ start: true, name: "Planner 1" });
    expect(canStart({ log })).toMatchObject({ start: true, name: "Executor 8" });
    const planner = {
      kind: "planner" as const,
      sessionId: "33330000-0000-0000-0000-000000000000",
      id: "",
      name: "Planner 3",
      status: "busy",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "plans/x.md",
    };
    // plans/planner-continues.md, part 4: the brief is sent to the live planner.
    expect(
      canStart({ kind: "planner", sessions: [planner], brief: "plans/next.md" }),
    ).toMatchObject({
      refuse: true,
      why: `A planner is alive: Planner 3 [33330000], busy, planning plans/x.md. Send it the brief with SendMessage, one message per brief: ${plannerPrompt("plans/next.md")}`,
    });
    // An executor's lock does not hold a planner back.
    expect(
      canStart({ kind: "planner", lock: { sessionId: "e", released: false } as never }),
    ).toMatchObject({ start: true });
  });

  it("counts only planner starts for a planner's quick-death rule", () => {
    const now = Date.now();
    const log = [
      { at: now - 60_000, name: "Planner 2" },
      { at: now - 30_000, name: "Executor 9" },
    ];
    expect(canStart({ kind: "planner", log, now })).toMatchObject({ refuse: true });
    expect(canStart({ kind: "planner", log, now })).toMatchObject({
      why: expect.stringContaining("The last planner (Planner 2)"),
    });
    expect(canStart({ log: [{ at: now - 60_000, name: "Planner 2" }], now })).toMatchObject({
      start: true,
    });
  });

  it("starts a planner on the oldest brief at high effort, or says nothing waits", () => {
    const agents = join(repo, ".claude", "agents");
    mkdirSync(agents, { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts-planner.log"),
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
    };
    const dry = () =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "start", "--agent", "planner", "--dry"], {
        encoding: "utf8",
        env,
      });
    try {
      writeFileSync(join(agents, "planner.md"), "---\nname: planner\neffort: high\n---\n\nBody.\n");
      put("q-old-brief.md", brief("24 October 2026"));
      const out = dry();
      expect(out).toContain('"--agent" "workflow:planner" "--effort" "high"');
      expect(out).toContain(JSON.stringify(plannerPrompt("plans/q-old-brief.md")));
      for (const name of ["q-old-brief.md", "q-taken.md", "q-late.md"])
        rmSync(join(plansDir(), name), { force: true });
      expect(dry().trim()).toBe("Nothing is waiting in the queue.");
      put("q-ready.md", "# Ready\n\nPlan only, 26 October 2026, for Javi.\n");
      const onPlan = execFileSync(
        "node",
        [join(here, "plan-queue.mjs"), "start", "--agent", "planner", "--dry", "plans/q-ready.md"],
        { encoding: "utf8", env },
      );
      expect(onPlan.trim()).toBe(
        "plans/q-ready.md is not a brief waiting for a planner; plans shows the briefs.",
      );
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  // plans/planner-continues.md, part 2: the executor's rule, for briefs.
  it("keeps a fresh planner on the oldest waiting brief, a once-compacted one on the oldest related brief, and retires a tired one", () => {
    const older = { path: "plans/older.md", related: false };
    const newer = { path: "plans/newer.md", related: true };
    expect(decidePlannerStop({ waiting: [older, newer] })).toMatchObject({
      refuse: true,
      told: ["plans/older.md"],
    });
    expect((decidePlannerStop({ waiting: [older, newer] }) as { reason: string }).reason).toContain(
      "A brief is waiting and this session can take it: plans/older.md.",
    );
    expect(decidePlannerStop({ waiting: [older, newer], compactions: 1 })).toMatchObject({
      refuse: true,
      told: ["plans/newer.md"],
    });
    expect(decidePlannerStop({ waiting: [older], compactions: 1 })).toEqual({
      retire: true,
      related: false,
    });
    expect(decidePlannerStop({ waiting: [older, newer], compactions: 2 })).toEqual({
      retire: true,
      related: true,
    });
    // Nothing waiting: alive, idle and unretired.
    expect(decidePlannerStop({ waiting: [] })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], current: { path: "plans/x.md" } })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], paused: true })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], retired: true })).toBeNull();
    // A brief named once and not taken goes to a fresh planner at the next Stop.
    expect(decidePlannerStop({ waiting: [older], told: ["plans/older.md"] })).toEqual({
      retire: true,
      related: false,
      declined: true,
    });
  });

  it("a brief is related when it names a file or a plan the planner's plans name", () => {
    const own = "Read `scripts/hooks/plan-queue.mjs` and `.claude/agents/planner.md`.";
    expect(briefPaths(own)).toEqual(["scripts/hooks/plan-queue.mjs", ".claude/agents/planner.md"]);
    expect(relatedBrief("Where to look: plans/a.md.", [], ["plans/a.md"])).toBe(true);
    expect(relatedBrief("Change .claude/agents/planner.md", [own])).toBe(true);
    expect(relatedBrief("See scripts/hooks/plan-queue.mjs, the hooks.", [own])).toBe(true);
    expect(relatedBrief("Change docs/editor.md", [own], ["plans/a.md"])).toBe(false);
    // The executor's rule stays narrow: plans/ and .claude/ are not its paths.
    expect(pathsIn("plans/a.md and .claude/agents/planner.md")).toEqual([]);
  });

  it("reads a planner's state written before the list", () => {
    expect(withPlans({ agent: "planner", brief: "plans/a.md", planned: true }).plans).toEqual([
      "plans/a.md",
    ]);
    expect(withPlans({ agent: "planner", brief: "plans/a.md", planned: false }).plans).toEqual([]);
    expect(withPlans({ agent: "planner", plans: ["plans/b.md"] }).plans).toEqual(["plans/b.md"]);
    expect(withPlans({ agent: "executor" })).toEqual({ agent: "executor" });
  });

  it("says what a planner holds and how often it compacted", () => {
    const one = {
      kind: "planner" as const,
      sessionId: "53593045-0000",
      id: "",
      name: "Planner 7",
      status: "busy",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "plans/x.md",
      holds: ["plans/a.md", "plans/b.md"],
      compactions: 1,
    };
    expect(describeSession(one)).toBe(
      "Planner 7 [53593045], busy, planning plans/x.md, holds plans/a.md and plans/b.md, 1 compaction",
    );
    expect(describeSession({ ...one, on: "", holds: ["plans/a.md"], compactions: 0 })).toBe(
      "Planner 7 [53593045], busy, holds plans/a.md",
    );
    expect(describeSession({ ...one, retired: true, status: "idle" })).toBe(
      "Planner 7 [53593045], idle, retired, its plans plans/a.md and plans/b.md",
    );
    expect(describeSession({ ...one, retired: true, holds: ["plans/a.md"] })).toBe(
      "Planner 7 [53593045], busy, retired, its plan plans/a.md",
    );
  });

  // plans/planner-open-decisions.md: a retired planner keeps one write.
  it("lets a retired planner edit its own plan and its sketch folder, and nothing else", () => {
    const base = "/repo";
    const may = (toolName: string, filePath: string, brief = "plans/x.md") =>
      plannerMayEdit({ brief, toolName, filePath, base });
    // plans/planner-continues.md, part 5: any plan the planner wrote.
    const plans = ["plans/a.md", "plans/b.md"];
    expect(plannerMayEdit({ plans, toolName: "Edit", filePath: "plans/b.md", base })).toBe(true);
    expect(plannerMayEdit({ plans, toolName: "Write", filePath: "plans/a/s.svg", base })).toBe(
      true,
    );
    expect(plannerMayEdit({ plans, toolName: "Edit", filePath: "plans/c.md", base })).toBe(false);
    expect(may("Edit", "plans/x.md")).toBe(true);
    expect(may("Edit", "/repo/plans/x.md")).toBe(true);
    expect(may("Write", "plans/x/sketch.md")).toBe(true);
    expect(may("MultiEdit", "/repo/plans/x/a/b.svg")).toBe(true);
    expect(may("Edit", "plans/y.md")).toBe(false);
    expect(may("Edit", "plans/x.md.bak")).toBe(false);
    expect(may("Edit", "plans/xy/sketch.md")).toBe(false);
    expect(may("Edit", "docs/editor.md")).toBe(false);
    expect(may("Edit", "plans/x.md", "")).toBe(false);
    expect(may("Bash", "plans/x.md")).toBe(false);
  });

  it("refuses a retired planner every write but an Edit of its own plan", () => {
    const id = `retired-planner-${process.pid}`;
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    mkdirSync(join(repo, "plans"), { recursive: true });
    writeFileSync(
      join(repo, "plans", "late.md"),
      "# Late\n\nPlan only, 26 October 2026, for Javi.\n\n## Decisions for Javi\n\n1. **One.**\n",
    );
    const retire = (planned: boolean) =>
      writeFileSync(
        stateFile,
        JSON.stringify({ agent: "planner", brief: "plans/late.md", retired: true, planned }),
      );
    retire(true);
    const tool = (tool_name: string, tool_input: object) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name,
        tool_input,
      });
    try {
      expect(tool("Edit", { file_path: join(repo, "plans", "late.md") })).toBe("");
      const other = tool("Edit", { file_path: join(repo, "plans", "other.md") });
      expect(other).toContain('"permissionDecision":"deny"');
      expect(other).toContain(
        "Only its own plan, plans/late.md, and its sketch folder may still be edited, until an executor starts it.",
      );
      const heredoc = tool("Bash", { command: "cat >> plans/late.md <<'EOF'\nDecided\nEOF" });
      expect(heredoc).toContain('"permissionDecision":"deny"');
      // Retired at a usage limit with the brief unfinished: the next
      // planner's plan is not this session's to write, even once it is a plan.
      retire(false);
      expect(tool("Edit", { file_path: join(repo, "plans", "late.md") })).toContain(
        '"permissionDecision":"deny"',
      );
      // plans/planner-talks-until-built.md: once an executor writes its
      // Building line, the plan is its, retired planner or not.
      retire(true);
      writeFileSync(
        join(repo, "plans", "late.md"),
        "# Late\n\n## Building, 26 October 2026, session abcdef12-0000\n\nPlan only, 26 October 2026, for Javi.\n",
      );
      const taken = tool("Edit", { file_path: join(repo, "plans", "late.md") });
      expect(taken).toContain('"permissionDecision":"deny"');
      expect(taken).toContain("the plan is the executor's now");
      expect(taken).toContain("plans/late.md was taken by session abcdef12 on 26 October 2026");
      writeFileSync(
        stateFile,
        JSON.stringify({ agent: "planner", brief: "plans/late.md", retired: false }),
      );
      expect(tool("Edit", { file_path: join(repo, "plans", "late.md") })).toContain(
        "the plan is the executor's now",
      );
    } finally {
      rmSync(stateFile, { force: true });
    }
  });

  it("lets a planner edit any plan it wrote and its sketch folders, and refuses the taken one only", () => {
    const id = `two-plans-${process.pid}`;
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    mkdirSync(join(repo, "plans"), { recursive: true });
    put("mine.md", "# Mine\n\nPlan only, 27 October 2026, for Javi.\n");
    put(
      "gone-to-build.md",
      "# Gone\n\n## Building, 27 October 2026, session abcdef12-0000\n\nPlan only, 27 October 2026, for Javi.\n",
    );
    const tool = (file: string) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "plans", file) },
      });
    try {
      for (const retired of [false, true]) {
        writeFileSync(
          stateFile,
          JSON.stringify({
            agent: "planner",
            retired,
            plans: ["plans/mine.md", "plans/gone-to-build.md"],
          }),
        );
        expect(tool("mine.md")).toBe("");
        expect(tool("mine/sketch.svg")).toBe("");
        expect(tool("gone-to-build.md")).toContain("the plan is the executor's now");
      }
      expect(tool("someone-else.md")).toContain(
        "Only its own plans, plans/mine.md and plans/gone-to-build.md, and their sketch folders",
      );
    } finally {
      rmSync(stateFile, { force: true });
    }
  });

  // Codex, 27 October: the brief named at Stop is the one in hand, so its plan joins the list.
  it("records the plan a planner writes over the brief its Stop hook named", () => {
    const id = `continuing-${process.pid}`;
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    put("first-plan.md", "# First\n\nPlan only, 27 October 2026, for Javi.\n");
    put("next-brief.md", brief("27 October 2026"));
    writeFileSync(
      stateFile,
      JSON.stringify({ agent: "planner", brief: "plans/first-plan.md", plans: [] }),
    );
    const env = {
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: id, name: "Planner 9", kind: "background", cwd: repo },
      ]),
    };
    const stop = () =>
      run(join(here, "plan-queue.mjs"), ["stop"], { session_id: id, agent_type: "planner" }, env);
    try {
      const said = stop();
      expect(said).toContain('"decision":"block"');
      const named = /can take it: (plans\/[^\s]+\.md)\./.exec(said)![1];
      let state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md"]);
      expect(state.brief).toBe(named);
      // The plan is written over the brief, its Planning line gone, before the next Stop.
      writeFileSync(join(repo, named), "# Next\n\nPlan only, 27 October 2026, for Javi.\n");
      stop();
      state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md", named]);
    } finally {
      rmSync(stateFile, { force: true });
    }
  });

  it("says a plan is taken by a Building, Built, Handing over or Resumed line", () => {
    const head = "# X\n\nPlan only, 26 October 2026, for Javi.\n\n";
    expect(planTaken(`# X\n\n## Building, 26 October 2026, session a\n\n${head}`)).toBe(true);
    expect(planTaken(`${head}## Built, 26 October 2026\n\nCommit 1234abcd.\n`)).toBe(true);
    expect(planTaken(`# X\n\n## Handing over, 26 October 2026\n\nStep in hand: 2\n`)).toBe(true);
    expect(planTaken(`# X\n\n## Resumed, 26 October 2026, session a, at step 2\n`)).toBe(true);
    expect(planTaken(head)).toBe(false);
    // Every plan has its own "Building it" section, which is not an executor's line.
    expect(planTaken(`${head}## Building it\n\nOne branch.\n\n## Built-in parts\n`)).toBe(false);
    expect(planTaken("# B\n\nBrief for the planner, 26 October 2026.\n")).toBe(false);
    expect(planTaken("")).toBe(false);
  });

  it("names who took a plan: the live executor, the session, or the built commit", () => {
    const building = "# X\n\n## Building, 26 October 2026, session b92bfc2b-9684\n";
    const live = [{ sessionId: "b92bfc2b-9684", name: "Executor 5" }];
    expect(whoTook(building, live)).toBe("Executor 5 [b92bfc2b] on 26 October 2026");
    expect(whoTook(building, [])).toBe("session b92bfc2b on 26 October 2026");
    expect(
      whoTook(
        "# X\n\nPlan only, 26 October 2026, for Javi.\n\n## Built, 26 October 2026\n\nBranch x, commit 1234abcd on `test`.\n",
      ),
    ).toBe("built, commit 1234abcd");
    expect(whoTook("# X\n\nPlan only, 26 October 2026.\n")).toBe("");
  });

  it("tells a planner where each of its plans stands", () => {
    const head = "# X\n\nPlan only, 26 October 2026, for Javi.\n";
    const texts: Record<string, string> = {
      "plans/own.md": head,
      "plans/taken.md": `# X\n\n## Building, 26 October 2026, session abcdef12\n${head}`,
      "plans/built.md": `${head}\n## Built, 26 October 2026\n\nCommit 1234abcd.\n`,
      "plans/gone.md": "",
    };
    const said = plannerContext(
      { plans: Object.keys(texts), retired: false },
      null,
      (path) => texts[path],
    );
    expect(said).toContain("plans/own.md is in the queue and still yours");
    expect(said).toContain("plans/taken.md was taken by session abcdef12 on 26 October 2026");
    expect(said).toContain("plans/built.md is built, commit 1234abcd");
    expect(said).toContain("plans/gone.md is no longer in plans/");
    expect(said).toContain("This session may take the next brief");
    expect(plannerContext({ plans: ["plans/own.md"], retired: true }, null, () => head)).toContain(
      "This session is retired: it plans nothing more",
    );
  });

  it("stops the queue's retired planner of a taken plan, and no other chat", () => {
    const live = [
      { sessionId: "p2", name: "Planner 2", kind: "background" },
      { sessionId: "p4", name: "Planner 4", kind: "background" },
      { sessionId: "pj", name: "Planner", kind: "interactive" },
    ];
    const states: Record<string, object> = {
      p2: { agent: "planner", retired: true, brief: "plans/x.md", planned: true },
      p4: { agent: "planner", retired: true, brief: "plans/y.md", planned: true },
      pj: { agent: "planner", retired: true, brief: "plans/x.md", planned: true },
    };
    const stopped: string[] = [];
    const written: Record<string, { stopAsked?: number }> = {};
    const options = {
      stateFor: (id: string) => ({ ...states[id], ...written[id] }),
      stop: (id: string) => stopped.push(id),
      write: (path: string, value: object) => {
        written[basename(path).replace(/^workflow-queue-|\.json$/g, "")] = value;
      },
      now: 1_000_000,
    };
    stopPlannersOn("plans/x.md", live, options);
    expect(stopped).toEqual(["p2"]);
    // Asked once: the executor's sweep on its next stop does not ask again.
    stopPlannersOn("plans/x.md", live, options);
    expect(stopped).toEqual(["p2"]);
  });

  it("stops a retired planner only when every plan of its own is taken", () => {
    const live = [{ sessionId: "p7", name: "Planner 7", kind: "background" }];
    const taken = "# A\n\n## Building, 27 October 2026, session e\n";
    const own = "# B\n\nPlan only, 27 October 2026.\n";
    const run = (state: object, b: string) => {
      const stopped: string[] = [];
      stopPlannersOn("plans/a.md", live, {
        stateFor: () => state as never,
        textOf: (path: string) => (path === "plans/a.md" ? taken : b),
        stop: (id: string) => stopped.push(id),
        write: () => {},
        now: 1,
      });
      return stopped;
    };
    const two = { agent: "planner", plans: ["plans/a.md", "plans/b.md"] };
    expect(run({ ...two, retired: true }, own)).toEqual([]);
    expect(run({ ...two, retired: true }, taken)).toEqual(["p7"]);
    // An unretired planner is the warm context the next brief goes to.
    expect(run({ ...two, retired: false }, taken)).toEqual([]);
  });

  it("stops the retired planners when the next planner starts, and no one else", () => {
    const live = [
      { sessionId: "r1", name: "Planner 2", kind: "background" },
      { sessionId: "r2", name: "Planner 3", kind: "background" },
      { sessionId: "a1", name: "Planner 4", kind: "background" },
      { sessionId: "j1", name: "Planner", kind: "interactive" },
    ];
    const states: Record<string, object> = {
      r1: { agent: "planner", retired: true },
      r2: { agent: "planner", retired: true },
      a1: { agent: "planner" },
      j1: { agent: "planner", retired: true },
    };
    const stopped: string[] = [];
    stopRetiredPlanners(live, {
      except: "r2",
      stateFor: (id: string) => states[id] as never,
      stop: (id: string) => stopped.push(id),
    });
    expect(stopped).toEqual(["r1"]);
  });

  it("sweeps the retired planners whose plan is taken, by the hook's own rule", () => {
    const live = [
      { sessionId: "p5", name: "Planner 5", kind: "background" },
      { sessionId: "p6", name: "Planner 6", kind: "background" },
    ];
    const states: Record<string, object> = {
      p5: { agent: "planner", retired: true, brief: "plans/a.md", planned: true },
      p6: { agent: "planner", retired: true, brief: "plans/b.md", planned: true },
    };
    const texts: Record<string, string> = {
      "plans/a.md": "# A\n\n## Building, 26 October 2026, session e\n\n## Building it\n",
      "plans/b.md": "# B\n\nPlan only, 26 October 2026.\n\n## Building it\n",
    };
    const stopped: string[] = [];
    stopTakenPlanners(live, {
      stateFor: (id: string) => states[id] as never,
      textOf: (path: string) => texts[path],
      stop: (id: string) => stopped.push(id),
      write: () => {},
      now: 1,
    });
    expect(stopped).toEqual(["p5"]);
  });

  it("stops a retired planner when its executor writes the Building line", () => {
    const executor = `executor-wrote-${process.pid}`;
    const planner = `planner-wrote-${process.pid}`;
    const plannerState = join(tmpdir(), `workflow-queue-${planner}.json`);
    const log = join(repo, ".claude", "stops.log");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    mkdirSync(join(repo, "plans"), { recursive: true });
    rmSync(log, { force: true });
    writeFileSync(
      plannerState,
      JSON.stringify({ agent: "planner", retired: true, brief: "plans/taken.md", planned: true }),
    );
    writeFileSync(
      join(repo, "plans", "taken.md"),
      `# T\n\n## Building, 26 October 2026, session ${executor}\n\nPlan only, 26 October 2026.\n`,
    );
    const env = {
      WORKFLOW_STOP_LOG: log,
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: planner, id: "bg-planner", name: "Planner 2", kind: "background", cwd: repo },
      ]),
    };
    const wrote = (file: string) =>
      run(
        join(here, "plan-queue.mjs"),
        ["wrote"],
        {
          session_id: executor,
          agent_type: "executor",
          tool_name: "Edit",
          tool_input: { file_path: join(repo, file) },
        },
        env,
      );
    try {
      expect(wrote("docs/editor.md")).toBe("");
      expect(existsSync(log)).toBe(false);
      expect(wrote("plans/taken.md")).toBe("");
      expect(readFileSync(log, "utf8")).toBe("bg-planner\n");
    } finally {
      rmSync(plannerState, { force: true });
      rmSync(log, { force: true });
    }
  });

  it("names the chats on an older Claude Code, and nothing when all match", () => {
    const rows = [
      { sessionId: "4bc43b44-0000", name: "Planner", pid: 1 },
      { sessionId: "14efb0df-0000", name: "project-b4", pid: 2 },
      { sessionId: "049920c4-0000", name: "Executor 4", pid: 3 },
      { sessionId: "deadbeef-0000", name: "Gone", pid: 4 },
    ];
    const versions: Record<number, string> = { 1: "2.1.306", 2: "2.1.306", 3: "2.1.310", 4: "" };
    const versionOf = (pid?: number) => versions[pid ?? 0] ?? "";
    expect(versionLine(rows, { installed: "2.1.310", versionOf })).toBe(
      "Claude Code 2.1.310 is installed; Planner [4bc43b44] and project-b4 [14efb0df] run 2.1.306: a chat picks the new version up when it is restarted (claude --resume <id>).",
    );
    expect(versionLine(rows.slice(2), { installed: "2.1.310", versionOf })).toBe("");
  });
});

/** `list()` in a child process, with `live` as the sessions. */
function listIn(dir: string, live: object[]): string {
  return execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { list } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
       console.log(list({ live: JSON.parse(process.env.LIVE) }));`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, LIVE: JSON.stringify(live) },
    },
  );
}

function listWith(live: object[]): string {
  return listIn(repo, live);
}

/**
 * **The faults the reviews found in the copied queue, closed**
 * (plans/queue-faults-carried-over.md), each against fixture projects.
 */
describe("the queue's faults, closed", () => {
  const made: string[] = [];
  const pids: number[] = [];
  afterAll(() => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  /** A project of its own: a repository with a project file naming it, and `plans/`. */
  const fixture = (name: string, front = "") => {
    const dir = temp(`queue-${name.toLowerCase()}-`);
    g(dir, "init", "-q");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "workflow.md"),
      `---\nname: ${name}\nbranch: test\n${front}---\n`,
    );
    return dir;
  };
  const queue = "plan-queue.mjs";
  const runIn = (dir: string, args: string[], env: Record<string, string> = {}, input?: object) =>
    execFileSync("node", [join(here, queue), ...args], {
      input: input ? JSON.stringify(input) : "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "[]", ...env },
    });

  describe("the read-only list", () => {
    it("takes substitution, eval, sort -o, --output, git branch -D and node as writing", () => {
      for (const command of [
        "echo $(touch x)",
        "echo `rm x`",
        "git branch -D feat",
        "cat a | sort -o a",
        "git log --output=x",
        "eval ls",
        "node --input-type=module -e 1",
        "find . -execdir rm {} +",
      ])
        expect(shellWrites(command), command).toBe(true);
    });
    it("reads git with -C or --no-pager, and git branch listing", () => {
      for (const command of [
        "git -C sub status",
        "git --no-pager log",
        "git branch --show-current",
        "git branch -a",
        "git branch",
      ])
        expect(shellWrites(command), command).toBe(false);
    });
  });

  it("snapshots a rename by its new path, with no cut-short entry", () => {
    const dir = temp("queue-rename-");
    g(dir, "init", "-q");
    writeFileSync(join(dir, "old-name.md"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "mv", "old-name.md", "new-name.md");
    expect(Object.keys(treeFiles(dir))).toEqual(["new-name.md"]);
    // A rename in the worktree column: an intent-to-add file and its source deleted.
    g(dir, "reset", "-q", "--hard");
    g(dir, "mv", "old-name.md", "tmp.md");
    g(dir, "commit", "-q", "-m", "two");
    execFileSync("mv", ["tmp.md", "third.md"], { cwd: dir });
    g(dir, "add", "-N", "third.md");
    const paths = Object.keys(treeFiles(dir));
    expect(paths).toContain("third.md");
    expect(paths.every((path) => existsSync(join(dir, path)) || path === "tmp.md")).toBe(true);
  });

  describe("stateOf", () => {
    it("reads a plan that names the brief it replaced as a plan", () => {
      const text =
        "# A plan\n\nPlan only, 27 October 2026, for Javi.\nIt replaces the brief (Brief for the planner, 27 October 2026).\n";
      expect(text.split("\n")[3]).toContain("Brief for the planner");
      expect(stateOf(text)).toMatchObject({ state: "ready" });
    });
    it("reads a handed-over branch name whole, dots and all", () => {
      const handed = (line: string) =>
        stateOf(
          `# P\n\n## Handing over, 27 October 2026\n\nStep in hand: 3\n\n${line}\n\nPlan only, 27 October 2026.\n`,
        );
      expect(handed("On branch `feat/v1.2`.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("On branch feat/v1.2.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("On branch feat/v1.2, then the push.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("The work is on branch queue-faults")).toMatchObject({
        branch: "queue-faults",
      });
    });
  });

  it("refuses the first stop on a red run, and lets a continued stop pass", () => {
    const dir = fixture("Run", "run: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    const sha = g(dir, "rev-parse", "HEAD");
    const bin = temp("queue-gh-");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const stop = (active: boolean) =>
      runIn(dir, ["stop"], env, {
        session_id: `red-run-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("(7) is failed");
    expect(stop(true)).toBe("");
    // A later turn's first stop refuses again.
    expect(stop(false)).toContain("(7) is failed");
  });

  describe("the lock", () => {
    it.each([
      ["an empty lock", null],
      ["a released lock", { sessionId: "gone", released: 1 }],
    ])(
      "gives one of two prompt hooks racing for %s the lock, and blocks the other",
      async (_, old) => {
        const dir = fixture("Race");
        if (old) writeFileSync(join(dir, ".claude", "executor.lock"), JSON.stringify(old));
        const ids = [`race-a-${process.pid}`, `race-b-${process.pid}`];
        const live = JSON.stringify(
          ids.map((sessionId, i) => ({ sessionId, name: `Race Executor ${i + 1}`, cwd: dir })),
        );
        const prompt = (sessionId: string) =>
          new Promise<string>((done, fail) => {
            const child = spawn("node", [join(here, queue), "prompt"], {
              env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: live },
            });
            let out = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.on("error", fail);
            child.on("close", () => done(out));
            child.stdin.end(JSON.stringify({ session_id: sessionId, agent_type: "executor" }));
          });
        const outs = await Promise.all(ids.map(prompt));
        const blocked = outs.filter((out) => out.includes("Another executor is building"));
        const answered = outs.filter((out) => out.includes("Plans in the queue"));
        expect(blocked).toHaveLength(1);
        expect(answered).toHaveLength(1);
        const lock = JSON.parse(readFileSync(join(dir, ".claude", "executor.lock"), "utf8"));
        expect(lock.sessionId).toBe(ids[outs.indexOf(answered[0])]);
        for (const id of ids) rmSync(join(tmpdir(), `workflow-queue-${id}.json`), { force: true });
      },
    );
    it("takes a released lock and a dead holder's, and not a live one's", () => {
      const path = join(fixture("Lock"), ".claude", "executor.lock");
      writeFileSync(path, JSON.stringify({ sessionId: "old", released: 1 }));
      expect(takeLock("new", [], { path, alive: () => true })).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).sessionId).toBe("new");
      expect(existsSync(`${path}.stale`)).toBe(false);
      expect(takeLock("other", [], { path, alive: () => true })).toBe(false);
      expect(takeLock("other", [], { path, alive: () => false })).toBe(true);
      expect(takeLock("other", [], { path, alive: () => true })).toBe(true);
      expect(existsSync(`${path}.guard`)).toBe(false);
    });
  });

  it("holds a deferral through a pause, and re-arms it at the resume", () => {
    const dir = fixture("Pause");
    const timer = spawn("node", ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    timer.unref();
    pids.push(timer.pid!);
    const file = join(dir, ".claude", "executor.deferred");
    const until = Date.now() + 3_600_000;
    writeFileSync(
      file,
      JSON.stringify({ until, why: "the five-hour window", paths: ["plans/p.md"], pid: timer.pid }),
    );
    const paused = runIn(dir, ["pause"]);
    expect(paused).toContain("Held: plans/p.md (until");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: null, until });
    expect(runIn(dir, ["list"])).toContain("plans/p.md, held while the queue is paused");
    const resumed = runIn(dir, ["resume"]);
    expect(resumed).toContain("Re-armed: plans/p.md (until");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.pid).toBeGreaterThan(0);
    pids.push(after.pid);
  });

  it("keeps the batch's files after the push and the detach, from the session's base", () => {
    const origin = temp("queue-faults-origin-");
    g(origin, "init", "-q", "--bare");
    const clone = fixture("Base");
    g(clone, "remote", "add", "origin", origin);
    writeFileSync(join(clone, "README"), "one\n");
    g(clone, "add", ".");
    g(clone, "commit", "-q", "-m", "one");
    g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
    g(clone, "fetch", "-q", "origin");
    const base = g(clone, "rev-parse", "origin/test");
    mkdirSync(join(clone, "src"));
    writeFileSync(join(clone, "src", "new.ts"), "export {}\n");
    g(clone, "add", ".");
    g(clone, "commit", "-q", "-m", "two");
    g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
    g(clone, "fetch", "-q", "origin");
    g(clone, "checkout", "-q", "--detach", "origin/test");
    const state = { sessionId: `base-${process.pid}`, base };
    expect(changedFiles(state, clone)).toContain("src/new.ts");
    expect(changedFiles({ sessionId: state.sessionId }, clone)).toEqual([]);
  });

  describe("base at the first Building line", () => {
    /** A project with an origin, a commit pushed to test, and a helper to push another. */
    const pushed = () => {
      const origin = temp("queue-base-origin-");
      g(origin, "init", "-q", "--bare");
      const dir = fixture("Building");
      g(dir, "remote", "add", "origin", origin);
      writeFileSync(join(dir, "README"), "one\n");
      g(dir, "add", "README", ".claude");
      g(dir, "commit", "-q", "-m", "one");
      g(dir, "push", "-q", "origin", "HEAD:refs/heads/test");
      g(dir, "fetch", "-q", "origin");
      // Another executor's push, which this checkout fetches.
      const another = (file: string) => {
        g(dir, "checkout", "-q", "--detach", "origin/test");
        writeFileSync(join(dir, file), "x\n");
        g(dir, "add", file);
        g(dir, "commit", "-q", "-m", file);
        g(dir, "push", "-q", "origin", "HEAD:refs/heads/test");
        g(dir, "fetch", "-q", "origin");
      };
      return { dir, another };
    };
    const stateFile = (id: string) => join(tmpdir(), `workflow-queue-${id}.json`);
    const building = (dir: string, id: string, plan: string) => {
      writeFileSync(
        join(dir, "plans", plan),
        `# P\n\n## Building, 27 October 2026, session ${id}\n\nShort plan, 27 October 2026.\n`,
      );
      runIn(
        dir,
        ["wrote"],
        {},
        {
          session_id: id,
          agent_type: "executor",
          tool_name: "Edit",
          tool_input: { file_path: join(dir, "plans", plan) },
        },
      );
      return JSON.parse(readFileSync(stateFile(id), "utf8"));
    };

    it("moves base to the branch at the first Building line, and keeps it at the second", () => {
      const { dir, another } = pushed();
      const id = `base-move-${process.pid}`;
      const old = g(dir, "rev-parse", "origin/test");
      writeFileSync(stateFile(id), JSON.stringify({ agent: "executor", base: old }));
      another("theirs.ts");
      const tip = g(dir, "rev-parse", "origin/test");
      const first = building(dir, id, "a.md");
      expect(first).toMatchObject({ base: tip, baseAt: "building" });
      expect(changedFiles({ sessionId: id, base: old }, dir)).toContain("theirs.ts");
      expect(changedFiles({ sessionId: id, base: first.base }, dir)).not.toContain("theirs.ts");
      another("later.ts");
      expect(building(dir, id, "b.md")).toMatchObject({ base: tip, baseAt: "building" });
      rmSync(stateFile(id), { force: true });
    });

    it("marks base from a Building line a shell command wrote, and not with no branch", () => {
      const { dir, another } = pushed();
      const id = `base-bash-${process.pid}`;
      writeFileSync(stateFile(id), JSON.stringify({ agent: "executor", base: "old" }));
      another("theirs.ts");
      const shell = () =>
        runIn(
          dir,
          ["wrote"],
          {},
          {
            session_id: id,
            agent_type: "executor",
            tool_name: "Bash",
            tool_input: { command: "python3 mark.py" },
          },
        );
      shell();
      expect(JSON.parse(readFileSync(stateFile(id), "utf8")).base).toBe("old");
      writeFileSync(
        join(dir, "plans", "c.md"),
        `# P\n\n## Building, 27 October 2026, session ${id}\n\nShort plan, 27 October 2026.\n`,
      );
      shell();
      expect(JSON.parse(readFileSync(stateFile(id), "utf8"))).toMatchObject({
        base: g(dir, "rev-parse", "origin/test"),
        baseAt: "building",
      });
      // With no origin/test, the first prompt's base stays.
      const bare = fixture("NoBranch");
      const other = `base-nobranch-${process.pid}`;
      writeFileSync(stateFile(other), JSON.stringify({ agent: "executor", base: "kept" }));
      expect(building(bare, other, "d.md")).toMatchObject({ base: "kept" });
      rmSync(stateFile(id), { force: true });
      rmSync(stateFile(other), { force: true });
    });

    it("keeps the first prompt's base in a session with no Building line", () => {
      const { dir } = pushed();
      const id = `base-none-${process.pid}`;
      runIn(dir, ["prompt"], {}, { session_id: id, agent_type: "executor" });
      const state = JSON.parse(readFileSync(stateFile(id), "utf8"));
      expect(state.base).toBe(g(dir, "rev-parse", "origin/test"));
      expect(state.baseAt).toBeUndefined();
      rmSync(stateFile(id), { force: true });
    });
  });

  describe("two projects apart", () => {
    it("starts B beside A's live executor, A's lock and A's pause", () => {
      const a = fixture("A");
      const b = fixture("B");
      const log = join(temp("queue-log-"), "starts.log");
      writeFileSync(
        log,
        `${JSON.stringify({ at: Date.now() - 3_600_000, name: "A Executor 1" })}\n`,
      );
      writeFileSync(
        join(a, ".claude", "executor.lock"),
        JSON.stringify({ sessionId: "a-exec", pid: process.pid, released: false }),
      );
      const live = JSON.stringify([
        { sessionId: "a-exec", name: "A Executor 1", kind: "background", cwd: a },
      ]);
      const dry = () =>
        runIn(b, ["start", "--dry", "plans/x.md"], {
          WORKFLOW_LIVE: live,
          WORKFLOW_STARTS_LOG: log,
          WORKFLOW_USAGE_FILE: join(b, ".claude", "usage.json"),
        });
      expect(dry()).toContain('Would run: claude "--bg" "--remote-control" "B Executor 1"');
      writeFileSync(join(a, ".claude", "executor.pause"), JSON.stringify({ at: "now" }));
      expect(dry()).toContain('"B Executor 1"');
    });
    it("counts no session with no working directory, unless its own files name it", () => {
      expect(inThisRepo(undefined, ["/w/a"])).toBe(false);
      const rows = [{ sessionId: "lock-holder", name: "A Executor 1" }];
      expect(ownRows(rows, { paths: ["/w/a"], lockId: "lock-holder" })).toEqual(rows);
      expect(ownRows(rows, { paths: ["/w/b"] })).toEqual([]);
      expect(ownRows(rows, { paths: ["/w/b"], named: ["lock-holder"] })).toEqual(rows);
    });
    it("stops nothing of A's from B's rows", () => {
      const rows = [
        { sessionId: "a-planner", name: "A Planner 1", kind: "background", cwd: "/w/a" },
      ];
      const stopped: string[] = [];
      stopRetiredPlanners(ownRows(rows, { paths: ["/w/b"] }), {
        stateFor: () => ({ agent: "planner", retired: true }),
        stop: (id: string) => stopped.push(id),
      });
      expect(stopped).toEqual([]);
    });
  });

  describe("a start sees its session, or says why not", () => {
    /** A `claude` in place of the real one: `agents --json` from a file, `--bg` by `STUB`. */
    const stub = () => {
      const dir = temp("queue-claude-");
      const rows = join(dir, "rows.json");
      writeFileSync(rows, "[]");
      const script = join(dir, "claude");
      writeFileSync(
        script,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const rows = process.env.STUB_ROWS;
if (args[0] === "agents") {
  process.stdout.write(fs.readFileSync(rows, "utf8"));
} else if (process.env.STUB === "untrusted") {
  console.error("Workspace not trusted. Run claude in " + process.cwd() + " once and accept the trust prompt, then retry.");
  process.exit(1);
} else {
  const name = args[args.indexOf("--name") + 1];
  const all = JSON.parse(fs.readFileSync(rows, "utf8"));
  all.push({ sessionId: "stub-" + Date.now(), name, kind: "background", cwd: process.cwd() });
  fs.writeFileSync(rows, JSON.stringify(all));
  console.log("Started " + name);
}
`,
      );
      chmodSync(script, 0o755);
      return { script, rows };
    };
    const startIn = (dir: string, env: Record<string, string>) => {
      const { WORKFLOW_LIVE: _, ...rest } = process.env;
      return execFileSync("node", [join(here, queue), "start", "plans/x.md"], {
        encoding: "utf8",
        env: {
          ...rest,
          CLAUDE_PROJECT_DIR: dir,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          ...env,
        },
      });
    };

    it("says why an untrusted start did not start, and logs nothing", { timeout: 30_000 }, () => {
      const dir = fixture("Untrusted");
      const { script, rows } = stub();
      const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows, STUB: "untrusted" });
      expect(said).toContain("Untrusted Executor 1 was not started: Workspace not trusted.");
      expect(existsSync(join(dir, ".claude", "starts.log"))).toBe(false);
    });
    it("logs a start whose session appears", { timeout: 30_000 }, () => {
      const dir = fixture("Seen");
      const { script, rows } = stub();
      const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows });
      expect(said).toContain("Seen Executor 1 was started on: plans/x.md.");
      expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
        '"name":"Seen Executor 1"',
      );
      expect(readFileSync(join(dir, ".claude", "executor.started"), "utf8")).toContain(
        "Started Seen Executor 1",
      );
    });
  });
});
