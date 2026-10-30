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
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_IGNORES } from "../plugins/workflow/scripts/project.mjs";
import {
  listToJudge,
  recordTool,
  shellWrites,
  treeFiles,
  unreasoned,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";
import {
  allowedWhileLocked,
  agentEffort,
  canStart,
  changedFiles,
  checksVerdict,
  decidePlannerStop,
  plannerPrompt,
  sessionsOf,
  versionLine,
  countCompaction,
  cutoffEdit,
  decideResumed,
  decideEnd,
  endedEdit,
  decideStop,
  inThisRepo,
  lockHeldByOther,
  mayReuse,
  sessionUsage,
  transcriptOf,
  ownRows,
  takeLock,
  parseDay,
  pathsIn,
  openPulls,
  ownOf,
  plannerMayEdit,
  pushedBranches,
  relatedLines,
  relatedOf,
  relatedWork,
  planTaken,
  readPlans,
  plannerContext,
  askingIn,
  buildingAdded,
  editedText,
  ANSWER_WINDOW,
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
  today,
  unreadPlans,
  withoutStatus,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { statusFrom } from "../plugins/workflow/scripts/statusline.mjs";

const here = new URL("../plugins/workflow/scripts/", import.meta.url).pathname;
const audit = join(here, "turn-audit.mjs");

// The plugin's `owner` option, as Claude Code exports it to a hook.
process.env.CLAUDE_PLUGIN_OPTION_OWNER = "Javi";
process.env.CLAUDE_PLUGIN_OPTION_MACHINE = "lab";
// The end timer and the stops are recorded here, so no hook a test runs
// leaves a timer sleeping for an hour (plans/idle-chats-end.md).
process.env.WORKFLOW_STOP_LOG = join(tmpdir(), `workflow-stops-hooks-${process.pid}.log`);

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
    expect(JSON.parse(out).reason).not.toContain("nothing under docs/patterns");
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
    expect(reason).toContain("nothing under docs/patterns did");
    expect(reason).not.toContain("changed 1 files");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: true })).toBe("");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: false })).toBe("");
  });

  it("accepts a decisions: none line in the final message", () => {
    run(audit, ["prompt"], { session_id: "t3", prompt: "Fix a typo" });
    writeFileSync(join(repo, "apps/forum/src/components/Composer.tsx"), "export {}\n");
    wrote("t3", "apps/forum/src/components/Composer.tsx");
    const out = run(audit, ["stop"], {
      session_id: "t3",
      stop_hook_active: false,
      last_assistant_message: "decisions: none (a typo)",
    });
    expect(out).toBe("");
  });

  it("stays quiet for a turn that changed nothing", () => {
    run(audit, ["prompt"], { session_id: "t4", prompt: "Explain the keypad" });
    expect(run(audit, ["stop"], { session_id: "t4", stop_hook_active: false })).toBe("");
  });

  /**
   * **The agent's choice carries its reason** (plans/every-word-researched.md):
   * today's entry that is the tag alone is asked for it once; one with a
   * reason, or dated an earlier day, passes.
   */
  it("asks once for the reason of an agent's choice dated today that is the tag alone", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-reasons-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "docs", "patterns"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Reasons\nui:\n  - "src/**"\ncatalogue: docs/patterns\n---\n',
    );
    const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    const file = join(root, "docs", "patterns", "words.md");
    const turn = (id: string, entry: string) => {
      run(
        audit,
        ["prompt"],
        { session_id: id, prompt: "Record the word" },
        { CLAUDE_PROJECT_DIR: root },
      );
      writeFileSync(file, `# Words\n\n${entry}\n`);
      run(
        audit,
        ["tool"],
        { session_id: id, tool_name: "Write", tool_input: { file_path: file } },
        { CLAUDE_PROJECT_DIR: root },
      );
      return run(
        audit,
        ["stop"],
        { session_id: id, stop_hook_active: false, last_assistant_message: "Done." },
        { CLAUDE_PROJECT_DIR: root },
      );
    };
    const id = `reasons-${process.pid}`;
    const first = turn(id, `- **Save, not Submit.** (the agent's choice, ${day})`);
    expect(JSON.parse(first).reason).toContain(
      `docs/patterns/words.md has 1 agent's choice dated today with no reason: "**Save, not Submit.** (the agent's choice, ${day})". An agent's choice says what was looked at`,
    );
    expect(
      run(
        audit,
        ["stop"],
        { session_id: id, stop_hook_active: true },
        { CLAUDE_PROJECT_DIR: root },
      ),
    ).toBe("");
    expect(
      turn(
        `${id}-tag`,
        `- **Save, not Submit.** (the agent's choice, ${day}, GitHub and Gmail differ and the house rules say nothing)`,
      ),
    ).toBe("");
    expect(
      turn(
        `${id}-after`,
        `- **Save, not Submit.** (the agent's choice, ${day}) GitHub and Gmail differ.`,
      ),
    ).toBe("");
    // Forty days back is never today.
    const earlier = new Date(Date.now() - 40 * 86_400_000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
    });
    expect(turn(`${id}-old`, `- **Save, not Submit.** (the agent's choice, ${earlier})`)).toBe("");
    rmSync(root, { recursive: true, force: true });
    // Thirteen hook runs, each a node process.
  }, 30_000);
});

