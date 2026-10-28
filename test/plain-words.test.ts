import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * **The plain-words check** (`plain-words.mjs`, docs/workflow.md, "The three
 * agents", "Asked in plain words"): a question to the owner that names code,
 * or is a single sentence, is refused with the rule as its reason, at most
 * twice in a turn.
 */
const script = new URL("../plugins/workflow/scripts/plain-words.mjs", import.meta.url).pathname;

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

/** A temporary project whose frontmatter is `front`, or with no project file when null. */
function projectWith(front: string | null) {
  const root = mkdtempSync(join(tmpdir(), "plain-words-"));
  made.push(root);
  if (front !== null) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Lab\n${front}---\n`);
  }
  return root;
}

/** The hook as Claude Code runs it: its stdout. */
function run(root: string, mode: string, input: object) {
  const done = spawnSync("node", [script, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_OWNER: "Javi" },
  });
  expect(done.stderr).toBe("");
  return done.stdout;
}

let n = 0;
/** A session id unique to this process. */
const session = () => `plain-${process.pid}-${++n}`;
afterAll(() => {
  for (let i = 1; i <= n; i++)
    rmSync(join(tmpdir(), `workflow-plain-words-plain-${process.pid}-${i}.json`), {
      force: true,
    });
});

const situation =
  "This is about what a reader sees after a hand-over, the change you asked for this morning. Today the page stays open until they close it.";

/** One question of the call: the situation, then `asked`, two clean options unless given. */
const question = (asked: string, options?: object[]) => ({
  question: `${situation} ${asked}`,
  header: "Hand-over",
  multiSelect: false,
  options: options ?? [
    { label: "Closes on its own (Recommended)", description: "Costs nothing unless they go back." },
    { label: "Stays open", description: "As today." },
  ],
});

const call = (sessionId: string | undefined, ...questions: object[]) => ({
  ...(sessionId ? { session_id: sessionId } : {}),
  tool_name: "AskUserQuestion",
  tool_input: { questions },
});

const rule = `Javi reads it on his phone with none of this chat in front of him. Rewrite it by "Asked in plain words" (the workflow's docs): say what it is about in the words he used when he asked for it, the situation from the start in two or three sentences, and what each choice means to him and costs him; call things by what they do for him, not by their names in the code, and keep the names for the plan. Options are what he gets, a few words each, the recommended one first.`;

const refusal = (why: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `The question ${why}: ${rule}`,
    },
  });

describe("the plain-words check", () => {
  const lab = projectWith("branch: test\n");

  it("refuses code names, with the reason word for word naming what was found", () => {
    const cases: [string, string][] = [
      ["Should scripts/connect.mjs stay?", '"scripts/connect.mjs"'],
      ["Should the `connect` script stay?", '"`"'],
      ["Should it exit on Ctrl+C?", '"Ctrl+C"'],
      ["Should plan.path change?", '"plan.path"'],
      ["Should it take --force?", '"--force"'],
      ["Is it session 9b372186?", '"9b372186"'],
      ["Should read_state go?", '"read_state"'],
      ["Should askingIn() run?", '"askingIn()"'],
    ];
    for (const [asked, found] of cases)
      expect(run(lab, "question", call(session(), question(asked)))).toBe(
        refusal(`names code (${found})`),
      );
  });

  it("refuses a single sentence, and a clean question whose option names code", () => {
    expect(
      run(lab, "question", call(session(), { ...question(""), question: "Keep it open?" })),
    ).toBe(refusal("is a single sentence"));
    expect(
      run(
        lab,
        "question",
        call(session(), {
          ...question(""),
          question: "Should `x` stay?",
        }),
      ),
    ).toBe(refusal('names code ("`") and is a single sentence'));
    expect(
      run(
        lab,
        "question",
        call(
          session(),
          question("Should it close?", [
            { label: "Close it", description: "Runs hooks.json again." },
            { label: "Keep it", description: "As today." },
          ]),
        ),
      ),
    ).toBe(refusal('names code ("hooks.json")'));
  });

  it("names three things found at most", () => {
    const out = run(lab, "question", call(session(), question("Should a_b, c_d, e_f and g_h go?")));
    expect(out).toContain('names code (\\"a_b\\", \\"c_d\\", \\"e_f\\")');
  });

  it("passes plain words: an address, a version, e.g., the owner's name and the workflow's own words", () => {
    for (const asked of [
      "The page is https://example.com/a/b.html, if you want to look. Should it close?",
      "Claude Code 2.1.113 does it, e.g. on a phone. Should it close?",
      "Javi, the planner, the executor and the queue all wait on this. Should GitHub hold it?",
      "Should it close on its own, or stay open?",
      // A full stop inside a quotation, and a number that is no id (/code-review).
      'He said "keep it." Should it close?',
      "It costs 10000000 tokens a day. Should it close?",
    ])
      expect(run(lab, "question", call(session(), question(asked)))).toBe("");
  });

  it("refuses twice in a turn and passes the third; a new prompt resets the count", () => {
    const id = session();
    const bad = call(id, question("Should plan.path change?"));
    expect(run(lab, "question", bad)).not.toBe("");
    expect(run(lab, "question", bad)).not.toBe("");
    expect(run(lab, "question", bad)).toBe("");
    expect(run(lab, "prompt", { session_id: id, prompt: "go on" })).toBe("");
    expect(run(lab, "question", bad)).not.toBe("");
  });

  it("checks a call with no session id and never counts it", () => {
    const bad = call(undefined, question("Should plan.path change?"));
    for (let i = 0; i < 3; i++) expect(run(lab, "question", bad)).not.toBe("");
  });

  it("runs with no project file and in the compact form", () => {
    const bad = (id: string) => call(id, question("Should plan.path change?"));
    expect(run(projectWith(null), "question", bad(session()))).not.toBe("");
    expect(run(projectWith("form: compact\n"), "question", bad(session()))).not.toBe("");
  });
});
