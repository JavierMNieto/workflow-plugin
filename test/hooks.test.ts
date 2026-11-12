// The design catalogue's hooks (docs/contributing.md):
// the edit-time context and the once-per-turn audit, run as the real scripts
// against a throwaway git repository.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_IGNORES } from "../plugins/workflow/scripts/project.mjs";
import {
  listToJudge,
  recordTool,
  shellWrites,
  agentsChoice,
  reasonFor,
  treeFiles,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";
import { costWords, measure, measureFile } from "../plugins/workflow/scripts/cost.mjs";
import {
  allowedWhileLocked,
  ceilingFor,
  ceilingsLine,
  REUSE_CAP,
  reuseInputs,
  transcriptsDir,
  REUSE_REFRESH,
  refreshLater,
  costCommand,
  hookRun,
  sharedTokens,
  lastFreshLines,
  tiredFor,
  usageWords,
  withShare,
  sweepTemp,
  ghCommand,
  secret,
  notesWaiting,
  marksReady,
  agentEffort,
  canStart,
  freeBriefs,
  checksVerdict,
  decidePlannerStop,
  plannerPrompt,
  assistantPrompt,
  followUpsMessage,
  startPrompt,
  githubPrompt,
  PLANNER_PROMPT,
  sessionsOf,
  versionLine,
  cutoffEdit,
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
  fromOf,
  issueOf,
  readyOf,
  carriesOf,
  carryOf,
  planTaken,
  readPlans,
  noteWritten,
  plannerContext,
  askingIn,
  buildingAdded,
  editedText,
  ANSWER_WINDOW,
  withPlans,
  describeSession,
  stopPlannersOn,
  stopRetiredPlanners,
  stopTakenPlanners,
  whoTook,
  resetTime,
  stateOf,
  today,
  unreadPlans,
  withoutStatus,
  noAppWords,
  noSecretWords,
  hasIssues,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { statusFrom } from "../plugins/workflow/scripts/statusline.mjs";
import {
  briefPaths,
  noteSeen,
  seenFile,
  seenIn,
  seenOf,
} from "../plugins/workflow/scripts/seen.mjs";
import { appJwt, repoOfRemote } from "../plugins/workflow/scripts/github-app.mjs";
import {
  githubEvents,
  itemsOfDelivery,
  noteFor,
  verifyDelivery,
} from "../plugins/workflow/scripts/github-webhook.mjs";

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

  /**
   * **A catalogue is written to when an entry is** (plans/catalogue-hook-and-audit.md):
   * a frontmatter, heading or prose line is no decision; an entry added or
   * changed is.
   */
  it("refuses once a UI change whose catalogue edit touched only frontmatter or prose", () => {
    const file = join(repo, "docs/patterns/buttons.md");
    const before = readFileSync(file, "utf8");
    try {
      run(audit, ["prompt"], { session_id: "e1", prompt: "Widen the composer" });
      writeFileSync(join(repo, "apps/forum/src/components/Wide.tsx"), "export {}\n");
      writeFileSync(
        file,
        `---\npaths:\n  - "apps/**"\n---\n\n${before}\nA note on buttons, no rule.\n`,
      );
      wrote("e1", "apps/forum/src/components/Wide.tsx");
      wrote("e1", "docs/patterns/buttons.md");
      const out = run(audit, ["stop"], {
        session_id: "e1",
        stop_hook_active: false,
        last_assistant_message: "Done.",
      });
      expect(JSON.parse(out).reason).toContain("nothing under docs/patterns did");
    } finally {
      writeFileSync(file, before);
    }
  });

  it("lets a UI change stop whose catalogue edit added an entry or changed one's text", () => {
    const file = join(repo, "docs/patterns/buttons.md");
    const before = readFileSync(file, "utf8");
    try {
      for (const [id, after] of [
        ["e2", `${before}- **Text buttons say what they do.** (Javi, 2 November)\n`],
        ["e3", before.replace("carry a tooltip", "carry a short tooltip")],
      ]) {
        writeFileSync(file, before);
        run(audit, ["prompt"], { session_id: id, prompt: "Label the buttons" });
        writeFileSync(join(repo, `apps/forum/src/components/${id}.tsx`), "export {}\n");
        writeFileSync(file, after);
        wrote(id, `apps/forum/src/components/${id}.tsx`);
        wrote(id, "docs/patterns/buttons.md");
        const out = run(audit, ["stop"], {
          session_id: id,
          stop_hook_active: false,
          last_assistant_message: "Done.",
        });
        expect(out ? JSON.parse(out).reason : "", id).not.toContain("nothing under docs/patterns");
      }
    } finally {
      writeFileSync(file, before);
    }
  });

  it("never takes an edit of the catalogue itself for a change to record, though ui covers it", () => {
    const d = "plugins/docs/decisions.md";
    const reason = reasonFor([d], "Fix a typo in the intro", "Done.", {
      ui: [/^plugins\//],
      catalogue: d,
      texts: { [d]: "# Decisions\n\nThe intro, fixed.\n\n- **A rule.** (Javi, 2 November)\n" },
      entries: { [d]: ["- **A rule.** (Javi, 2 November)"] },
    });
    expect(reason).toBe("");
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
   * **The agent's choice is retired** (plans/log-only-decisions-with-a-reason.md):
   * today's entry at it, bare or reasoned, is asked once to be taken out or
   * tiered by what it followed; one dated an earlier day is the check's, and
   * a person's or a product's passes.
   */
  it("asks once to take out or re-tier an entry at the agent's choice dated today", () => {
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
    const refusal = (entry: string) =>
      `docs/patterns/words.md has 1 entry at the agent's choice dated today: "${entry}". The catalogue holds only well-formed opinions, a person's call or a product or source followed; a detail nobody decided is free, changed on sight and not recorded. Take the entry out, or tier it by what it followed (as <product> does, per <source>, observed in <x>).`;
    expect(JSON.parse(first).reason).toContain(
      refusal(`**Save, not Submit.** (the agent's choice, ${day})`),
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
      JSON.parse(
        turn(`${id}-tag`, `- **Save.** (the agent's choice, ${day}, GitHub and Gmail differ)`),
      ).reason,
    ).toContain(refusal(`**Save.** (the agent's choice, ${day}, GitHub and Gmail differ)`));
    expect(
      JSON.parse(turn(`${id}-after`, `- **Save.** (the agent's choice, ${day}) Gmail differs.`))
        .reason,
    ).toContain(refusal(`**Save.** (the agent's choice, ${day}) Gmail differs.`));
    expect(turn(`${id}-person`, `- **Save, not Submit.** (Javi, ${day})`)).toBe("");
    expect(turn(`${id}-product`, `- **Save, not Submit.** (as GitHub does, ${day})`)).toBe("");
    // Forty days back is never today.
    const earlier = new Date(Date.now() - 40 * 86_400_000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
    });
    expect(turn(`${id}-old`, `- **Save, not Submit.** (the agent's choice, ${earlier})`)).toBe("");
    rmSync(root, { recursive: true, force: true });
    // Nineteen hook runs, each a node process.
  }, 40_000);
});

describe("agentsChoice", () => {
  const text = `# Words

- **Bare today.** (the agent's choice, 29 October)
- **With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)
- **With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.
- **Bare and older.** (the agent's choice, 2 May)
- **Bare in ISO.** (the agent's choice, 2026-10-29)
- **A person's, bare.** (Javi, 29 October)
- **A product's.** (as GitHub does, 29 October)
- **A source's.** (per GOV.UK, 29 October)
`;

  it("lists every entry at the retired tier, reasoned or not, never a person's or a product's", () => {
    expect(agentsChoice(text)).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)",
      "**With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.",
      "**Bare and older.** (the agent's choice, 2 May)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
  });

  it("with a day, only those dated that day, in either way of writing it", () => {
    expect(agentsChoice(text, "29 October")).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)",
      "**With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.",
    ]);
    expect(agentsChoice(text, ["2 May", "2026-10-29"])).toEqual([
      "**Bare and older.** (the agent's choice, 2 May)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
    const withYears =
      "- **This year.** (the agent's choice, 29 October 2026)\n- **Last year.** (the agent's choice, 29 October 2025, a reason)\n";
    expect(agentsChoice(withYears, ["29 October", "29 October 2026"])).toEqual([
      "**This year.** (the agent's choice, 29 October 2026)",
    ]);
    expect(agentsChoice(withYears, ["29 October 2025"])).toEqual([
      "**Last year.** (the agent's choice, 29 October 2025, a reason)",
    ]);
  });

  it("reads a rule's tier from its own tag, never from the struck-through rule kept under it", () => {
    const history = `- **Save, not Submit.** (Javi, 29 October)
  ~~**Submit.**~~ (the agent's choice, 1 January)
- **Over history.** (the agent's choice, 29 October)
  ~~**Older.**~~ (Javi, 1 January) He said so.
`;
    expect(agentsChoice(history)).toEqual([
      "**Over history.** (the agent's choice, 29 October) ~~**Older.**~~ (Javi, 1 January) He said so.",
    ]);
  });

  it("reads the tier only right after the bold statement or at the rule's end, never a parenthesis inside the statement or mid-body", () => {
    expect(
      agentsChoice("- **Per-step (per row) toggle.** (the agent's choice, 29 October)\n"),
    ).toEqual(["**Per-step (per row) toggle.** (the agent's choice, 29 October)"]);
    // A product's tag inside the statement does not make the tier.
    expect(
      agentsChoice(
        "- **Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)\n",
      ),
    ).toEqual(["**Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)"]);
    // Nor does the retired tag inside the statement or the body.
    expect(
      agentsChoice(
        "- **Grid (the agent's choice, 2 May) keys.** (Javi, 29 October)\n- **Rows.** (Javi, 29 October) Once (the agent's choice, 2 May).\n",
      ),
    ).toEqual([]);
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
    // The tag that ends the rule is its tier.
    expect(untiered("- **Rows toggle.** Each row has one switch. (Javi, 21 October)\n")).toEqual(
      [],
    );
    expect(agentsChoice("- **Save.** Saves the draft. (the agent's choice, 29 October)\n")).toEqual(
      ["**Save.** Saves the draft. (the agent's choice, 29 October)"],
    );
    // A closed parenthesis inside a source's name is part of the tier.
    expect(
      untiered("- **Use sentence case.** (per Microsoft Writing Style Guide (2024), 29 October)\n"),
    ).toEqual([]);
  });

  it("reads no rule inside a fenced example, and reads the README's rules", () => {
    const readme =
      "# Decisions\n\nAn entry looks like this:\n\n```md\n- **Example.** (the agent's choice, 29 October)\n- **No tier.**\n```\n\n- **Real.** (the agent's choice, 29 October)\n";
    expect(agentsChoice(readme)).toEqual(["**Real.** (the agent's choice, 29 October)"]);
    expect(untiered(readme)).toEqual([]);
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

    // plans/dropped-plan-state.md: a plan or a brief dropped on Javi's word.
    it("reads a Dropped section as dropped, before Built, and not in a fenced example", () => {
      const dropped =
        "\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides\nit.\n";
      expect(stateOf(`${header("30 October 2026")}${dropped}`)).toMatchObject({
        state: "dropped",
        kind: "Plan only",
        droppedDay: "30 October 2026",
        why: "#31 already decides it",
      });
      expect(stateOf(`# B\n\nBrief for the planner, 30 October 2026.\n${dropped}`)).toMatchObject({
        state: "dropped",
        kind: "Brief",
        why: "#31 already decides it",
      });
      // Nobody writes both; the drop is the last word.
      expect(
        stateOf(
          `${header("30 October 2026")}${dropped}\n## Built, 30 October 2026\n\nCommit 1234abcd.\n`,
        ),
      ).toMatchObject({ state: "dropped" });
      // A plan that shows the section in a fenced example, or a heading that only starts with the word, is not.
      expect(
        stateOf(
          `${header("30 October 2026")}## The section\n\n\`\`\`\n## Dropped, 30 October 2026\n\`\`\`\n`,
        ),
      ).toMatchObject({ state: "ready" });
      // A tilde fence, and a four-backtick one holding three (Codex, 30 October).
      for (const fence of [
        "~~~markdown\n## Dropped, 30 October 2026\n~~~\n",
        "````\n```\n## Dropped, 30 October 2026\n```\n````\n",
      ])
        expect(
          stateOf(`${header("30 October 2026")}## The section\n\n${fence}`),
          fence,
        ).toMatchObject({ state: "ready" });
      expect(stateOf(`${header("30 October 2026")}## Dropped ideas\n\nNone.\n`)).toMatchObject({
        state: "ready",
      });
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
      // plans/executor-over-ceiling-hands-on.md, part 4: the commit line, in
      // any case and at seven digits, before a session id later in the section.
      const at = (opening: string, rest = "") =>
        stateOf(`${header("5 November 2026")}## Built, 5 November 2026\n\n${opening}\n${rest}`);
      expect(
        at(
          "Commit 63708ca on branch `x`, pushed to `master` at 15:42.",
          "\n- Both earlier plans' `## Building … session 632d8f1c` lines removed.\n",
        ),
      ).toMatchObject({ sha: "63708ca" });
      expect(at("commit 63708ca8fa6ead31ac3fbabf76d62fc20e1d6418")).toMatchObject({
        sha: "63708ca8",
      });
      expect(at("Pushed to `master` as 744af17 from branch `x`.")).toMatchObject({
        sha: "744af17",
      });
      expect(at("by Docs Executor 3 (session 0858c8cd) as `15829f0`")).toMatchObject({
        sha: "15829f0",
      });
      // Codex, C1: a whole UUID, or one in backticks, is a session id too.
      expect(
        at("Executor (session 0858c8cd-1234-4567-89ab-0123456789ab) pushed as 15829f0."),
      ).toMatchObject({ sha: "15829f0" });
      expect(at("Executor (session `0858c8cd`), run 19123456789, as 15829f0.")).toMatchObject({
        sha: "15829f0",
      });
      expect(at("Executor [0858c8cd-1234-4567-89ab-0123456789ab] as 15829f0.")).toMatchObject({
        sha: "15829f0",
      });
      // /code-review: a bare UUID, a run written "Run:" or as a link, upper
      // case, and the opening's commit before a later merge's.
      expect(at("Executor 3 (0858c8cd-1234-4567-89ab-0123456789ab) pushed 744af17.")).toMatchObject(
        { sha: "744af17" },
      );
      expect(at("Run: 19123456789, pushed as 744af17.")).toMatchObject({ sha: "744af17" });
      expect(
        at("https://github.com/o/r/actions/runs/19123456789 green, pushed as 744af17."),
      ).toMatchObject({ sha: "744af17" });
      expect(at("Commit ABCDEF1 pushed.")).toMatchObject({ sha: "abcdef1" });
      expect(
        at(
          "Pull request #12 (https://github.com/o/r/pull/12) to test from branch x, commit 1234abcd; draft.",
          "\nMerged test 5 November, commit abcdef12: none.\n",
        ),
      ).toMatchObject({ sha: "1234abcd" });
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

    // plans/plans-as-github-issues.md, part 3: a plan with an issue waits for Ready.
    it("reads a plan with an Issue line and no Ready as planned, and with one as ready", () => {
      const planned = `${header("3 November 2026")}Lands: topic t, ready.\nIssue: #12.\n\n## What was asked\n`;
      expect(stateOf(planned)).toMatchObject({ state: "planned", issue: 12 });
      expect(issueOf(planned)).toBe(12);
      const ready = `${planned}\n## Ready, 4 November 2026\n\nReady on GitHub, 4 November.\nKeep the order on the phone (Henry, 4 November, comment on #12)\n`;
      expect(stateOf(ready)).toMatchObject({ state: "ready", issue: 12 });
      expect(readyOf(ready)).toEqual({
        readyDay: "4 November 2026",
        by: "github",
        lines: ["Keep the order on the phone (Henry, 4 November, comment on #12)"],
      });
      expect(
        readyOf(`${planned}\n## Ready, 4 November 2026\n\nReady on Javi's word, 4 November.\n`),
      ).toMatchObject({ by: "owner", lines: [] });
      // A brief carries its issue to the plan.
      expect(
        stateOf("# B\n\nBrief for the planner, 3 November 2026.\n\nIssue: #12.\n"),
      ).toMatchObject({ state: "brief", issue: 12 });
      // In a fenced example it is no line, and a Ready in a fence no section.
      const fenced = `${header("3 November 2026")}\`\`\`\nIssue: #12.\n\`\`\`\n\n## What was asked\n`;
      expect(issueOf(fenced)).toBe(0);
      expect(stateOf(fenced)).toMatchObject({ state: "ready", issue: 0 });
      expect(stateOf(`${planned}\n\`\`\`\n## Ready, 4 November 2026\n\`\`\`\n`)).toMatchObject({
        state: "planned",
      });
      // Built, building and dropped are read before planned.
      expect(stateOf(`${planned}\n## Built, 5 November 2026\n\nCommit 1234abcd.\n`)).toMatchObject({
        state: "built",
      });
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

    // plans/simpler-agents.md, part 3: the state and the facts, no landing steps.
    it("names the waiting plans and no landing steps to an executor taking more", () => {
      const waiting = [plan("plans/a.md")];
      expect(decideStop({ waiting })!.reason).toBe(
        "Plans are waiting and this session can take them: plans/a.md (no context known). Build them as a new batch.",
      );
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
      // Told and still waiting: not named twice, the session is retired on them
      // (plans/executor-takes-next-ready-plan.md, part 1).
      expect(decideStop({ waiting, told: ["plans/a.md", "plans/b.md"] })).toEqual({
        retire: true,
        declined: true,
        paths: ["plans/a.md", "plans/b.md"],
        why: "the plans named at the last stop are still waiting, untaken",
      });
      expect(decideStop({ waiting: [plan("plans/a.md")], told: ["plans/a.md"] })!.why).toBe(
        "the plan named at the last stop is still waiting, untaken",
      );
      expect(decideStop({})).toBeNull();
    });

    // plans/executor-takes-next-ready-plan.md: Executor 54 in a project was
    // named nine plans at 90k, built one, and stopped at 127k with eight
    // still ready; the hook passed, and they sat two hours.
    it("retires a session that stops with the plans it was named untaken, whatever its context", () => {
      const now = Date.now();
      const eight = ["topic-rename", "b", "c", "d", "e", "f", "g", "h"].map((x, i) =>
        plan(`plans/${x}.md`, i ? {} : { lands: { name: "topic-rename", ready: false } }),
      );
      const told = ["plans/ai-client-on-sdk.md", ...eight.map((one) => one.path)];
      const out = decideStop({
        waiting: eight,
        told,
        usage: { context: 127_000, at: now },
        fallback: 200_000,
        inputs: {},
        now,
      });
      expect(out).toMatchObject({
        retire: true,
        paths: eight.map((one) => one.path),
        why: "the plans named at the last stop are still waiting, untaken",
      });
    });

    it(
      "hands Executor 54's eight plans to a fresh executor at its stop, end to end",
      { timeout: 30_000 },
      () => {
        const dir = mkdtempSync(join(tmpdir(), "queue-declined-"));
        const id = "e5400000-0000-0000-0000-000000000000";
        const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
        try {
          execFileSync("git", ["init", "-q"], { cwd: dir });
          mkdirSync(join(dir, ".claude"));
          mkdirSync(join(dir, "plans"));
          writeFileSync(
            join(dir, ".claude", "workflow.md"),
            "---\nname: Words\nbranch: test\n---\n",
          );
          const names = ["topic-rename", "b", "c", "d", "e", "f", "g", "h"];
          // Oldest first, by the files' times, the topic's plan the first.
          names.forEach((name, i) => {
            const file = join(dir, "plans", `${name}.md`);
            writeFileSync(
              file,
              `# ${name}\n\nPlan only, 6 November 2026, for Javi.\n${i ? "" : "\nLands: topic topic-rename, waiting.\n"}`,
            );
            const at = new Date(Date.now() - (10 - i) * 60_000);
            utimesSync(file, at, at);
          });
          const paths = names.map((name) => `plans/${name}.md`);
          writeFileSync(
            stateFile,
            JSON.stringify({ agent: "executor", told: ["plans/ai-client-on-sdk.md", ...paths] }),
          );
          const transcript = join(dir, "54.jsonl");
          writeFileSync(
            transcript,
            `${JSON.stringify({
              type: "assistant",
              timestamp: new Date().toISOString(),
              message: { usage: { input_tokens: 10, cache_read_input_tokens: 126_990 } },
            })}\n`,
          );
          const starts = join(dir, ".claude", "starts.log");
          const { WORKFLOW_LIVE: _, ...rest } = process.env;
          const said = execFileSync("node", [join(here, "plan-queue.mjs"), "stop"], {
            input: JSON.stringify({
              session_id: id,
              agent_type: "executor",
              transcript_path: transcript,
            }),
            encoding: "utf8",
            env: {
              ...rest,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_CLAUDE: "/bin/true",
              WORKFLOW_STARTS_LOG: starts,
              WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
            },
          });
          const context = JSON.parse(said).hookSpecificOutput.additionalContext;
          // The checkout's sync speaks between the two, as at any retirement.
          expect(context).toMatch(
            /^Retired: the plans named at the last stop are still waiting, untaken\. /,
          );
          expect(context).toContain(`Words Executor 1 (lab) was started on: ${paths.join(", ")}.`);
          const line = JSON.parse(readFileSync(starts, "utf8").trim());
          expect(line).toMatchObject({ name: "Words Executor 1 (lab)", paths });
          expect(line.why).toContain(
            "was retired: the plans named at the last stop are still waiting, untaken.",
          );
          expect(JSON.parse(readFileSync(stateFile, "utf8")).retired).toBe(true);
        } finally {
          rmSync(stateFile, { force: true });
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it("passes a retired session", () => {
      expect(decideStop({ retired: true, waiting: [plan("plans/a.md")], run: failed })).toBeNull();
    });

    // plans/executor-over-ceiling-hands-on.md, part 1: a session named plans
    // at 187k and stopping at 202k is retired on them.
    it("retires a session over the ceiling on the plans it was told", () => {
      const now = Date.now();
      const at = (minutes: number, k: number) => ({
        context: k * 1000,
        at: now - minutes * 60_000,
      });
      const both = [plan("plans/a.md"), plan("plans/b.md")];
      const told = ["plans/a.md", "plans/b.md"];
      const fresh = decideStop({ waiting: [plan("plans/a.md")], usage: at(0, 300), now });
      expect(fresh).toMatchObject({ retire: true, paths: ["plans/a.md"] });
      expect(fresh!.why).toContain("over the ceiling of 200k (no history yet: today's numbers)");
      // Under the ceiling, told and still waiting: retired as declined.
      expect(decideStop({ waiting: both, told, usage: at(0, 187), now })).toMatchObject({
        retire: true,
        declined: true,
        paths: ["plans/a.md", "plans/b.md"],
      });
      const over = decideStop({ waiting: both, told, usage: at(0, 202), now });
      expect(over).toMatchObject({ retire: true, paths: ["plans/a.md", "plans/b.md"] });
      expect(over!.why).toContain("over the ceiling of 200k");
      const one = decideStop({
        waiting: both,
        told: ["plans/a.md"],
        usage: at(0, 150),
        now,
      });
      // a told and still waiting: b is not named, both go to a fresh executor.
      expect(one).toMatchObject({
        retire: true,
        paths: ["plans/a.md", "plans/b.md"],
        why: "the plan named at the last stop is still waiting, untaken",
      });
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

  // plans/project-follow-ups-reach-the-project.md, part 4.
  describe("a brief for the project a plan came from", () => {
    const head = "# T\n\nPlan only, 31 October 2026, for Javi.\n";
    it("reads the From line, wrapped or not, past a status section and outside a fence", () => {
      const of = (line: string) => fromOf(`${head}${line}\n\n## What was asked\n`);
      expect(of("From: Docs, /workspaces/docs.")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: Docs, /workspaces/docs")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: Docs,\n/workspaces/docs.")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: My-Docs, /home/u/a.b.")).toEqual({
        project: "My-Docs",
        path: "/home/u/a.b",
      });
      expect(of("From: my_docs, /Users/j/My Projects/docs.")).toEqual({
        project: "my_docs",
        path: "/Users/j/My Projects/docs",
      });
      expect(of("From: Docs, workspaces/docs.")).toBeNull();
      expect(of("")).toBeNull();
      expect(of("```\nFrom: Docs, /workspaces/docs.\n```")).toBeNull();
      expect(
        fromOf(
          `# T\n\n## Planning, 31 October 2026, session s\n\nPlan only, 31 October 2026, for Javi.\nFrom: Docs, /workspaces/docs.\n`,
        ),
      ).toEqual({ project: "Docs", path: "/workspaces/docs" });
      // A From line in the body is no header line.
      expect(fromOf(`${head}\n## Notes\n\nFrom: Docs, /workspaces/docs.\n`)).toBeNull();
    });
    it("reads every For section outside a fence, the file as written", () => {
      expect(carriesOf(`${head}\n## For Docs: plans/catalogue-sorted.md\n\nTitle: x.\n`)).toEqual([
        { project: "Docs", file: "plans/catalogue-sorted.md" },
      ]);
      expect(
        carriesOf(`${head}\n## For Docs: plans/a.md\n\n## For Docs: plans/b.md\n`).map(
          (c) => c.file,
        ),
      ).toEqual(["plans/a.md", "plans/b.md"]);
      expect(carriesOf(`${head}\n\`\`\`\n## For Docs: plans/a.md\n\`\`\`\n`)).toEqual([]);
      expect(carriesOf(head)).toEqual([]);
    });
    it("gives a plan its from and carries, and a brief neither", () => {
      const plan = stateOf(
        `${head}From: Docs, /workspaces/docs.\n\n## Built, 31 October 2026\n\nx\n\n## For Docs: plans/x.md\n`,
      )!;
      expect(plan.state).toBe("built");
      expect(plan.from).toEqual({ project: "Docs", path: "/workspaces/docs" });
      expect(plan.carries).toEqual([{ project: "Docs", file: "plans/x.md" }]);
      const brief = stateOf(
        "# B\n\nBrief for the planner, 31 October 2026.\n\n## For Docs: plans/x.md\n",
      )!;
      expect(brief).not.toHaveProperty("from");
      expect(brief).not.toHaveProperty("carries");
    });
    it("finds what each built plan owes: a brief there that names the plan, at its name or the next free one", () => {
      const files: Record<string, string> = {
        "/w/docs/plans/y.md": "# Y\n\nBrief for the planner, by E from /p/plans/a.md (commit 1).\n",
        "/w/docs/plans/z.md": "# Someone else's\n",
        "/w/docs/plans/z-2.md": "# Z\n\nfrom /p/plans/d.md\n",
      };
      const read = (at: string) => {
        if (!(at in files)) throw new Error("ENOENT");
        return files[at];
      };
      const plans = [
        {
          path: "plans/a.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [
            { project: "Docs", file: "plans/x.md" },
            { project: "Docs", file: "plans/y.md" },
          ],
        },
        { path: "plans/b.md", from: null, carries: [{ project: "Docs", file: "plans/z.md" }] },
        {
          path: "plans/c.md",
          from: { project: "Other", path: "/w/other" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
        {
          path: "plans/d.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
        {
          path: "plans/e.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
      ];
      expect(carryOf(plans, { read }).map((one) => [one.path, one.file, one.missing])).toEqual([
        ["plans/a.md", "plans/x.md", "file"],
        ["plans/a.md", "plans/y.md", ""],
        ["plans/b.md", "plans/z.md", "from"],
        ["plans/c.md", "plans/z.md", "from"],
        // Written as z-2.md, since z.md is another's.
        ["plans/d.md", "plans/z.md", ""],
        // Another's file of the name is no brief of this plan's.
        ["plans/e.md", "plans/z.md", "file"],
      ]);
      expect(carryOf(plans, { read })[0].checkout).toBe("/w/docs");
    });
    it("refuses the stop once per brief not written, after a red run and before anything else", () => {
      const owed = {
        path: "plans/a.md",
        project: "Docs",
        file: "plans/x.md",
        checkout: "/w/docs",
        missing: "file",
      };
      const first = decideStop({ carry: [owed] })!;
      expect(first).toMatchObject({ refuse: true, told: ["for:plans/a.md:plans/x.md"] });
      expect(first.reason).toBe(
        'plans/a.md leaves work for Docs (its section "For Docs: plans/x.md") and /w/docs/plans/x.md is not written. Write the brief there from the section, by your agent file, and start that queue: cd /w/docs && plans start --agent planner plans/x.md, or what its line says to do; then say so in "Built". A change the plugin leaves for the project it came from goes back as a brief.',
      );
      expect(decideStop({ carry: [owed], told: ["for:plans/a.md:plans/x.md"] })).toBeNull();
      const from = decideStop({ carry: [{ ...owed, checkout: "", missing: "from" }] })!;
      expect(from.reason).toContain("but names no checkout for it: no From line");
      expect(from.reason).toContain('Add "From: Docs, <path>."');
      expect(decideStop({ carry: [{ ...owed, missing: "" }] })).toBeNull();
      const failed = { id: 7, status: "completed", conclusion: "failure", onHead: true };
      expect(decideStop({ carry: [owed], run: failed })!.reason).toContain("(7) is failed");
      const second = { ...owed, file: "plans/y.md" };
      expect(decideStop({ carry: [owed, second] })!.told).toEqual(["for:plans/a.md:plans/x.md"]);
      expect(
        decideStop({ carry: [owed, second], told: ["for:plans/a.md:plans/x.md"] })!.told,
      ).toEqual(["for:plans/a.md:plans/y.md"]);
      // Before the waiting plans, which would retire or hand on the session.
      expect(decideStop({ carry: [owed], waiting: [{ path: "plans/w.md" }] })!.told).toEqual([
        "for:plans/a.md:plans/x.md",
      ]);
    });
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
    // plans/executor-takes-next-ready-plan.md, part 3: a plan ready, none alive.
    expect(out).toMatch(
      /^Plans on lab, .*The executor: none alive; \d+ plans? ready, and the next hook or timer starts one\./,
    );
    expect(out.indexOf("Ready, oldest first")).toBeLessThan(out.indexOf("Built today"));
    expect(out).toContain("plans/ready.md");
    expect(out).toContain("0123abcd");
    expect(out).toContain("Older, by path only: 1 plan dated");
    // plans/dropped-plan-state.md: on screen only on its day, every one with --all.
    expect(out).not.toContain("Dropped");
    writeFileSync(
      join(repo, "plans", "dropped.md"),
      `${header("24 October 2026")}## Dropped, ${today()}\n\nDropped on Javi's word: #31 already decides it.\n`,
    );
    writeFileSync(
      join(repo, "plans", "dropped-old.md"),
      `${header("24 October 2026")}## Dropped, 25 October 2026\n\nDropped on Javi's word: he no longer wants it.\n`,
    );
    try {
      const listed = (args: string[]) =>
        execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
        });
      const day = today().replace(/ \d{4}$/, "");
      const shown = listed(["list"]);
      expect(shown.indexOf("Built today")).toBeLessThan(shown.indexOf("Dropped today"));
      expect(shown).toMatch(
        new RegExp(`plans/dropped\\.md +dropped, ${day}: #31 already decides it\\n`),
      );
      expect(shown).not.toContain("plans/dropped-old.md");
      // A drop dated in ISO is today's by the calendar day (Codex, 30 October).
      const now = new Date();
      const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      writeFileSync(
        join(repo, "plans", "dropped-iso.md"),
        `${header("24 October 2026")}## Dropped, ${iso}\n\nDropped on Javi's word: folded into plans/ready.md.\n`,
      );
      expect(listed(["list"])).toMatch(
        /plans\/dropped-iso\.md +dropped, .*: folded into plans\/ready\.md/,
      );
      expect(shown.slice(0, shown.indexOf("Dropped today"))).not.toContain("plans/dropped.md");
      const every = listed(["--all"]);
      expect(every).toMatch(/\nDropped\n/);
      expect(every).toMatch(/plans\/dropped-old\.md +dropped, 25 October: he no longer wants it/);
    } finally {
      rmSync(join(repo, "plans", "dropped.md"));
      rmSync(join(repo, "plans", "dropped-old.md"));
      rmSync(join(repo, "plans", "dropped-iso.md"), { force: true });
    }
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
  }, 30_000);

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
    // plans/executor-takes-next-ready-plan.md, part 3.
    it("says with plans ready and none alive that the next hook or timer starts one, or why none does", () => {
      const dir = mkdtempSync(join(tmpdir(), "queue-none-alive-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude"));
        mkdirSync(join(dir, "plans"));
        writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Lines\nbranch: test\n---\n");
        expect(listIn(dir, [])).toContain("The executor: none alive.\n");
        for (const x of ["a", "b", "c", "d", "e", "f", "g", "h"])
          writeFileSync(join(dir, "plans", `${x}.md`), header("6 November 2026"));
        expect(listIn(dir, [])).toContain(
          "The executor: none alive; 8 plans ready, and the next hook or timer starts one.\n",
        );
        writeFileSync(join(dir, ".claude", "executor.pause"), JSON.stringify({ at: "23:10" }));
        expect(listIn(dir, [])).toContain(
          'The executor: none alive; 8 plans ready, but none starts: The queue is paused since 23:10 ("resume the queue" in any session lifts it).\n',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

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
    // plans/executor-over-ceiling-hands-on.md, part 3.
    it("moves past untracked files under plans/, and refuses any other untracked file", () => {
      const test = g(clone, "rev-parse", "origin/test");
      mkdirSync(join(clone, "plans", "x"), { recursive: true });
      writeFileSync(join(clone, "plans", "x.md"), "# X\n");
      writeFileSync(join(clone, "plans", "x", "sketch.md"), "# Sketch\n");
      try {
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
        g(clone, "checkout", "-q", "--detach", first);
        expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        writeFileSync(join(clone, "plans", "my plan.md"), "# Mine\n");
        g(clone, "checkout", "-q", "--detach", first);
        expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        writeFileSync(join(clone, "other.txt"), "other\n");
        expect(syncIn(clone)).toBe(
          "Not moved: the checkout has changes; commit, stash or discard them first.",
        );
      } finally {
        rmSync(join(clone, "plans"), { recursive: true, force: true });
        rmSync(join(clone, "other.txt"), { force: true });
      }
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
        ".claude/executor.*\n.claude/planner.*\n.claude/worktrees/\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n",
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
          `Added .claude/asking.*, .claude/handed.*, .claude/assistant.* to .git/info/exclude. The checkout is at test, ${test.slice(0, 8)}.`,
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(clone, "status", "--porcelain")).toBe("");
        // The tracked .gitignore is left as it is; the line is added once.
        expect(g(clone, "diff", "--name-only")).toBe("");
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
        expect(readFileSync(exclude, "utf8").split("\n")).toContain(".claude/asking.*");
        // An assistant chat's start file too (plans/project-follow-ups-reach-the-project.md).
        expect(readFileSync(exclude, "utf8").split("\n")).toContain(".claude/assistant.*");
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
        ".claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n",
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
  // An executor holds the lock, alive as this process, so a planner's or an
  // assistant's stop in this checkout of ready plans starts none
  // (plans/executor-takes-next-ready-plan.md, part 2); the release puts it back.
  const executorHeld = () => {
    const lock = join(repo, ".claude", "executor.lock");
    const before = existsSync(lock) ? readFileSync(lock, "utf8") : null;
    writeFileSync(lock, JSON.stringify({ sessionId: "held", pid: process.pid, released: false }));
    return () => (before === null ? rmSync(lock, { force: true }) : writeFileSync(lock, before));
  };

  // plans/project-follow-ups-reach-the-project.md, part 6.
  it("starts an assistant chat on a built plan's follow-ups, refuses beside an open one, and lists it", () => {
    const live = (rows: object[]) => JSON.stringify(rows);
    const env = (rows: object[] = []) => ({
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts-assistant.log"),
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage-assistant.json"),
      WORKFLOW_LIVE: live(rows),
    });
    const start = (path: string, rows: object[] = []) =>
      execFileSync(
        "node",
        [join(here, "plan-queue.mjs"), "start", "--agent", "assistant", "--dry", path],
        { encoding: "utf8", env: env(rows) },
      ).trim();
    put(
      "q-built.md",
      "# Built\n\nPlan only, 31 October 2026, for Javi.\n\n## Built, 31 October 2026\n\nPushed to test as commit 0123abcd.\n",
    );
    put("q-ready-a.md", "# Ready\n\nPlan only, 31 October 2026, for Javi.\n");
    put("q-brief-a.md", brief("31 October 2026"));
    const out = start("plans/q-built.md");
    expect(out).toContain(
      'Would run: claude "--bg" "--remote-control" "Test Assistant 1 (lab)" "--name" "Test Assistant 1 (lab)" "--agent" "workflow:assistant" "--effort" "medium" "Follow-ups ready: plans/q-built.md',
    );
    expect(out).toContain(JSON.stringify(assistantPrompt("plans/q-built.md")));
    for (const path of ["plans/q-ready-a.md", "plans/q-brief-a.md"])
      expect(start(path)).toBe(
        `${path} is not a built plan with follow-ups; plans shows the built plans.`,
      );
    // Beside the owner's assistant chat or the queue's, idle or busy: the message instead.
    for (const name of ["Test Assistant", "Test Assistant 2 (lab)"])
      expect(
        start("plans/q-built.md", [
          { sessionId: "a1", name, status: "busy", kind: "interactive", cwd: repo },
        ]),
      ).toBe(
        `${name} is open: send it the message instead. ${followUpsMessage("plans/q-built.md")}`,
      );
    // Not beside another project's, nor another machine's chat.
    for (const row of [
      { sessionId: "a2", name: "Other Assistant", status: "idle", kind: "interactive", cwd: repo },
      {
        sessionId: "a3",
        name: "Test Assistant",
        status: "idle",
        kind: "remote-control",
        cwd: repo,
      },
    ])
      expect(start("plans/q-built.md", [row])).toContain("Would run: claude");
    // The line, only while a chat the queue started is alive.
    const started = {
      sessionId: "44444444-aaaa-0000-0000-000000000000",
      name: "Test Assistant 3 (lab)",
      status: "idle",
      kind: "background",
      cwd: repo,
    };
    expect(listWith([started])).toMatch(
      /\nThe assistant: Test Assistant 3 \(lab\) \[44444444\], idle\.\n/,
    );
    expect(listWith([{ ...started, name: "Test Assistant" }])).not.toContain("The assistant:");
    expect(listWith([])).not.toContain("The assistant:");
    // Its stop arms the end timer; the owner's own assistant chat arms none.
    const log = process.env.WORKFLOW_STOP_LOG!;
    rmSync(log, { force: true });
    const releaseHeld = executorHeld();
    // The queue's launch marks its chat; the owner's chat has no mark and reads nothing.
    const stop = (rows: object[], id: string, marked = true) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "stop"], {
        input: JSON.stringify({ session_id: id, agent_type: "workflow:assistant" }),
        encoding: "utf8",
        env: { ...env(rows), ...(marked ? { WORKFLOW_STARTED: "assistant" } : {}) },
      });
    stop([started], started.sessionId);
    stop([started], `${started.sessionId.slice(0, -1)}9`, false);
    const owner = {
      ...started,
      sessionId: "55555555-aaaa-0000-0000-000000000000",
      name: "Test Assistant",
    };
    stop([owner], owner.sessionId);
    releaseHeld();
    const ends = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(ends).toContain(`end ${started.sessionId} at `);
    expect(ends).not.toContain(owner.sessionId);
    for (const id of [started.sessionId, owner.sessionId])
      rmSync(join(tmpdir(), `workflow-queue-${id}.json`), { force: true });
    for (const name of ["q-built.md", "q-ready-a.md", "q-brief-a.md"])
      rmSync(join(plansDir(), name), { force: true });
  });

  // plans/simpler-agents.md, part 3: the agent file carries the workflow.
  describe("a start prompt names the work", () => {
    it("is one line: the path and what it is", () => {
      expect(plannerPrompt("plans/x.md")).toBe("Plan plans/x.md: it is a brief.");
      const plans = [
        { state: "ready", path: "plans/a.md" },
        { state: "ready", path: "plans/b.md" },
      ];
      expect(startPrompt(["plans/a.md", "plans/b.md"], plans)).toBe(
        "Build plans/a.md, then plans/b.md.",
      );
      expect(startPrompt(["plans/a.md"], plans)).toBe("Build plans/a.md.");
      expect(startPrompt(["plans/x.md"], [{ state: "handed", path: "plans/x.md" }])).toBe(
        'Resume plans/x.md from its "Handing over" section.',
      );
      expect(assistantPrompt("plans/x.md")).toBe("Follow-ups ready: plans/x.md.");
      expect(followUpsMessage("plans/x.md")).toBe("Follow-ups ready: plans/x.md.");
      expect(githubPrompt("plans/github/4.md")).toBe("GitHub: plans/github/4.md.");
    });

    it("reads the planner's prompt inside a message's wrapper", () => {
      const wrapped = `<cross-session-message from="uds:/tmp/x.sock" from-name="Assistant">\n${plannerPrompt("plans/x.md")}\n</cross-session-message>`;
      expect(PLANNER_PROMPT.exec(wrapped)?.[1]).toBe("plans/x.md");
    });
  });

  it("has the executor send, by hand, the follow-ups message the queue prints", () => {
    const executor = readFileSync(join(here, "..", "agents", "executor.md"), "utf8");
    expect(executor.replace(/\s+/g, " ")).toContain(`\`${followUpsMessage("plans/<x>.md")}\``);
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

  it("names planners by their own count and refuses only beside an executor", () => {
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
    // plans/briefs-reach-a-free-planner.md, part 2: a busy planner with room
    // takes the brief at its Stop hook, and nothing is sent.
    const now = Date.UTC(2026, 10, 6, 4, 25);
    const until = new Date(now + 30 * 60_000).toTimeString().slice(0, 5);
    expect(
      canStart({ kind: "planner", sessions: [planner], brief: "plans/next.md", now }),
    ).toMatchObject({
      wait: true,
      why: `Planner 3 [33330000] is busy, planning plans/x.md, with room for plans/next.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
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
  it("keeps a planner under its ceiling on the oldest waiting brief, one over it for a brief that shares nothing on the oldest it has room for, and retires a tired one", () => {
    const now = Date.now();
    const usage = (k: number) => ({ context: k * 1000, at: now });
    // A planner here: fresh start 35k, 70 turns, Fable (plans/adaptive-reuse.md).
    const inputs = {
      planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
    };
    const older = { path: "plans/older.md", shared: 0 };
    const newer = { path: "plans/newer.md", shared: 100_000 };
    expect(decidePlannerStop({ waiting: [older, newer] })).toMatchObject({
      refuse: true,
      told: ["plans/older.md"],
    });
    expect((decidePlannerStop({ waiting: [older, newer] }) as { reason: string }).reason).toContain(
      "A brief is waiting and this session can take it: plans/older.md (no context known).",
    );
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: usage(200), now, inputs }),
    ).toMatchObject({ refuse: true, told: ["plans/newer.md"] });
    expect(decidePlannerStop({ waiting: [older], usage: usage(200), now, inputs })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 75k worked out here"),
    });
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: usage(500), now, inputs }),
    ).toMatchObject({ retire: true });
    // Nothing waiting: alive, idle and unretired.
    expect(decidePlannerStop({ waiting: [] })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], current: { path: "plans/x.md" } })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], paused: true })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], retired: true })).toBeNull();
    // A brief named once and not taken goes to a fresh planner at the next Stop.
    expect(decidePlannerStop({ waiting: [older], told: ["plans/older.md"] })).toEqual({
      retire: true,
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
      // A plan of this queue's own holds topic shown, #24's head branch.
      writeFileSync(
        join(dir, "plans", "mine.md"),
        "# Mine\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown, ready.\n\n## What was asked\n",
      );
      const bin = join(dir, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\n[ -e "$(dirname "$0")/gh.off" ] && exit 1\necho '[{"number":31,"title":"Pictures kept","author":{"login":"anton"},"headRefName":"pictures","files":[{"path":"plugins/workflow/scripts/plan-queue.mjs"}]},{"number":24,"title":"Shown","author":{"login":"javi"},"headRefName":"shown","files":[{"path":"plugins/workflow/scripts/plan-queue.mjs"}]}]'\n`,
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
      // The queue's own pull request names its topic, which a `Lands` line needs to land in it.
      expect(first).toContain(
        'looks related to #24 \\"Shown\\" (this queue\'s, plans/mine.md, topic shown; both name plugins/workflow/scripts/plan-queue.mjs)',
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

  it("a brief's paths take plans/ and .claude/; the executor's rule does not", () => {
    const own = "Read `scripts/hooks/plan-queue.mjs` and `.claude/agents/planner.md`.";
    expect(briefPaths(own)).toEqual(["scripts/hooks/plan-queue.mjs", ".claude/agents/planner.md"]);
    // A root file by its bare name (plans/shared-count-fixes.md, part 2); a
    // number or an abbreviation is not a name.
    expect(briefPaths("Read CLAUDE.md and README.md, e.g. the rules in 5.1.")).toEqual([
      "CLAUDE.md",
      "README.md",
    ]);
    // A root name of more than one dot, or a dotfile, whole (/code-review).
    expect(briefPaths("See vitest.config.ts, .mcp.json and tsconfig.base.json.")).toEqual([
      "vitest.config.ts",
      ".mcp.json",
      "tsconfig.base.json",
    ]);
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

  it("says what a planner holds", () => {
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
    };
    expect(describeSession(one)).toBe(
      "Planner 7 [53593045], busy, planning plans/x.md, holds plans/a.md and plans/b.md",
    );
    expect(describeSession({ ...one, on: "", holds: ["plans/a.md"] })).toBe(
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

  // plans/no-agent-marks-ready.md: only the owner marks a pull request ready, on GitHub.
  it("refuses every session's `gh pr ready` without `--undo`, and no quoted mention of it", () => {
    for (const command of [
      "gh pr ready 12",
      "cd x && gh pr ready 12",
      // Compound commands, wrappers, a continued line and a comment (Codex, /code-review).
      "(gh pr ready 12)",
      "if true; then gh pr ready 12; fi",
      "for n in 12 13; do gh pr ready $n; done",
      "echo $(gh pr ready 12)",
      "env gh pr ready 12",
      "/usr/bin/gh pr ready 12",
      "gh pr \\\nready 12",
      "gh pr ready 12 # --undo is only for reverting",
      "cat > body.md <<EOF\nit's done\nEOF\ngh pr ready 12",
      "gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{}){clientMutationId}}'",
    ])
      expect(marksReady(command), command).toBe(true);
    for (const command of [
      "gh pr ready 12 --undo",
      "gh pr ready 12 --undo=true",
      'git commit -m "never gh pr ready"',
      "gh pr view 12",
      "cat <<'EOF'\ngh pr ready 12\nEOF",
    ])
      expect(marksReady(command), command).toBe(false);
    const tool = (agent_type: string, command: string) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: `ready-${agent_type}-${process.pid}`,
        agent_type,
        tool_name: "Bash",
        tool_input: { command },
      });
    for (const agent of ["executor", "assistant", "planner"]) {
      const refused = tool(agent, "cd x && gh pr ready 12");
      expect(refused).toContain('"permissionDecision":"deny"');
      expect(refused).toContain(
        "Marking a pull request ready for review is its owner's step on GitHub (the Ready for review button), never an agent's. `gh pr ready --undo` is allowed.",
      );
      expect(tool(agent, "gh pr ready 12 --undo")).not.toContain('"permissionDecision":"deny"');
    }
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
      // The state and the rule's heading in the agent file, nothing restated.
      expect(taken).toContain('(your agent file, \\"A change to a taken plan\\")');
      expect(taken).not.toContain("For the assistant's chat");
      writeFileSync(
        stateFile,
        JSON.stringify({ agent: "planner", brief: "plans/late.md", retired: false }),
      );
      const live = tool("Edit", { file_path: join(repo, "plans", "late.md") });
      expect(live).toContain("the plan is the executor's now");
      expect(live).toContain('(your agent file, \\"A change to a taken plan\\")');
      expect(live).not.toContain("For the assistant's chat");
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
      // A follow-up the planner writes itself joins its own plans as it is written.
      writeFileSync(
        stateFile,
        JSON.stringify({ agent: "planner", retired: false, plans: ["plans/gone-to-build.md"] }),
      );
      const write = run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name: "Write",
        tool_input: {
          file_path: join(repo, "plans", "gone-to-build-follow-up.md"),
          content: "# More\n\nPlan only, 30 October 2026, for Javi.\n",
        },
      });
      expect(write).toBe("");
      expect(JSON.parse(readFileSync(stateFile, "utf8")).plans).toEqual([
        "plans/gone-to-build.md",
        "plans/gone-to-build-follow-up.md",
      ]);
      expect(tool("gone-to-build.md")).toContain(
        '(your agent file, \\"A change to a taken plan\\")',
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
    const releaseHeld = executorHeld();
    try {
      const said = stop();
      expect(said).toContain('"decision":"block"');
      const named = /can take it: (plans\/[^\s]+\.md) \(/.exec(said)![1];
      let state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md"]);
      expect(state.brief).toBe(named);
      // The plan is written over the brief, its Planning line gone, before the next Stop.
      writeFileSync(join(repo, named), "# Next\n\nPlan only, 27 October 2026, for Javi.\n");
      stop();
      state = JSON.parse(readFileSync(stateFile, "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md", named]);
    } finally {
      releaseHeld();
      rmSync(stateFile, { force: true });
    }
  });

  // plans/brief-lease-per-brief.md, part 3: two planners never plan one brief.
  it("never names at a stop a brief sent by message to another live planner, and names it at the holder's", () => {
    const id = `stopping-${process.pid}`;
    const holder = `holding-${process.pid}`;
    const files = [id, holder].map((one) => join(tmpdir(), `workflow-queue-${one}.json`));
    const deferred = join(repo, ".claude", "handed.deferred");
    put("own-plan.md", "# Own\n\nPlan only, 6 November 2026, for Javi.\n");
    put("sent-brief.md", brief("6 November 2026"));
    const fresh = () => {
      for (const file of files)
        writeFileSync(
          file,
          JSON.stringify({ agent: "planner", brief: "plans/own-plan.md", plans: [] }),
        );
    };
    const env = {
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: id, name: "Planner 9", kind: "background", cwd: repo },
        { sessionId: holder, name: "Planner 10", kind: "background", cwd: repo },
      ]),
    };
    const stop = (session: string) =>
      run(
        join(here, "plan-queue.mjs"),
        ["stop"],
        { session_id: session, agent_type: "planner" },
        env,
      );
    const named = (said: string) => /can take it: (plans\/[^\s]+\.md) \(/.exec(said)?.[1] || "";
    const releaseHeld = executorHeld();
    try {
      fresh();
      const first = named(stop(id));
      expect(first).not.toBe("");
      // The brief it would name is sent by message to the other planner.
      writeFileSync(
        deferred,
        JSON.stringify({
          until: Date.now() + ANSWER_WINDOW,
          pid: null,
          paths: [first],
          leases: {
            [first]: {
              until: Date.now() + ANSWER_WINDOW,
              why: "handed to Planner 10 [holding-] at 10:25 by message",
              holder,
              held: true,
            },
          },
        }),
      );
      fresh();
      expect(named(stop(id))).not.toBe(first);
      // The planner it was sent to takes it.
      fresh();
      expect(named(stop(holder))).toBe(first);
    } finally {
      releaseHeld();
      for (const file of [...files, deferred]) rmSync(file, { force: true });
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
      "plans/dropped.md": `${head}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`,
      "plans/gone.md": "",
    };
    const said = plannerContext(
      { plans: Object.keys(texts), retired: false },
      null,
      (path) => texts[path],
    );
    // plans/simpler-agents.md, part 3: one line per plan, the state alone.
    const lines = said.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines).toContain("plans/own.md is in the queue and still yours.");
    expect(lines).toContain(
      "plans/taken.md was taken by session abcdef12 on 26 October 2026: it is the executor's.",
    );
    expect(said).toContain("plans/built.md is built, commit 1234abcd");
    expect(lines).toContain("plans/dropped.md is dropped (30 October 2026).");
    expect(lines).toContain("plans/gone.md is no longer in plans/.");
    for (const line of lines) expect(line.length).toBeLessThan(160);
    expect(said).not.toContain("This session may take the next brief");
    expect(said).not.toContain("a follow-up plan you write yourself");
    const retired = plannerContext({ plans: ["plans/own.md"], retired: true }, null, () => head);
    expect(retired).toBe(
      "plans/own.md is in the queue and still yours.\nThis session is retired: it plans nothing more.",
    );
  });

  // plans/agents-pass-messages-directly.md: the follow-up a planner writes itself is its own.
  it("adds a new plan a planner writes to its own, never a brief and never when retired", () => {
    const plan = "# Y\n\nPlan only, 30 October 2026, for Javi; the executor builds it.\n";
    const brief = "# Z\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n";
    const state = { plans: ["plans/x.md"], brief: "", retired: false };
    expect(noteWritten(state, "plans/x-follow-up.md", plan)).toMatchObject({
      plans: ["plans/x.md", "plans/x-follow-up.md"],
      planned: true,
    });
    expect(noteWritten(state, "plans/z.md", brief)).toBe(state);
    expect(noteWritten(state, "plans/x.md", plan)).toBe(state);
    expect(noteWritten(state, "", plan)).toBe(state);
    const retired = { ...state, retired: true };
    expect(noteWritten(retired, "plans/x-follow-up.md", plan)).toBe(retired);
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
    // plans/dropped-plan-state.md: a plan dropped on Javi's word is done with, as a taken one is.
    const dropped = `${own}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`;
    expect(run({ ...two, retired: true }, dropped)).toEqual(["p7"]);
    const sweep: string[] = [];
    stopTakenPlanners(live, {
      stateFor: () => ({ ...two, retired: true }) as never,
      textOf: (path: string) => (path === "plans/a.md" ? dropped : taken),
      stop: (id: string) => sweep.push(id),
      write: () => {},
      now: 1,
    });
    expect(sweep).toEqual(["p7"]);
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
        'looks related to #24 "Shown" (this queue\'s, plans/mine.md, topic shown; both name b/w.md)',
        'looks related to branch next, "Next step" (this queue\'s, plans/next.md; both name b/w.md)',
      ]);
      // The day's fixes pull request is the queue's own but no topic to land in.
      expect(
        relatedLines(text, [{ path: "plans/fix.md", state: "built", pr: 40 }] as never, {
          pulls: [
            {
              number: 40,
              title: "Fixes",
              author: "javi",
              headRefName: "fixes-2026-11-07",
              files: ["b/w.md"],
            },
          ],
        }),
      ).toEqual(['looks related to #40 "Fixes" (this queue\'s, plans/fix.md; both name b/w.md)']);
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
        /plans\/ready\.md +Plan only, 30 October, topic shown, ready, related: #31\n    looks related to #33 "Earlier" \(this queue's, plans\/earlier\.md, topic earlier; both name plugins\/workflow\/docs\/workflow\.md\)\n/,
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
    // plans/dropped-plan-state.md: the Lands line is read on a dropped plan too.
    it("reads a dropped plan with its Lands line", () => {
      const text =
        "# P\n\nPlan only, 30 October 2026, for Javi.\n\nLands: fix.\n\n## Dropped, 30 October 2026\n\nDropped on Javi's word: folded into plans/x.md.\n";
      expect(stateOf(text)).toMatchObject({
        state: "dropped",
        lands: { kind: "fix", now: false },
        droppedDay: "30 October 2026",
        why: "folded into plans/x.md",
      });
    });

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
      // plans/lands-line-suffix.md: the pull request it lands in, or is stacked
      // on, after the topic's state, where agents write it.
      expect(lands("Lands: topic headless-ui, ready; lands in #52.")).toEqual({
        kind: "topic",
        name: "headless-ui",
        ready: true,
        into: 52,
      });
      expect(lands("Lands: topic ai-client, ready; stacked on #52.")).toEqual({
        kind: "topic",
        name: "ai-client",
        ready: true,
        stackedOn: 52,
      });
      expect(lands("Lands: topic x, waiting; lands\nin #7")).toEqual({
        kind: "topic",
        name: "x",
        ready: false,
        into: 7,
      });
      expect(lands("Lands: topic x, waiting.")).toEqual({ kind: "topic", name: "x", ready: false });
      expect(lands("Lands: topic Bad Name, ready.")).toBeNull();
      expect(lands("Lands: fix; lands in #52.")).toBeNull();
      // An example quoted in a fence is not the plan's line (/code-review).
      expect(lands("```\nLands: topic headless-ui, ready.\n```")).toBeNull();
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
      `# A\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; draft, checks green.\n`,
    );
    // plans/owner-reviews-before-anyone-else.md: a draft waits on its owner, read off `isDraft`.
    writeFileSync(
      join(dir, "plans", "ready-pull.md"),
      `# C\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #22 (https://github.com/o/r/pull/22) to test from branch z, commit 71c4a812; draft, checks green.\n`,
    );
    writeFileSync(
      join(dir, "plans", "merged-pull.md"),
      `# D\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #23 (https://github.com/o/r/pull/23) to test from branch w, commit 81c4a812; draft, checks green.\n`,
    );
    writeFileSync(
      join(dir, "plans", "pushed.md"),
      `# B\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nBranch y, commit 1234abcd on test.\n`,
    );
    const bin = temp("queue-gh-list-");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2 $3 $4" = "pr list --state all" ]; then echo '[{"number":21,"state":"OPEN","isDraft":true},{"number":22,"state":"OPEN","isDraft":false},{"number":23,"state":"MERGED","isDraft":false}]'; else exit 1; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const listed = runIn(dir, ["list"], { PATH: `${bin}:${process.env.PATH}` });
    expect(listed).toMatch(/plans\/by-pull\.md\s+#21, draft\n/);
    expect(listed).toMatch(/plans\/ready-pull\.md\s+#22, open\n/);
    expect(listed).toMatch(/plans\/merged-pull\.md\s+#23, merged\n/);
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
    expect(listed).not.toContain("Lands line not read");
    // plans/lands-line-suffix.md: the pull request after the state keeps the
    // topic, and a line the queue cannot read is said, not taken for the file.
    ready("headless-ui-controls.md", "Lands: topic headless-ui, ready; lands in #52.");
    ready("ai-client-stack.md", "Lands: topic ai-client, ready; stacked on #52.");
    ready("bad-name.md", "Lands: topic Bad Name, ready.");
    const suffixed = runIn(dir, ["list"], { PATH: empty });
    // plans/related-plans-share-a-pull-request.md: the row says where it lands.
    expect(suffixed).toMatch(
      /plans\/headless-ui-controls\.md\s+Plan only, 30 October, topic headless-ui, ready, lands in #52\n/,
    );
    expect(suffixed).toMatch(
      /plans\/ai-client-stack\.md\s+Plan only, 30 October, topic ai-client, ready, stacked on #52\n/,
    );
    expect(suffixed).toContain("Lands line not read: plans/bad-name.md\n");
    expect(suffixed).not.toMatch(/Lands line not read: .*plans\/(?:headless|ai-client|ready)/);
    // Outside the pull request mode the line means nothing, so it is not said (Codex).
    const pushMode = fixture("TopicsPush");
    writeFileSync(
      join(pushMode, "plans", "bad-name.md"),
      "# R\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic Bad Name, ready.\n\n## What was asked\n",
    );
    expect(runIn(pushMode, ["list"], { PATH: empty })).not.toContain("Lands line not read");
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

  // plans/project-follow-ups-reach-the-project.md, part 4.
  it("holds the executor's stop once until a built plan's brief is in its project's plans", () => {
    const dir = fixture("Carrier");
    const docs = temp("queue-docs-");
    mkdirSync(join(docs, "plans"));
    const id = `carrier-${process.pid}`;
    const plan = (from: string) =>
      `# C\n\n## Building, 31 October 2026, session ${id}\n\nPlan only, 31 October 2026, for Javi.\n${from}\n## Built, 31 October 2026\n\nPushed to test as commit 0123abcd.\n\n## For Docs: plans/x.md\n\nTitle: X.\n`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`));
    const stop = () => runIn(dir, ["stop"], {}, { session_id: id, agent_type: "executor" });
    const first = stop();
    expect(first).toContain('"decision":"block"');
    expect(first).toContain(`${docs}/plans/x.md is not written`);
    expect(stop()).toBe("");
    const state = (sid: string) =>
      JSON.parse(readFileSync(join(tmpdir(), `workflow-queue-${sid}.json`), "utf8"));
    expect(state(id).told).toContain("for:plans/c.md:plans/x.md");
    // Written, a new session's stop passes.
    // Another's file of the name is no brief of this plan's.
    writeFileSync(join(docs, "plans", "x.md"), "# X\n");
    const other = `carrier-other-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, other));
    expect(runIn(dir, ["stop"], {}, { session_id: other, agent_type: "executor" })).toContain(
      "is not written",
    );
    writeFileSync(
      join(docs, "plans", "x.md"),
      `# X\n\nBrief for the planner, from ${dir}/plans/c.md.\n`,
    );
    const again = `carrier-written-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, again));
    expect(runIn(dir, ["stop"], {}, { session_id: again, agent_type: "executor" })).toBe("");
    // No From line: refused once with the From words.
    const bare = `carrier-bare-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan("").replace(id, bare));
    const told = runIn(dir, ["stop"], {}, { session_id: bare, agent_type: "executor" });
    expect(told).toContain("but names no checkout for it");
    expect(runIn(dir, ["stop"], {}, { session_id: bare, agent_type: "executor" })).toBe("");
    // The Building line taken out at "Built": the session's own record still holds the plan.
    const held = `carrier-held-${process.pid}`;
    rmSync(join(docs, "plans", "x.md"));
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, held));
    runIn(
      dir,
      ["wrote"],
      {},
      {
        session_id: held,
        agent_type: "executor",
        tool_name: "Write",
        tool_input: { file_path: join(dir, "plans", "c.md") },
      },
    );
    writeFileSync(
      join(dir, "plans", "c.md"),
      plan(`From: Docs, ${docs}.\n`).replace(/^## Building, [^\n]*\n\n/m, ""),
    );
    expect(runIn(dir, ["stop"], {}, { session_id: held, agent_type: "executor" })).toContain(
      "is not written",
    );
    // Another session that never held it is not asked.
    expect(
      runIn(
        dir,
        ["stop"],
        {},
        { session_id: `carrier-none-${process.pid}`, agent_type: "executor" },
      ),
    ).toBe("");
    for (const sid of [id, again, other, bare, held, `carrier-none-${process.pid}`])
      rmSync(join(tmpdir(), `workflow-queue-${sid}.json`), { force: true });
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
    // plans/brief-lease-per-brief.md, part 1.
    it(
      "keeps a lease per brief: two entries, one timer at the earlier, and the file goes with the last",
      { timeout: 30_000 },
      () => {
        const dir = fixture("Leases");
        const file = join(dir, ".claude", "handed.deferred");
        const call = (code: string) =>
          execFileSync(
            "node",
            [
              "--input-type=module",
              "-e",
              `import * as q from ${JSON.stringify(join(here, queue))};\n${code}`,
            ],
            { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } },
          );
        const timers: number[] = [];
        const read = () => {
          const table = JSON.parse(readFileSync(file, "utf8"));
          timers.push(table.pid);
          return table;
        };
        const armedAt = (pid: number) =>
          readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        const now = Date.now();
        const b = { until: now + 40 * 60_000, why: "waiting for B", holder: "h-b", held: false };
        const c = { until: now + 35 * 60_000, why: "handed to C", holder: "h-c", held: true };
        try {
          expect(call("console.log(JSON.stringify(q.leases()));").trim()).toBe("{}");
          call(`q.lease("plans/b.md", ${JSON.stringify(b)});`);
          call(`q.lease("plans/c.md", ${JSON.stringify(c)});`);
          // leases() reads both, each with its own until, why, holder and held.
          expect(JSON.parse(call("console.log(JSON.stringify(q.leases()));"))).toEqual({
            "plans/b.md": b,
            "plans/c.md": c,
          });
          // One timer, at the earlier until.
          const both = read();
          expect(both.paths).toEqual(["plans/b.md", "plans/c.md"]);
          expect(both.until).toBe(c.until);
          if (existsSync("/proc")) expect(armedAt(both.pid)).toContain(`--timer ${c.until} `);
          // Releasing one leaves the other, its timer at its own time.
          call(`q.releaseLease(["plans/c.md"]);`);
          const one = read();
          expect(one.leases).toEqual({ "plans/b.md": b });
          expect(one.until).toBe(b.until);
          if (existsSync("/proc")) expect(armedAt(one.pid)).toContain(`--timer ${b.until} `);
          // The last one takes the file with it.
          call(`q.releaseLease(["plans/b.md"]);`);
          expect(existsSync(file)).toBe(false);
        } finally {
          for (const pid of timers)
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
        }
      },
    );
    // plans/briefs-reach-a-free-planner.md, parts 3 and 4, and
    // plans/brief-lease-per-brief.md, parts 1 and 2.
    it(
      "leases a brief left with a busy planner, ends the lease at its Planning line, and starts a fresh planner at its end",
      { timeout: 90_000 },
      () => {
        const dir = fixture("Lease");
        const brief = (title: string) =>
          `# ${title}\n\nBrief for the planner, 6 November 2026, by the assistant with Javi.\n\nWhat.\n`;
        writeFileSync(join(dir, "plans", "b.md"), brief("B"));
        writeFileSync(join(dir, "plans", "c.md"), brief("C"));
        const projects = temp("queue-lease-projects-");
        const row = (n: number, status: object) => ({
          sessionId: `lease-planner-${n}`,
          name: `Lease Planner ${n} (lab)`,
          kind: "background",
          cwd: dir,
          ...status,
        });
        const deferred = join(dir, ".claude", "handed.deferred");
        const env = {
          WORKFLOW_PROJECTS: projects,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          WORKFLOW_LIVE: JSON.stringify([row(1, { status: "busy" })]),
        };
        const timers: number[] = [];
        const read = () => {
          const table = JSON.parse(readFileSync(deferred, "utf8"));
          timers.push(table.pid);
          return table;
        };
        const at = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
        const listed = () =>
          execFileSync(
            "node",
            [
              "--input-type=module",
              "-e",
              `import { list } from ${JSON.stringify(join(here, queue))};
             console.log(list({ live: [] }));`,
            ],
            { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } },
          );
        // A lease's end brought forward, as the clock would bring it.
        const due = (path: string) => {
          const table = JSON.parse(readFileSync(deferred, "utf8"));
          table.leases[path].until = Date.now() - 1000;
          writeFileSync(deferred, JSON.stringify(table));
        };
        const { script, rows } = stub();
        const { WORKFLOW_LIVE: _, ...rest } = process.env;
        const timer = (paths: string[], live: object[]) => {
          writeFileSync(rows, JSON.stringify(live));
          return execFileSync(
            "node",
            [
              join(here, queue),
              "start",
              "--timer",
              String(Date.now() - 1000),
              "--agent",
              "planner",
              "--deferral",
              "handed",
              ...paths,
            ],
            {
              encoding: "utf8",
              env: {
                ...rest,
                ...env,
                WORKFLOW_LIVE: "",
                CLAUDE_PROJECT_DIR: dir,
                WORKFLOW_CLAUDE: script,
                STUB_ROWS: rows,
              },
            },
          );
        };
        try {
          // A dry run says the same line and writes nothing.
          const dry = runIn(dir, ["start", "--dry", "--agent", "planner", "plans/b.md"], env);
          expect(dry).toContain(
            "Lease Planner 1 (lab) [lease-pl] is busy, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ",
          );
          expect(existsSync(deferred)).toBe(false);
          const before = Date.now();
          const said = runIn(dir, ["start", "--agent", "planner", "plans/b.md"], env);
          expect(said).toContain(
            "Lease Planner 1 (lab) [lease-pl] is busy, with room for plans/b.md",
          );
          const first = read();
          const b = first.leases["plans/b.md"];
          expect(first.paths).toEqual(["plans/b.md"]);
          expect(b).toMatchObject({ holder: "lease-planner-1", held: false });
          expect(b.why).toMatch(
            /^waiting for Lease Planner 1 \(lab\) \[lease-pl\] since \d\d:\d\d$/,
          );
          expect(b.until).toBeGreaterThanOrEqual(before + 30 * 60_000);
          expect(b.until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
          expect(said).toContain(`It has until ${at(b.until)}`);
          // A second brief, left with a second planner, idle: its own lease,
          // held by message, beside the first.
          const two = {
            ...env,
            WORKFLOW_LIVE: JSON.stringify([row(1, { status: "busy" }), row(2, { status: "idle" })]),
          };
          const saidC = runIn(dir, ["start", "--agent", "planner", "plans/c.md"], two);
          expect(saidC).toContain(
            "Lease Planner 2 (lab) [lease-pl] is idle with room for plans/c.md",
          );
          const both = read();
          const c = both.leases["plans/c.md"];
          expect(both.paths).toEqual(["plans/b.md", "plans/c.md"]);
          expect(both.leases["plans/b.md"]).toEqual(b);
          expect(c).toMatchObject({ holder: "lease-planner-2", held: true });
          expect(c.why).toMatch(
            /^handed to Lease Planner 2 \(lab\) \[lease-pl\] at \d\d:\d\d by message$/,
          );
          expect(saidC).toContain(`It has until ${at(c.until)}`);
          expect(both.until).toBe(b.until);
          // A brief sent by message is its holder's: named by path, refused.
          expect(runIn(dir, ["start", "--agent", "planner", "plans/c.md"], two)).toContain(
            `plans/c.md was sent to Lease Planner 2 (lab) [lease-pl] at ${at(c.until - 30 * 60_000)} and is its until ${at(c.until)}; plans shows the briefs.\n`,
          );
          // `plans` says who holds each and until when, a line per brief.
          const lines = listed();
          expect(lines).toContain(`Deferred until ${at(b.until)}: ${b.why}; plans/b.md\n`);
          expect(lines).toContain(`Deferred until ${at(c.until)}: ${c.why}; plans/c.md\n`);
          // b's end: its planner waits on a question, so a fresh planner is
          // started beside it on b alone (numbered by the live and the log,
          // where the second is gone), and c keeps its own lease.
          due("plans/b.md");
          expect(
            timer(["plans/b.md", "plans/c.md"], [row(1, { status: "idle", state: "blocked" })]),
          ).toBe("");
          expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
            '"name":"Lease Planner 2 (lab)","paths":["plans/b.md"]',
          );
          expect(readFileSync(join(dir, ".claude", "planner.started"), "utf8")).toContain(
            "Started Lease Planner 2 (lab)",
          );
          const left = read();
          expect(left.leases).toEqual({ "plans/c.md": c });
          expect(left.until).toBe(c.until);
          // c's end with its holder busy with room: the lease renews thirty
          // minutes, the same words with the new time, and `plans` names it.
          due("plans/c.md");
          const renewing = Date.now();
          expect(timer(["plans/c.md"], [row(2, { status: "busy" })])).toBe("");
          const renewed = read().leases["plans/c.md"];
          expect(renewed).toMatchObject({ holder: "lease-planner-2", held: false });
          expect(renewed.until).toBeGreaterThanOrEqual(renewing + 30 * 60_000);
          expect(renewed.why).toBe(
            `waiting for Lease Planner 2 (lab) [lease-pl] since ${at(renewed.until - 30 * 60_000)}`,
          );
          expect(listed()).toContain(
            `Deferred until ${at(renewed.until)}: ${renewed.why}; plans/c.md\n`,
          );
          expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).not.toContain(
            '"paths":["plans/c.md"]',
          );
          // Its Planning line on c ends c's lease, and the file with it.
          writeFileSync(
            join(dir, "plans", "c.md"),
            `## Planning, 6 November 2026, session lease-planner-2\n\n${brief("C")}`,
          );
          runIn(dir, ["wrote"], env, {
            session_id: "lease-planner-2",
            agent_type: "planner",
            tool_name: "Edit",
            tool_input: { file_path: join(dir, "plans", "c.md") },
          });
          expect(existsSync(deferred)).toBe(false);
        } finally {
          for (const pid of timers)
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
          rmSync(projects, { recursive: true, force: true });
        }
      },
    );
  });
});

/** **The cache-aware queue** (plans/cache-aware-queue.md): reuse by context and the cache. */
describe("the cache-aware queue", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 27, 14, 0);
  const at = (minutes: number, k: number) => ({ context: k * 1000, at: now - minutes * MIN });

  it("mayReuse: by the ceiling and the cache, today's numbers with no history", () => {
    expect(mayReuse({ usage: at(1, 150), now })).toEqual({
      reuse: true,
      why: "its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
    });
    expect(mayReuse({ usage: at(1, 250), now }).why).toBe(
      "its context is 250k tokens, over the ceiling of 200k (no history yet: today's numbers)",
    );
    expect(mayReuse({ usage: at(1, 150), now, fallback: 100_000 }).reuse).toBe(false);
    expect(mayReuse({ usage: at(70, 200), now }).why).toContain(
      "its cache has gone cold after 70 minutes idle",
    );
    expect(mayReuse({ usage: at(70, 40), now })).toMatchObject({ reuse: true });
    expect(mayReuse({})).toEqual({ reuse: true, why: "no context known" });
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
      // Its model, for the ceiling's prices, when the turn names one.
      writeFileSync(
        file,
        `${JSON.stringify({ type: "assistant", timestamp: "2026-10-27T13:59:00Z", message: { model: "claude-fable-5-1", usage: { input_tokens: 5 } } })}\n`,
      );
      expect(sessionUsage(file)).toMatchObject({ context: 5, model: "claude-fable-5-1" });
      expect(sessionUsage(join(dir, "none.jsonl"))).toBeNull();
      expect(transcriptOf({ sessionId: "s1", cwd: "/home/v/.claude/x" }, "/p")).toBe(
        "/p/-home-v--claude-x/s1.jsonl",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decideStop and decidePlannerStop retire with the ceiling's reason", () => {
    const waiting = [{ path: "plans/a.md", shared: 0, asks: false }];
    expect(decideStop({ waiting, usage: at(1, 300), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 200k"),
    });
    expect(decidePlannerStop({ waiting, usage: at(1, 500), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 160k"),
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
    fallback: 200_000,
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

  it("canStart starts a planner beside a busy stale one, and waits for a busy one under the ceiling", () => {
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
    expect(beside.note).toContain("busy with a context of 300k (its context is 300k tokens");
    const waited = canStart({
      kind: "planner",
      now,
      usage,
      sessions: [one("busy", 100, "planner")] as never,
    });
    expect(waited).toMatchObject({ wait: true });
    expect(waited.why).toContain("its Stop hook names the next brief waiting, so nothing is sent");
  });

  it("describeSession shows the context and its warmth", () => {
    const warm = {
      ...one("busy", 618),
      fallback: 700_000,
      usage: { context: 618_000, at: Date.now() - 2 * MIN },
    };
    expect(describeSession(warm as never)).toContain("618k context, warm");
    const cold = { ...one("idle", 200), usage: { context: 200_000, at: Date.now() - 130 * MIN } };
    expect(describeSession(cold as never)).toContain("200k context, cold 130 min");
    expect(describeSession(one("idle", 300) as never)).toContain(", over its ceiling,");
  });

  // plans/adaptive-reuse.md: each agent's ceiling worked out from measured
  // inputs and raised by what the work shares with the chat.
  const inputs = {
    planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
    executor: { sessions: 39, start: 49_000, turns: 79, model: "claude-opus-5-5" },
  };
  const plannerUnder =
    "its context is 200k tokens, under the ceiling of 289k worked out here (fresh start 35k, 70 turns, 100k shared, Fable 5.1 prices)";
  const plannerOver =
    "its context is 200k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)";

  it("mayReuse with a context of 200k keeps a planner that shares 100k and retires one that shares nothing, and says why either way", () => {
    const usage = at(1, 200);
    expect(mayReuse({ usage, shared: 100_000, inputs, kind: "planner", now })).toEqual({
      reuse: true,
      why: plannerUnder,
    });
    expect(mayReuse({ usage, inputs, kind: "planner", now })).toEqual({
      reuse: false,
      why: plannerOver,
    });
    // Cold, the shared reading is written again: 135k cold, so 200k retires
    // with the cold words, and 100k is kept.
    expect(mayReuse({ usage: at(70, 200), shared: 100_000, inputs, kind: "planner", now })).toEqual(
      {
        reuse: false,
        why: "its cache has gone cold after 70 minutes idle, and rewriting 200k tokens costs more than a fresh start",
      },
    );
    expect(
      mayReuse({ usage: at(70, 100), shared: 100_000, inputs, kind: "planner", now }).reuse,
    ).toBe(true);
    // The session's own model sets the prices: Opus's for a planner gives a lower ceiling.
    expect(
      mayReuse({
        usage: { ...usage, model: "claude-opus-5-5" },
        shared: 100_000,
        inputs,
        kind: "planner",
        now,
      }).why,
    ).toContain("Opus 5.5 prices");
  });

  it("decidePlannerStop names the oldest brief it has room for with what it shares, and says why", () => {
    const older = { path: "plans/older.md", shared: 0 };
    const newer = { path: "plans/newer.md", shared: 100_000 };
    const kept = decidePlannerStop({ waiting: [older, newer], usage: at(1, 200), now, inputs });
    expect(kept).toMatchObject({
      refuse: true,
      told: ["plans/newer.md"],
      kept: { paths: ["plans/newer.md"], why: plannerUnder },
    });
    expect((kept as { reason: string }).reason).toContain(
      `A brief is waiting and this session can take it: plans/newer.md (${plannerUnder}).`,
    );
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: at(1, 50), now, inputs }),
    ).toMatchObject({ refuse: true, told: ["plans/older.md"] });
    expect(decidePlannerStop({ waiting: [older], usage: at(1, 200), now, inputs })).toEqual({
      retire: true,
      why: plannerOver,
    });
  });

  it("decideStop takes the plans an executor has room for with what they share, and leaves the rest to a fresh executor", () => {
    const waiting = [
      { path: "plans/a.md", shared: 0, asks: false },
      { path: "plans/b.md", shared: 100_000, asks: false },
    ];
    const kept = decideStop({ waiting, usage: at(1, 200), now, inputs });
    expect(kept).toMatchObject({
      refuse: true,
      told: ["plans/b.md"],
      kept: { paths: ["plans/b.md"] },
    });
    expect((kept as { reason: string }).reason).toContain(
      "can take them: plans/b.md (its context is 200k tokens, under the ceiling of 224k worked out here (fresh start 49k, 79 turns, 100k shared, Opus 5.5 prices)).",
    );
    // At the next stop, b built, a goes to a fresh executor.
    expect(
      decideStop({ waiting: [waiting[0]], told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, paths: ["plans/a.md"] });
    // b declined and still waiting: a is not held for it; both go to a fresh
    // executor (Javi, 5 November).
    expect(
      decideStop({ waiting, told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, paths: ["plans/a.md", "plans/b.md"] });
    // Every plan named and b with room, still waiting: declined, a fresh
    // executor takes it (plans/executor-takes-next-ready-plan.md).
    expect(
      decideStop({ waiting: [waiting[1]], told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, declined: true, paths: ["plans/b.md"] });
    // Under both, every plan, as before.
    expect(decideStop({ waiting, usage: at(1, 50), now, inputs })).toMatchObject({
      told: ["plans/a.md", "plans/b.md"],
    });
  });

  it("canStart waits for a busy planner at 250k for a brief that shares 100k, starts beside it for one that shares nothing, and replaces it idle", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const held = (status: string, shared: number) => ({
      ...one(status, 250, "planner"),
      holds: ["plans/own.md"],
      shared,
    });
    const messaged = canStart({
      kind: "planner",
      now,
      usage,
      name: "Test",
      brief: "plans/next.md",
      inputs,
      sessions: [held("busy", 100_000)] as never,
    });
    // Busy: nothing is sent; its Stop hook names the brief (plans/briefs-reach-a-free-planner.md).
    expect(messaged).toMatchObject({ wait: true });
    expect(messaged.why).toContain(
      "Test Planner 1 [planner-] is busy, with room for plans/next.md (its context is 250k tokens, under the ceiling of 289k worked out here (fresh start 35k, 70 turns, 100k shared, Fable 5.1 prices)): its Stop hook names the next brief waiting, so nothing is sent.",
    );
    expect(messaged.why).not.toContain("SendMessage");
    const beside = canStart({
      kind: "planner",
      now,
      usage,
      name: "Test",
      inputs,
      sessions: [held("busy", 0)] as never,
    });
    expect(beside).toMatchObject({ start: true });
    expect(beside.note).toContain("Started beside Test Planner 1");
    expect(
      canStart({
        kind: "planner",
        now,
        usage,
        name: "Test",
        inputs,
        sessions: [held("idle", 0)] as never,
      }),
    ).toMatchObject({
      start: true,
      replace: [
        {
          sessionId: "planner-idle-250",
          why: "its context is 250k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
        },
      ],
    });
  });

  it("canStart keeps an executor for plans that share enough with its batch (Codex C1)", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const idle = (shared: number) => ({ ...one("idle", 200), shared });
    expect(
      canStart({ now, usage, name: "Test", inputs, sessions: [idle(100_000)] as never }).why,
    ).toContain("An executor is alive");
    expect(
      canStart({ now, usage, name: "Test", inputs, sessions: [idle(0)] as never }),
    ).toMatchObject({ start: true, replace: [{ sessionId: "executor-idle-200" }] });
  });

  it("usageWords says over its ceiling, worked out with what the row shares, and never for an assistant", () => {
    const row = (k: number, shared = 0) => ({
      kind: "planner",
      inputs,
      shared,
      usage: { context: k * 1000, at: Date.now() - MIN },
    });
    expect(usageWords(row(300) as never)).toBe("300k context, warm, over its ceiling");
    expect(usageWords(row(200, 100_000) as never)).toBe("200k context, warm");
    expect(usageWords(row(50) as never)).toBe("50k context, warm");
    // No history: today's 160k for a planner.
    expect(usageWords({ ...row(150), inputs: {} } as never)).toBe("150k context, warm");
    expect(usageWords({ ...row(500), kind: "assistant" } as never)).toBe("500k context, warm");
    // The share, with the work it is judged against, after the warmth.
    const shares = (k: number, shared: number) => ({ ...row(k, shared), sharedWith: "plans/x.md" });
    expect(usageWords(shares(300, 13_000) as never)).toBe(
      "300k context, warm, shares 13k with plans/x.md, over its ceiling",
    );
    expect(usageWords(shares(200, 100_000) as never)).toBe(
      "200k context, warm, shares 100k with plans/x.md",
    );
    expect(usageWords(shares(50, 0) as never)).toBe("50k context, warm");
  });

  it("sweepTemp removes a dead session's temp files older than a day, and keeps a live one's, a fresh one and a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    try {
      const now = Date.now();
      const old = (now - 2 * 24 * 60 * MIN) / 1000;
      const file = (name: string, aged = true) => {
        writeFileSync(join(dir, name), "x");
        if (aged) utimesSync(join(dir, name), old, old);
      };
      file("workflow-queue-dead.json");
      file("workflow-seen-dead.jsonl");
      file("workflow-turn-dead.tools");
      file("workflow-plain-words-live.json");
      file("workflow-queue-live.json");
      file("workflow-seen-fresh.jsonl", false);
      file("other-dead.json");
      // Another tool's file of the same prefix is not the plugin's (/code-review).
      file("workflow-run-dead.log");
      mkdirSync(join(dir, "workflow-hooks-dead.d"));
      utimesSync(join(dir, "workflow-hooks-dead.d"), old, old);
      expect(sweepTemp({ dir, live: ["live"], now })).toBe(3);
      expect(readdirSync(dir).sort()).toEqual([
        "other-dead.json",
        "workflow-hooks-dead.d",
        "workflow-plain-words-live.json",
        "workflow-queue-live.json",
        "workflow-run-dead.log",
        "workflow-seen-fresh.jsonl",
      ]);
      expect(sweepTemp({ dir: join(dir, "missing") })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withShare measures an executor against a handed plan before an older ready one", () => {
    const checkout = mkdtempSync(join(tmpdir(), "share-next-"));
    try {
      mkdirSync(join(checkout, "src"));
      writeFileSync(join(checkout, "src", "a.mjs"), "x".repeat(400_000));
      writeFileSync(join(checkout, "src", "b.mjs"), "x".repeat(400_000));
      const rows = [
        {
          sessionId: "e",
          kind: "executor",
          inputs,
          seen: { "src/a.mjs": 13_000, "src/b.mjs": 2_000 },
        },
      ];
      const ready = { path: "plans/old.md", state: "ready", text: "Changes `src/b.mjs`." };
      const handed = { path: "plans/handed.md", state: "handed", text: "Changes `src/a.mjs`." };
      // readPlans's order, handed first; the handed plan is what the queue starts next.
      const [row] = withShare(rows, "executor", [handed, ready], [], { checkout });
      expect(row).toMatchObject({ shared: 13_000, sharedWith: "plans/handed.md" });
      expect(
        usageWords({ ...row, usage: { context: 50_000, at: Date.now() - MIN } } as never),
      ).toBe("50k context, warm, shares 13k with plans/handed.md");
      // A handed plan asking the owner is not started, so not measured (/code-review).
      expect(
        withShare(rows, "executor", [{ ...handed, askingIn: 1 }, ready], [], { checkout })[0],
      ).toMatchObject({ sharedWith: "plans/old.md" });
      // With none handed, the oldest ready plan.
      expect(withShare(rows, "executor", [ready], [], { checkout })[0]).toMatchObject({
        shared: 2_000,
        sharedWith: "plans/old.md",
      });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("describeSession shows why a kept session was kept, and not once it is retired", () => {
    const kept = {
      ...one("busy", 180, "planner"),
      inputs,
      shared: 100_000,
      on: "plans/x.md",
      kept: { paths: ["plans/x.md"], why: plannerUnder },
    };
    expect(describeSession(kept as never)).toContain(
      `planning plans/x.md, kept for plans/x.md: ${plannerUnder}`,
    );
    expect(describeSession({ ...kept, retired: true } as never)).not.toContain("kept for");
    // Once the work it was kept for is done, the reason is stale.
    expect(describeSession({ ...kept, on: "" } as never)).not.toContain("kept for");
    const executor = {
      ...one("busy", 150),
      on: "plans/b.md",
      kept: {
        paths: ["plans/a.md", "plans/b.md"],
        why: "its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
      },
    };
    expect(describeSession(executor as never)).toContain(
      "kept for plans/a.md and plans/b.md: its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
    );
  });

  it("plans says the ceilings worked out here, or today's numbers with no history, and the last fresh start of each kind with why", () => {
    const reuse = { executor: 200_000, planner: 160_000 };
    expect(ceilingsLine(reuse)).toBe(
      "Ceilings: an executor retires past 200k and a planner past 160k (no history yet: today's numbers).",
    );
    const measured = { at: new Date(2026, 10, 6, 19, 0).getTime(), transcripts: 65 };
    expect(ceilingsLine(reuse, { ...inputs, measured })).toBe(
      "Ceilings: an executor retires past 74k (fresh start 49k, 79 turns, Opus 5.5 prices), a planner past 75k (fresh start 35k, 70 turns, Fable 5.1 prices), plus what a plan or brief shares with the chat; measured from 65 transcripts on 6 November.",
    );
    // A planner with too few sessions keeps today's number beside an executor worked out.
    expect(
      ceilingsLine(reuse, {
        executor: inputs.executor,
        planner: { ...inputs.planner, sessions: 4 },
      }),
    ).toBe(
      "Ceilings: an executor retires past 74k (fresh start 49k, 79 turns, Opus 5.5 prices), a planner past 160k (no history yet: today's numbers), plus what a plan or brief shares with the chat.",
    );
    const log = [
      { at: Date.UTC(2026, 10, 5, 9, 0), name: "Reuse Planner 1 (wp)", paths: ["plans/a.md"] },
      {
        at: new Date(2026, 10, 5, 12, 40).getTime(),
        name: "Reuse Planner 2 (wp)",
        paths: ["plans/x.md"],
        why: "Reuse Planner 1 (wp) [17515cb3] was retired: its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers).",
      },
      { at: now, name: "Other Executor 3 (wp)", paths: ["plans/b.md"], why: "Other." },
    ];
    expect(lastFreshLines(log, "Reuse")).toEqual([
      "Last fresh planner: Reuse Planner 2 (wp) at 12:40 on 5 November, on plans/x.md; Reuse Planner 1 (wp) [17515cb3] was retired: its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers).",
    ]);
    const repo = mkdtempSync(join(tmpdir(), "ceilings-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Reuse\nbranch: test\n---\n");
      writeFileSync(
        join(repo, ".claude", "starts.log"),
        log.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      const out = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { list } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(list({ live: [] }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: repo,
            WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
          },
        },
      );
      expect(out).toContain(
        "The planner: none alive.\nCeilings: an executor retires past 200k and a planner past 160k (no history yet: today's numbers).\nLast fresh planner: Reuse Planner 2 (wp) at 12:40 on 5 November, on plans/x.md; Reuse Planner 1 (wp) [17515cb3] was retired:",
      );
      expect(out).not.toContain("Last fresh executor");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("tiredFor and the planner's prompt hook call a planner over its worked-out ceiling tired for a brief that shares too little, and say why", () => {
    const repo = mkdtempSync(join(tmpdir(), "tired-"));
    const id = `tired-${process.pid}`;
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Tired\nbranch: test\n---\n");
      writeFileSync(
        join(repo, "plans", "own.md"),
        "# Own\n\nPlan only, 5 November 2026.\n\nChanges `src/a.mjs`.\n",
      );
      writeFileSync(
        join(repo, "plans", "other.md"),
        "# Other\n\nBrief for the planner, 5 November 2026, by the assistant with Javi.\n\nChanges `src/b.mjs`.\n",
      );
      writeFileSync(
        join(repo, "plans", "near.md"),
        "# Near\n\nBrief for the planner, 5 November 2026, by the assistant with Javi.\n\nChanges `src/a.mjs` again.\n",
      );
      // src/a.mjs, which near.md names and the planner read whole: 100k tokens.
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "a.mjs"), "x".repeat(400_000));
      const textOf = (path: string) => readFileSync(join(repo, path), "utf8");
      const state = { agent: "planner", plans: ["plans/own.md"], seen: { "src/a.mjs": 100_000 } };
      const usage = { context: 250_000, at: Date.now() - MIN };
      const options = { usage, textOf, inputs, checkout: repo };
      expect(tiredFor(state, "plans/other.md", options)).toBe(
        "its context is 250k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
      );
      expect(tiredFor(state, "plans/near.md", options)).toBe("");
      const transcript = join(repo, "t.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } },
        })}\n`,
      );
      // The prompt hook reads the count from the log the tool hooks append to.
      const { seen, ...kept } = state;
      writeFileSync(stateFile, JSON.stringify(kept));
      noteSeen(id, seen);
      const out = execFileSync("node", [join(here, "plan-queue.mjs"), "prompt"], {
        input: JSON.stringify({
          session_id: id,
          agent_type: "planner",
          transcript_path: transcript,
          prompt: "Plan plans/other.md: it is a brief for the planner.",
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: repo,
          WORKFLOW_LIVE: "[]",
          WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
        },
      });
      expect(out).toContain(
        "This session is too full for plans/other.md (its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers)): do not plan it; say so and stop.",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateFile, { force: true });
      rmSync(seenFile(id), { force: true });
    }
  });

  it("a Stop hook's start deferred by usage keeps the retired session's why for the timer's start", () => {
    const repo = mkdtempSync(join(tmpdir(), "deferred-why-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Later\nbranch: test\n---\n");
      // Paused, so the deferral is written and no timer runs.
      writeFileSync(join(repo, ".claude", "executor.pause"), JSON.stringify({ at: "12:00" }));
      execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/x.md"], { replace: "old-session", at: Date.now() + 3_600_000, why: "its context is 250k tokens, over the reuse ceiling of 200k: every turn would re-read it" }));`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: repo, WORKFLOW_LIVE: "[]" },
        },
      );
      expect(
        JSON.parse(readFileSync(join(repo, ".claude", "executor.deferred"), "utf8")),
      ).toMatchObject({
        replace: "old-session",
        retired:
          "its context is 250k tokens, over the reuse ceiling of 200k: every turn would re-read it",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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

/**
 * **A brief reaches a planner that can plan it now** (plans/briefs-reach-a-
 * free-planner.md): a planner is judged at `plans start` by what it can do
 * now, a busy one is never messaged, and a brief left with a live planner is
 * leased to it for thirty minutes.
 */
describe("a brief reaches a free planner", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 10, 6, 4, 25);
  const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
  const until = hhmm(now + 30 * MIN);
  const usage = {
    at: now / 1000,
    five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
  };
  const fallback = 160_000;
  const planner = (
    n: number,
    status: string,
    k: number | null,
    { on = "", shared = 0, id = "" } = {},
  ) => ({
    kind: "planner",
    sessionId: id || `planner-${n}-0000`,
    id: "",
    name: `Docs Planner ${n}`,
    status,
    usage: k === null ? null : { context: k * 1000, at: now - MIN },
    fallback,
    where: "checkout",
    branch: "",
    holdsLock: false,
    retired: false,
    on,
    holds: [],
    shared,
  });
  const facts = (sessions: object[], brief: string, more: object = {}) => ({
    kind: "planner" as const,
    now,
    usage,
    name: "Docs",
    fallback,
    brief,
    sessions: sessions as never,
    taken: sessions.map((one) => (one as { name: string }).name),
    ...more,
  });
  const over230 =
    "its context is 230k tokens, over the ceiling of 160k (no history yet: today's numbers)";
  const blockedWhy =
    "it is waiting for Javi's answer to a question, and takes nothing until he answers";

  it("canStart starts beside a busy planner at 230k with a brief under way and a brief that shares nothing, saying why", () => {
    const busy = planner(34, "busy", 230, { on: "plans/own.md" });
    const decision = canStart(facts([busy], "plans/a.md"));
    expect(decision).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(decision.note).toBe(
      `Started beside Docs Planner 34 [planner-], which is busy with a context of 230k (${over230}).`,
    );
    expect(decision.replace).toBeUndefined();
  });

  it("canStart starts beside a planner waiting for input whatever its context, saying it waits for Javi's answer", () => {
    for (const k of [10, 230, null]) {
      for (const on of ["", "plans/own.md"]) {
        const blocked = planner(34, "waiting for input", k, { on, shared: 100_000 });
        const decision = canStart(facts([blocked], "plans/a.md"));
        expect(decision).toMatchObject({ start: true });
        expect(decision.note).toContain(
          `Started beside Docs Planner 34 [planner-], which is waiting for input with a context of ${k ?? 0}k (${blockedWhy}).`,
        );
        expect(decision.replace).toBeUndefined();
      }
    }
  });

  it("canStart waits for an idle planner with room: the message to send, and the time it has", () => {
    const idle = planner(35, "idle", 50);
    const decision = canStart(facts([idle], "plans/b.md"));
    expect(decision).toEqual({
      wait: true,
      why: `Docs Planner 35 [planner-] is idle with room for plans/b.md (its context is 50k tokens, under the ceiling of 160k (no history yet: today's numbers)): send it the brief with SendMessage, one message per brief: ${plannerPrompt("plans/b.md")} It has until ${until} to take it; then a fresh planner is started on it.`,
      lease: `handed to Docs Planner 35 [planner-] at ${hhmm(now)} by message`,
      holder: "planner-35-0000",
      until: now + 30 * MIN,
      held: true,
    });
  });

  it("canStart waits for a busy planner with room, and nothing is sent", () => {
    const busy = planner(35, "busy", null, { on: "plans/y.md" });
    const decision = canStart(facts([busy], "plans/b.md"));
    expect(decision).toEqual({
      wait: true,
      why: `Docs Planner 35 [planner-] is busy, planning plans/y.md, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
      lease: `waiting for Docs Planner 35 [planner-] since ${hhmm(now)}, planning plans/y.md`,
      holder: "planner-35-0000",
      until: now + 30 * MIN,
      held: false,
    });
    expect(decision.why).not.toContain("SendMessage");
  });

  it("canStart, unwatched, replaces an idle planner under its ceiling and starts beside a blocked one", () => {
    const idle = planner(35, "idle", 50, { id: "planner-35-idle" });
    const blocked = planner(34, "waiting for input", 230, { id: "planner-34-blocked" });
    const decision = canStart(facts([blocked, idle], "plans/b.md", { unwatched: true }));
    expect(decision).toMatchObject({
      start: true,
      name: "Docs Planner 36",
      replace: [
        {
          sessionId: "planner-35-idle",
          why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    expect(decision.note).toContain(
      `Started beside Docs Planner 34 [planner-], which is waiting for input with a context of 230k (${blockedWhy}).`,
    );
    // plans/brief-lease-per-brief.md (Decided): a busy planner with room keeps
    // the brief at the lease's end, and the lease renews.
    const busy = planner(37, "busy", 50, { id: "planner-37-busy", on: "plans/y.md" });
    expect(canStart(facts([blocked, idle, busy], "plans/b.md", { unwatched: true }))).toMatchObject(
      {
        wait: true,
        holder: "planner-37-busy",
        held: false,
        lease: `waiting for Docs Planner 37 [planner-] since ${hhmm(now)}, planning plans/y.md`,
      },
    );
  });

  // plans/brief-lease-per-brief.md, part 3: a brief sent by message is its
  // holder's for the lease; one waiting for a busy planner is anyone's.
  it("freeBriefs leaves out a brief held by message by another live planner, and keeps the rest", () => {
    const plans = ["a", "b", "c", "d", "e", "f"]
      .map((x) => ({ path: `plans/${x}.md`, state: "brief" }))
      .concat({ path: "plans/r.md", state: "ready" });
    const later = now + 30 * MIN;
    const table = {
      "plans/a.md": { until: later, why: "", holder: "other", held: true },
      "plans/b.md": { until: later, why: "", holder: "other", held: false },
      "plans/c.md": { until: later, why: "", holder: "self", held: true },
      "plans/d.md": { until: later, why: "", holder: "old", held: true },
      "plans/e.md": { until: later, why: "", holder: "gone", held: true },
      "plans/f.md": { until: now - MIN, why: "", holder: "other", held: true },
    };
    const live = ["other", "self", "old"].map((sessionId, n) => ({
      sessionId,
      name: `Docs Planner ${n + 1}`,
      kind: "background",
    }));
    const free = (stateFor: (id: string) => object) =>
      freeBriefs(plans, { live, self: "self", replace: "old", table, stateFor, now } as never).map(
        (p) => p.path,
      );
    expect(free(() => ({ agent: "planner" }))).toEqual([
      "plans/b.md",
      "plans/c.md",
      "plans/d.md",
      "plans/e.md",
      "plans/f.md",
    ]);
    // A retired holder holds nothing.
    expect(free((id) => ({ agent: "planner", retired: id === "other" }))).toContain("plans/a.md");
    // With the sessions unread, a held lease is kept until its timer settles it.
    expect(
      freeBriefs(plans, { live: null, self: "self", table, now } as never).map((p) => p.path),
    ).not.toContain("plans/e.md");
  });

  // plans/briefs-reach-a-free-planner-follow-up.md: "A chat holds every plan
  // it wrote until a Building line takes it", at the timer too.
  it("canStart, unwatched, starts beside an idle planner that holds a plan not yet building", () => {
    // plans/planner-holds-unread-plan.md: a plan the queue cannot read is held too.
    for (const stands of ["ready, for the executor", "not read by the queue"]) {
      const holding = {
        ...planner(35, "idle", 50, { id: "planner-35-holds" }),
        holds: ["plans/p.md"],
        standing: { "plans/p.md": stands },
      };
      const decision = canStart(facts([holding], "plans/b.md", { unwatched: true }));
      expect(decision).toMatchObject({ start: true, name: "Docs Planner 36" });
      expect(decision.replace).toBeUndefined();
      expect(decision.note).toBe(
        "Started beside Docs Planner 35 [planner-], which is idle with a context of 50k (idle while a brief's thirty minutes ran out, and the queue cannot message it).",
      );
    }
  });

  // plans/planner-holds-unread-plan.md: a held plan the queue cannot read is
  // told from one whose file is gone.
  it("says a held plan with no header is not read by the queue, and gone once deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-unread-held-"));
    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, "plans", "h.md"), "# H\n\nNotes, the header misplaced.\n");
    const held = () =>
      describeSession(
        sessionsOf(
          "planner",
          [
            {
              sessionId: "p1000000-0000",
              name: "Docs Planner 1",
              kind: "background",
              status: "idle",
            },
          ],
          null,
          {
            trees: [],
            plans: [],
            checkout: dir,
            stateFor: () => ({ agent: "planner", plans: ["plans/h.md"] }),
            usageFor: () => null,
          } as never,
        )[0],
      );
    try {
      expect(held()).toContain("holds plans/h.md (not read by the queue)");
      // Built or dropped all the same, it is not held (/code-review).
      writeFileSync(join(dir, "plans", "h.md"), "# H\n\n## Built, 6 November 2026\n\nDone.\n");
      expect(held()).toContain("holds plans/h.md (built)");
      rmSync(join(dir, "plans", "h.md"));
      expect(held()).toContain("holds plans/h.md (gone)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canStart, unwatched, replaces an idle planner whose only plan is built, building or gone", () => {
    for (const stands of ["built", "building, Docs Executor 3 (lab)", "gone", "dropped", "old"]) {
      const done = {
        ...planner(35, "idle", 50, { id: "planner-35-done" }),
        holds: ["plans/p.md"],
        standing: { "plans/p.md": stands },
      };
      const decision = canStart(facts([done], "plans/b.md", { unwatched: true }));
      expect(decision).toMatchObject({
        start: true,
        replace: [
          {
            sessionId: "planner-35-done",
            why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
          },
        ],
      });
    }
  });

  it("canStart starts beside an idle planner over its ceiling with a brief under way, and never retires it", () => {
    const idle = planner(34, "idle", 230, { on: "plans/own.md" });
    const decision = canStart(facts([idle], "plans/a.md"));
    expect(decision).toMatchObject({ start: true });
    expect(decision.replace).toBeUndefined();
    expect(decision.note).toContain("Started beside Docs Planner 34 [planner-], which is idle");
  });

  // The six steps of 6 November, replayed in order (part 6).
  it("replays 6 November: five briefs reach a planner that can plan them, none waits behind a question", () => {
    const p34 = planner(34, "busy", 230, {
      on: "plans/headless-ui-popovers.md",
      id: "8f8eb02c-0000",
    });
    // 1. Planner 34 mid-brief at 230k: a fresh planner beside it for brief a.
    const first = canStart(facts([p34], "plans/a.md"));
    expect(first).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(first.note).toBe(
      `Started beside Docs Planner 34 [8f8eb02c], which is busy with a context of 230k (${over230}).`,
    );
    // 2. Planner 35 alive and busy, no usage yet: brief b waits for it, nothing sent.
    const p35 = planner(35, "busy", null, { id: "35350000-0000" });
    const second = canStart(facts([p34, p35], "plans/b.md"));
    expect(second).toMatchObject({
      wait: true,
      lease: `waiting for Docs Planner 35 [35350000] since ${hhmm(now)}`,
    });
    expect(second.why).toBe(
      `Docs Planner 35 [35350000] is busy, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
    );
    // 3. Planner 34 asks Javi: brief c still waits for Planner 35, which has room;
    // with Planner 35 gone, a fresh planner starts beside the blocked one.
    const asking = { ...p34, status: "waiting for input" };
    expect(canStart(facts([asking, p35], "plans/c.md"))).toMatchObject({
      wait: true,
      why: expect.stringContaining("Docs Planner 35 [35350000] is busy"),
    });
    const alone = canStart(facts([asking], "plans/c.md"));
    expect(alone).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(alone.note).toContain(
      `which is waiting for input with a context of 230k (${blockedWhy})`,
    );
    // 4. The lease's timer, unwatched: Planner 34 blocked, Planner 35 idle under
    // its ceiling: a fresh planner, Planner 35 replaced.
    const idle35 = { ...p35, status: "idle", usage: { context: 90_000, at: now - 2 * MIN } };
    const timer = canStart(facts([asking, idle35], "plans/b.md", { unwatched: true }));
    expect(timer).toMatchObject({
      start: true,
      name: "Docs Planner 36",
      replace: [
        {
          name: "Docs Planner 35",
          why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    // 5. The fresh planner, after its first plan, with four briefs waiting
    // and none told: names the oldest.
    const waiting = ["b", "c", "d", "e"].map((x) => ({ path: `plans/${x}.md`, shared: 0 }));
    expect(
      decidePlannerStop({ waiting, usage: { context: 80_000, at: now - MIN }, now }),
    ).toMatchObject({ refuse: true, told: ["plans/b.md"] });
    // 6. Planner 34, its question answered, with the briefs all under way or planned.
    expect(
      decidePlannerStop({ waiting: [], usage: { context: 240_000, at: now - MIN }, now }),
    ).toBeNull();
  });
});

/**
 * **The ceiling is worked out from measured inputs** (plans/adaptive-reuse.md,
 * part 2): the wash of decisions.md#context-cost from the agent's fresh start
 * and turns here, raised by what the work shares, capped at 480k, and today's
 * numbers while the agent has under five sessions.
 */
describe("the ceiling is worked out from measured inputs", () => {
  const fable = { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" };
  const inputs = { planner: fable };

  it("gives a planner's wash, warm and cold, and says what it rests on", () => {
    const warm = ceilingFor({ kind: "planner", inputs });
    expect(warm.wash).toBeCloseTo(75_000);
    expect(warm.ceiling).toBeCloseTo(75_000);
    expect(warm.why).toBe(
      "the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
    );
    const cold = ceilingFor({ kind: "planner", inputs, warm: false });
    expect(cold.wash).toBe(35_000);
    expect(cold.ceiling).toBe(35_000);
  });

  it("raises the ceiling by what is shared, times the warm factor, and caps it at 480k", () => {
    const shared = ceilingFor({ kind: "planner", inputs, shared: 100_000 });
    expect(Math.round(shared.ceiling / 1000)).toBe(289);
    expect(shared.why).toContain("the ceiling of 289k worked out here");
    expect(shared.why).toContain("100k shared");
    const capped = ceilingFor({ kind: "planner", inputs, shared: 600_000 });
    expect(capped.ceiling).toBe(480_000);
    expect(REUSE_CAP).toBe(480_000);
    expect(capped.why).toBe("the cap of 480k");
    // Cold, the shared reading is written again at the write price.
    expect(ceilingFor({ kind: "planner", inputs, shared: 100_000, warm: false }).ceiling).toBe(
      135_000,
    );
  });

  it("gives a larger project's fresh start a larger ceiling: twice the start, twice the wash", () => {
    const small = ceilingFor({ kind: "planner", inputs });
    const large = ceilingFor({ kind: "planner", inputs: { planner: { ...fable, start: 70_000 } } });
    expect(large.wash).toBeCloseTo(2 * small.wash);
  });

  it("gives today's number with under five sessions of the agent, and says so", () => {
    const few = ceilingFor({
      kind: "planner",
      inputs: { planner: { ...fable, sessions: 4 } },
      fallback: 160_000,
    });
    expect(few.ceiling).toBe(160_000);
    expect(few.why).toBe("the ceiling of 160k (no history yet: today's numbers)");
    expect(ceilingFor({ kind: "executor", inputs }).why).toBe(
      "the ceiling of 200k (no history yet: today's numbers)",
    );
    // Cold, today's 60k.
    expect(ceilingFor({ kind: "executor", warm: false }).ceiling).toBe(60_000);
  });

  it("sharedTokens counts what the chat holds of each file the text names, at most the file's size", () => {
    const checkout = mkdtempSync(join(tmpdir(), "shared-"));
    try {
      mkdirSync(join(checkout, "src"));
      writeFileSync(join(checkout, "src", "a.mjs"), "x".repeat(4000));
      writeFileSync(join(checkout, "src", "b.mjs"), "x".repeat(800));
      writeFileSync(join(checkout, "src", "c.mjs"), "x".repeat(4000));
      writeFileSync(join(checkout, "src", "d.mjs"), "x".repeat(4000));
      const seen = { "src/a.mjs": 300, "src/b.mjs": 5000, "src/gone.mjs": 100, "src/d.mjs": 900 };
      const text = "Change `src/a.mjs` and src/b.mjs, and src/gone.mjs; read src/c.mjs.";
      // a: 300 of its 1000 held; b: read whole, its 200; gone: missing; c: not
      // read; d: read, not named.
      expect(sharedTokens(text, seen, { checkout })).toBe(500);
      expect(sharedTokens(text, {}, { checkout })).toBe(0);
      expect(sharedTokens("Nothing named.", seen, { checkout })).toBe(0);
      // A root file by its bare name: 300 seen of its 200; a bare name with no file, nothing.
      writeFileSync(join(checkout, "NOTES.md"), "x".repeat(800));
      const root = { "NOTES.md": 300, "gone.md": 100 };
      expect(sharedTokens("Read NOTES.md.", root, { checkout })).toBe(200);
      expect(sharedTokens("Read gone.md.", root, { checkout })).toBe(0);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

/**
 * **The tool hook counts what the chat holds of each file**
 * (plans/shared-file-share.md, part 1; plans/shared-count-fixes.md, part 1):
 * `seenIn`, this call's map from the hook's own input, characters over four;
 * `noteSeen` appends it to the session's log and `seenOf` sums the log.
 */
describe("the tool hook counts what the chat holds of each file", () => {
  let checkout = "";
  beforeAll(() => {
    checkout = mkdtempSync(join(tmpdir(), "seen-"));
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "a.mjs"), "a\n");
    writeFileSync(join(checkout, "src", "b.mjs"), "b\n");
    writeFileSync(join(checkout, "CLAUDE.md"), "c\n");
  });
  afterAll(() => rmSync(checkout, { recursive: true, force: true }));
  const of = (input: object) => seenIn(input, { checkout });
  const chars = (n: number) => "x".repeat(n);

  it("a Read gives its text, an Edit its two strings, a MultiEdit its edits, a Write its content", () => {
    const read = of({
      tool_name: "Read",
      tool_input: { file_path: "src/a.mjs" },
      tool_response: { type: "text", file: { filePath: "src/a.mjs", content: chars(4000) } },
    });
    expect(read).toEqual({ "src/a.mjs": 1000 });
    // A response as plain text is counted as it is.
    expect(
      of({ tool_name: "Read", tool_input: { file_path: "src/a.mjs" }, tool_response: chars(400) }),
    ).toEqual({ "src/a.mjs": 100 });
    const edit = {
      tool_name: "Edit",
      tool_input: { file_path: "src/a.mjs", old_string: chars(400), new_string: chars(400) },
      tool_response: { originalFile: chars(100_000) },
    };
    expect(of(edit)).toEqual({ "src/a.mjs": 200 });
    const multi = {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "src/a.mjs",
        edits: [
          { old_string: chars(100), new_string: chars(300) },
          { old_string: chars(200), new_string: chars(200) },
        ],
      },
    };
    expect(of(multi)).toEqual({ "src/a.mjs": 200 });
    const write = {
      tool_name: "Write",
      tool_input: { file_path: "src/b.mjs", content: chars(2000) },
      tool_response: { filePath: "src/b.mjs", type: "create" },
    };
    expect(of(write)).toEqual({ "src/b.mjs": 500 });
  });

  it("seenOf sums the log's lines on one file, and passes over a line cut short", () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-log-"));
    try {
      const id = "sum";
      noteSeen(id, { "src/a.mjs": 200 }, dir);
      noteSeen(id, { "src/a.mjs": 300, "src/b.mjs": 50 }, dir);
      noteSeen(id, {}, dir);
      expect(readFileSync(seenFile(id, dir), "utf8").split("\n")).toHaveLength(4);
      appendFileSync(seenFile(id, dir), '{"p":"src/b.mj');
      expect(seenOf(id, dir)).toEqual({ "src/a.mjs": 500, "src/b.mjs": 50 });
      expect(seenOf("none", dir)).toEqual({});
      // Nothing to append, no file.
      noteSeen("empty", {}, dir);
      expect(existsSync(seenFile("empty", dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Bash command's output is split among the files of the checkout it names, and nothing else counts", () => {
    const bash = (command: string, stdout: string, stderr = "") => ({
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr, interrupted: false, isImage: false },
    });
    expect(of(bash("cat src/a.mjs src/b.mjs", chars(6000), chars(2000)))).toEqual({
      "src/a.mjs": 1000,
      "src/b.mjs": 1000,
    });
    expect(of(bash("npm test", chars(8000)))).toEqual({});
    // A folder, a ref and a file not there are passed over.
    expect(of(bash("ls src/ && git diff origin/test...HEAD src/gone.mjs", chars(800)))).toEqual({});
    expect(of(bash(`sed -n 1,9p ${join(checkout, "src", "a.mjs")}`, chars(400)))).toEqual({
      "src/a.mjs": 100,
    });
    // A root file by its bare name.
    expect(of(bash("cat CLAUDE.md", chars(400)))).toEqual({ "CLAUDE.md": 100 });
    expect(of({ tool_name: "Grep", tool_input: { path: "src/a.mjs" } })).toEqual({});
    // A relative path is the call's cwd's.
    mkdirSync(join(checkout, "src", "inner"), { recursive: true });
    writeFileSync(join(checkout, "src", "inner", "c.mjs"), "c\n");
    const inner = { ...bash("cat inner/c.mjs", chars(400)), cwd: join(checkout, "src") };
    expect(of(inner)).toEqual({ "src/inner/c.mjs": 100 });
  });

  it("a worktree's file counts under the path the plans name it by", () => {
    const tree = join(checkout, ".claude", "worktrees", "exec-1");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "a.mjs"), "a\n");
    const edit = (path: string) => ({
      tool_name: "Edit",
      cwd: tree,
      tool_input: { file_path: path, old_string: chars(200), new_string: chars(200) },
    });
    expect(of(edit(join(tree, "src", "a.mjs")))).toEqual({ "src/a.mjs": 100 });
    expect(of(edit("src/a.mjs"))).toEqual({ "src/a.mjs": 100 });
  });

  it("an absolute path inside the checkout counts under its relative path; one outside does not", () => {
    const outside = mkdtempSync(join(tmpdir(), "seen-out-"));
    try {
      writeFileSync(join(outside, "c.mjs"), "c\n");
      const read = (file_path: string) => ({
        tool_name: "Read",
        tool_input: { file_path },
        tool_response: { file: { content: chars(400) } },
      });
      expect(of(read(join(checkout, "src", "b.mjs")))).toEqual({ "src/b.mjs": 100 });
      expect(of(read(join(outside, "c.mjs")))).toEqual({});
      expect(of(read(join(checkout, "src")))).toEqual({});
      // An image or a PDF read is not text the chat holds.
      const image = {
        tool_name: "Read",
        tool_input: { file_path: "src/a.mjs" },
        tool_response: { type: "image", file: { base64: chars(40_000), type: "image/png" } },
      };
      expect(of(image)).toEqual({});
      const pdf = {
        tool_name: "Read",
        tool_input: { file_path: "src/a.mjs" },
        tool_response: { type: "pdf", file: { base64: chars(40_000) } },
      };
      expect(of(pdf)).toEqual({});
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("counts a response of 400 KB in under 50 ms", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cat src/a.mjs" },
      tool_response: { stdout: chars(400_000), stderr: "" },
    };
    const t0 = performance.now();
    const seen = of(input);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(seen).toEqual({ "src/a.mjs": 100_000 });
  });

  it("the executor's Stop hook says the share by what the chat holds, not the file's size", () => {
    const base = mkdtempSync(join(tmpdir(), "seen-stop-"));
    const ids: string[] = [];
    try {
      const dir = join(base, "checkout");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, "plans"));
      mkdirSync(join(dir, "test"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Held\nbranch: test\n---\n");
      // A 332 KB test file, 83k tokens whole.
      writeFileSync(join(dir, "test", "hooks.test.ts"), "x".repeat(332_000));
      writeFileSync(
        join(dir, "plans", "p.md"),
        "# P\n\nPlan only, 6 November 2026, for Javi.\n\nChanges `test/hooks.test.ts`.\n",
      );
      // Five executors' transcripts, measured into the summary the hook reads.
      const projects = join(base, "projects");
      const data = join(base, "data");
      const folder = transcriptsDir(dir, projects);
      mkdirSync(folder, { recursive: true });
      for (const name of ["a", "b", "c", "d", "e"])
        writeFileSync(
          join(folder, `${name}.jsonl`),
          [
            JSON.stringify({ type: "agent-setting", agentSetting: "workflow:executor" }),
            ...Array.from({ length: 80 }, (_, i) =>
              JSON.stringify({
                type: "assistant",
                timestamp: new Date(Date.parse("2026-11-01T10:00:00Z") + i * 60_000).toISOString(),
                message: {
                  id: `m${i}`,
                  model: "claude-opus-5-5",
                  usage: { input_tokens: 0, cache_creation_input_tokens: 50_000 + i * 1000 },
                },
              }),
            ),
            "",
          ].join("\n"),
        );
      const inputs = reuseInputs({
        refresh: true,
        dir: folder,
        file: join(data, "reuse", `${basename(folder)}.json`),
      });
      // Under the ceiling with nothing shared, so both stops name the plan with why.
      const context = ceilingFor({ kind: "executor", inputs }).ceiling - 1000;
      const transcript = join(base, "t.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { model: "claude-opus-5-5", usage: { input_tokens: context } },
        })}\n`,
      );
      const stop = (seen?: Record<string, number>[]) => {
        const id = `seen-stop-${ids.length}-${process.pid}`;
        ids.push(id);
        writeFileSync(
          join(tmpdir(), `workflow-queue-${id}.json`),
          JSON.stringify({ agent: "executor" }),
        );
        // The log's lines, as the tool hooks appended them.
        for (const map of seen || []) noteSeen(id, map);
        return execFileSync("node", [join(here, "plan-queue.mjs"), "stop"], {
          input: JSON.stringify({
            session_id: id,
            agent_type: "executor",
            transcript_path: transcript,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_LIVE: "[]",
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_DATA: data,
          },
        });
      };
      const held = stop([{ "test/hooks.test.ts": 5_000 }, { "test/hooks.test.ts": 8_000 }]);
      expect(held).toContain("can take them: plans/p.md");
      expect(held).toContain("13k shared");
      expect(held).not.toContain("83k shared");
      expect(stop()).toContain("0k shared");
    } finally {
      rmSync(base, { recursive: true, force: true });
      for (const id of ids)
        for (const file of [`workflow-queue-${id}.json`, `workflow-seen-${id}.jsonl`])
          rmSync(join(tmpdir(), file), { force: true });
    }
  });

  describe("the tool hooks", () => {
    const made: string[] = [];
    afterAll(() => {
      for (const path of made) rmSync(path, { recursive: true, force: true });
    });
    const project = () => {
      const dir = mkdtempSync(join(tmpdir(), "seen-hook-"));
      made.push(dir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Seen\nbranch: test\n---\n");
      writeFileSync(join(dir, "src", "a.mjs"), "a\n");
      return dir;
    };
    const stateOf = (id: string) => {
      const file = join(tmpdir(), `workflow-queue-${id}.json`);
      made.push(file);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    };
    const logOf = (id: string) => {
      made.push(seenFile(id));
      return existsSync(seenFile(id)) ? seenOf(id) : null;
    };
    const env = (dir: string) => ({ ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "[]" });
    const wrote = (dir: string, input: object) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "wrote"], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: env(dir),
      });
    const seen = (dir: string, input: object) =>
      execFileSync("node", [join(here, "seen.mjs")], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: env(dir),
      });
    const bash = { tool_name: "Bash", tool_input: { command: "cat src/a.mjs" } };
    const out = { tool_response: { stdout: "x".repeat(4000), stderr: "" } };
    const reading = (file_path: string, n = 4000) => ({
      tool_name: "Read",
      tool_input: { file_path },
      tool_response: { type: "text", file: { content: "x".repeat(n) } },
    });

    it("a planner's Read appends a line to its log; an assistant's and a subagent's append none", () => {
      const dir = project();
      const id = (who: string) => `seen-${who}-${process.pid}`;
      const read = reading("src/a.mjs");
      expect(
        seen(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...read }),
      ).toBe("");
      expect(readFileSync(seenFile(id("planner")), "utf8")).toBe(
        `${JSON.stringify({ p: "src/a.mjs", t: 1000 })}\n`,
      );
      expect(logOf(id("planner"))).toEqual({ "src/a.mjs": 1000 });
      seen(dir, { session_id: id("assistant"), agent_type: "workflow:assistant", ...read });
      expect(logOf(id("assistant"))).toBeNull();
      seen(dir, { session_id: id("explore"), agent_type: "Explore", ...read });
      expect(logOf(id("explore"))).toBeNull();
      expect(stateOf(id("explore"))).toBeNull();
    });

    it("a planner's Bash through the wrote hook appends its lines and never writes the state", () => {
      const dir = project();
      const id = (who: string) => `seen-wrote-${who}-${process.pid}`;
      wrote(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...bash, ...out });
      wrote(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...bash, ...out });
      expect(logOf(id("planner"))).toEqual({ "src/a.mjs": 2000 });
      // The count never writes the state, so it never writes back over a field set meanwhile.
      expect(stateOf(id("planner"))?.seen).toBeUndefined();
      wrote(dir, {
        session_id: id("assistant"),
        agent_type: "workflow:assistant",
        ...bash,
        ...out,
      });
      expect(logOf(id("assistant"))).toBeNull();
      wrote(dir, { session_id: id("explore"), agent_type: "Explore", ...bash, ...out });
      expect(logOf(id("explore"))).toBeNull();
    });

    it("parallel tool hooks lose no count", async () => {
      const dir = project();
      const id = `seen-parallel-${process.pid}`;
      const names = Array.from({ length: 8 }, (_, i) => `src/f${i}.mjs`);
      for (const name of names) writeFileSync(join(dir, name), "x".repeat(4000));
      const run = (input: object) =>
        new Promise<void>((done, fail) => {
          const child = execFile("node", [join(here, "seen.mjs")], { env: env(dir) }, (error) =>
            error ? fail(error) : done(),
          );
          child.stdin?.end(JSON.stringify(input));
        });
      await Promise.all(
        names.map((name) =>
          run({ session_id: id, agent_type: "workflow:planner", ...reading(name) }),
        ),
      );
      expect(logOf(id)).toEqual(Object.fromEntries(names.map((name) => [name, 1000])));
    });

    it("a Read counts and takes nothing: no Building line is taken until the plan is edited", () => {
      const dir = project();
      const id = `seen-read-${process.pid}`;
      const plan = join(dir, "plans", "p.md");
      writeFileSync(
        plan,
        `# P\n\n## Building, 6 November 2026, session ${id}\n\nShort plan, 6 November 2026.\n`,
      );
      const read = { session_id: id, agent_type: "executor", ...reading(plan, 400) };
      expect(seen(dir, read)).toBe("");
      expect(logOf(id)).toEqual({ "plans/p.md": 100 });
      expect(stateOf(id)).toBeNull();
      // The same file edited is taken.
      wrote(dir, {
        ...read,
        tool_name: "Edit",
        tool_input: { file_path: plan, old_string: "a", new_string: "b" },
      });
      expect(stateOf(id).held).toEqual(["plans/p.md"]);
    });

    it("a Read of 400 KB costs a bare node start, and a 400 KB Bash response under 100 ms more than none", () => {
      const dir = project();
      const id = `seen-time-${process.pid}`;
      const best = (run: () => unknown) =>
        Math.min(
          ...[1, 2, 3, 4, 5].map(() => {
            const t0 = performance.now();
            run();
            return performance.now() - t0;
          }),
        );
      const node = best(() => execFileSync("node", ["-e", ""]));
      const read = best(() =>
        seen(dir, {
          session_id: id,
          agent_type: "workflow:planner",
          ...reading("src/a.mjs", 400_000),
        }),
      );
      // The wrote hook on the same output, with and without a file named: node,
      // the script's load and the stdin's parse, which every hook pays already.
      const bash = (command: string) => ({
        session_id: id,
        agent_type: "workflow:planner",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "x".repeat(400_000), stderr: "" },
      });
      const bare = best(() => wrote(dir, bash("npm test")));
      const counted = best(() => wrote(dir, bash("cat src/a.mjs")));
      // Five Reads and five Bash runs, each adding the output's 100k tokens.
      expect(logOf(id)).toEqual({ "src/a.mjs": 1_000_000 });
      console.log(
        `seen.mjs on a 400 KB Read ${Math.round(read)} ms, node -e '' ${Math.round(node)} ms; wrote hook ${Math.round(counted)} ms counting, ${Math.round(bare)} ms not`,
      );
      expect(read - node).toBeLessThan(60);
      expect(counted - bare).toBeLessThan(100);
    });
  });
});

/** **The cost report** (plans/reuse-ceiling-per-agent.md, part 6): `plans cost`'s numbers. */
describe("the cost report", () => {
  const turn = (id: string, at: string, u: object, extra: object = {}) =>
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: { id, model: "claude-fable-5-1-20261001", usage: u },
      ...extra,
    });

  it("measures each transcript's main thread and prices it by agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cost-"));
    try {
      // A planner: two turns, the second written twice (one message id), a
      // sidechain turn to skip, a synthetic one to skip, one compaction.
      writeFileSync(
        join(dir, "planner-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:planner" }),
          turn("m1", "2026-11-01T10:00:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 0,
            output_tokens: 1000,
          }),
          // The turn's first entry, its output still streaming: the last entry counts.
          turn("m2", "2026-11-01T10:05:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 150_000,
            cache_read_input_tokens: 50_000,
            output_tokens: 7,
          }),
          turn("m2", "2026-11-01T10:05:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 150_000,
            cache_read_input_tokens: 50_000,
            output_tokens: 2000,
          }),
          turn(
            "side",
            "2026-11-01T10:06:00Z",
            { input_tokens: 0, cache_creation_input_tokens: 999_999, output_tokens: 1 },
            { isSidechain: true },
          ),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-01T10:07:00Z",
            message: { id: "syn", model: "<synthetic>", usage: { input_tokens: 0 } },
          }),
          JSON.stringify({ type: "system", subtype: "compact_boundary" }),
          "",
        ].join("\n"),
      );
      // An executor on Opus: one turn.
      writeFileSync(
        join(dir, "executor-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:executor" }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-02T09:00:00Z",
            message: {
              id: "e1",
              model: "claude-opus-5-5",
              usage: {
                input_tokens: 0,
                cache_creation_input_tokens: 100_000,
                cache_read_input_tokens: 150_000,
                output_tokens: 5000,
              },
            },
          }),
          "",
        ].join("\n"),
      );
      // An older chat with no agent, and an unknown model.
      writeFileSync(
        join(dir, "chat-1.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-10-20T09:00:00Z",
          message: { id: "c1", model: "claude-other-1", usage: { input_tokens: 1_000_000 } },
        })}\n`,
      );
      const rows = measure(dir);
      expect(rows.map((row: { id: string }) => row.id)).toEqual([
        "chat-1",
        "planner-1",
        "executor-1",
      ]);
      expect(rows[1]).toMatchObject({
        agent: "workflow:planner",
        turns: 2,
        maxContext: 200_000,
        endContext: 200_000,
        write: 200_000,
        read: 50_000,
        output: 3000,
        compactions: 1,
      });
      const lines = costWords(rows, {
        reuse: {
          executor: { warm: { ceiling: 200_000 } },
          planner: { warm: { ceiling: 160_000 } },
        },
        machine: "wp",
        dir: "~/.claude/projects/x",
      });
      expect(lines[0]).toBe(
        "Cost of this queue's sessions on wp since 20 October 2026 (3 transcripts in ~/.claude/projects/x), at the prices read on 5 November 2026 from platform.claude.com/docs/en/about-claude/pricing: Fable 5.1 $10 input, $20 one-hour cache write, $0.25 cache read, $50 output a million tokens; Opus 5.5 $4, $8, $0.20, $20.",
      );
      // Planner: writes 200k x $20 = $4, reads 50k x $0.25 = $0.0125, output 3k x $50 = $0.15.
      expect(lines[1]).toBe(
        "Planners: 1 session, median 2 turns, median context at the end 200k, 1 ended over 160k, 1 compacted; $4.16, cache writes 96%, output 4%, cache reads 0%.",
      );
      // Executor: writes 100k x $8 = $0.80, reads 150k x $0.20 = $0.03, output 5k x $20 = $0.10.
      expect(lines[2]).toBe(
        "Executors: 1 session, median 1 turns, median context at the end 250k, 1 ended over 200k, none compacted; $0.93, cache writes 86%, output 11%, cache reads 3%.",
      );
      expect(lines[3]).toBe(
        "Other: 1 session (no agent setting); $4.00 (claude-other-1 priced as Opus 5.5).",
      );
      // Each turn at its own model's prices (Codex C2): $10 on Fable, then $4 on Opus.
      writeFileSync(
        join(dir, "switched-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:assistant" }),
          turn("s1", "2026-11-03T09:00:00Z", { input_tokens: 1_000_000 }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-03T09:05:00Z",
            message: { id: "s2", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } },
          }),
          "",
        ].join("\n"),
      );
      expect(costWords(measure(dir, { since: "2026-11-03" }))[1]).toBe(
        "Assistants: 1 session, median 2 turns, median context at the end 1000k, none compacted; $14, input 100%, cache writes 0%, output 0%.",
      );
      // With history, the inputs the ceiling is worked out from, after the agent's line.
      const worked = costWords(rows, {
        reuse: {
          planner: {
            sessions: 21,
            start: 35_000,
            turns: 70,
            warm: ceilingFor({
              kind: "planner",
              inputs: {
                planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
              },
            }),
            cold: ceilingFor({
              kind: "planner",
              warm: false,
              inputs: {
                planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
              },
            }),
          },
        },
      });
      expect(worked[1]).toContain("1 ended over 75k");
      expect(worked[2]).toBe(
        "Reuse inputs: fresh start 35k (median first turn of 21 sessions), 70 turns; the ceiling is 75k warm and 35k cold at Fable 5.1 prices, capped at 480k.",
      );
      // Without history, no inputs line.
      expect(lines.some((line: string) => line.startsWith("Reuse inputs"))).toBe(false);
      // Since a day: the older chat is left out.
      expect(measure(dir, { since: "2026-11-01" })).toHaveLength(3);
      expect(
        costWords(measure(dir, { since: "2026-11-02" }), { since: "2026-11-02" })[0],
      ).toContain("since 2 November 2026 (2 transcripts)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      writeFileSync(stateFile(tired), JSON.stringify({ agent: "executor" }));
      const transcript = join(dir, "tired.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } },
        })}\n`,
      );
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
        const said = queue(["stop"], {
          session_id: tired,
          agent_type: "executor",
          transcript_path: transcript,
        });
        expect(said).toContain("Retired: its context is 250k tokens");
        expect(logged()).toEqual([expect.stringMatching(new RegExp(`^end ${tired} at `))]);
        expect(JSON.parse(readFileSync(stateFile(tired), "utf8")).retired).toBe(true);
      } finally {
        rmSync(stateFile(tired), { force: true });
        rmSync(transcript, { force: true });
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
    // A planned plan (plans/plans-as-github-issues.md) asks as a ready one does (/code-review).
    const planned = stateOf(asks.replace("builds it.\n", "builds it.\n\nIssue: #12.\n"));
    expect(planned).toMatchObject({ state: "planned", asks: true });
    expect(askingIn({ path: "plans/asks.md", ...planned }, [row], options(5))).toMatchObject({
      until: now + 25 * MIN,
    });
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

  it("plannerContext says how long the plan is held", () => {
    const texts: Record<string, string> = { "plans/asks.md": asks };
    const within = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(5),
    );
    expect(within).toBe(
      `plans/asks.md is in the queue and still yours. It asks Javi until ${hhmm(now + 25 * MIN)}.`,
    );
    const past = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(40),
    );
    expect(past).toBe(
      "plans/asks.md is in the queue and still yours. Its question went unanswered for thirty minutes.",
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

    /**
     * **A dropped plan is never started** (plans/dropped-plan-state.md): left
     * out with no path, refused by path, dropped by a timer, and out of the
     * asking deferral the moment the planner writes the section.
     */
    it("a dropped plan is never started, and its drop takes it out of the asking deferral", () => {
      const file = join(dir, "plans", "dropped.md");
      writeFileSync(
        file,
        `${asks.replace("# X", "# Dropped")}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`,
      );
      try {
        expect(start()).not.toContain("plans/dropped.md");
        expect(start("plans/dropped.md").trim()).toBe(
          "plans/dropped.md is dropped (30 October 2026): nothing to build.",
        );
        // Refused whole, with another plan beside it.
        expect(start("plans/plain.md", "plans/dropped.md")).not.toContain("Would run");
        // The same path in another spelling (Codex, 30 October).
        for (const spelled of ["./plans/dropped.md", file])
          expect(start(spelled).trim(), spelled).toBe(
            "plans/dropped.md is dropped (30 October 2026): nothing to build.",
          );
        const timer = execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(["plans/dropped.md"], { dry: true, timer: true }));`,
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
        expect(timer.trim()).toBe("Nothing is waiting in the queue.");
        writeFileSync(
          deferredFile(),
          JSON.stringify({
            until: Date.now() + 30 * MIN,
            why: "Javi has thirty minutes to answer",
            paths: ["plans/dropped.md", "plans/asks.md"],
            pid: null,
          }),
        );
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:planner",
          tool_name: "Edit",
          tool_input: { file_path: file },
        });
        expect(JSON.parse(readFileSync(deferredFile(), "utf8")).paths).toEqual(["plans/asks.md"]);
        // The assistant drops a plan too: its write takes it out the same way (/code-review).
        writeFileSync(
          deferredFile(),
          JSON.stringify({
            until: Date.now() + 30 * MIN,
            why: "w",
            paths: ["plans/dropped.md", "plans/asks.md"],
            pid: null,
          }),
        );
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:assistant",
          tool_name: "Edit",
          tool_input: { file_path: "plans/dropped.md" },
        });
        expect(JSON.parse(readFileSync(deferredFile(), "utf8")).paths).toEqual(["plans/asks.md"]);
        // An executor's Building line on it is refused, with the start's words (/code-review).
        const building = queue(["tool"], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Edit",
          tool_input: {
            file_path: file,
            old_string: "# Dropped\n",
            new_string: `# Dropped\n\n## Building, 30 October 2026, session ${ids.exec}\n`,
          },
        });
        expect(JSON.parse(building).hookSpecificOutput.permissionDecisionReason).toBe(
          "plans/dropped.md is dropped (30 October 2026): nothing to build.",
        );
      } finally {
        rmSync(deferredFile(), { force: true });
        rmSync(file, { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
    });

    // plans/plans-as-github-issues.md, part 3: a planned plan waits for Ready.
    it("a planned plan is skipped by the default pick, refused by path and listed with its issue", () => {
      const file = join(dir, "plans", "planned.md");
      const planned = `${head.replace("# ", "# Planned ")}\nIssue: #12.\n\n## What was asked\n`;
      writeFileSync(file, planned);
      const words =
        'plans/planned.md is planned and waits on GitHub (#12): it is built once the issue is labelled status: ready, or Javi says so in the assistant\'s chat, which writes its "Ready" section.';
      try {
        expect(start()).not.toContain("plans/planned.md");
        expect(start("plans/planned.md").trim()).toBe(words);
        expect(start("plans/plain.md", "plans/planned.md")).not.toContain("Would run");
        const out = queue(["list"]);
        expect(out).toMatch(
          /\nPlanned, waiting on GitHub\n {2}plans\/planned\.md +#12, since \d+ [A-Z][a-z]+\n/,
        );
        expect(out.slice(out.indexOf("Ready, oldest first"))).not.toContain("plans/planned.md");
        // An executor's Building line on it is refused, with the start's words.
        const building = queue(["tool"], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Write",
          tool_input: {
            file_path: file,
            content: planned.replace(
              "\n## What was asked",
              `\n## Building, 3 November 2026, session ${ids.exec}\n\n## What was asked`,
            ),
          },
        });
        expect(JSON.parse(building).hookSpecificOutput.permissionDecisionReason).toBe(words);
        // Ready on GitHub: it is a plan like any other.
        writeFileSync(
          file,
          `${planned}\n## Ready, 4 November 2026\n\nReady on GitHub, 4 November.\n`,
        );
        expect(start("plans/planned.md")).toContain("Would run");
      } finally {
        rmSync(file, { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
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
        expect(out).toContain("Build plans/asks.md.");
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
        expect(timerStart(["plans/built.md", "plans/older.md"])).toContain("Build plans/older.md.");
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

// plans/plans-as-github-issues.md, part 1: the queue writes on GitHub as the project's own app.
describe("github-app", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs a JWT with RS256, issued by the app's id, ending ten minutes out", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const jwt = appJwt("123", pem, now);
    const [head, body, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 600, iss: "123" });
    expect(
      createVerify("RSA-SHA256")
        .update(`${head}.${body}`)
        .verify(publicKey, signature, "base64url"),
    ).toBe(true);
    // A key whose line ends came as `\n` escapes signs the same.
    expect(appJwt("123", pem.replace(/\n/g, "\\n"), now)).toBe(jwt);
  });

  it("reads the repository from a GitHub remote, https or ssh", () => {
    expect(repoOfRemote("https://github.com/o/r.git\n")).toBe("o/r");
    expect(repoOfRemote("git@github.com:o/r")).toBe("o/r");
    expect(repoOfRemote("https://example.org/o/r.git")).toBeNull();
  });
});

describe("plans gh", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const env = { PATH: process.env.PATH || "", WORKFLOW_APP_ID: "123", WORKFLOW_APP_KEY: pem };
  const now = Date.UTC(2026, 10, 3, 12);
  /** GitHub, as far as the token goes: the calls counted, each token an hour long from `now`. */
  const github = () => {
    const calls: string[] = [];
    const fetch = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const body = url.endsWith("/installation")
        ? { id: 77 }
        : { token: `t${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() };
      return { ok: true, status: 200, json: async () => body };
    };
    return { calls, fetch };
  };
  /** `gh`, as far as its calls go: their words and the token each was given. */
  const gh = () => {
    const runs: { args: string[]; token?: string }[] = [];
    const run = (_bin: string, args: string[], options: { env?: Record<string, string> }) => {
      runs.push({ args, token: options.env?.GH_TOKEN });
      return { status: 0, stdout: "", stderr: "" };
    };
    return { runs, run };
  };
  const cache = () => join(mkdtempSync(join(tmpdir(), "app-token-")), "app-token.json");

  it("with no app here, says what to register and runs nothing", async () => {
    const { runs, run } = gh();
    const { calls, fetch } = github();
    const done = await ghCommand(["issue", "list"], {
      env: { PATH: env.PATH },
      run,
      fetch,
      repo: "o/r",
      cacheFile: cache(),
    });
    expect(done).toEqual({
      said: "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues and Pull requests read and write), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      status: 1,
    });
    expect(runs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("in a container setup made, names the host's file and the rebuild", () => {
    const mounted = { WORKFLOW_SECRETS_FILE: "/run/secrets/workflow.env" };
    expect(noAppWords("o/r", mounted, "Docs")).toBe(
      "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues and Pull requests read and write), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY in ~/.config/workflow/docs.env on the host, then rebuild the container.",
    );
    expect(noSecretWords(mounted, "Docs")).toBe(
      "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT in ~/.config/workflow/docs.env on the host, then rebuild the container.",
    );
    expect(noAppWords("o/r", mounted, "My Docs")).toContain("~/.config/workflow/my-docs.env");
  });

  it("with any other secrets file, says where GH_TOKEN is set as before", () => {
    const other = { WORKFLOW_SECRETS_FILE: ".secrets/workflow.env" };
    expect(noAppWords("o/r", other, "Docs")).toBe(
      "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues and Pull requests read and write), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
    );
    expect(noSecretWords(other, "Docs")).toBe(
      "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
    );
  });

  it("refuses gh pr ready as the hook does, and allows --undo", async () => {
    const { runs, run } = gh();
    const { fetch } = github();
    const options = { env, run, fetch, repo: "o/r", now, cacheFile: cache() };
    const refused = await ghCommand(["pr", "ready", "12"], options);
    expect(refused.status).toBe(1);
    expect(refused.said).toContain("never an agent's");
    expect(runs).toEqual([]);
    expect(await ghCommand(["pr", "ready", "--undo", "12"], options)).toEqual({
      said: "",
      status: 0,
    });
    expect(runs).toEqual([{ args: ["pr", "ready", "--undo", "12"], token: "t2" }]);
    // The tool hook reads `plans gh` as `gh`.
    expect(marksReady("plans gh pr ready 12")).toBe(true);
    expect(marksReady("plans gh pr ready --undo 12")).toBe(false);
  });

  it("mints the token once and reuses it until five minutes before it ends", async () => {
    const { runs, run } = gh();
    const { calls, fetch } = github();
    const cacheFile = cache();
    const at = (minutes: number) => ({
      env,
      run,
      fetch,
      repo: "o/r",
      cacheFile,
      now: now + minutes * 60_000,
    });
    await ghCommand(["issue", "list"], at(0));
    await ghCommand(["issue", "list"], at(30));
    await ghCommand(["issue", "list"], at(54));
    expect(calls).toEqual([
      "GET /repos/o/r/installation",
      "POST /app/installations/77/access_tokens",
    ]);
    await ghCommand(["issue", "list"], at(56));
    expect(calls).toHaveLength(4);
    expect(runs.map((one) => one.token)).toEqual(["t2", "t2", "t2", "t4"]);
    // Another repository's token is never reused.
    await ghCommand(["issue", "list"], { ...at(57), repo: "o/other" });
    expect(calls).toHaveLength(6);
  });

  it("says GitHub's answer when no token can be minted", async () => {
    const { runs, run } = gh();
    const fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    });
    const done = await ghCommand(["issue", "list"], {
      env,
      run,
      fetch,
      repo: "o/r",
      now,
      cacheFile: cache(),
    });
    expect(done).toEqual({
      said: "The project's Claude could not get a token from GitHub: GET /repos/o/r/installation answered 404: Not Found.",
      status: 1,
    });
    expect(runs).toEqual([]);
  });

  it("says so when gh cannot be run", async () => {
    const { fetch } = github();
    const run = () => ({ status: null, error: new Error("spawnSync gh ENOENT") });
    expect(
      await ghCommand(["issue", "list"], { env, run, fetch, repo: "o/r", now, cacheFile: cache() }),
    ).toEqual({ said: "The project's Claude could not run gh: spawnSync gh ENOENT.", status: 1 });
  });

  it("as a command, prints the refusal and starts no gh", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "gh-ran-")), "ran");
    const fake = join(mkdtempSync(join(tmpdir(), "fake-gh-")), "gh");
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(fake, 0o755);
    const done = spawnSync("node", [join(here, "plan-queue.mjs"), "gh", "issue", "list"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || "", WORKFLOW_ROOT: repo, WORKFLOW_GH: fake },
    });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/^The project's Claude has no GitHub App here: /);
    expect(existsSync(marker)).toBe(false);
  });
});

// plans/secrets-from-a-file.md: the app's key and the webhook's secret from a private file.
describe("secrets from a file", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const names = ["WORKFLOW_APP_ID", "WORKFLOW_APP_KEY", "WORKFLOW_WEBHOOK_SECRET"];
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "secrets-")), "workflow.env");
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it("reads the app's id, key and the webhook's secret from the file when the environment has none", () => {
    const path = file(
      `# The queue's secrets\nexport WORKFLOW_APP_ID=123 # the app's\nWORKFLOW_APP_KEY="${pem}"\nWORKFLOW_WEBHOOK_SECRET='s3 cret' # the webhook's\n`,
    );
    const env = { PATH: "", WORKFLOW_SECRETS_FILE: path };
    expect(secret("WORKFLOW_APP_ID", env)).toBe("123");
    expect(secret("WORKFLOW_APP_KEY", env)).toBe(pem);
    expect(secret("WORKFLOW_WEBHOOK_SECRET", env)).toBe("s3 cret");
    // A value that begins with `#` is the value, as Compose reads it.
    const hashed = file("WORKFLOW_WEBHOOK_SECRET=#Xk9#2\n");
    expect(secret("WORKFLOW_WEBHOOK_SECRET", { WORKFLOW_SECRETS_FILE: hashed })).toBe("#Xk9#2");
  });

  it("reads a relative path from the checkout's root, wherever the command runs", () => {
    const checkout = mkdtempSync(join(tmpdir(), "secrets-root-"));
    mkdirSync(join(checkout, ".devcontainer"));
    writeFileSync(join(checkout, ".devcontainer", "workflow.env"), "WORKFLOW_APP_ID=123\n");
    const source = `import { secret } from ${JSON.stringify(join(here, "plan-queue.mjs"))}; process.stdout.write(secret("WORKFLOW_APP_ID"));`;
    const done = spawnSync("node", ["--input-type=module", "-e", source], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        WORKFLOW_ROOT: checkout,
        WORKFLOW_SECRETS_FILE: ".devcontainer/workflow.env",
      },
    });
    rmSync(checkout, { recursive: true, force: true });
    expect(done.stdout).toBe("123");
  });

  it("reads a key spanning lines in one double-quoted value whole, and a key with \\n escapes signs the same", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const spanning = file(`WORKFLOW_APP_KEY="${pem}"\nWORKFLOW_APP_ID=123\n`);
    const escaped = file(`WORKFLOW_APP_KEY=${pem.replace(/\n/g, "\\n")}\n`);
    const quoted = file(`WORKFLOW_APP_KEY="${pem.replace(/\n/g, "\\n")}"\n`);
    const key = (path: string) => secret("WORKFLOW_APP_KEY", { WORKFLOW_SECRETS_FILE: path });
    expect(key(spanning)).toBe(pem);
    expect(secret("WORKFLOW_APP_ID", { WORKFLOW_SECRETS_FILE: spanning })).toBe("123");
    expect(appJwt("123", key(escaped), now)).toBe(appJwt("123", pem, now));
    expect(appJwt("123", key(quoted), now)).toBe(appJwt("123", pem, now));
  });

  it("lets a name set in the environment win over the file", () => {
    const path = file("WORKFLOW_APP_ID=123\nWORKFLOW_WEBHOOK_SECRET=from-file\n");
    const env = { WORKFLOW_SECRETS_FILE: path, WORKFLOW_APP_ID: "456" };
    expect(secret("WORKFLOW_APP_ID", env)).toBe("456");
    expect(secret("WORKFLOW_WEBHOOK_SECRET", env)).toBe("from-file");
  });

  it("reads a missing or unreadable file as unset, and the refusals name the file", async () => {
    const missing = join(tmpdir(), "no-such-secrets.env");
    const unreadable = file("WORKFLOW_APP_ID=123\n");
    chmodSync(unreadable, 0o000);
    // Root reads a file whatever its mode, so the unreadable one counts only for others.
    const asRoot = process.getuid?.() === 0;
    const folder = mkdtempSync(join(tmpdir(), "secrets-dir-"));
    for (const path of [missing, folder, ...(asRoot ? [] : [unreadable])]) {
      for (const name of names) expect(secret(name, { WORKFLOW_SECRETS_FILE: path })).toBe("");
    }
    const ran: string[][] = [];
    const done = await ghCommand(["issue", "list"], {
      env: { PATH: "", WORKFLOW_SECRETS_FILE: missing },
      run: (_bin: string, args: string[]) => {
        ran.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      repo: "o/r",
    });
    expect(done).toEqual({
      said: "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues and Pull requests read and write), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      status: 1,
    });
    expect(ran).toEqual([]);
  });

  it("plans gh mints from the file's key and leaves none of the three in process.env", async () => {
    const path = file(
      `WORKFLOW_APP_ID=123\nWORKFLOW_APP_KEY="${pem}"\nWORKFLOW_WEBHOOK_SECRET=s3cret\n`,
    );
    const before = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    const now = Date.UTC(2026, 10, 6, 12);
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/installation")
          ? { id: 77 }
          : { token: "t", expires_at: new Date(now + 3600_000).toISOString() },
    });
    const runs: Record<string, string>[] = [];
    try {
      const done = await ghCommand(["issue", "list"], {
        env: { ...process.env, WORKFLOW_SECRETS_FILE: path },
        run: (_bin: string, _args: string[], options: { env: Record<string, string> }) => {
          runs.push(options.env);
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch,
        repo: "o/r",
        now,
        cacheFile: join(mkdtempSync(join(tmpdir(), "app-token-")), "app-token.json"),
      });
      expect(done).toEqual({ said: "", status: 0 });
      expect(runs[0].GH_TOKEN).toBe("t");
      for (const name of names) {
        expect(process.env[name]).toBeUndefined();
        expect(runs[0][name]).toBeUndefined();
      }
    } finally {
      names.forEach((name, i) => {
        if (before[i] !== undefined) process.env[name] = before[i];
      });
    }
  });
});

// plans/github-watched.md: what people write on GitHub reaches the queue on its own.
describe("github webhook", () => {
  const sign = (secret: string, body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("verifyDelivery accepts a body signed with the secret and refuses a wrong one, none and sha1", () => {
    const body = '{"zen":"Keep it logically awesome."}';
    expect(verifyDelivery("s3cret", body, sign("s3cret", body))).toBe(true);
    expect(verifyDelivery("s3cret", body, sign("other", body))).toBe(false);
    expect(verifyDelivery("s3cret", `${body} `, sign("s3cret", body))).toBe(false);
    expect(verifyDelivery("s3cret", body, undefined)).toBe(false);
    const sha1 = `sha1=${createHmac("sha1", "s3cret").update(body).digest("hex")}`;
    expect(verifyDelivery("s3cret", body, sha1)).toBe(false);
    expect(verifyDelivery("", body, sign("", body))).toBe(false);
  });

  const at = (minute: number) => `2026-11-03T21:${String(minute).padStart(2, "0")}:00Z`;
  const user = (login: string) => ({ login });
  const deliveries: [string, string, object][] = [
    [
      "d1",
      "issues",
      {
        action: "labeled",
        label: { name: "status: planning" },
        issue: {
          number: 20,
          title: "Reorder",
          labels: [{ name: "status: planning" }],
          updated_at: at(1),
          html_url: "u20",
        },
        sender: user("henry"),
      },
    ],
    [
      "d2",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: {
          body: "@docs-claude can this also keep the order on the phone?",
          user: user("henry"),
          created_at: at(2),
          html_url: "c2",
        },
      },
    ],
    [
      "d3",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: { body: "Nice!", user: user("reader"), created_at: at(3), html_url: "c3" },
      },
    ],
    [
      "d4",
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 40, title: "Series", head: { ref: "series-order" }, labels: [] },
        comment: { body: "Rename this.", user: user("anton"), created_at: at(4), html_url: "r4" },
      },
    ],
    [
      "d5",
      "pull_request",
      {
        action: "closed",
        pull_request: {
          number: 41,
          title: "Small",
          merged: true,
          merged_at: at(5),
          body: "For #12.\n\n## Changes\n",
          head: { ref: "x" },
          labels: [],
        },
        sender: user("javi"),
      },
    ],
    [
      "d6",
      "issues",
      {
        action: "labeled",
        label: { name: "status: ready" },
        issue: {
          number: 12,
          title: "Series",
          labels: [{ name: "status: ready" }],
          updated_at: at(6),
        },
        sender: user("anton"),
      },
    ],
    [
      "d7",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: {
          body: "Answered from the plan.",
          user: user("docs-claude[bot]"),
          created_at: at(7),
        },
      },
    ],
  ];
  const items = deliveries.flatMap(([id, event, payload]) => itemsOfDelivery(event, payload, id));
  const seen = {
    deliveries: [],
    issues: {},
    pulls: {},
    permissions: { henry: "write", anton: "write", javi: "admin", reader: "read" },
    readAt: "",
  };
  const context = {
    carried: [12],
    planned: [12],
    own: [40, "series-order"],
    slug: "docs-claude",
  };

  it("githubEvents returns the five events of seven deliveries, none for a reader's or the app's", () => {
    const { events } = githubEvents(seen, items, context);
    expect(events.map((one) => [one.kind, one.number, one.by])).toEqual([
      ["plan", 20, "henry"],
      ["mention", 12, "henry"],
      ["review", 40, "anton"],
      ["merged", 12, "javi"],
      ["ready", 12, "anton"],
    ]);
    expect(events[3]).toMatchObject({ pull: 41 });
    // The same delivery twice is one event: GitHub's redelivery is safe.
    const twice = githubEvents(seen, [items[1], items[1]], context);
    expect(twice.events).toHaveLength(1);
    expect(githubEvents(twice.seen, [items[1]], context).events).toEqual([]);
  });

  it("an issue opened with the planning label is one plan event, and a read's label counts once", () => {
    const issue = {
      number: 21,
      title: "New",
      labels: [{ name: "status: planning" }],
      created_at: at(8),
      updated_at: at(8),
    };
    const both = [
      ...itemsOfDelivery(
        "issues",
        { action: "opened", issue: { ...issue, user: user("henry") } },
        "o1",
      ),
      ...itemsOfDelivery(
        "issues",
        { action: "labeled", label: { name: "status: planning" }, issue, sender: user("henry") },
        "o2",
      ),
    ];
    const first = githubEvents(seen, both, context);
    expect(first.events.map((one) => one.kind)).toEqual(["plan"]);
    expect(first.seen.labeled).toEqual(["21:status: planning"]);
  });

  it("notesWaiting lists the notes with an event after their last Handled line, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    writeFileSync(
      join(dir, "12.md"),
      "# GitHub #12: S\n\nmention, 3 November 2026 21:02, by henry (write): u\n",
    );
    writeFileSync(
      join(dir, "13.md"),
      "# GitHub #13: S\n\ncomment, 3 November 2026 21:02, by henry (write): u\n\n## Handled, 3 November 2026, session x\n",
    );
    expect(notesWaiting(dir)).toEqual(["plans/github/12.md"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("noteFor writes the note's heading once, then the event and its text indented", () => {
    const { events } = githubEvents(seen, [items[1]], context);
    const note = noteFor(events[0], { first: true });
    expect(note).toMatch(
      /^# GitHub #12: Series\n\nmention, 3 November 2026 \d\d:02, by henry \(write\): c2\n {4}@docs-claude can this also keep the order on the phone\?\n\n$/,
    );
    expect(noteFor(events[0])).not.toContain("# GitHub");
  });

  // plans/related-plans-share-a-pull-request-follow-up-5.md: issues need pull requests.
  describe("issues are read only with pull requests", () => {
    const body = "# Hook\n\n## Issues\n\nTopics here are GitHub issues.\n";
    it("an Issues heading with land: pull-request turns issues on, as before", () => {
      expect(hasIssues(body, "pull-request")).toBe(true);
    });
    it("an Issues heading without land: pull-request turns them off", () => {
      expect(hasIssues(body, "push")).toBe(false);
    });
    it("with land taken out by hand, plans prints no webhook line", () => {
      const dir = mkdtempSync(join(tmpdir(), "issues-off-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude"));
        const file = (land: string) =>
          writeFileSync(
            join(dir, ".claude", "workflow.md"),
            `---\nname: Hook\nbranch: test\n${land}---\n\n## Issues\n\nTopics here are GitHub issues.\n`,
          );
        const list = () =>
          spawnSync("node", [join(here, "plan-queue.mjs"), "list"], {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH || "",
              WORKFLOW_ROOT: dir,
              WORKFLOW_GH: "/bin/false",
              WORKFLOW_LIVE: "[]",
              CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
              CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
            },
          }).stdout;
        file("land: pull-request\n");
        expect(list()).toContain("The webhook: none; plans webhook starts it.");
        file("");
        expect(list()).not.toContain("The webhook");
        // A listener left running acts on no delivery once issues are off (Codex).
        mkdirSync(join(dir, ".claude", "github-inbox"));
        const body = JSON.stringify({
          action: "opened",
          issue: { number: 3, title: "T", labels: [] },
        });
        writeFileSync(
          join(dir, ".claude", "github-inbox", "d1.json"),
          JSON.stringify({ id: "d1", event: "issues", body }),
        );
        const inbox = () =>
          spawnSync("node", [join(here, "plan-queue.mjs"), "github", "--inbox"], {
            encoding: "utf8",
            env: { PATH: process.env.PATH || "", WORKFLOW_ROOT: dir, WORKFLOW_GH: "/bin/false" },
          }).stdout;
        expect(inbox()).toBe("GitHub: nothing new.\n");
        expect(existsSync(join(dir, ".claude", "github-seen.json"))).toBe(false);
        file("land: pull-request\n");
        inbox();
        expect(existsSync(join(dir, ".claude", "github-seen.json"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("plans webhook", () => {
    let dir: string;
    const port = 30000 + (process.pid % 20000);
    const env = () => ({
      PATH: process.env.PATH || "",
      WORKFLOW_ROOT: dir,
      WORKFLOW_WEBHOOK_SECRET: "s3cret",
      WORKFLOW_WEBHOOK_PORT: String(port),
      WORKFLOW_GH: "/bin/false",
      WORKFLOW_LIVE: "[]",
      CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
      CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
    });
    const plans = (...args: string[]) =>
      spawnSync("node", [join(here, "plan-queue.mjs"), ...args], { encoding: "utf8", env: env() });
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "webhook-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      writeFileSync(
        join(dir, ".claude", "workflow.md"),
        "---\nname: Hook\nbranch: test\nland: pull-request\n---\n\n## Issues\n\nTopics here are GitHub issues.\n",
      );
    });
    afterAll(() => {
      plans("webhook", "--stop");
      rmSync(dir, { recursive: true, force: true });
    });

    it("with no secret says what to turn on and runs nothing", () => {
      const done = spawnSync("node", [join(here, "plan-queue.mjs"), "webhook"], {
        encoding: "utf8",
        env: { ...env(), WORKFLOW_WEBHOOK_SECRET: "" },
      });
      expect(done.status).toBe(1);
      expect(done.stdout.trim()).toBe(
        "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      );
      expect(existsSync(join(dir, ".claude", "webhook.json"))).toBe(false);
    });

    it("answers a signed POST 202 and keeps it, a bad one 401 with nothing, and stops", async () => {
      expect(plans("list").stdout).toContain("The webhook: none; plans webhook starts it.");
      expect(plans("webhook").stdout).toMatch(
        new RegExp(`^The webhook: listening on ${port} since \\d\\d:\\d\\d\\.\\n$`),
      );
      const body = JSON.stringify({
        action: "opened",
        issue: { number: 3, title: "T", labels: [] },
      });
      const post = (signature: string, id: string) =>
        fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "issues",
            "X-GitHub-Delivery": id,
          },
        });
      expect((await post(sign("s3cret", body), "good-1")).status).toBe(202);
      expect(existsSync(join(dir, ".claude", "github-inbox", "good-1.json"))).toBe(true);
      expect((await post(sign("wrong", body), "bad-1")).status).toBe(401);
      expect(existsSync(join(dir, ".claude", "github-inbox", "bad-1.json"))).toBe(false);
      // A second one finds the first alive and says so.
      expect(plans("webhook").stdout).toMatch(
        /^The webhook: listening on \d+ since \d\d:\d\d, last delivery \d\d:\d\d\.\n$/,
      );
      expect(plans("list").stdout).toMatch(/\nThe webhook: listening on \d+ since/);
      const pid = JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8")).pid;
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
      await new Promise((done) => setTimeout(done, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    });

    // plans/webhook-stale-record.md: a record counts only when its port answers.
    const record = () => JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8"));

    it("replaces a record whose pid is alive but whose port answers nothing, and starts one", () => {
      // This test's own pid: alive, and nothing listens on the port yet.
      writeFileSync(
        join(dir, ".claude", "webhook.json"),
        JSON.stringify({ pid: process.pid, port, at: Date.now(), lastAt: 0 }),
      );
      const done = plans("webhook");
      expect(done.status).toBe(0);
      expect(done.stdout).toMatch(new RegExp(`^The webhook: listening on ${port} since `));
      expect(record().pid).not.toBe(process.pid);
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
    });

    it("leaves a live listener on its port alone and says it listens", () => {
      expect(plans("webhook").status).toBe(0);
      const first = record().pid;
      const again = plans("webhook");
      expect(again.status).toBe(0);
      expect(again.stdout).toMatch(new RegExp(`^The webhook: listening on ${port} since `));
      expect(record().pid).toBe(first);
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
    });

    it("exits 1 when no listener is up after the wait", async () => {
      // The port taken by another server, so the listener cannot bind it.
      const taken = createServer();
      await new Promise<void>((done) => taken.listen(port, "127.0.0.1", done));
      try {
        const done = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
          execFile(
            "node",
            [join(here, "plan-queue.mjs"), "webhook"],
            { encoding: "utf8", env: env() },
            (error, stdout) => resolve({ status: error ? (error.code as number) : 0, stdout }),
          );
        });
        expect(done.status).toBe(1);
        expect(done.stdout).toBe(`The webhook: none came up on ${port}.\n`);
        expect(existsSync(join(dir, ".claude", "webhook.json"))).toBe(false);
      } finally {
        await new Promise((done) => taken.close(done));
      }
    }, 10_000);
  });
});

// plans/adaptive-reuse.md, part 1: the inputs measured into a cached summary.
describe("the reuse inputs are cached", () => {
  const session = (agent: string, start: number, turns: number) =>
    [
      JSON.stringify({ type: "agent-setting", agentSetting: `workflow:${agent}` }),
      ...Array.from({ length: turns }, (_, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: `2026-11-0${1 + i}T10:00:00Z`,
          message: {
            id: `m${i}`,
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: start + i * 1000,
              output_tokens: 1,
            },
          },
        }),
      ),
      "",
    ].join("\n");

  it("from a hook with no summary reads no transcript, and the ceiling is the default, said so", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      for (const name of ["a", "b", "c", "d", "e"])
        writeFileSync(join(dir, `${name}.jsonl`), session("executor", 50_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const reads: string[] = [];
      const read = (path: string) => {
        reads.push(path);
        return measureFile(path);
      };
      for (const mode of ["prompt", "tool", "stop", "wrote"]) {
        const cachedOnly = hookRun(["node", "plan-queue.mjs", mode]);
        expect(cachedOnly).toBe(true);
        const inputs = reuseInputs({ cachedOnly, dir, file, read });
        expect(inputs).toEqual({});
        const verdict = ceilingFor({ kind: "executor", inputs });
        expect(verdict.history).toBe(false);
        expect(verdict.why).toBe("the ceiling of 200k (no history yet: today's numbers)");
      }
      expect(reads).toEqual([]);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("from a hook takes a summary older than the hour as it is and reads nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const measured = reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 6));
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 3));
      let reads = 0;
      const inputs = reuseInputs({
        cachedOnly: hookRun(["node", "plan-queue.mjs", "stop"]),
        now: t0 + 3 * REUSE_REFRESH,
        dir,
        file,
        read: () => (reads++, null),
      });
      expect(reads).toBe(0);
      expect(inputs).toEqual(measured);
      expect(JSON.parse(readFileSync(file, "utf8")).measuredAt).toBe(t0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("plans and plans start from the command line measure an hour-old summary and write it", () => {
    for (const mode of [undefined, "list", "start", "cost"])
      expect(hookRun(["node", "plan-queue.mjs", ...(mode ? [mode] : [])])).toBe(false);
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 3));
      const reads: string[] = [];
      const read = (path: string) => (reads.push(basename(path)), measureFile(path));
      const now = t0 + REUSE_REFRESH + 1;
      const inputs = reuseInputs({
        cachedOnly: hookRun(["node", "x", "start"]),
        now,
        dir,
        file,
        read,
      });
      expect(reads).toEqual(["b.jsonl"]);
      expect(inputs.planner?.sessions).toBe(2);
      expect(JSON.parse(readFileSync(file, "utf8")).measuredAt).toBe(now);

      // `plans` itself, run as the command is: the summary written under the data folder.
      const checkout = join(base, "checkout");
      mkdirSync(join(checkout, ".claude"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      writeFileSync(join(checkout, ".claude", "workflow.md"), "---\nname: Docs\n---\n");
      const projects = join(base, "projects");
      const folder = join(projects, checkout.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "a.jsonl"), session("planner", 30_000, 3));
      const data = join(base, "data");
      const env = {
        ...process.env,
        WORKFLOW_ROOT: checkout,
        CLAUDE_PROJECT_DIR: checkout,
        WORKFLOW_PROJECTS: projects,
        WORKFLOW_DATA: data,
        WORKFLOW_LIVE: "[]",
      };
      execFileSync("node", [join(here, "plan-queue.mjs")], {
        cwd: checkout,
        env,
        encoding: "utf8",
      });
      const summary = JSON.parse(
        readFileSync(join(data, "reuse", `${basename(folder)}.json`), "utf8"),
      );
      expect(Object.keys(summary.rows)).toEqual(["a"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  describe("a hook refreshes the summary in the background", () => {
    const t0 = Date.parse("2026-11-06T12:00:00Z");
    const setUp = () => {
      const base = mkdtempSync(join(tmpdir(), "reuse-"));
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const spawned: string[][] = [];
      let reads = 0;
      /** One hook's read, at `now`, as `reuseNow` makes it with a stub spawner. */
      const hookAt = (now: number) =>
        reuseInputs({
          cachedOnly: hookRun(["node", "plan-queue.mjs", "stop"]),
          now,
          dir,
          file,
          read: () => (reads++, null),
          stale: (summary: string) =>
            refreshLater(summary, {
              now,
              spawner: (_bin: string, args: string[]) => spawned.push(args),
            }),
        });
      return { base, dir, file, spawned, reads: () => reads, hookAt };
    };

    it("with no summary, or one an hour old, starts one plans cost and goes on with what it holds", () => {
      const none = setUp();
      try {
        expect(none.hookAt(t0)).toEqual({});
        expect(none.spawned).toHaveLength(1);
        expect(none.spawned[0].slice(-2)).toEqual(["cost", "--summary"]);
        expect(none.spawned[0][0]).toMatch(/plan-queue\.mjs$/);
        expect(none.reads()).toBe(0);
        expect(existsSync(none.file.replace(/\.json$/, ".refreshing"))).toBe(true);
      } finally {
        rmSync(none.base, { recursive: true, force: true });
      }
      const old = setUp();
      try {
        const measured = reuseInputs({ refresh: true, now: t0, dir: old.dir, file: old.file });
        expect(old.hookAt(t0 + REUSE_REFRESH)).toEqual(measured);
        expect(old.spawned).toHaveLength(1);
        expect(old.reads()).toBe(0);
      } finally {
        rmSync(old.base, { recursive: true, force: true });
      }
    });

    it("plans cost --summary refreshes the reuse inputs alone and prints nothing", () => {
      const calls: string[] = [];
      const printed: string[] = [];
      costCommand(["--summary"], {
        measureAll: () => (calls.push("measure"), []),
        refreshInputs: (opts: { refresh?: boolean }) => (
          calls.push(`reuseInputs refresh=${opts.refresh}`),
          {}
        ),
        write: (text: string) => printed.push(text),
      });
      expect(calls).toEqual(["reuseInputs refresh=true"]);
      expect(printed).toEqual([]);
    });

    it("two hooks at once start one refresh", () => {
      const run = setUp();
      try {
        // The first hook's marker is created; the second, at the same moment, finds it.
        run.hookAt(t0);
        run.hookAt(t0);
        expect(run.spawned).toHaveLength(1);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });

    it("a marker under an hour old starts nothing, the summary still old; one an hour old starts again", () => {
      const run = setUp();
      try {
        run.hookAt(t0);
        run.hookAt(t0 + REUSE_REFRESH - 1);
        expect(run.spawned).toHaveLength(1);
        expect(existsSync(run.file)).toBe(false);
        run.hookAt(t0 + REUSE_REFRESH);
        expect(run.spawned).toHaveLength(2);
        const marker = run.file.replace(/\.json$/, ".refreshing");
        expect(readFileSync(marker, "utf8")).toBe(String(t0 + REUSE_REFRESH));
        expect(readdirSync(dirname(marker))).toEqual(["-checkout.refreshing"]);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });

    it("with a summary under the hour, starts nothing", () => {
      const run = setUp();
      try {
        reuseInputs({ refresh: true, now: t0, dir: run.dir, file: run.file });
        run.hookAt(t0 + REUSE_REFRESH - 1);
        expect(run.spawned).toEqual([]);
        expect(run.reads()).toBe(0);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });
  });

  it("keeps a changed transcript's row when it cannot be read", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("executor", 50_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const first = reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      expect(first.executor?.sessions).toBe(1);
      const kept = JSON.parse(readFileSync(file, "utf8")).rows.a;
      writeFileSync(join(dir, "a.jsonl"), session("executor", 50_000, 5));
      const after = reuseInputs({ refresh: true, now: t0 + 1000, dir, file, read: () => null });
      expect(after.executor).toEqual(first.executor);
      // Its old stat too, so the next refresh reads the transcript again.
      expect(JSON.parse(readFileSync(file, "utf8")).rows).toEqual({ a: kept });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("measures each transcript once, then only the changed, and a hook within the hour none", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 5));
      writeFileSync(join(dir, "c.jsonl"), session("executor", 50_000, 2));
      const file = join(base, "reuse", "-checkout.json");
      let reads: string[] = [];
      const read = (path: string) => {
        reads.push(basename(path));
        return measureFile(path);
      };
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const inputs = reuseInputs({ refresh: true, now: t0, dir, file, read });
      expect(reads.sort()).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
      const summary = JSON.parse(readFileSync(file, "utf8"));
      expect(Object.keys(summary.rows).sort()).toEqual(["a", "b", "c"]);
      for (const key of [
        "id",
        "mtime",
        "size",
        "agent",
        "model",
        "turns",
        "startContext",
        "endContext",
      ])
        expect(summary.rows.a).toHaveProperty(key);
      expect(summary.measuredAt).toBe(t0);
      expect(inputs.planner).toEqual({
        sessions: 2,
        start: 35_000,
        turns: 4,
        model: "claude-opus-5-5",
      });
      expect(inputs.executor).toEqual({
        sessions: 1,
        start: 50_000,
        turns: 2,
        model: "claude-opus-5-5",
      });
      expect(summary.inputs).toEqual(inputs);

      // Nothing changed: a stat per file, no transcript read.
      reads = [];
      reuseInputs({ refresh: true, now: t0 + 1000, dir, file, read });
      expect(reads).toEqual([]);

      // One grown: it alone is read again.
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 7));
      reads = [];
      // From a hook within the hour of measuredAt: none read, even with b changed.
      expect(reuseInputs({ now: t0 + 30 * 60_000, dir, file, read })).toEqual(
        JSON.parse(readFileSync(file, "utf8")).inputs,
      );
      expect(reads).toEqual([]);
      // plans cost refreshes: b alone.
      const after = reuseInputs({ refresh: true, now: t0 + 31 * 60_000, dir, file, read });
      expect(reads).toEqual(["b.jsonl"]);
      expect(after.planner.turns).toBe(5);
      // A hook past the hour measures too.
      writeFileSync(join(dir, "c.jsonl"), session("executor", 50_000, 4));
      reads = [];
      reuseInputs({ now: t0 + 120 * 60_000, dir, file, read });
      expect(reads).toEqual(["c.jsonl"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("gives no inputs for a missing folder", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      expect(
        reuseInputs({ refresh: true, dir: join(base, "none"), file: join(base, "r.json") }),
      ).toEqual({});
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * **Ready plans never wait with no executor** (plans/executor-takes-next-
 * ready-plan.md, part 2): a planner's or an assistant's stop, or the end
 * timer, starts one when plans are ready and none is alive, under the cheap
 * gate and the marker. A stub \`claude\` stands in: \`agents --json\` from a
 * file, \`--bg\` adds its row, and every call is logged, so a gate that reads
 * no sessions is seen to read none.
 */
describe("ready plans reach an executor", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const project = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `queue-net-${name.toLowerCase()}-`));
    made.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, ".claude", "workflow.md"), `---\nname: ${name}\nbranch: test\n---\n`);
    for (const x of ["a", "b"])
      writeFileSync(
        join(dir, "plans", `${x}.md`),
        `# ${x}\n\nPlan only, 6 November 2026, for Javi.\n`,
      );
    const rows = join(dir, "rows.json");
    writeFileSync(rows, "[]");
    const calls = join(dir, "calls.log");
    const script = join(dir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ").slice(0, 80) + "\\n");
if (args[0] === "agents") process.stdout.write(fs.readFileSync(${JSON.stringify(rows)}, "utf8"));
else if (args.includes("--bg")) {
  const name = args[args.indexOf("--name") + 1];
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(rows)}, "utf8"));
  all.push({ sessionId: "net-" + Date.now(), name, kind: "background", cwd: process.cwd() });
  fs.writeFileSync(${JSON.stringify(rows)}, JSON.stringify(all));
}
`,
    );
    chmodSync(script, 0o755);
    const starts = join(dir, ".claude", "starts.log");
    const { WORKFLOW_LIVE: _, ...rest } = process.env;
    const env = {
      ...rest,
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_CLAUDE: script,
      WORKFLOW_STARTS_LOG: starts,
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
    };
    const queue = (args: string[], input: object = {}, extra: Record<string, string> = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...env, ...extra },
      });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      dir,
      rows,
      queue,
      calls: () => read(calls),
      started: () =>
        read(starts)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
    };
  };
  const ownerStop = { session_id: "a0000000-0000-0000-0000-000000000000", agent_type: "assistant" };
  const why = "Plans were ready and no executor was alive.";

  it("a planner's stop with nothing of its own to do starts one", { timeout: 30_000 }, () => {
    const net = project("Plain");
    const id = "p7000000-0000-0000-0000-000000000000";
    const stateFile = join(tmpdir(), `workflow-queue-${id}.json`);
    writeFileSync(stateFile, JSON.stringify({ agent: "planner", plans: ["plans/a.md"] }));
    try {
      const said = net.queue(["stop"], { session_id: id, agent_type: "planner" });
      expect(JSON.parse(said).hookSpecificOutput.additionalContext).toContain(
        "Plain Executor 1 (lab) was started on: plans/a.md, plans/b.md.",
      );
      expect(net.started()).toEqual([
        expect.objectContaining({
          name: "Plain Executor 1 (lab)",
          paths: ["plans/a.md", "plans/b.md"],
          why,
        }),
      ]);
      expect(existsSync(join(net.dir, ".claude", "executor.starting"))).toBe(false);
    } finally {
      rmSync(stateFile, { force: true });
    }
  });

  it("the owner's own assistant chat's stop starts one", { timeout: 30_000 }, () => {
    const net = project("Owner");
    const said = net.queue(["stop"], ownerStop);
    expect(JSON.parse(said).hookSpecificOutput.additionalContext).toContain(
      "Owner Executor 1 (lab) was started on: plans/a.md, plans/b.md.",
    );
    expect(net.started()).toEqual([expect.objectContaining({ why })]);
  });

  it(
    "the end timer ending an idle executor with a ready plan starts one",
    { timeout: 30_000 },
    () => {
      const net = project("Timer");
      const exec = "e7000000-0000-0000-0000-000000000000";
      writeFileSync(
        net.rows,
        JSON.stringify([
          {
            sessionId: exec,
            id: "bg-t",
            name: "Timer Executor 1 (lab)",
            kind: "background",
            state: "done",
            status: "idle",
            cwd: net.dir,
          },
        ]),
      );
      writeFileSync(
        join(net.dir, ".claude", "executor.lock"),
        JSON.stringify({ sessionId: exec, pid: process.pid, released: false }),
      );
      try {
        expect(net.queue(["end", "--timer", String(Date.now() - 1), exec])).toBe("");
        expect(net.started()).toEqual([
          expect.objectContaining({
            name: "Timer Executor 2 (lab)",
            paths: ["plans/a.md", "plans/b.md"],
            why,
          }),
        ]);
      } finally {
        rmSync(join(tmpdir(), `workflow-queue-${exec}.json`), { force: true });
      }
    },
  );

  // Codex C1 to C3 and the plan review: a stale marker is reclaimed, a lock
  // with no pid and a dead session's Building line are judged by the
  // sessions, and a stop where nothing was waiting after all says nothing.
  it(
    "reclaims a stale marker, and judges a pid-less lock and a dead session's Building line by the sessions",
    { timeout: 60_000 },
    () => {
      const stale = project("Stale");
      const marker = join(stale.dir, ".claude", "executor.starting");
      writeFileSync(marker, `${Date.now() - 3 * 60_000} 1`);
      expect(stale.queue(["stop"], ownerStop)).toContain("Stale Executor 1 (lab) was started on");
      expect(existsSync(marker)).toBe(false);

      const pidless = project("Pidless");
      writeFileSync(
        join(pidless.dir, ".claude", "executor.lock"),
        JSON.stringify({ sessionId: "gone", pid: null, released: false }),
      );
      expect(pidless.queue(["stop"], ownerStop)).toContain(
        "Pidless Executor 1 (lab) was started on",
      );

      const dead = project("Dead");
      for (const x of ["a", "b"]) rmSync(join(dead.dir, "plans", `${x}.md`));
      const building = (id: string) =>
        `# A\n\n## Building, 6 November 2026, session ${id}\n\nPlan only, 6 November 2026, for Javi.\n`;
      writeFileSync(join(dead.dir, "plans", "a.md"), building("d0000000-dead"));
      expect(dead.queue(["stop"], ownerStop)).toContain(
        "Dead Executor 1 (lab) was started on: plans/a.md.",
      );

      // The Building line's session alive, with the lock released: nothing waits, nothing is said.
      const alive = project("Alive");
      for (const x of ["a", "b"]) rmSync(join(alive.dir, "plans", `${x}.md`));
      writeFileSync(join(alive.dir, "plans", "a.md"), building("b0000000-live"));
      writeFileSync(
        alive.rows,
        JSON.stringify([
          {
            sessionId: "b0000000-live",
            name: "Alive Executor 1 (lab)",
            kind: "background",
            status: "busy",
            cwd: alive.dir,
          },
        ]),
      );
      expect(alive.queue(["stop"], ownerStop)).toBe("");
      expect(alive.started()).toEqual([]);
    },
  );

  it("starts nothing and reads no sessions beside a live lock, paused, while another hook starts one, deferred or asking", () => {
    const net = project("Held");
    const lock = join(net.dir, ".claude", "executor.lock");
    writeFileSync(lock, JSON.stringify({ sessionId: "live", pid: process.pid, released: false }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(lock);
    const pause = join(net.dir, ".claude", "executor.pause");
    writeFileSync(pause, JSON.stringify({ at: "23:10" }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(pause);
    const marker = join(net.dir, ".claude", "executor.starting");
    writeFileSync(marker, String(Date.now() - 60_000));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // A start already deferred to the reset, and plans whose planner is asking (/code-review).
    const deferred = join(net.dir, ".claude", "executor.deferred");
    writeFileSync(deferred, JSON.stringify({ until: Date.now() + 60 * 60_000, pid: 1, paths: [] }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(deferred);
    writeFileSync(
      join(net.dir, ".claude", "asking.deferred"),
      JSON.stringify({
        until: Date.now() + 30 * 60_000,
        pid: null,
        paths: ["plans/a.md", "plans/b.md"],
      }),
    );
    expect(net.queue(["stop"], ownerStop)).toBe("");
    expect(net.calls()).toBe("");
    expect(net.started()).toEqual([]);
  });
});