describe("unreasoned", () => {
  const text = `# Words

- **Bare today.** (the agent's choice, 29 October)
- **With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)
- **With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.
- **Bare and older.** (the agent's choice, 2 May)
- **Bare in ISO.** (the agent's choice, 2026-10-29)
- **A person's, bare.** (Javi, 29 October)
- **A product's.** (as GitHub does, 29 October)
`;

  it("lists each agent's choice that is the tag alone, never a person's or a product's", () => {
    expect(unreasoned(text)).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**Bare and older.** (the agent's choice, 2 May)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
  });

  it("with a day, only those dated that day, in either way of writing it", () => {
    expect(unreasoned(text, "29 October")).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
    ]);
    expect(unreasoned(text, ["29 October", "2026-10-29"])).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
    const withYears =
      "- **This year.** (the agent's choice, 29 October 2026)\n- **Last year.** (the agent's choice, 29 October 2025)\n";
    expect(unreasoned(withYears, ["29 October", "29 October 2026"])).toEqual([
      "**This year.** (the agent's choice, 29 October 2026)",
    ]);
  });

  it("reads a rule's tier from its own tag, never from the struck-through rule kept under it", () => {
    const history = `- **Save, not Submit.** (Javi, 29 October)
  ~~**Submit.**~~ (the agent's choice, 1 January)
- **Bare over history.** (the agent's choice, 29 October)
  ~~**Older.**~~ (Javi, 1 January) He said so.
`;
    expect(unreasoned(history)).toEqual([
      "**Bare over history.** (the agent's choice, 29 October) ~~**Older.**~~ (Javi, 1 January) He said so.",
    ]);
  });

  it("reads the tier only right after the bold statement or at the rule's end, never a parenthesis inside the statement or mid-body", () => {
    expect(
      unreasoned("- **Per-step (per row) toggle.** (the agent's choice, 29 October)\n"),
    ).toEqual(["**Per-step (per row) toggle.** (the agent's choice, 29 October)"]);
    expect(
      unreasoned(
        "- **Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)\n",
      ),
    ).toEqual(["**Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)"]);
    expect(untiered("- **X.** (as GitHub does, 29 October)\n")).toEqual([]);
    // A tag-shaped parenthesis in the body, or in the statement, is no tier.
    expect(
      untiered(
        "- **Rows toggle.** Each row (Javi, 29 October) has one.\n- **Per-step (per row, 2 May) toggle.**\n",
      ),
    ).toEqual([
      "**Rows toggle.** Each row (Javi, 29 October) has one.",
      "**Per-step (per row, 2 May) toggle.**",
    ]);
    // A reason in the body after the tag still counts.
    expect(
      unreasoned(
        "- **Toggle.** (the agent's choice, 29 October) Gmail (per row) and GitHub differ.\n",
      ),
    ).toEqual([]);
    // The tag that ends the rule is its tier, as the audit's hint writes it; an agent's choice there is bare.
    expect(untiered("- **Rows toggle.** Each row has one switch. (Javi, 21 October)\n")).toEqual(
      [],
    );
    expect(unreasoned("- **Save.** Saves the draft. (the agent's choice, 29 October)\n")).toEqual([
      "**Save.** Saves the draft. (the agent's choice, 29 October)",
    ]);
    // A closed parenthesis inside a source's name is part of the tier.
    expect(
      untiered("- **Use sentence case.** (per Microsoft Writing Style Guide (2024), 29 October)\n"),
    ).toEqual([]);
  });

  it("reads no rule inside a fenced example", () => {
    const readme =
      "# Decisions\n\nAn entry looks like this:\n\n```md\n- **Example.** (the agent's choice, 29 October)\n- **No tier.**\n```\n\n- **Real.** (the agent's choice, 29 October)\n";
    expect(unreasoned(readme)).toEqual(["**Real.** (the agent's choice, 29 October)"]);
    expect(untiered(readme)).toEqual([]);
  });

  it("takes a placeholder copied from the hint for no reason", () => {
    expect(
      unreasoned("- **Save.** (the agent's choice, 29 October, <what was looked at>)\n"),
    ).toEqual(["**Save.** (the agent's choice, 29 October, <what was looked at>)"]);
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
      last_assistant_message: "decisions: none (a test)",
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

    // plans/handed-plan-stays-in-queue.md: a hand-over written between the
    // title and the header pushed the header past line 12, and the plan fell
    // out of every list.
    const handOver = [
      "## Handing over, 27 October 2026",
      "",
      "Step in hand: 1",
      "",
      "On branch `grip-work`, one work commit.",
      "Done: nothing yet.",
      "In progress: step 1, the store.",
      "What failed: the usage window ran out.",
      "Left: steps 2 to 5.",
      "Specs run: none.",
      "",
      "The task list was in the final message.",
      "Nothing pushed.",
      "",
    ].join("\n");
    const short =
      "Short plan, 27 October 2026, by the assistant with Javi; the executor builds\nit.\n\n## What was asked\n\nA thing.\n";

    it("reads a plan whose long Handing over section sits above its header as handed", () => {
      const text = `# A plan\n\n${handOver}${short}`;
      // The header is past the twelve lines the queue read before.
      expect(text.split("\n").findIndex((line) => line.startsWith("Short plan"))).toBe(15);
      expect(stateOf(text)).toMatchObject({
        state: "handed",
        kind: "Short plan",
        day: "27 October 2026",
        step: "1",
        branch: "grip-work",
      });
    });

    it("reads Building and Resumed lines above the header as building while live, handed once not", () => {
      const resumedHeading = handOver.replace(
        "## Handing over, 27 October 2026",
        "## Resumed, 28 October 2026, session r1, at step 1",
      );
      const text = `# A plan\n\n## Building, 28 October 2026, session abc\n\n${handOver}${resumedHeading}${short}`;
      expect(stateOf(text, { live: ["abc"] })).toMatchObject({
        state: "building",
        session: "abc",
        resumed: ["1"],
      });
      expect(stateOf(text, { live: [] })).toMatchObject({
        state: "handed",
        stale: true,
        step: "1",
      });
    });

    it("reads a brief with a Planning line still as a brief, and keeps a plan's Building it", () => {
      const brief =
        "# B\n\n## Planning, 28 October 2026, session p1\n\nBrief for the planner, 28 October 2026.\n";
      expect(stateOf(brief, { live: ["p1"] })).toMatchObject({ state: "planning", session: "p1" });
      expect(stateOf(brief, { live: [] })).toMatchObject({ state: "brief", stale: true });
      // "## Building it" is the plan's own section, not the queue's line.
      expect(withoutStatus(`${header("24 October 2026")}## Building it\n\n1. A step.\n`)).toContain(
        "1. A step.",
      );
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

  describe("checksVerdict", () => {
    const run = (status: string, conclusion = "") => ({
      __typename: "CheckRun",
      status,
      conclusion,
    });
    const context = (state: string) => ({ __typename: "StatusContext", state });
    it("is green for no checks and for passing ones", () => {
      expect(checksVerdict([])).toBe("green");
      expect(checksVerdict(null as never)).toBe("green");
      expect(
        checksVerdict([
          run("COMPLETED", "SUCCESS"),
          run("COMPLETED", "NEUTRAL"),
          run("COMPLETED", "SKIPPED"),
          context("SUCCESS"),
        ]),
      ).toBe("green");
    });
    it("is running for a queued or running check and a pending context", () => {
      expect(checksVerdict([run("QUEUED")])).toBe("running");
      expect(checksVerdict([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")])).toBe("running");
      expect(checksVerdict([context("PENDING")])).toBe("running");
      expect(checksVerdict([context("EXPECTED")])).toBe("running");
    });
    it("is red for a failed check or context, and red beats running", () => {
      for (const conclusion of [
        "FAILURE",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "STALE",
      ])
        expect(checksVerdict([run("COMPLETED", conclusion)]), conclusion).toBe("red");
      expect(checksVerdict([context("ERROR")])).toBe("red");
      expect(checksVerdict([context("FAILURE")])).toBe("red");
      expect(checksVerdict([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("red");
      expect(checksVerdict([context("PENDING"), context("ERROR")])).toBe("red");
    });
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

    it("refuses on a pull request's checks with its own words, and lets a continued stop pass", () => {
      const pull = {
        id: "21@61c4a812",
        status: "completed",
        conclusion: "failure",
        onHead: true,
        pull: { number: 21, url: "https://github.com/o/r/pull/21" },
      };
      const first = decideStop({ run: pull });
      expect(first).toMatchObject({ refuse: true, runId: "21@61c4a812" });
      expect(first!.reason).toContain(
        "The checks on pull request #21 (https://github.com/o/r/pull/21) are failing.",
      );
      expect(first!.reason).toContain("`gh pr checks 21 --watch --fail-fast`");
      expect(
        decideStop({ run: { ...pull, status: "in_progress", conclusion: null } })!.reason,
      ).toContain("are still running");
      expect(decideStop({ run: pull, continuing: true, refusedRun: "21@61c4a812" })).toBeNull();
      // Two pull requests not green: both named, and both in the id.
      const two = { ...pull, id: "21@61c4a812,22@0badc0de", pull: { ...pull.pull, also: [22] } };
      expect(decideStop({ run: two })!.reason).toContain("Pull request #22 is not green either.");
      expect(decideStop({ run: two, continuing: true, refusedRun: "21@61c4a812" })).toMatchObject({
        refuse: true,
      });
      // A push to the branch is a new commit, so a new id, asked about again.
      expect(
        decideStop({
          run: { ...pull, id: "21@0badc0de" },
          continuing: true,
          refusedRun: "21@61c4a812",
        }),
      ).toMatchObject({ refuse: true, runId: "21@0badc0de" });
    });

    it("names each plan's landing by its Lands line to an executor taking more, in the pull request mode", () => {
      const waiting = [plan("plans/a.md")];
      expect(decideStop({ waiting })!.reason).toContain("the suites once at the end");
      const reason = decideStop({ waiting, land: "pull-request" })!.reason;
      expect(reason).toContain("each by its Lands line");
      expect(reason).toContain("the day's fixes pull request");
      expect(reason).toContain("its pull request when the topic is ready");
      expect(reason).not.toContain("one pull request per plan");
      expect(reason).not.toContain("the suites once at the end");
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
      expect(out!.reason).toContain(
        'plans/a.md, plans/b.md (decisions unanswered: the recommended options, "Asked once")',
      );
      expect(decideStop({ waiting, told: ["plans/a.md", "plans/b.md"] })).toBeNull();
      expect(decideStop({})).toBeNull();
    });

    it("keeps a session with one compaction only for a related plan, and retires it at two", () => {
      expect(
        decideStop({ compactions: 1, waiting: [plan("plans/a.md", { related: true })] }),
      ).toMatchObject({
        refuse: true,
      });
      expect(decideStop({ compactions: 1, waiting: [plan("plans/a.md")] })).toMatchObject({
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

  // plans/handed-plan-stays-in-queue.md: the hook's hand-over goes after the
  // header paragraph, though the Building line sat between the title and the header.
  it("puts the hook's hand-over after the header paragraph, wherever the Building line was", () => {
    const options = { sessionId: "abc", branch: "queue", day: "24 October 2026" };
    const section = `## Handing over, 24 October 2026, by the hook\n\nStep in hand: unknown, the usage limit cut session abc off on branch \`queue\`. Read the branch's commits and the task list's state in the final messages above.\n`;
    const head = "Plan only, 24 October 2026, for Javi; the executor builds it.";
    const above = `# A plan\n\n## Building, 24 October 2026, session abc\n\n${head}\n\n## What was asked\n`;
    expect(cutoffEdit(above, options)).toBe(
      `# A plan\n\n${head}\n\n${section}\n## What was asked\n`,
    );
    // /code-review, 28 October: a heading straight under the header ends its paragraph.
    const tight = `# A plan\n\n${head}\n## Building, 24 October 2026, session abc\n\n## What was asked\n\nA thing.\n`;
    expect(cutoffEdit(tight, options)).toBe(
      `# A plan\n\n${head}\n\n${section}\n## What was asked\n\nA thing.\n`,
    );
    // No header found: the section takes the Building line's place.
    const headless = `# Notes\n\n## Building, 24 October 2026, session abc\n\nSome notes.\n`;
    expect(cutoffEdit(headless, options)).toBe(`# Notes\n\n${section}\nSome notes.\n`);
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
    expect(out).toMatch(/^Plans on lab, .*The executor: none alive\./);
    expect(out.indexOf("Ready, oldest first")).toBeLessThan(out.indexOf("Built today"));
    expect(out).toContain("plans/ready.md");
    expect(out).toContain("0123abcd");
    expect(out).toContain("Older, by path only: 1 plan dated");
    // plans/handed-plan-stays-in-queue.md: a file with no header and no brief line is said.
    expect(out).not.toContain("Not read by the queue");
    writeFileSync(join(repo, "plans", "x.md"), "# Notes\n\nSome notes, no header.\n");
    // Codex, 28 October: a file that cannot be read is said too (a directory
    // stands in for a file the user cannot read).
    mkdirSync(join(repo, "plans", "y.md"));
    try {
      const said = execFileSync("node", [join(here, "plan-queue.mjs"), "list"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      });
      expect(said).toContain("Not read by the queue (no header found): plans/x.md");
      expect(said).toContain("Not read by the queue (the file could not be read): plans/y.md");
      expect(said.indexOf("Older, by path only")).toBeLessThan(said.indexOf("Not read by"));
      expect(unreadPlans(join(repo, "plans"))).toEqual({
        headless: ["plans/x.md"],
        failed: ["plans/y.md"],
      });
    } finally {
      rmSync(join(repo, "plans", "x.md"));
      rmSync(join(repo, "plans", "y.md"), { recursive: true });
    }
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
        "An executor is alive: Executor 2 [aacbea39], busy, in public-sources-edits on codex-answers. Message it in Remote Control, or have the assistant end it (plans end aacbea39), then start again.",
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
      writeFileSync(join(clone, ".gitignore"), `${QUEUE_IGNORES.join("\n")}\n`);
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
    it("ignores a kind of queue file the project's .gitignore lacks, then moves the checkout", () => {
      // A project set up before the third kind: its .gitignore lacks it.
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(
        join(clone, ".gitignore"),
        ".claude/executor.*\n.claude/planner.*\n.claude/worktrees/\n",
      );
      g(clone, "commit", "-q", "-am", "two kinds");
      const behind = g(clone, "rev-parse", "HEAD");
      writeFileSync(join(clone, "README"), "three\n");
      g(clone, "commit", "-q", "-am", "three");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
      g(clone, "checkout", "-q", "--detach", behind);
      writeFileSync(join(clone, ".claude", "asking.deferred"), "{}\n");
      const exclude = join(clone, ".git", "info", "exclude");
      const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(clone)).toBe(
          `Added .claude/asking.* to .git/info/exclude. The checkout is at test, ${test.slice(0, 8)}.`,
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(clone, "status", "--porcelain")).toBe("");
        // The tracked .gitignore is left as it is; the line is added once.
        expect(g(clone, "diff", "--name-only")).toBe("");
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
        expect(readFileSync(exclude, "utf8").split("\n")).toContain(".claude/asking.*");
      } finally {
        rmSync(join(clone, ".claude", "asking.deferred"), { force: true });
        writeFileSync(exclude, before);
      }
    });
    it("ignores Claude Code's worktrees under .claude/, then moves the checkout", () => {
      // A project set up before: its .gitignore has the kinds, not the folder.
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(
        join(clone, ".gitignore"),
        ".claude/executor.*\n.claude/planner.*\n.claude/asking.*\n",
      );
      g(clone, "commit", "-q", "-am", "three kinds");
      const behind = g(clone, "rev-parse", "HEAD");
      writeFileSync(join(clone, "README"), "four\n");
      g(clone, "commit", "-q", "-am", "four");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
      g(clone, "checkout", "-q", "--detach", behind);
      mkdirSync(join(clone, ".claude", "worktrees", "x"), { recursive: true });
      writeFileSync(join(clone, ".claude", "worktrees", "x", "f"), "\n");
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(clone)).toBe(
          `Added .claude/worktrees/ to .git/info/exclude. The checkout is at test, ${test.slice(0, 8)}.`,
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(clone, "status", "--porcelain")).toBe("");
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
      } finally {
        // The exclude keeps its lines: the tests after this one find
        // nothing to add, as origin/test's .gitignore lacks the folder.
        rmSync(join(clone, ".claude", "worktrees"), { recursive: true, force: true });
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
    expect(decidePlannerStop({ waiting: [older], compactions: 1 })).toMatchObject({
      retire: true,
      related: false,
    });
    expect(decidePlannerStop({ waiting: [older, newer], compactions: 2 })).toMatchObject({
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

  // plans/collaborating-when-claude-writes-the-code.md, part 2.
  it("tells a planner what the brief it is handed looks related to, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-related-"));
    const id = `planner-related-${process.pid}`;
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, "plans"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "workflow.md"),
        "---\nname: Rel\nbranch: test\nland: pull-request\n---\n",
      );
      writeFileSync(
        join(dir, "plans", "b.md"),
        brief("30 October 2026", "\nWhere to look: scripts/plan-queue.mjs.\n"),
      );
      const bin = join(dir, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\n[ -e "$(dirname "$0")/gh.off" ] && exit 1\necho '[{"number":31,"title":"Pictures kept","author":{"login":"anton"},"headRefName":"pictures","files":[{"path":"plugins/workflow/scripts/plan-queue.mjs"}]}]'\n`,
      );
      chmodSync(join(bin, "gh"), 0o755);
      const prompt = (text: string) =>
        execFileSync("node", [join(here, "plan-queue.mjs"), "prompt"], {
          input: JSON.stringify({ session_id: id, agent_type: "planner", prompt: text }),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_LIVE: "[]",
            PATH: `${bin}:${process.env.PATH}`,
          },
        });
      // `gh` unread: nothing said, and the brief is looked up again on its next prompt.
      writeFileSync(join(bin, "gh.off"), "");
      expect(prompt(plannerPrompt("plans/b.md"))).not.toContain("The brief looks related to:");
      rmSync(join(bin, "gh.off"));
      const first = prompt(plannerPrompt("plans/b.md"));
      expect(first).toContain(
        'The brief looks related to:\\nlooks related to #31 \\"Pictures kept\\" (anton; both name plugins/workflow/scripts/plan-queue.mjs)',
      );
      // The table in the context reads nothing: the line is the brief's only.
      expect(first.match(/looks related to #31/g)).toHaveLength(1);
      expect(prompt(plannerPrompt("plans/b.md"))).not.toContain("The brief looks related to:");
      expect(prompt("How is it going?")).not.toContain("The brief looks related to:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateFile, { force: true });
    }
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
    expect(
      whoTook(
        "# X\n\nPlan only, 26 October 2026, for Javi.\n\n## Built, 28 October 2026\n\nPull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; open, checks green.\n",
      ),
    ).toBe("built, pull request #21");
    // plans/pull-requests-by-topic.md: a fix pushed straight, and a topic waiting.
    const head = "# X\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, 30 October 2026\n\n";
    expect(
      whoTook(`${head}Pushed straight to test as a fix, commit 61c4a812; checks.yml green.\n`),
    ).toBe("built, straight to test");
    // The branch the Built line names, not the project file's today.
    expect(
      whoTook(`${head}Pushed straight to main as a fix, commit 61c4a812; no run to read.\n`),
    ).toBe("built, straight to main");
    expect(
      whoTook(
        `${head}On topic pictures, commit 61c4a812, branch pushed; its pull request waits.\n`,
      ),
    ).toBe("built, on topic pictures");
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

    // plans/collaborating-when-claude-writes-the-code.md, part 2 and its tests.
    it("ranks related work by files in common, a pull request first, three at most, by suffix", () => {
      const pull = (number: number, files: string[], headRefName = `h${number}`) => ({
        number,
        title: `P${number}`,
        author: "anton",
        headRefName,
        files,
      });
      const qs = "plugins/workflow/scripts/plan-queue.mjs";
      const doc = "plugins/workflow/docs/workflow.md";
      const found = relatedWork(["scripts/plan-queue.mjs", "docs/workflow.md"], {
        pulls: [pull(1, [doc]), pull(2, [qs, doc]), pull(3, ["README.md"]), pull(4, [qs])],
        branches: [
          { name: "b-two", author: "henry", title: "B", files: [qs, doc] },
          { name: "b-one", author: "henry", title: "C", files: [doc] },
        ],
      });
      expect(found.map((one) => one.number ?? one.name)).toEqual([2, "b-two", 1]);
      expect(found[0]).toMatchObject({ kind: "pull", files: [qs, doc], own: "" });
      expect(found[1]).toMatchObject({ kind: "branch", title: "B", author: "henry" });
      // Nothing in common: nothing.
      expect(relatedWork(["apps/x.tsx"], { pulls: [pull(1, [doc])] })).toEqual([]);
      // A named path is no suffix of a file it only ends like.
      expect(relatedWork(["workflow.md"], { pulls: [pull(1, ["docs/myworkflow.md"])] })).toEqual(
        [],
      );
      // This queue's, by number or by its topic's branch.
      const own = new Map<number | string, string>([
        [1, "plans/one.md"],
        ["h4", "plans/four.md"],
      ]);
      expect(
        relatedWork(["docs/workflow.md", "scripts/plan-queue.mjs"], {
          pulls: [pull(1, [doc]), pull(4, [qs])],
          own,
        }).map((one) => one.own),
      ).toEqual(["plans/one.md", "plans/four.md"]);
    });

    it("reads the Related line under the header, past a status section, and nowhere else", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic x, ready.\n";
      const of = (line: string) => relatedOf(`${head}${line}\n\n## What was asked\n`);
      expect(of("Related: #31.")).toEqual([{ kind: "pull", number: 31 }]);
      expect(of("Related: #31 and branch a-b.")).toEqual([
        { kind: "pull", number: 31 },
        { kind: "branch", name: "a-b" },
      ]);
      expect(of("Related: branch a-b.")).toEqual([{ kind: "branch", name: "a-b" }]);
      expect(of("Related: #3, #4 and\nbranch a-b")).toHaveLength(3);
      // Another person's branch in Git's shape, the line's full stop not its name's.
      expect(of("Related: #31 and branch fix/pictures-v1.2.")).toEqual([
        { kind: "pull", number: 31 },
        { kind: "branch", name: "fix/pictures-v1.2" },
      ]);
      // A bare `Related:` does not take the next line's issue reference.
      expect(of("Related:\n#5 is another thing.")).toBeNull();
      expect(of("")).toBeNull();
      expect(
        relatedOf(
          `# P\n\n## Building, 30 October 2026, session abc\n\nPlan only, 30 October 2026.\n\nRelated: #31.\n`,
        ),
      ).toEqual([{ kind: "pull", number: 31 }]);
      expect(relatedOf(`${head}\n## What was asked\n\nRelated: #31.\n`)).toBeNull();
      expect(relatedOf(`${head}\n\`\`\`\nRelated: #31.\n\`\`\`\n\n## What was asked\n`)).toBeNull();
      // A brief's, under its header line.
      expect(
        stateOf(
          "# B\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n\nRelated: #7.\n\n## What was asked\n",
        ),
      ).toMatchObject({ state: "brief", relatedTo: [{ kind: "pull", number: 7 }] });
    });

    it("words related lines with the queue's own, two files and the rest counted", () => {
      const plans = [
        { path: "plans/mine.md", state: "built", pr: 24, topic: "", lands: { name: "shown" } },
        { path: "plans/next.md", state: "ready", lands: { kind: "topic", name: "next" } },
      ];
      expect(ownOf(plans as never)).toEqual(
        new Map<number | string, string>([
          [24, "plans/mine.md"],
          ["shown", "plans/mine.md"],
          ["next", "plans/next.md"],
        ]),
      );
      const text = "Change a/x.mjs, a/y.mjs, a/z.mjs and b/w.md.";
      const lines = relatedLines(text, plans as never, {
        pulls: [
          {
            number: 31,
            title: "Pictures kept",
            author: "anton",
            headRefName: "pictures",
            files: ["a/x.mjs", "a/y.mjs", "a/z.mjs"],
          },
          { number: 24, title: "Shown", author: "javi", headRefName: "shown", files: ["b/w.md"] },
        ],
        branches: [{ name: "next", author: "javi", title: "Next step", files: ["b/w.md"] }],
      });
      // A plan's own topic is never related to it.
      expect(
        relatedLines(
          text,
          plans as never,
          {
            pulls: [],
            branches: [{ name: "next", author: "javi", title: "Next step", files: ["b/w.md"] }],
          },
          { topic: "next" },
        ),
      ).toEqual([]);
      expect(lines).toEqual([
        'looks related to #31 "Pictures kept" (anton; both name a/x.mjs, a/y.mjs and 1 more)',
        'looks related to #24 "Shown" (this queue\'s, plans/mine.md; both name b/w.md)',
        'looks related to branch next, "Next step" (this queue\'s, plans/next.md; both name b/w.md)',
      ]);
    });

    it("prints related lines under briefs and ready plans in the pull request mode only", () => {
      const write = (dir: string) => {
        writeFileSync(
          join(dir, "plans", "brief.md"),
          "# B\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n\n## What was asked\n\nChange scripts/plan-queue.mjs.\n",
        );
        writeFileSync(
          join(dir, "plans", "ready.md"),
          "# R\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown, ready.\nRelated: #31.\n\n## What was asked\n\nChange docs/workflow.md.\n",
        );
        writeFileSync(
          join(dir, "plans", "earlier.md"),
          "# E\n\nPlan only, 29 October 2026, for Javi.\n\nLands: topic earlier, ready.\n\n## Built, 29 October 2026\n\nPull request #33 (https://github.com/o/r/pull/33) to test from branch earlier, commit 61c4a812; open, checks green.\n",
        );
      };
      const pulls = [
        {
          number: 31,
          title: "Pictures kept",
          author: "anton",
          headRefName: "pictures",
          files: ["plugins/workflow/scripts/plan-queue.mjs"],
        },
        {
          number: 32,
          title: "Shown",
          author: "javi",
          headRefName: "shown",
          files: ["plugins/workflow/docs/workflow.md"],
        },
        {
          number: 33,
          title: "Earlier",
          author: "javi",
          headRefName: "earlier",
          files: ["plugins/workflow/docs/workflow.md"],
        },
      ];
      const listed = (dir: string, readers: object | null, related = true) =>
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { list } from ${JSON.stringify(join(here, queue))};
             console.log(list({ live: [], related: ${related}, readers: JSON.parse(process.env.READERS) }));`,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, CLAUDE_PROJECT_DIR: dir, READERS: JSON.stringify(readers) },
          },
        );
      const dir = fixture("Related", "land: pull-request\n");
      write(dir);
      const out = listed(dir, { pulls, branches: [] });
      expect(out).toMatch(
        /plans\/brief\.md +brief, 30 October\n    looks related to #31 "Pictures kept" \(anton; both name plugins\/workflow\/scripts\/plan-queue\.mjs\)\n/,
      );
      expect(out).toMatch(
        /plans\/ready\.md +Plan only, 30 October, topic shown, ready, related: #31\n    looks related to #33 "Earlier" \(this queue's, plans\/earlier\.md; both name plugins\/workflow\/docs\/workflow\.md\)\n/,
      );
      // Its own topic's pull request is not related to it.
      expect(out).not.toContain("#32");
      // `gh` unread: said once, under the first row, and the branches still read.
      const unread = listed(dir, {
        pulls: null,
        branches: [{ name: "x-y", author: "henry", title: "T", files: ["docs/workflow.md"] }],
      });
      expect(unread.match(/related work not read \(gh\)/g)).toHaveLength(1);
      expect(unread).toMatch(/brief, 30 October\n    related work not read \(gh\)\n/);
      expect(unread).toContain(
        'looks related to branch x-y, "T" (henry; both name docs/workflow.md)',
      );
      // Off with related: false, and in the push mode.
      expect(listed(dir, { pulls, branches: [] }, false)).not.toContain("looks related");
      const pushMode = fixture("RelatedPush");
      write(pushMode);
      const pushed = listed(pushMode, { pulls, branches: [] });
      expect(pushed).not.toContain("looks related");
      expect(pushed).not.toContain("related: #31");
    });

    it("reads no related work in a hook's table", () => {
      const dir = fixture("RelatedHook", "land: pull-request\n");
      writeFileSync(
        join(dir, "plans", "ready.md"),
        "# R\n\nPlan only, 30 October 2026, for Javi.\n\n## What was asked\n\nChange docs/workflow.md.\n",
      );
      const bin = temp("queue-gh-related-");
      const log = join(bin, "calls.log");
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> ${log}\nexit 1\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const said = runIn(dir, ["prompt"], env, {
        session_id: `related-hook-${process.pid}`,
        agent_type: "executor",
        prompt: "Build the plans.",
      });
      expect(said).toContain("plans/ready.md");
      expect(said).not.toContain("related work not read");
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("files");
      // The command reads it.
      const listed = runIn(dir, ["list"], env);
      expect(listed).toContain("related work not read (gh)");
      expect(readFileSync(log, "utf8")).toContain("number,title,author,headRefName,files");
    });

    it("reads the open pull requests' files, and the pushed branches past the branch", () => {
      const calls: string[][] = [];
      expect(
        openPulls({
          run: ((_: string, args: string[]) => {
            calls.push(args);
            return JSON.stringify([
              {
                number: 31,
                title: "T",
                author: { login: "anton" },
                headRefName: "pictures",
                files: [{ path: "a/b.md", additions: 1 }],
              },
            ]);
          }) as never,
        }),
      ).toEqual([
        { number: 31, title: "T", author: "anton", headRefName: "pictures", files: ["a/b.md"] },
      ]);
      expect(calls[0]).toContain("number,title,author,headRefName,files");
      expect(
        openPulls({
          run: (() => {
            throw new Error("no gh");
          }) as never,
        }),
      ).toBeNull();
      const now = Date.UTC(2026, 9, 30);
      const day = 24 * 60 * 60;
      const at = (days: number) => String(now / 1000 - days * day);
      const refs = [
        `origin\tsha\t${at(0)}\tjavi\tHEAD`,
        `origin/test\tsha\t${at(0)}\tjavi\tthe branch`,
        `origin/main\tsha\t${at(0)}\tjavi\tmain`,
        `origin/pictures\tsha\t${at(1)}\tanton\ta pull request's head`,
        `origin/kept\tsha\t${at(2)}\tanton\tKept`,
        `origin/merged\tsha\t${at(3)}\tjavi\tMerged`,
        `origin/squashed\tc0ffee\t${at(2)}\tjavi\tSquashed`,
        `origin/old\tsha\t${at(31)}\thenry\tOld`,
        ...Array.from(
          { length: 25 },
          (_, i) => `origin/many-${i}\tsha\t${at(4)}\thenry\tMany ${i}`,
        ),
      ].join("\n");
      const seen: string[][] = [];
      const run = (args: string[]) => {
        seen.push(args);
        if (args[0] === "fetch") throw new Error("offline");
        if (args[0] === "for-each-ref") return refs;
        if (args[0] === "diff") return args[2].endsWith("/merged") ? "" : "docs/x.md\n";
        throw new Error(args.join(" "));
      };
      const merged = new Map([["squashed", "c0ffee"]]);
      const branches = pushedBranches({ run, base: "test", heads: ["pictures"], merged, now });
      expect(seen[0]).toEqual(["fetch", "--prune", "--quiet", "origin"]);
      expect(branches[0]).toEqual({
        name: "kept",
        author: "anton",
        title: "Kept",
        files: ["docs/x.md"],
      });
      const names = branches.map((one) => one.name);
      for (const gone of ["HEAD", "test", "main", "pictures", "merged", "squashed", "old"])
        expect(names).not.toContain(gone);
      // Twenty read, the merged one among them and dropped.
      expect(names).toHaveLength(19);
      expect(seen.filter((args) => args[0] === "diff")).toHaveLength(20);
      expect(seen.find((args) => args[0] === "diff")?.[2]).toBe("origin/test...origin/kept");
      // No fetch when asked, and nothing read past the deadline.
      seen.length = 0;
      pushedBranches({ run, base: "test", now, fetch: false });
      expect(seen[0][0]).toBe("for-each-ref");
      seen.length = 0;
      expect(pushedBranches({ run, base: "test", now, deadline: Date.now() - 1 })).toEqual([]);
      expect(seen.filter((args) => args[0] === "diff")).toHaveLength(0);
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
    // plans/pull-requests-by-topic.md, part 1 and part 6.
    it("reads the Lands line under the header, and none as null", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\n";
      const lands = (line: string) => stateOf(`${head}${line}\n\n## What was asked\n`)?.lands;
      expect(lands("Lands: fix.")).toEqual({ kind: "fix", now: false });
      expect(lands("Lands: fix, now.")).toEqual({ kind: "fix", now: true });
      expect(lands("Lands: topic pictures, waiting.")).toEqual({
        kind: "topic",
        name: "pictures",
        ready: false,
      });
      expect(lands("Lands: topic pictures, ready.")).toEqual({
        kind: "topic",
        name: "pictures",
        ready: true,
      });
      expect(lands("")).toBeNull();
      // Hand-wrapped, or with its full stop left off.
      expect(lands("Lands: topic pull-requests-by-topic,\nwaiting.")).toEqual({
        kind: "topic",
        name: "pull-requests-by-topic",
        ready: false,
      });
      expect(lands("Lands: fix")).toEqual({ kind: "fix", now: false });
      // A Lands line inside a later section is not the plan's.
      expect(stateOf(`${head}## What was asked\n\nLands: fix.\n`)?.lands).toBeNull();
      // Past a status section written above the header.
      expect(
        stateOf(
          `# P\n\n## Building, 30 October 2026, session abc\n\nPlan only, 30 October 2026.\n\nLands: fix.\n`,
        )?.lands,
      ).toEqual({ kind: "fix", now: false });
    });

    it("reads a fix pushed straight, a topic waiting, and a pull request opened or joined later", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, 30 October 2026\n\n";
      expect(
        stateOf(`${head}Pushed straight to test as a fix, commit 61c4a812; image.yml green.\n`),
      ).toMatchObject({ state: "built", fix: true, topic: "", sha: "61c4a812", pr: 0 });
      const waiting = `${head}On topic pictures, commit 61c4a812, branch pushed; its pull request waits.\n`;
      expect(stateOf(waiting)).toMatchObject({ fix: false, topic: "pictures", pr: 0 });
      expect(
        stateOf(
          waiting.replace(
            "waits.\n",
            "waits.\nPull request #22 (https://github.com/o/r/pull/22) opened 30 October 2026 with plans/x.md.\n",
          ),
        ),
      ).toMatchObject({ topic: "pictures", pr: 22 });
      expect(
        stateOf(
          `${head}Pull request #22 (https://github.com/o/r/pull/22) joined, commit 61c4a812; open, checks green.\n`,
        ),
      ).toMatchObject({ pr: 22, sha: "61c4a812" });
      expect(
        stateOf(
          `${head}Pull request #23 (https://github.com/o/r/pull/23) of the day's fixes, commit 61c4a812; open, checks green.\n`,
        ),
      ).toMatchObject({ pr: 23, sha: "61c4a812" });
    });

    it("reads the pull request a Built section names, and none as 0", () => {
      const head = "# P\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, 28 October 2026\n\n";
      expect(
        stateOf(
          `${head}Pull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; open, checks green.\n`,
        ),
      ).toMatchObject({ state: "built", sha: "61c4a812", pr: 21 });
      expect(stateOf(`${head}Branch x, commit 61c4a812 on test.\n`)).toMatchObject({
        state: "built",
        sha: "61c4a812",
        pr: 0,
      });
    });

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

  it("lists a plan built as a pull request by its number and state, and one pushed by its commit", () => {
    const dir = fixture("Listed", "land: pull-request\n");
    const day = today();
    writeFileSync(
      join(dir, "plans", "by-pull.md"),
      `# A\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; open, checks green.\n`,
    );
    writeFileSync(
      join(dir, "plans", "pushed.md"),
      `# B\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nBranch y, commit 1234abcd on test.\n`,
    );
    const bin = temp("queue-gh-list-");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2 $3 $4" = "pr list --state all" ]; then echo '[{"number":21,"state":"OPEN"}]'; else exit 1; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const listed = runIn(dir, ["list"], { PATH: `${bin}:${process.env.PATH}` });
    expect(listed).toMatch(/plans\/by-pull\.md\s+#21, open\n/);
    expect(listed).toMatch(/plans\/pushed\.md\s+1234abcd, on test/);
    // No `gh` on the PATH: the number alone.
    const empty = temp("queue-no-gh-");
    for (const tool of ["git", "node"])
      execFileSync("ln", [
        "-s",
        execFileSync("which", [tool], { encoding: "utf8" }).trim(),
        join(empty, tool),
      ]);
    const bare = runIn(dir, ["list"], { PATH: empty });
    expect(bare).toMatch(/plans\/by-pull\.md\s+#21\n/);
  });

  it("lists a fix pushed straight, a waiting topic and the Ready plans' landings", () => {
    const dir = fixture("Topics", "land: pull-request\n");
    const day = today();
    const built = (name: string, title: string, line: string) =>
      writeFileSync(
        join(dir, "plans", name),
        `# ${title}\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, ${day}\n\n${line}\n`,
      );
    built("fix.md", "F", "Pushed straight to test as a fix, commit 61c4a812; checks.yml green.");
    built(
      "x.md",
      "X",
      "On topic pictures, commit 1234abcd, branch pushed; its pull request waits.",
    );
    built(
      "y.md",
      "Y",
      "On topic opened, commit 2234abcd, branch pushed; its pull request waits.\nPull request #22 (https://github.com/o/r/pull/22) opened 30 October 2026 with plans/z.md.",
    );
    const ready = (name: string, line: string) =>
      writeFileSync(
        join(dir, "plans", name),
        `# R\n\nPlan only, 30 October 2026, for Javi.\n\n${line}\n\n## What was asked\n`,
      );
    ready("ready-topic.md", "Lands: topic pictures, ready.");
    ready("ready-fix.md", "Lands: fix, now.");
    ready("no-line.md", "");
    // A topic opened by its ready plan alone: its Lands line names it.
    writeFileSync(
      join(dir, "plans", "w.md"),
      `# W\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, ${day}\n\nOn topic shown, commit 3234abcd, branch pushed; its pull request waits.\n`,
    );
    writeFileSync(
      join(dir, "plans", "v.md"),
      `# V\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown, ready.\n\n## Built, ${day}\n\nPull request #24 (https://github.com/o/r/pull/24) to test from branch shown, commit 4234abcd; open, checks green.\n`,
    );
    const empty = temp("queue-no-gh-topics-");
    for (const tool of ["git", "node"])
      execFileSync("ln", [
        "-s",
        execFileSync("which", [tool], { encoding: "utf8" }).trim(),
        join(empty, tool),
      ]);
    const listed = runIn(dir, ["list"], { PATH: empty });
    expect(listed).toMatch(/plans\/fix\.md\s+61c4a812, on test, a fix\n/);
    expect(listed).toMatch(/plans\/x\.md\s+topic pictures, waiting\n/);
    expect(listed).toMatch(/plans\/y\.md\s+#22\n/);
    expect(listed).toContain("Topics waiting for a pull request\n  pictures: plans/x.md");
    expect(listed).not.toContain("opened: plans/y.md");
    expect(listed).not.toContain("shown: plans/w.md");
    expect(listed).toMatch(/plans\/no-line\.md\s+Plan only, 30 October, topic no-line, ready\n/);
    expect(listed).toMatch(
      /plans\/ready-topic\.md\s+Plan only, 30 October, topic pictures, ready\n/,
    );
    expect(listed).toMatch(/plans\/ready-fix\.md\s+Plan only, 30 October, a fix, now\n/);
  });

  it("reads the run a fix pushed straight sets off after the pull requests' checks, in the pull request mode", () => {
    const dir = fixture("Straight", "land: pull-request\nrun: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    const sha = g(dir, "rev-parse", "HEAD");
    const bin = temp("queue-gh-straight-");
    const run = `echo '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'`;
    // No pull request of this checkout: the run on the push is read.
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; else ${run}; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const stop = (active: boolean, id = "straight") =>
      runIn(dir, ["stop"], env, {
        session_id: `${id}-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    // HEAD is no fix this queue pushed straight (another person's merge, say): no run read.
    expect(stop(false, "straight-none")).toBe("");
    writeFileSync(
      join(dir, "plans", "fix.md"),
      `# F\n\nPlan only, 30 October 2026, for Javi.\n\nLands: fix, now.\n\n## Built, ${today()}\n\nPushed straight to test as a fix, commit ${sha.slice(0, 8)}; checks.yml green.\n`,
    );
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("(7) is failed");
    expect(stop(true)).toBe("");
    // Both red: the pull request is named first.
    g(dir, "branch", "land-x");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]}]'; else ${run}; fi\n`,
    );
    // Both red: the pull request is named first, and the run with it.
    const both = stop(false, "straight-both");
    expect(both).toContain("pull request #21");
    expect(both.indexOf("pull request #21")).toBeLessThan(both.indexOf("(7) is failed"));
    expect(stop(true, "straight-both")).toBe("");
  });

  it("refuses the first stop on a red pull request of this checkout, in the pull request mode", () => {
    const dir = fixture("Pull", "land: pull-request\nrun: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "branch", "land-x");
    const sha = g(dir, "rev-parse", "land-x");
    const bin = temp("queue-gh-pr-");
    // A `gh` that answers `pr list` only: the run list is not the mode's.
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]}]'; else echo '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const stop = (active: boolean) =>
      runIn(dir, ["stop"], env, {
        session_id: `red-pull-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("pull request #21");
    expect(first).not.toContain("(7) is failed");
    expect(stop(true)).toBe("");
    // The branch moved on: the pull request's head is no longer this checkout's.
    g(dir, "checkout", "-q", "land-x");
    writeFileSync(join(dir, "README"), "two\n");
    g(dir, "commit", "-q", "-am", "two");
    expect(stop(false)).toBe("");
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
      expect(dry()).toContain('Would run: claude "--bg" "--remote-control" "B Executor 1 (lab)"');
      // A session of the same name in another checkout still takes its number.
      expect(
        runIn(b, ["start", "--dry", "plans/x.md"], {
          WORKFLOW_LIVE: JSON.stringify([
            { sessionId: "elsewhere", name: "B Executor 1 (lab)", kind: "background", cwd: "/x" },
          ]),
          WORKFLOW_STARTS_LOG: log,
          WORKFLOW_USAGE_FILE: join(b, ".claude", "usage.json"),
        }),
      ).toContain('"--remote-control" "B Executor 2 (lab)"');
      writeFileSync(join(a, ".claude", "executor.pause"), JSON.stringify({ at: "now" }));
      expect(dry()).toContain('"B Executor 1 (lab)"');
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
      expect(said).toContain("Untrusted Executor 1 (lab) was not started: Workspace not trusted.");
      expect(existsSync(join(dir, ".claude", "starts.log"))).toBe(false);
    });
    it("logs a start whose session appears", { timeout: 30_000 }, () => {
      const dir = fixture("Seen");
      const { script, rows } = stub();
      const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows });
      expect(said).toContain("Seen Executor 1 (lab) was started on: plans/x.md.");
      expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
        '"name":"Seen Executor 1 (lab)"',
      );
      expect(readFileSync(join(dir, ".claude", "executor.started"), "utf8")).toContain(
        "Started Seen Executor 1 (lab)",
      );
    });
  });
});

/** **The cache-aware queue** (plans/cache-aware-queue.md): reuse by context, not compactions alone. */
describe("the cache-aware queue", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 27, 14, 0);
  const at = (minutes: number, k: number) => ({ context: k * 1000, at: now - minutes * MIN });

  it("mayReuse: by compactions, the ceiling and the cache", () => {
    expect(mayReuse({ compactions: 0, usage: at(1, 150), now })).toEqual({ reuse: true });
    expect(mayReuse({ usage: at(1, 250), now }).why).toContain(
      "its context is 250k tokens, over the reuse ceiling of 200k",
    );
    expect(mayReuse({ usage: at(1, 150), now, ceiling: 100_000 }).reuse).toBe(false);
    expect(mayReuse({ usage: at(70, 200), now }).why).toContain(
      "its cache has gone cold after 70 minutes idle",
    );
    expect(mayReuse({ usage: at(70, 40), now })).toEqual({ reuse: true });
    expect(mayReuse({ compactions: 2, usage: at(1, 10), now }).reuse).toBe(false);
    expect(mayReuse({ compactions: 1, related: false, now }).reuse).toBe(false);
    expect(mayReuse({ compactions: 1, related: true, now })).toEqual({ reuse: true });
    expect(mayReuse({ compactions: 0 })).toEqual({ reuse: true });
  });

  it("sessionUsage reads the last assistant turn's context and time, and null without a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const file = join(dir, "t.jsonl");
    const turn = (n: number, time: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: time,
        message: {
          usage: {
            input_tokens: n,
            cache_read_input_tokens: 1000 * n,
            cache_creation_input_tokens: 10,
          },
        },
      });
    writeFileSync(
      file,
      [
        turn(1, "2026-10-27T13:00:00Z"),
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        turn(2, "2026-10-27T13:30:00Z"),
        turn(3, "2026-10-27T13:59:00Z"),
        "",
      ].join("\n"),
    );
    try {
      expect(sessionUsage(file)).toEqual({
        context: 3 + 3000 + 10,
        at: Date.parse("2026-10-27T13:59:00Z"),
      });
      expect(sessionUsage(join(dir, "none.jsonl"))).toBeNull();
      expect(transcriptOf({ sessionId: "s1", cwd: "/home/v/.claude/x" }, "/p")).toBe(
        "/p/-home-v--claude-x/s1.jsonl",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decideStop and decidePlannerStop retire with the ceiling's reason", () => {
    const waiting = [{ path: "plans/a.md", related: true, asks: false }];
    expect(decideStop({ waiting, usage: at(1, 300), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the reuse ceiling"),
    });
    expect(decidePlannerStop({ waiting, usage: at(1, 300), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the reuse ceiling"),
    });
    expect(decideStop({ waiting, usage: at(1, 100), now })).toMatchObject({ refuse: true });
  });

  const one = (status: string, k: number, kind = "executor", minutes = 1) => ({
    kind,
    sessionId: `${kind}-${status}-${k}`,
    id: "",
    name: `Test ${kind === "planner" ? "Planner" : "Executor"} 1`,
    status,
    usage: at(minutes, k),
    ceiling: 200_000,
    where: "checkout",
    branch: "",
    holdsLock: false,
    retired: false,
    on: "",
  });

  it("canStart replaces a stale idle session, and refuses a busy or a reusable one", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const replaced = canStart({ now, usage, name: "Test", sessions: [one("idle", 300)] as never });
    expect(replaced).toMatchObject({ start: true, replace: [{ sessionId: "executor-idle-300" }] });
    expect(canStart({ now, usage, sessions: [one("busy", 300)] as never })).toMatchObject({
      refuse: true,
    });
    expect(canStart({ now, usage, sessions: [one("idle", 100)] as never }).why).toContain(
      "An executor is alive",
    );
    // A lock the replaced session holds does not refuse the start.
    expect(
      canStart({
        now,
        usage,
        alive: () => true,
        lock: { sessionId: "executor-idle-300", released: false } as never,
        sessions: [one("idle", 300)] as never,
      }),
    ).toMatchObject({ start: true });
  });

  it("canStart, unwatched, replaces an idle executor whatever its warmth, and never a busy one", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const warm = one("idle", 100);
    expect(
      canStart({ now, usage, name: "Test", sessions: [warm] as never, unwatched: true }),
    ).toMatchObject({
      start: true,
      replace: [
        {
          sessionId: "executor-idle-100",
          why: "idle while a plan's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    expect(
      canStart({ now, usage, sessions: [one("busy", 100)] as never, unwatched: true }),
    ).toMatchObject({ refuse: true });
    expect(
      canStart({ now, usage, sessions: [one("waiting for input", 300)] as never, unwatched: true }),
    ).toMatchObject({ refuse: true });
    // Watched, the warm idle one refuses as before.
    expect(canStart({ now, usage, sessions: [warm] as never }).why).toContain(
      "An executor is alive",
    );
  });

  it("canStart never replaces a session with a plan under way, and skips a synthetic turn", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const building = { ...one("idle", 300), on: "plans/a.md" };
    expect(canStart({ now, usage, sessions: [building] as never })).toMatchObject({ refuse: true });
    const dir = mkdtempSync(join(tmpdir(), "synthetic-"));
    try {
      const file = join(dir, "t.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-10-27T13:00:00Z",
            message: { usage: { input_tokens: 5, cache_read_input_tokens: 500_000 } },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-10-27T13:05:00Z",
            message: { model: "<synthetic>", usage: { input_tokens: 0 } },
          }),
          "",
        ].join("\n"),
      );
      expect(sessionUsage(file)?.context).toBe(500_005);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canStart starts a planner beside a busy stale one, and refuses beside a busy one under the ceiling", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const beside = canStart({
      kind: "planner",
      now,
      usage,
      sessions: [one("busy", 300, "planner")] as never,
    });
    expect(beside).toMatchObject({ start: true });
    expect(beside.note).toContain("Started beside Test Planner 1");
    expect(beside.note).toContain("busy with a context of 300k");
    expect(
      canStart({ kind: "planner", now, usage, sessions: [one("busy", 100, "planner")] as never }),
    ).toMatchObject({ refuse: true });
  });

  it("describeSession shows the context and its warmth", () => {
    const warm = {
      ...one("busy", 618),
      ceiling: 700_000,
      usage: { context: 618_000, at: Date.now() - 2 * MIN },
    };
    expect(describeSession(warm as never)).toContain("618k context, warm");
    const cold = { ...one("idle", 200), usage: { context: 200_000, at: Date.now() - 130 * MIN } };
    expect(describeSession(cold as never)).toContain("200k context, cold 130 min");
    expect(describeSession(one("idle", 300) as never)).toContain("over the reuse ceiling");
  });

  it("plans start --dry retires an idle executor whose transcript is over the ceiling", () => {
    const repo = mkdtempSync(join(tmpdir(), "reuse-"));
    const projects = mkdtempSync(join(tmpdir(), "reuse-projects-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Reuse\nbranch: test\n---\n");
      const id = "old-executor";
      const slug = join(projects, repo.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(slug, { recursive: true });
      writeFileSync(
        join(slug, `${id}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 400_000 } },
        })}\n`,
      );
      const out = execFileSync(
        "node",
        [join(here, "plan-queue.mjs"), "start", "--dry", "plans/x.md"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: repo,
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_LIVE: JSON.stringify([
              {
                sessionId: id,
                name: "Reuse Executor 1",
                status: "idle",
                kind: "background",
                cwd: repo,
              },
            ]),
            WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
            WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
          },
        },
      );
      expect(out).toContain("Would run: claude");
      expect(out).toContain("Would retire Reuse Executor 1 [old-exec]: its context is 400k tokens");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });
});

/** plans/idle-chats-end.md: a finished chat ends an hour after it goes quiet. */
describe("a finished chat ends", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 27, 22, 0);
  const done = { kind: "background", state: "done", sessionId: "s", name: "Ends Executor 1" };
  const used = (minutes: number) => ({ context: 150_000, at: now - minutes * MIN });

  it("decideEnd: done, cold and nothing under way ends; anything else says why not", () => {
    expect(decideEnd({ row: done, usage: used(70), now })).toEqual({ end: true });
    expect(decideEnd({ row: done, usage: used(20), now })).toEqual({
      end: false,
      why: "its cache is still warm",
    });
    expect(decideEnd({ row: done, usage: used(20), now, force: true })).toEqual({ end: true });
    expect(decideEnd({ row: { ...done, state: "blocked" }, usage: used(70), now })).toEqual({
      end: false,
      why: "its state is blocked",
    });
    expect(decideEnd({ row: { ...done, state: "working" }, now, force: true })).toEqual({
      end: false,
      why: "its state is working",
    });
    expect(decideEnd({ row: done, usage: used(70), on: "plans/x.md", now })).toEqual({
      end: false,
      why: "it has plans/x.md under way",
    });
    expect(decideEnd({ row: { ...done, kind: "interactive" }, usage: used(70), now })).toEqual({
      end: false,
      why: "it is not a background session of the queue",
    });
    expect(decideEnd({ row: null, now })).toMatchObject({ end: false });
    // No usage known: the timer fired an hour after the Stop that armed it.
    expect(decideEnd({ row: done, now })).toEqual({ end: true });
    // A planner holding an untaken plan ends like the rest (Decided 1): nothing in the rule reads it.
    expect(decideEnd({ row: { ...done, name: "Ends Planner 1" }, usage: used(70), now })).toEqual({
      end: true,
    });
  });

  // plans/end-a-stuck-chat.md: `--now` ends a named chat whatever it is doing.
  it("decideEnd: immediate ends a working or warm one, and returns the plan it had under way", () => {
    const working = { ...done, state: "working" };
    expect(decideEnd({ row: working, now, force: true })).toEqual({
      end: false,
      why: "its state is working",
    });
    expect(decideEnd({ row: working, now, immediate: true })).toEqual({ end: true });
    expect(decideEnd({ row: { ...done, state: "blocked" }, now, immediate: true })).toEqual({
      end: true,
    });
    expect(decideEnd({ row: done, usage: used(5), now, immediate: true })).toEqual({ end: true });
    expect(decideEnd({ row: working, on: "plans/x.md", now, immediate: true })).toEqual({
      end: true,
      on: "plans/x.md",
    });
    // Still only the queue's background sessions: the owner's own chat is his.
    expect(
      decideEnd({ row: { ...done, kind: "interactive" }, now, immediate: true }),
    ).toMatchObject({ end: false });
  });

  it("endedEdit hands a plan over, and puts a brief back in the queue", () => {
    const plan =
      "# A plan\n\n## Building, 28 October 2026, session abc\n\nShort plan, 28 October 2026, by the assistant.\n\n## The change\n";
    const out = endedEdit(plan, {
      sessionId: "abc",
      by: "Javi",
      branch: "fix",
      day: "28 October 2026",
    });
    expect(out).not.toContain("## Building");
    expect(out).toContain(
      "Short plan, 28 October 2026, by the assistant.\n\n## Handing over, 28 October 2026, ended by Javi\n\nStep in hand: unknown, Javi ended session abc with `plans end --now` on branch `fix`",
    );
    expect(stateOf(out)).toMatchObject({
      state: "handed",
      branch: "fix",
      step: expect.stringMatching(/^unknown/),
    });
    const brief =
      "# A brief\n\n## Planning, 28 October 2026, session abc\n\nBrief for the planner, 28 October 2026.\n\nWhat to plan.\n";
    // A brief only loses its Planning line: a Handing over line would read as an executor's taking.
    const back = endedEdit(brief, { sessionId: "abc", by: "Javi", day: "28 October 2026" });
    expect(back).toBe("# A brief\n\nBrief for the planner, 28 October 2026.\n\nWhat to plan.\n");
    expect(stateOf(back)).toMatchObject({ kind: "Brief", state: "brief" });
    // Another session's line, or none (it wrote Built while it was stopped), is left as it is.
    expect(endedEdit(plan, { sessionId: "other", by: "Javi" })).toBe(plan);
  });

  it("reads a blocked session as waiting for input, and never replaces it", () => {
    const row = {
      sessionId: "b1000000-0000",
      name: "Ends Planner 1",
      kind: "background",
      state: "blocked",
      status: "idle",
      cwd: "/x",
    };
    const [one] = sessionsOf("planner", [row], null, {
      trees: [{ path: "/x", branch: "" }],
      stateFor: () => ({ agent: "planner", plans: [] }),
      usageFor: () => ({ context: 300_000, at: now - MIN }),
    } as never);
    expect(one.status).toBe("waiting for input");
    expect(describeSession(one)).toContain("Ends Planner 1 [b1000000], waiting for input");
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    // A planner waiting on its owner is left: a fresh one starts beside it, none is retired.
    const planner = canStart({ kind: "planner", now, usage, name: "Ends", sessions: [one] });
    expect(planner).toMatchObject({ start: true });
    expect(planner).not.toHaveProperty("replace");
    expect(planner.note).toContain("which is waiting for input with a context of 300k");
    // An executor waiting on its owner refuses the start.
    const executor = { ...one, kind: "executor" as const };
    expect(canStart({ now, usage, name: "Ends", sessions: [executor] })).toMatchObject({
      refuse: true,
    });
  });

  it("says when a chat ends, and where each plan a planner holds stands", () => {
    const at = Date.now() + 30 * MIN;
    const hhmm = new Date(at).toTimeString().slice(0, 5);
    const executor = {
      kind: "executor" as const,
      sessionId: "e1000000-0000",
      id: "",
      name: "Ends Executor 1",
      status: "idle",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "",
      endsAt: at,
    };
    expect(describeSession(executor)).toBe(
      `Ends Executor 1 [e1000000], idle, ends at ${hhmm} if left quiet, in the checkout`,
    );
    // A turn under way is not quiet.
    expect(describeSession({ ...executor, status: "busy" })).toBe(
      "Ends Executor 1 [e1000000], busy, in the checkout",
    );
    expect(describeSession({ ...executor, endsAt: Date.now() - MIN })).toBe(
      "Ends Executor 1 [e1000000], idle, in the checkout",
    );
    const live = [{ sessionId: "e1000000-0000", name: "Ends Executor 1" }];
    const plans = [
      { path: "plans/a.md", state: "ready" },
      { path: "plans/b.md", state: "ready", asks: true },
      { path: "plans/c.md", state: "built" },
      { path: "plans/d.md", state: "building", session: "e1000000-0000" },
    ];
    const [planner] = sessionsOf(
      "planner",
      [{ sessionId: "p1000000-0000", name: "Ends Planner 1", kind: "background", status: "idle" }],
      null,
      {
        trees: [],
        plans,
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/a.md", "plans/b.md", "plans/c.md"],
          end: { pid: null, at },
        }),
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(planner)).toBe(
      `Ends Planner 1 [p1000000], idle, ends at ${hhmm} if left quiet, holds plans/a.md (ready, for the executor), plans/b.md (unanswered, the executor decides) and plans/c.md (built)`,
    );
    // "Asked once": within thirty minutes of its question, the plan is this planner's.
    const last = Date.now() - 5 * MIN;
    const [asking] = sessionsOf(
      "planner",
      [{ sessionId: "p1000000-0000", name: "Ends Planner 1", kind: "background", status: "idle" }],
      null,
      {
        trees: [],
        plans,
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/b.md"],
          asked: { "plans/b.md": last },
        }),
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(asking)).toContain(
      `holds plans/b.md (asks Javi here until ${new Date(last + 30 * MIN).toTimeString().slice(0, 5)})`,
    );
    const [retired] = sessionsOf(
      "planner",
      [
        ...live,
        { sessionId: "p2000000-0000", name: "Ends Planner 2", kind: "background", status: "idle" },
      ],
      null,
      {
        trees: [],
        plans,
        stateFor: (id: string) =>
          id.startsWith("p2")
            ? { agent: "planner", retired: true, plans: ["plans/d.md", "plans/e.md"] }
            : { agent: "executor" },
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(retired)).toBe(
      "Ends Planner 2 [p2000000], idle, retired, its plans plans/d.md (building, Ends Executor 1) and plans/e.md (gone)",
    );
  });

  describe("in a fixture", () => {
    let dir: string;
    let projects: string;
    let log: string;
    const exec = "e2000000-0000-0000-0000-000000000000";
    const planner = "p3000000-0000-0000-0000-000000000000";
    const asker = "p4000000-0000-0000-0000-000000000000";
    const lone = "p5000000-0000-0000-0000-000000000000";
    const tty = "e6000000-0000-0000-0000-000000000000";
    const stateFile = (id: string) => join(tmpdir(), `workflow-queue-${id}.json`);
    const rows = [
      {
        sessionId: exec,
        id: "bg-e",
        name: "Ends Executor 1",
        kind: "background",
        state: "done",
        status: "idle",
      },
      {
        sessionId: asker,
        id: "bg-a",
        pid: 4242,
        name: "Ends Planner 1",
        kind: "background",
        state: "blocked",
        status: "idle",
      },
      {
        sessionId: planner,
        id: "bg-p",
        name: "Ends Planner 2",
        kind: "background",
        state: "done",
        status: "idle",
      },
      {
        sessionId: tty,
        name: "Ends Executor 2",
        kind: "interactive",
        state: "done",
        status: "idle",
      },
      {
        sessionId: lone,
        id: "bg-l",
        name: "Ends Planner 3",
        kind: "background",
        state: "done",
        status: "idle",
      },
    ];
    const env = () => ({
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_STOP_LOG: log,
      WORKFLOW_PROJECTS: projects,
      WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
      WORKFLOW_LIVE: JSON.stringify(rows.map((row) => ({ ...row, cwd: dir }))),
    });
    const queue = (args: string[], input: object = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, ...env() },
      });
    const logged = () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    const endAt = (line: string) => Number(/ at (\d+)$/.exec(line)![1]);

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ends-"));
      projects = mkdtempSync(join(tmpdir(), "ends-projects-"));
      log = join(dir, "stops.log");
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Ends\nbranch: test\n---\n");
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `# Taken\n\n## Building, 27 October 2026, session ${exec}\n\nPlan only, 27 October 2026, for Javi.\n`,
      );
      writeFileSync(
        stateFile(planner),
        JSON.stringify({ agent: "planner", plans: ["plans/taken.md"] }),
      );
      writeFileSync(
        stateFile(asker),
        JSON.stringify({ agent: "planner", plans: ["plans/asks.md"] }),
      );
      writeFileSync(stateFile(lone), JSON.stringify({ agent: "planner", plans: [] }));
    });
    afterAll(() => {
      for (const id of [exec, planner, asker, lone, tty]) rmSync(stateFile(id), { force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    });

    it("arms one end timer an hour on at each stop of an executor, and of a planner the queue gave work", () => {
      rmSync(log, { force: true });
      rmSync(stateFile(exec), { force: true });
      const before = Date.now();
      expect(queue(["stop"], { session_id: exec, agent_type: "executor" })).toBe("");
      const first = logged();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(new RegExp(`^end ${exec} at \\d+$`));
      expect(Math.abs(endAt(first[0]) - (before + 60 * MIN))).toBeLessThan(MIN);
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end.at).toBe(endAt(first[0]));
      queue(["stop"], { session_id: exec, agent_type: "executor" });
      const second = logged();
      expect(second).toHaveLength(2);
      expect(endAt(second[1])).toBeGreaterThanOrEqual(endAt(second[0]));
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end.at).toBe(endAt(second[1]));
      // A planner with plans arms the same; one the queue gave nothing arms nothing.
      rmSync(log, { force: true });
      queue(["stop"], { session_id: planner, agent_type: "planner" });
      expect(logged()).toEqual([expect.stringMatching(new RegExp(`^end ${planner} at `))]);
      queue(["stop"], { session_id: lone, agent_type: "planner" });
      expect(logged()).toHaveLength(1);
      // The owner's interactive executor is never the queue's to end: no timer.
      queue(["stop"], { session_id: tty, agent_type: "executor" });
      expect(logged()).toHaveLength(1);
      // plans says when it ends.
      const hhmm = new Date(endAt(second[1])).toTimeString().slice(0, 5);
      expect(queue([])).toContain(
        `Ends Executor 1 [e2000000], idle, ends at ${hhmm} if left quiet`,
      );
    });

    it("arms it on the retire too", () => {
      rmSync(log, { force: true });
      const tired = "e3000000-0000-0000-0000-000000000000";
      writeFileSync(stateFile(tired), JSON.stringify({ agent: "executor", compactions: 2 }));
      writeFileSync(
        join(dir, "plans", "waiting.md"),
        "# Waiting\n\nPlan only, 27 October 2026, for Javi.\n",
      );
      // A start a minute ago with nothing built since: the next start is refused, so none launches.
      writeFileSync(
        join(dir, ".claude", "starts.log"),
        `${JSON.stringify({ at: Date.now() - MIN, name: "Ends Executor 1", paths: [] })}\n`,
      );
      try {
        const said = queue(["stop"], { session_id: tired, agent_type: "executor" });
        expect(said).toContain("Retired: this session has compacted 2 times");
        expect(logged()).toEqual([expect.stringMatching(new RegExp(`^end ${tired} at `))]);
        expect(JSON.parse(readFileSync(stateFile(tired), "utf8")).retired).toBe(true);
      } finally {
        rmSync(stateFile(tired), { force: true });
        rmSync(join(dir, "plans", "waiting.md"), { force: true });
        rmSync(join(dir, ".claude", "starts.log"), { force: true });
      }
    });

    it("plans end ends the finished chats, says why not for the rest, and takes an id", () => {
      rmSync(log, { force: true });
      // The executor's Building line is gone, so nothing is under way.
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `# Taken\n\n## Built, 27 October 2026\n\nCommit 1234abcd.\n\nPlan only, 27 October 2026, for Javi.\n`,
      );
      const out = queue(["end"]);
      expect(logged()).toEqual(["bg-e", "bg-p", "bg-l"]);
      expect(out).toContain("Ended Ends Executor 1 [e2000000]: done.");
      expect(out).toContain("Ended Ends Planner 2 [p3000000]: done.");
      expect(out).toContain("Not ended: Ends Planner 1 [p4000000], its state is blocked.");
      expect(out).toContain(
        "Not ended: Ends Executor 2 [e6000000], it is not a background session of the queue.",
      );
      expect(out).not.toContain("Nothing to end");
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8"))).not.toHaveProperty("end");
      rmSync(log, { force: true });
      expect(queue(["end", "p3000000"])).toBe("Ended Ends Planner 2 [p3000000]: done.\n");
      expect(logged()).toEqual(["bg-p"]);
      expect(queue(["end", "bg-e"])).toBe("Ended Ends Executor 1 [e2000000]: done.\n");
      expect(queue(["end", "deadbeef"])).toBe(
        "deadbeef is no live session of this queue; plans lists them.\n",
      );
    });

    it("never signals a pid that is not the session's timer, and keeps the timer when the stop fails", async () => {
      // Codex, 27 October: a timer gone leaves its pid to be reused.
      writeFileSync(
        join(dir, "plans", "taken.md"),
        "# Taken\n\n## Built, 27 October 2026\n\nCommit 1234abcd.\n\nPlan only, 27 October 2026, for Javi.\n",
      );
      const other = spawn("sleep", ["30"], { stdio: "ignore" });
      try {
        writeFileSync(
          stateFile(exec),
          JSON.stringify({ agent: "executor", end: { pid: other.pid, at: Date.now() } }),
        );
        queue(["stop"], { session_id: exec, agent_type: "executor" });
        await new Promise((done) => setTimeout(done, 300));
        expect(other.exitCode).toBeNull();
        expect(other.signalCode).toBeNull();
      } finally {
        other.kill();
      }
      const kept = { pid: 1, at: Date.now() + 60 * MIN };
      writeFileSync(stateFile(exec), JSON.stringify({ agent: "executor", end: kept }));
      const failed = execFileSync("node", [join(here, "plan-queue.mjs"), "end", "bg-e"], {
        encoding: "utf8",
        env: { ...process.env, ...env(), WORKFLOW_STOP_LOG: "", WORKFLOW_CLAUDE: "/bin/false" },
      });
      expect(failed).toBe("Not ended: Ends Executor 1 [e2000000], claude stop failed.\n");
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end).toEqual(kept);
    });

    it("the timer ends the session when it fires, by the same rule", () => {
      rmSync(log, { force: true });
      expect(queue(["end", "--timer", String(Date.now() - 1), exec])).toBe("");
      expect(logged()).toEqual(["bg-e"]);
      queue(["end", "--timer", String(Date.now() - 1), asker]);
      expect(logged()).toEqual(["bg-e"]);
    });

    // plans/end-a-stuck-chat.md
    it("plans end --now ends a named chat whatever it is doing, its plan handed over first", () => {
      rmSync(log, { force: true });
      expect(queue(["end", "--now"])).toBe(
        "Not ended: name the chat to end now (plans end <id> --now); plans lists them.\n",
      );
      expect(logged()).toEqual([]);
      // Blocked: refused without --now, ended with it, and its subagents' tmux server too.
      expect(queue(["end", "bg-a"])).toBe(
        "Not ended: Ends Planner 1 [p4000000], its state is blocked.\n",
      );
      expect(queue(["end", "bg-a", "--now"])).toBe("Ended Ends Planner 1 [p4000000]: blocked.\n");
      expect(logged()).toEqual(["bg-a", "tmux claude-swarm-4242"]);
      // A plan under way is refused without --now, and handed over with it.
      rmSync(log, { force: true });
      const taken = join(dir, "plans", "taken.md");
      writeFileSync(
        taken,
        `# Taken\n\n## Building, 28 October 2026, session ${exec}\n\nPlan only, 28 October 2026, for Javi.\n\n## The change\n`,
      );
      expect(queue(["end", "bg-e"])).toBe(
        "Not ended: Ends Executor 1 [e2000000], it has plans/taken.md under way.\n",
      );
      // The queue resumes it now: a fresh executor started in its place (WORKFLOW_CLAUDE stands in).
      const ended = execFileSync("node", [join(here, "plan-queue.mjs"), "end", "--now", "bg-e"], {
        encoding: "utf8",
        env: { ...process.env, ...env(), WORKFLOW_CLAUDE: "/bin/true" },
      });
      expect(ended).toMatch(
        /^Ended Ends Executor 1 \[e2000000\]: done\. plans\/taken\.md is handed over\.\n/,
      );
      // start's own answer follows: here the owner's interactive executor refuses it.
      expect(ended).toContain("An executor is alive: Ends Executor 2 [e6000000]");
      expect(logged()).toEqual(["bg-e"]);
      const text = readFileSync(taken, "utf8");
      expect(text).not.toContain("## Building");
      expect(text).toMatch(/^## Handing over, [^,\n]+, ended by [^\n]+\n\nStep in hand: unknown/m);
      expect(stateOf(text)).toMatchObject({ state: "handed" });
      // A failed stop leaves the plan as it was.
      const before = `# Taken\n\n## Building, 28 October 2026, session ${exec}\n\nPlan only, 28 October 2026, for Javi.\n`;
      writeFileSync(taken, before);
      const failed = execFileSync("node", [join(here, "plan-queue.mjs"), "end", "bg-e", "--now"], {
        encoding: "utf8",
        env: { ...process.env, ...env(), WORKFLOW_STOP_LOG: "", WORKFLOW_CLAUDE: "/bin/false" },
      });
      expect(failed).toBe("Not ended: Ends Executor 1 [e2000000], claude stop failed.\n");
      expect(readFileSync(taken, "utf8")).toBe(before);
    });
  });
});

/** plans/owner-questions-plain-and-once.md, part 1: a plan that asks stays with its planner. */
describe("asked once", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 28, 12, 0);
  const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
  const head = "# X\n\nPlan only, 28 October 2026, for Javi; the executor builds it.\n";
  const asks = `${head}\n## Decisions for Javi\n\n1. **The shape.** One (Recommended) or two.\n`;
  const ids = {
    planner: "a1000000-0000-0000-0000-000000000000",
    other: "a2000000-0000-0000-0000-000000000000",
    exec: "a3000000-0000-0000-0000-000000000000",
  };
  const row = {
    sessionId: ids.planner,
    name: "Asks Planner 3",
    kind: "background",
    status: "idle",
    state: "blocked",
  };
  const ready = (path: string) => ({ path, ...stateOf(asks) });
  /** The planner asked `minutesAgo` (none with null), as its tool hook records it. */
  const options = (minutesAgo: number | null, state: object = {}) => ({
    stateFor: () => ({
      agent: "planner",
      brief: "plans/asks.md",
      plans: [],
      ...(minutesAgo === null ? {} : { asked: { "plans/asks.md": now - minutesAgo * MIN } }),
      ...state,
    }),
    now,
  });

  it("askingIn: the live planner whose brief or plans name the plan, within thirty minutes of its question", () => {
    expect(ANSWER_WINDOW).toBe(30 * MIN);
    const held = askingIn(ready("plans/asks.md"), [row], options(5));
    expect(held).toMatchObject({ row: { sessionId: ids.planner }, until: now + 25 * MIN });
    expect(
      askingIn(ready("plans/asks.md"), [row], options(5, { brief: "", plans: ["plans/asks.md"] })),
    ).toMatchObject({ until: now + 25 * MIN });
    // A plan that does not ask; a planner not live; one naming another path;
    // a question past the window; a planner that never asked.
    expect(askingIn({ path: "plans/asks.md", ...stateOf(head) }, [row], options(5))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [], options(5))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(5, { brief: "plans/x.md" }))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(31))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(null))).toBeNull();
    // A built or building plan; an owner's interactive planner, which the queue gave nothing.
    expect(
      askingIn({ path: "plans/asks.md", state: "building", asks: true }, [row], options(5)),
    ).toBeNull();
    expect(
      askingIn({ path: "plans/asks.md", state: "built", asks: true }, [row], options(5)),
    ).toBeNull();
    expect(
      askingIn(ready("plans/asks.md"), [{ ...row, kind: "interactive" }], options(5)),
    ).toBeNull();
    // Talking does not restart the window: a question long ago holds nothing,
    // however recent the planner's last turn (askingIn reads no transcript).
    expect(askingIn(ready("plans/asks.md"), [row], options(45))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(30))).toBeNull();
    // Each plan has its own question: another plan's does not hold this one.
    expect(
      askingIn(ready("plans/asks.md"), [row], {
        ...options(null),
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/asks.md", "plans/b.md"],
          asked: { "plans/b.md": now - MIN },
        }),
      }),
    ).toBeNull();
    // Before its question, a plan is held from when it was written: the
    // planner writes the plan, then asks.
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - 2 * MIN }, [row], options(null)),
    ).toMatchObject({ until: now + 28 * MIN });
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - 40 * MIN }, [row], options(null)),
    ).toBeNull();
    // The question, once asked, is what counts, however recent the last edit.
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - MIN }, [row], options(40)),
    ).toBeNull();
  });

  it("plannerContext says how long the plan is held, and what happens after", () => {
    const texts: Record<string, string> = { "plans/asks.md": asks };
    const within = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(5),
    );
    expect(within).toContain(
      `It asks Javi until ${hhmm(now + 25 * MIN)}: his answer comes here, goes in Decided with its reason, and the plan is handed over by The final message; after that the executor takes it and builds the recommended options.`,
    );
    const past = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(40),
    );
    expect(past).toContain(
      "Its question went unanswered for thirty minutes: the executor takes it and builds the recommended options; an answer now that differs is a follow-up through the assistant's chat.",
    );
  });

  describe("in a fixture", () => {
    let dir: string;
    let projects: string;
    const stateFile = (id: string) => join(tmpdir(), `workflow-queue-${id}.json`);
    const live = [
      { ...row, cwd: "" },
      {
        sessionId: ids.exec,
        name: "Asks Executor 1",
        kind: "background",
        status: "idle",
        state: "done",
      },
    ];
    /** The planner's question, `minutes` ago, in its state as its tool hook writes it. */
    const asked = (minutes: number) => {
      const at = Date.now() - minutes * MIN;
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({
          agent: "planner",
          brief: "plans/asks.md",
          plans: [],
          asked: { "plans/asks.md": at },
        }),
      );
      return at;
    };
    const queue = (args: string[], input: object = {}, rows: object[] = live) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: dir,
          WORKFLOW_ROOT: dir,
          WORKFLOW_PROJECTS: projects,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          WORKFLOW_LIVE: JSON.stringify(rows.map((one) => ({ ...one, cwd: dir }))),
        },
      });
    // With no executor alive, so a start is not refused beside one.
    const start = (...paths: string[]) => queue(["start", "--dry", ...paths], {}, [live[0]]);

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "asks-"));
      projects = mkdtempSync(join(tmpdir(), "asks-projects-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Asks\nbranch: test\n---\n");
      writeFileSync(join(dir, "plans", "asks.md"), asks);
      writeFileSync(join(dir, "plans", "plain.md"), head);
      writeFileSync(
        join(dir, "plans", "topic.md"),
        "# T\n\nBrief for the planner, 28 October 2026.\n",
      );
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", brief: "plans/asks.md", plans: [] }),
      );
    });
    afterAll(() => {
      for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    });

    it("lists a held plan under Asking Javi, and past the window under Ready", () => {
      const at = asked(5);
      const out = queue(["list"]);
      // The headings in order: Briefs, Asking, Ready.
      expect(out.indexOf("Briefs, oldest first")).toBeGreaterThan(0);
      expect(out.indexOf("Briefs, oldest first")).toBeLessThan(
        out.indexOf("Asking Javi, oldest first"),
      );
      expect(out.indexOf("Asking Javi, oldest first")).toBeLessThan(
        out.indexOf("Ready, oldest first"),
      );
      expect(out).toMatch(
        new RegExp(
          `plans/asks\\.md +Plan only, 28 October, in Asks Planner 3 \\[a1000000\\], waiting for input, the executor decides at ${hhmm(at + 30 * MIN)}`,
        ),
      );
      expect(out.slice(out.indexOf("Ready, oldest first"))).not.toContain("plans/asks.md");
      asked(40);
      const later = queue(["list"]);
      expect(later).not.toContain("Asking Javi");
      expect(later).toMatch(
        /plans\/asks\.md +Plan only, 28 October, unanswered, the executor decides/,
      );
    });

    it("plans start leaves a held plan out, refuses it by path, and starts it past the window", () => {
      const at = asked(5);
      const all = start();
      expect(all).toContain("plans/plain.md");
      expect(all).not.toContain("plans/asks.md");
      expect(start("plans/asks.md").trim()).toBe(
        `plans/asks.md asks Javi in Asks Planner 3 [a1000000] until ${hhmm(at + 30 * MIN)}: he answers there, or the executor takes it then and decides by the recommended options.`,
      );
      // Refused whole, with another plan beside it.
      expect(start("plans/plain.md", "plans/asks.md")).not.toContain("Would run");
      // A deferred start, which nobody watches, starts the rest (/code-review).
      const deferred = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/plain.md", "plans/asks.md"], { dry: true, timer: true }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_ROOT: dir,
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
            WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
            WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
          },
        },
      );
      expect(deferred).toContain("Would run: claude");
      expect(deferred).toContain("plans/plain.md");
      expect(deferred).not.toContain("plans/asks.md");
      asked(40);
      expect(start("plans/asks.md")).toContain("Would run: claude");
    });

    const deferredFile = () => join(dir, ".claude", "asking.deferred");
    /** The deferral the hook wrote, its timer killed so nothing fires after the test. */
    const takeDeferral = () => {
      const written = JSON.parse(readFileSync(deferredFile(), "utf8"));
      try {
        process.kill(written.pid);
      } catch {
        // Gone already.
      }
      rmSync(deferredFile(), { force: true });
      return written;
    };
    const question = (state: object) => {
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", plans: [], ...state }),
      );
      const before = Date.now();
      const out = queue(["tool"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [] },
      });
      return { out, before, state: JSON.parse(readFileSync(stateFile(ids.planner), "utf8")) };
    };

    it("the planner's question records its time and defers a start of the plan it asks about", () => {
      rmSync(deferredFile(), { force: true });
      // A usage limit's deferral stands apart: the question neither moves nor merges it.
      const usageDeferral = join(dir, ".claude", "executor.deferred");
      const usage = { until: Date.now() + 5 * MIN, why: "the usage limit", paths: ["plans/x.md"] };
      writeFileSync(usageDeferral, JSON.stringify({ ...usage, pid: null }));
      const { out, before, state } = question({ brief: "plans/asks.md" });
      expect(out).toBe("");
      const at = state.asked["plans/asks.md"];
      expect(at).toBeGreaterThanOrEqual(before);
      const written = takeDeferral();
      expect(written.paths).toEqual(["plans/asks.md"]);
      expect(written.why).toBe("Javi has thirty minutes to answer");
      expect(written.until).toBeGreaterThanOrEqual(at + 30 * MIN);
      expect(written.until).toBeLessThanOrEqual(at + 30 * MIN + 10_000);
      expect(written.pid).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(usageDeferral, "utf8"))).toMatchObject(usage);
      rmSync(usageDeferral);
      // A question about a plan that asks nothing, or before any plan: nothing held.
      const plain = question({ brief: "plans/plain.md" });
      expect(plain.out).toBe("");
      expect(plain.state.asked).toEqual({});
      expect(existsSync(deferredFile())).toBe(false);
      expect(question({ brief: "" }).state.asked).toEqual({});
      expect(existsSync(deferredFile())).toBe(false);
      // A plan whose window ran out is not held again by a later question.
      const late = question({
        brief: "plans/asks.md",
        asked: { "plans/asks.md": Date.now() - 40 * MIN },
      });
      expect(late.state.asked["plans/asks.md"]).toBeLessThan(late.before);
      expect(existsSync(deferredFile())).toBe(false);
      // A second round inside the window holds it from the new question.
      const second = question({
        brief: "plans/asks.md",
        asked: { "plans/asks.md": Date.now() - 10 * MIN },
      });
      expect(second.state.asked["plans/asks.md"]).toBeGreaterThanOrEqual(second.before);
      takeDeferral();
      // The executor's question is never refused by the lock.
      writeFileSync(
        join(dir, ".claude", "executor.lock"),
        JSON.stringify({ sessionId: ids.other, pid: process.pid, released: false }),
      );
      try {
        expect(
          queue(["tool"], {
            session_id: ids.exec,
            agent_type: "workflow:executor",
            tool_name: "AskUserQuestion",
            tool_input: { questions: [] },
          }),
        ).toBe("");
      } finally {
        rmSync(join(dir, ".claude", "executor.lock"), { force: true });
      }
    });

    /**
     * **A plan leaves the asking deferral once it is decided or taken**
     * (plans/research-order-and-asking-cleared.md): the planner's write of a
     * full "Decided", then an executor's Building line, in either path form.
     */
    it("a decided plan, then a taken one, leaves the asking deferral", () => {
      const plan = (name: string, text: string) =>
        writeFileSync(join(dir, "plans", `${name}.md`), text);
      writeFileSync(
        deferredFile(),
        JSON.stringify({
          until: Date.now() + 30 * MIN,
          why: "Javi has thirty minutes to answer",
          paths: ["plans/decided.md", "plans/taken.md"],
          pid: null,
        }),
      );
      const paths = () => JSON.parse(readFileSync(deferredFile(), "utf8")).paths;
      const planner = (file: string) =>
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:planner",
          tool_name: "Edit",
          tool_input: { file_path: file },
        });
      // Still asking: it stays.
      plan("decided", asks.replace("# X", "# Decided"));
      planner(join(dir, "plans", "decided.md"));
      expect(paths()).toEqual(["plans/decided.md", "plans/taken.md"]);
      // Decided, by an absolute path: it goes, and the other stays.
      plan(
        "decided",
        `${asks.replace("# X", "# Decided")}\n## Decided, 28 October 2026\n\n1. One.\n`,
      );
      planner(join(dir, "plans", "decided.md"));
      expect(paths()).toEqual(["plans/taken.md"]);
      // An executor's Building line, by a relative path: the last one goes, and the file.
      plan("taken", `${head}\n## Building, 28 October 2026, session ${ids.exec}\n`);
      queue(["wrote"], {
        session_id: ids.exec,
        agent_type: "workflow:executor",
        tool_name: "Edit",
        tool_input: { file_path: "plans/taken.md" },
      });
      expect(existsSync(deferredFile())).toBe(false);
      // A shell command names no file: every plan the deferral holds is read.
      writeFileSync(
        deferredFile(),
        JSON.stringify({ until: Date.now() + 30 * MIN, why: "w", paths: ["plans/decided.md"] }),
      );
      queue(["wrote"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name: "Bash",
        tool_input: { command: "cat >> plans/decided.md" },
      });
      expect(existsSync(deferredFile())).toBe(false);
      rmSync(join(dir, "plans", "decided.md"));
      rmSync(join(dir, "plans", "taken.md"));
      rmSync(stateFile(ids.exec), { force: true });
    });

    it("a timer whose plans were cleared leaves a newer deferral standing", () => {
      const newer = { until: Date.now() + 30 * MIN, why: "w", paths: ["plans/b.md"], pid: 1 };
      writeFileSync(deferredFile(), JSON.stringify(newer));
      // The old timer fires at once on a plan that is gone, and starts nothing.
      const out = queue(
        ["start", "--timer", String(Date.now()), "--deferral", "asking", "plans/gone.md"],
        {},
        [live[0]],
      );
      expect(out).toBe("");
      expect(JSON.parse(readFileSync(deferredFile(), "utf8"))).toEqual(newer);
      rmSync(deferredFile());
    });

    it("plans prints the window's deferral beside the Asking row, from the same question", () => {
      rmSync(deferredFile(), { force: true });
      const { state } = question({ brief: "plans/asks.md" });
      const at = state.asked["plans/asks.md"];
      const out = queue(["list"]);
      takeDeferral();
      expect(out).toContain(
        `Deferred until ${hhmm(at + 30 * MIN + 5000)}: Javi has thirty minutes to answer; plans/asks.md`,
      );
      expect(out).toContain(`the executor decides at ${hhmm(at + 30 * MIN)}`);
    });

    it("a timer's start takes only what is still waiting, and the window's replaces an idle executor", () => {
      const timerStart = (paths: string[], deferral = "asking") =>
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(${JSON.stringify(paths)}, { dry: true, timer: true, deferral: ${JSON.stringify(deferral)} }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_PROJECTS: projects,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
              WORKFLOW_LIVE: JSON.stringify(live.map((one) => ({ ...one, cwd: dir }))),
            },
          },
        );
      asked(40);
      writeFileSync(
        join(dir, "plans", "built.md"),
        `${head}\n## Built, 28 October 2026\n\nCommit \`0123abcd\`.\n`,
      );
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `${head}\n## Building, 28 October 2026, session ${ids.exec}\n`,
      );
      writeFileSync(stateFile(ids.exec), JSON.stringify({ agent: "executor" }));
      try {
        expect(timerStart(["plans/built.md", "plans/taken.md"]).trim()).toBe(
          "Nothing is waiting in the queue.",
        );
        rmSync(join(dir, "plans", "taken.md"));
        const out = timerStart(["plans/built.md", "plans/asks.md"]);
        expect(out).toContain("Would run: claude");
        expect(out).toContain("Build the plans waiting in the queue, oldest first: plans/asks.md.");
        expect(out).toContain(
          "Would retire Asks Executor 1 [a3000000]: idle while a plan's thirty minutes ran out, and the queue cannot message it.",
        );
        // A usage limit's timer refuses beside the live executor, as before.
        expect(timerStart(["plans/asks.md"], "")).toContain("An executor is alive");
        // A plan dated before the queue, deferred by path, is kept.
        writeFileSync(
          join(dir, "plans", "older.md"),
          "# O\n\nPlan only, 20 October 2026, for Javi.\n",
        );
        expect(timerStart(["plans/built.md", "plans/older.md"])).toContain(
          "oldest first: plans/older.md.",
        );
      } finally {
        rmSync(join(dir, "plans", "older.md"), { force: true });
        rmSync(join(dir, "plans", "built.md"), { force: true });
        rmSync(join(dir, "plans", "taken.md"), { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
    });

    it("a question does not hold a plan written over thirty minutes ago and never asked", () => {
      rmSync(deferredFile(), { force: true });
      const file = join(dir, "plans", "asks.md");
      const long = (Date.now() - 40 * MIN) / 1000;
      utimesSync(file, long, long);
      try {
        const { state } = question({ brief: "plans/asks.md" });
        expect(state.asked).toEqual({});
        expect(existsSync(deferredFile())).toBe(false);
      } finally {
        const fresh = Date.now() / 1000;
        utimesSync(file, fresh, fresh);
      }
    });

    it("the window's start, deferred by usage, stays the window's", () => {
      rmSync(deferredFile(), { force: true });
      asked(40);
      const usageFile = join(dir, ".claude", "usage.json");
      const now = Date.now() / 1000;
      writeFileSync(
        usageFile,
        JSON.stringify({ at: now, five_hour: { used_percentage: 90, resets_at: now + 3600 } }),
      );
      try {
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(["plans/asks.md"], { timer: true, deferral: "asking" }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_USAGE_FILE: usageFile,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
            },
          },
        );
        expect(existsSync(join(dir, ".claude", "executor.deferred"))).toBe(false);
        expect(takeDeferral()).toMatchObject({
          paths: ["plans/asks.md"],
          why: "the five-hour window is at 90 percent",
        });
      } finally {
        rmSync(usageFile, { force: true });
      }
    });

    it("a window's timer that finds its plan asked again re-arms it at the new window", () => {
      rmSync(deferredFile(), { force: true });
      const at = asked(5);
      const out = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/asks.md"], { timer: true, deferral: "asking" }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_ROOT: dir,
            WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
          },
        },
      );
      expect(out).toContain("plans/asks.md asks Javi in Asks Planner 3");
      const written = takeDeferral();
      expect(written.paths).toEqual(["plans/asks.md"]);
      expect(written.until).toBe(at + 30 * MIN + 5000);
    });

    describe("the executor's Building line on a held plan", () => {
      const file = () => join(dir, "plans", "asks.md");
      const line = `## Building, 28 October 2026, session ${ids.exec}`;
      const exec = (mode: string, tool_name: string, tool_input: object) =>
        queue([mode], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name,
          tool_input,
        });
      const edit = (new_string: string) =>
        exec("tool", "Edit", {
          file_path: file(),
          old_string: "## Decisions for Javi",
          new_string,
        });
      const denied = (out: string) =>
        out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
      const words = (at: number) =>
        `plans/asks.md is still asking Javi (its planner's until ${hhmm(at + 30 * MIN)}): build the other plans first, and come back to it after ${hhmm(at + 30 * MIN)}, or when Javi says in this chat to build it now. Once he has, write his word in its "Decided" section first: that lets the plan go.`;
      afterAll(() => {
        writeFileSync(file(), asks);
        rmSync(stateFile(ids.exec), { force: true });
      });

      it("the tool hook refuses it by Edit, MultiEdit or Write while the plan asks, with the words", () => {
        const at = asked(5);
        expect(denied(edit(`${line}\n\n## Decisions for Javi`))).toBe(words(at));
        expect(
          denied(
            exec("tool", "MultiEdit", {
              file_path: file(),
              edits: [{ old_string: "# X\n", new_string: `# X\n\n${line}\n` }],
            }),
          ),
        ).toBe(words(at));
        expect(
          denied(exec("tool", "Write", { file_path: file(), content: `${line}\n\n${asks}` })),
        ).toBe(words(at));
      });

      it("lets it through past the window, with a Decided, or with the planner gone", () => {
        asked(40);
        expect(edit(`${line}\n\n## Decisions for Javi`)).toBe("");
        asked(5);
        // Javi said in the executor's chat to build it now: his word in Decided, first or with the line.
        expect(
          edit(
            `${line}\n\n## Decided, 28 October 2026\n\nJavi said in the executor's chat to build it now.\n\n## Decisions for Javi`,
          ),
        ).toBe("");
        writeFileSync(file(), `${asks}\n## Decided, 28 October 2026\n\nBuild it now (Javi).\n`);
        try {
          expect(edit(`${line}\n\n## Decisions for Javi`)).toBe("");
        } finally {
          writeFileSync(file(), asks);
        }
        expect(
          queue(
            ["tool"],
            {
              session_id: ids.exec,
              agent_type: "workflow:executor",
              tool_name: "Edit",
              tool_input: {
                file_path: file(),
                old_string: "## Decisions for Javi",
                new_string: `${line}\n\n## Decisions for Javi`,
              },
            },
            [live[1]],
          ),
        ).toBe("");
      });

      it("lets the executor's other edits to the held plan through, and its edits elsewhere", () => {
        asked(5);
        expect(edit("A note.\n\n## Decisions for Javi")).toBe("");
        // A Building line already there is not added by an edit beside it.
        writeFileSync(file(), `${asks}\n${line}\n`);
        try {
          expect(edit("A note.\n\n## Decisions for Javi")).toBe("");
        } finally {
          writeFileSync(file(), asks);
        }
        expect(
          exec("tool", "Write", { file_path: join(dir, "notes.md"), content: `${line}\n` }),
        ).toBe("");
      });

      it("the wrote hook takes a line a shell wrote out again, and leaves one past the window", () => {
        const at = asked(5);
        rmSync(stateFile(ids.exec), { force: true });
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        const out = JSON.parse(exec("wrote", "Bash", { command: "sed -i ... plans/asks.md" }));
        expect(out.decision).toBe("block");
        expect(out.reason).toBe(`${words(at)} Its Building line was taken out.`);
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        asked(40);
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        expect(exec("wrote", "Bash", { command: "sed -i ... plans/asks.md" })).toBe("");
        expect(readFileSync(file(), "utf8")).toContain(line);
        // Let through once, it is not judged again, a new question or not.
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).taken).toEqual([
          "plans/asks.md",
        ]);
        asked(5);
        expect(exec("wrote", "Bash", { command: "true" })).toBe("");
        expect(readFileSync(file(), "utf8")).toContain(line);
        // A plan whose line is gone drops from the list, and is judged afresh.
        writeFileSync(file(), asks);
        expect(exec("wrote", "Bash", { command: "true" })).toBe("");
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).taken).toEqual([]);
      });

      it("before any question, a shell's line is judged by the plan's time before the command", () => {
        // The planner wrote the plan just now and has not asked yet (Codex).
        writeFileSync(
          stateFile(ids.planner),
          JSON.stringify({ agent: "planner", brief: "plans/asks.md", plans: [] }),
        );
        rmSync(stateFile(ids.exec), { force: true });
        writeFileSync(file(), asks);
        const before = statSync(file()).mtimeMs;
        expect(exec("tool", "Bash", { command: "sed -i 's/x/y/' plans/asks.md" })).toBe("");
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).plansAt).toMatchObject({
          "plans/asks.md": before,
        });
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        const out = JSON.parse(exec("wrote", "Bash", { command: "sed -i 's/x/y/' plans/asks.md" }));
        expect(out.reason).toBe(`${words(before)} Its Building line was taken out.`);
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        writeFileSync(file(), asks);
      });

      it("an Edit let through with no sessions read is judged again at the next command (Codex)", () => {
        asked(5);
        rmSync(stateFile(ids.exec), { force: true });
        const input = {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Edit",
          tool_input: {
            file_path: file(),
            old_string: "## Decisions for Javi",
            new_string: `${line}\n\n## Decisions for Javi`,
          },
        };
        const blind = execFileSync("node", [join(here, "plan-queue.mjs"), "tool"], {
          input: JSON.stringify(input),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "null" },
        });
        expect(blind).toBe("");
        expect(existsSync(stateFile(ids.exec))).toBe(false);
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        expect(JSON.parse(exec("wrote", "Bash", { command: "true" })).decision).toBe("block");
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        writeFileSync(file(), asks);
      });
    });

    it("editedText and buildingAdded read an edit's result", () => {
      expect(editedText("Edit", { old_string: "a", new_string: "b" }, "aa")).toBe("ba");
      expect(
        editedText("Edit", { old_string: "a", new_string: "b", replace_all: true }, "aa"),
      ).toBe("bb");
      expect(editedText("Edit", { old_string: "z", new_string: "b" }, "aa")).toBe("aa");
      expect(editedText("Edit", { old_string: "", new_string: "new" }, "")).toBe("new");
      expect(editedText("Write", { content: "c" }, "aa")).toBe("c");
      expect(
        editedText(
          "MultiEdit",
          {
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "b", new_string: "$&c" },
            ],
          },
          "a",
        ),
      ).toBe("$&c");
      const building = "## Building, 28 October 2026, session x";
      expect(buildingAdded("# X\n", `# X\n${building}\n`)).toEqual([building]);
      expect(buildingAdded(`${building}\n`, `${building}\nmore\n`)).toEqual([]);
      expect(buildingAdded("# X\n## Building it\n", "# X\n## Building it\n1.\n")).toEqual([]);
    });

    it("the executor's Stop hook names a held plan only past the window, or with its planner gone", () => {
      asked(5);
      rmSync(stateFile(ids.exec), { force: true });
      const reason = () =>
        JSON.parse(queue(["stop"], { session_id: ids.exec, agent_type: "executor" })).reason;
      const within = reason();
      expect(within).toContain("plans/plain.md");
      expect(within).not.toContain("plans/asks.md");
      asked(40);
      rmSync(stateFile(ids.exec), { force: true });
      expect(reason()).toContain(
        'plans/asks.md (decisions unanswered: the recommended options, "Asked once")',
      );
      // The planner's chat gone: the plan is the executor's at once.
      asked(5);
      rmSync(stateFile(ids.exec), { force: true });
      const gone = JSON.parse(
        queue(["stop"], { session_id: ids.exec, agent_type: "executor" }, [live[1]]),
      ).reason;
      expect(gone).toContain("plans/asks.md (decisions unanswered");
    });
  });
});
