import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * **The project's tool denials** (`tool-denials.mjs`, docs/workflow.md,
 * "The project file", the `deny` paragraph): a call to an MCP tool the
 * project file denies the agent is refused with the reason, and a subagent
 * is held to its session's agent.
 */
const script = new URL("../plugins/workflow/scripts/tool-denials.mjs", import.meta.url).pathname;

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

/** A temporary project whose frontmatter is `front`, or with no project file when null. */
function projectWith(front: string | null) {
  const root = mkdtempSync(join(tmpdir(), "tool-denials-"));
  made.push(root);
  if (front !== null) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Lab\n${front}---\n`);
  }
  return root;
}

/** The hook as Claude Code runs it: its stdout, stderr and exit code. */
function run(root: string, mode: string, input: object) {
  const done = spawnSync("node", [script, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { out: done.stdout, err: done.stderr, code: done.status };
}

let n = 0;
/** A session id unique to this process. */
const session = () => `deny-${process.pid}-${++n}`;
const recordOf = (id: string) => join(tmpdir(), `workflow-agent-${id}.json`);
afterAll(() => {
  for (let i = 1; i <= n; i++) rmSync(recordOf(`deny-${process.pid}-${i}`), { force: true });
});

const deny = (patterns: string[]) =>
  `deny:\n  assistant:\n${patterns.map((p) => `    - "${p}"\n`).join("")}`;

const refusal = (tool: string, agent: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${tool} is not the ${agent}'s here: .claude/workflow.md denies it (deny, ${agent}). Do not reach it another way; say so when the answer needs it.`,
    },
  });

describe("the project's tool denials", () => {
  const lab = projectWith(deny(["mcp__(claude_ai_)?lab__.*"]));

  it("refuses a denied tool, the connector's and the local server's, with the reason word for word", () => {
    for (const tool_name of ["mcp__claude_ai_lab__delete", "mcp__lab__delete"])
      expect(
        run(lab, "tool", { session_id: session(), agent_type: "workflow:assistant", tool_name })
          .out,
      ).toBe(refusal(tool_name, "assistant"));
    expect(
      run(lab, "tool", {
        session_id: session(),
        agent_type: "assistant",
        tool_name: "mcp__lab__delete",
      }).out,
    ).toBe(refusal("mcp__lab__delete", "assistant"));
    expect(refusal("mcp__claude_ai_lab__delete", "assistant")).toContain(
      "mcp__claude_ai_lab__delete is not the assistant's here: .claude/workflow.md denies it (deny, assistant).",
    );
  });

  it("passes another server, another agent, and a name the pattern matches only in part", () => {
    expect(
      run(lab, "tool", {
        session_id: session(),
        agent_type: "workflow:assistant",
        tool_name: "mcp__other__delete",
      }).out,
    ).toBe("");
    expect(
      run(lab, "tool", {
        session_id: session(),
        agent_type: "workflow:planner",
        tool_name: "mcp__claude_ai_lab__delete",
      }).out,
    ).toBe("");
    const exact = projectWith(deny(["mcp__lab__delete"]));
    expect(
      run(exact, "tool", {
        session_id: session(),
        agent_type: "workflow:assistant",
        tool_name: "mcp__claude_ai_lab__delete_all",
      }).out,
    ).toBe("");
    expect(
      run(exact, "tool", {
        session_id: session(),
        agent_type: "workflow:assistant",
        tool_name: "mcp__lab__delete_all",
      }).out,
    ).toBe("");
  });

  it("holds a subagent to its session's agent, recorded at the prompt", () => {
    const s = session();
    const call = {
      session_id: s,
      agent_type: "Explore",
      agent_id: "a1",
      tool_name: "mcp__lab__delete",
    };
    expect(run(lab, "prompt", { session_id: s, agent_type: "workflow:assistant" }).out).toBe("");
    expect(run(lab, "tool", call).out).toBe(refusal("mcp__lab__delete", "assistant"));
    // A prompt with no agent of the plugin's drops the record.
    run(lab, "prompt", { session_id: s, agent_type: "Explore" });
    expect(existsSync(recordOf(s))).toBe(false);
    expect(run(lab, "tool", call).out).toBe("");
    run(lab, "prompt", { session_id: s, agent_type: "workflow:assistant" });
    run(lab, "prompt", { session_id: s });
    expect(run(lab, "tool", call).out).toBe("");
    // A session never prompted has no record.
    expect(run(lab, "tool", { ...call, session_id: session() }).out).toBe("");
  });

  it("holds a subagent with a list of its own to its session's list too", () => {
    const both = projectWith(
      `deny:\n  executor:\n    - "mcp__lab__.*"\n  reviewer:\n    - "mcp__other__.*"\n`,
    );
    const s = session();
    run(both, "prompt", { session_id: s, agent_type: "workflow:executor" });
    const sub = { session_id: s, agent_type: "workflow:reviewer", agent_id: "a2" };
    expect(run(both, "tool", { ...sub, tool_name: "mcp__lab__delete" }).out).toBe(
      refusal("mcp__lab__delete", "executor"),
    );
    expect(run(both, "tool", { ...sub, tool_name: "mcp__other__delete" }).out).toBe(
      refusal("mcp__other__delete", "reviewer"),
    );
  });

  it("skips a pattern that is not a regular expression, and the valid one still denies", () => {
    const mixed = projectWith(deny(["mcp__[", "mcp__lab__.*"]));
    const done = run(mixed, "tool", {
      session_id: session(),
      agent_type: "workflow:assistant",
      tool_name: "mcp__lab__delete",
    });
    expect(done).toEqual({ out: refusal("mcp__lab__delete", "assistant"), err: "", code: 0 });
  });

  it("denies in the compact form too", () => {
    const compact = projectWith(`form: compact\ndeny:\n  maker:\n    - "mcp__lab__.*"\n`);
    expect(
      run(compact, "tool", {
        session_id: session(),
        agent_type: "workflow:maker",
        tool_name: "mcp__lab__delete",
      }).out,
    ).toBe(refusal("mcp__lab__delete", "maker"));
  });

  it("does nothing without a project file or without deny, and records nothing then", () => {
    const call = {
      session_id: session(),
      agent_type: "workflow:assistant",
      tool_name: "mcp__lab__delete",
    };
    expect(run(projectWith(null), "tool", call)).toEqual({ out: "", err: "", code: 0 });
    const plain = projectWith("branch: test\n");
    expect(run(plain, "tool", call)).toEqual({ out: "", err: "", code: 0 });
    const s = session();
    run(plain, "prompt", { session_id: s, agent_type: "workflow:assistant" });
    expect(existsSync(recordOf(s))).toBe(false);
    // A record left from when the key was there is dropped at the next prompt.
    run(lab, "prompt", { session_id: s, agent_type: "workflow:assistant" });
    expect(existsSync(recordOf(s))).toBe(true);
    run(plain, "prompt", { session_id: s, agent_type: "workflow:planner" });
    expect(existsSync(recordOf(s))).toBe(false);
  });

  it("writes nothing in tool mode", () => {
    const s = session();
    run(lab, "tool", {
      session_id: s,
      agent_type: "workflow:assistant",
      tool_name: "mcp__lab__delete",
    });
    expect(existsSync(recordOf(s))).toBe(false);
  });
});
