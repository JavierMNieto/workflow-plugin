import { execFileSync } from "node:child_process";
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
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kindsFor, menuOf, nameWords } from "../plugins/workflow/scripts/catalogue-context.mjs";

/**
 * **The catalogue's hook** (`catalogue-context.mjs`, docs/workflow.md,
 * "Decisions"): the rules recorded for the control being edited, in the
 * context before the edit, read through the project file's `catalogue` and
 * `ui`. A port of the first project's own hook and its cases.
 */
const context = new URL("../plugins/workflow/scripts/catalogue-context.mjs", import.meta.url)
  .pathname;

let repo: string;

/**
 * A fake `claude` for the hook's model call (plans/catch-inconsistent-ui-at-build.md):
 * it appends a line to `FAKE_MARKER` when run, sleeps `FAKE_SLEEP` seconds,
 * exits `FAKE_EXIT`, and answers `FAKE_ANSWER` (`none` unless a case says).
 */
const fakeBin = mkdtempSync(join(tmpdir(), "catalogue-fake-claude-"));
writeFileSync(
  join(fakeBin, "claude"),
  `#!/bin/sh
cat > /dev/null
[ -n "$FAKE_MARKER" ] && echo run >> "$FAKE_MARKER"
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
[ -n "$FAKE_EXIT" ] && exit "$FAKE_EXIT"
printf '{"result":"%s","total_cost_usd":0.0003}' "\${FAKE_ANSWER:-none}"
`,
);
chmodSync(join(fakeBin, "claude"), 0o755);
const dataDir = mkdtempSync(join(tmpdir(), "catalogue-data-"));
afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

/** The hook as Claude Code runs it: an input with no tool named is an Edit's. */
function run(script: string, args: string[], input: object, env: Record<string, string> = {}) {
  return execFileSync("node", [script, ...args], {
    input: JSON.stringify({ tool_name: "Edit", ...input }),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
      WORKFLOW_DATA: dataDir,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
      ...env,
    },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "catalogue-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "workflow.md"),
    `---
name: Test
ui:
  - "apps/*/src/{components,app}/**"
  - "packages/{ui,editor,player}/src/**"
catalogue: docs/patterns
---
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

describe("catalogue-context", () => {
  it("names the person's rules first for a file the catalogue maps by path", () => {
    const out = run(context, [], {
      tool_input: { file_path: join(repo, "packages/player/src/components/Keypad.tsx") },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("docs/patterns/chat.md");
    expect(ctx).toContain("Javi, 11 October: The calculator opens in the field's place.");
    // The fixture's entry at the retired tier is still no person's: counted, not listed.
    expect(ctx).toContain(
      "- and 2 more rules there (shown already this session, or a product's or a source's).",
    );
    expect(ctx).toContain(
      "A new control follows the rules above; one that carries a decision gets its entry in the same change, and a free detail gets none.",
    );
    expect(ctx).not.toContain("Keys are drawn");
  });

  it("finds rules by the words of the file's name", () => {
    const out = run(context, [], {
      tool_input: { file_path: join(repo, "packages/player/src/components/PlayCalculator.tsx") },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("The calculator opens in the field's place");
    expect(ctx).not.toContain("Stop button");
  });

  it("meets a delete button in a brand-new file by the text being written", () => {
    const out = run(context, [], {
      tool_input: {
        file_path: join(repo, "apps/forum/src/components/RemoveMember.tsx"),
        content: "export function RemoveMember() {\n  return <button>Delete member</button>;\n}\n",
      },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("docs/patterns/destructive.md");
    expect(ctx).toContain("looks like delete");
    expect(ctx).toContain("Javi, 3 September: Deleting asks to confirm");
    expect(ctx).toContain("(2 rules; the text you are writing looks like delete)");
    expect(ctx).not.toContain("Undo where it is cheap");
  });

  it("says that nothing covers a control drawn where no rule matches: a known one to the research, a free detail to the everywhere rules", () => {
    const out = run(context, [], {
      tool_input: {
        file_path: join(repo, "apps/forum/src/components/Wizard.tsx"),
        content: "export function Wizard() {\n  return <ol><li>First</li></ol>;\n}\n",
      },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("No recorded design decision covers");
    expect(ctx).toContain(
      "It is free unless it carries a decision. Did Javi say how it should work and look? Then it is their call: build it and record it under their name. A control, flow or string people know from a product is looked up (the design-research skill: name the product, match the nearest pattern this project has, keep its look) and recorded as that product's; a new screen or flow is asked about first, by the skill. Anything else, a tooltip's words, an icon among a set, spacing, a line kept or cut, is free: build it by the catalogue's everywhere rules and the nearest pattern, record nothing, ask nothing, and end the turn with the line decisions: none (free: <the rule it follows>).",
    );
    expect(ctx).not.toContain("make your own call");
    expect(ctx).not.toContain("the agent's choice");
    expect(
      run(context, [], {
        tool_input: {
          file_path: join(repo, "apps/forum/src/components/Wizard.tsx"),
          new_string: "const n = 1;",
        },
      }),
    ).toBe("");
  });

  it("names the owner in the nothing-covers line", () => {
    const out = run(context, [], {
      tool_input: {
        file_path: join(repo, "apps/forum/src/components/Wizard.tsx"),
        content: "export function Wizard() {\n  return <ol><li>First</li></ol>;\n}\n",
      },
    });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("Did Javi say how");
  });

  it("says nothing in a project whose file names no catalogue", () => {
    const bare = mkdtempSync(join(tmpdir(), "catalogue-none-"));
    try {
      mkdirSync(join(bare, ".claude"));
      writeFileSync(join(bare, ".claude", "workflow.md"), "---\nname: Bare\n---\n");
      expect(
        run(
          context,
          [],
          { tool_input: { file_path: join(bare, "apps/forum/src/components/Keypad.tsx") } },
          { CLAUDE_PROJECT_DIR: bare },
        ),
      ).toBe("");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("reads a MultiEdit's replacements, a wrapped rule, quoted globs, and a name with regex characters", () => {
    const ctx = (input: object) =>
      JSON.parse(run(context, [], { tool_input: input })).hookSpecificOutput
        .additionalContext as string;
    expect(
      ctx({
        file_path: join(repo, "apps/forum/src/components/Plain.tsx"),
        edits: [{ old_string: "x", new_string: "<button>Delete it</button>" }],
      }),
    ).toContain("looks like delete");
    writeFileSync(
      join(repo, "docs", "patterns", "wrapped.md"),
      `---
paths:
  - 'apps/forum/src/components/Wrapped*.tsx'
signals:
  - "toast("
---

# Wrapped

- **A wrapped rule runs on
  to a second line.** (José Luis, 4 October)
`,
    );
    try {
      expect(
        ctx({ file_path: join(repo, "apps/forum/src/components/WrappedThing.tsx") }),
      ).toContain("José Luis, 4 October: A wrapped rule runs on to a second line.");
      expect(
        ctx({
          file_path: join(repo, "apps/forum/src/components/Other.tsx"),
          content: "toast(1); <div/>",
        }),
      ).toContain("docs/patterns/wrapped.md");
      expect(() =>
        run(context, [], {
          tool_input: { file_path: join(repo, "apps/forum/src/app/+page.svelte"), content: "<p/>" },
        }),
      ).not.toThrow();
    } finally {
      rmSync(join(repo, "docs", "patterns", "wrapped.md"));
    }
  });

  it("says nothing outside the UI paths or with no matching rule", () => {
    expect(run(context, [], { tool_input: { file_path: join(repo, "docs/data-model.md") } })).toBe(
      "",
    );
    expect(
      run(context, [], {
        tool_input: { file_path: join(repo, "apps/forum/src/components/Search.tsx") },
      }),
    ).toBe("");
  });
});

describe("a talk's catalogue: ids, inherits, tools, once per session", () => {
  let ws: string;
  let paper: string;
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "catalogue-ws-"));
    paper = join(ws, "paper");
    mkdirSync(join(ws, ".claude", "decisions", "slides"), { recursive: true });
    mkdirSync(join(paper, ".claude"), { recursive: true });
    mkdirSync(join(paper, "_talk"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "decisions", "slides", "title.md"),
      `---
signals:
  - "presenter"
---

# The title slide

- \`presenter-bold\` **The presenter's name is bold.** (Javi, 2026-10-21)
- \`title-size\` **The title is 40 point.** (per Wheeler, 3 October)
`,
    );
    writeFileSync(
      join(paper, "_talk", "decisions.md"),
      "# This talk\n\n- `presenter-bold` **The presenter's name is regular here.** (Javi, 2026-10-22) overrides slides/title#presenter-bold.\n",
    );
    writeFileSync(
      join(paper, ".claude", "workflow.md"),
      `---
name: Talk
form: compact
catalogue: _talk/decisions.md
inherits:
  - ../.claude/decisions
tools:
  - "mcp__powerpoint__ppt_(set|add)_.*"
---
`,
    );
  });
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  const call = (tool: string, session?: string) =>
    run(
      context,
      [],
      {
        ...(session ? { session_id: session } : {}),
        tool_name: tool,
        tool_input: { slide: 1, text: "The presenter, Javier" },
      },
      { CLAUDE_PROJECT_DIR: paper },
    );

  it("gives a writing call the rules its input signals, the project's override in the inherited one's place", () => {
    const ctx = JSON.parse(call("mcp__powerpoint__ppt_set_text")).hookSpecificOutput
      .additionalContext as string;
    expect(ctx).toContain("Recorded design decisions cover this call.");
    expect(ctx).toContain(
      "Javi, 2026-10-22: The presenter's name is regular here. (decisions#presenter-bold; overrides slides/title#presenter-bold)",
    );
    expect(ctx).not.toContain("The presenter's name is bold.");
    expect(ctx).toContain("../.claude/decisions/slides/title.md");
  });

  it("judges an MCP call by its tools entry even when its input has a file_path", () => {
    const out = run(
      context,
      [],
      {
        tool_name: "mcp__powerpoint__ppt_set_text",
        tool_input: { file_path: join(paper, "talk.pptx"), text: "The presenter" },
      },
      { CLAUDE_PROJECT_DIR: paper },
    );
    expect(out).toContain("regular here");
    expect(
      run(
        context,
        [],
        { tool_name: "mcp__files__read", tool_input: { file_path: join(paper, "_talk", "x.md") } },
        { CLAUDE_PROJECT_DIR: paper },
      ),
    ).toBe("");
  });

  it("says nothing for a call outside tools or a read-only one", () => {
    expect(call("mcp__powerpoint__ppt_get_slide")).toBe("");
    expect(call("mcp__other__write_thing")).toBe("");
  });

  it("shows an entry in full once per session, and again in another", () => {
    const session = `talk-${process.pid}`;
    try {
      expect(call("mcp__powerpoint__ppt_add_shape", session)).toContain("regular here");
      const second = call("mcp__powerpoint__ppt_add_shape", session);
      expect(second).not.toContain("regular here");
      expect(second).toContain("more rule");
      expect(call("mcp__powerpoint__ppt_add_shape", `${session}-b`)).toContain("regular here");
    } finally {
      for (const id of [session, `${session}-b`])
        rmSync(join(tmpdir(), `workflow-catalogue-${id}.json`), { force: true });
    }
  });

  it("reads a single-file catalogue for an edit", () => {
    writeFileSync(
      join(paper, ".claude", "workflow.md"),
      '---\nname: Talk\ncatalogue: _talk/decisions.md\nui:\n  - "_talk/**"\n---\n',
    );
    const ctx = JSON.parse(
      run(
        context,
        [],
        { tool_input: { file_path: join(paper, "_talk", "presenter-notes.md"), content: "x" } },
        { CLAUDE_PROJECT_DIR: paper },
      ),
    ).hookSpecificOutput.additionalContext as string;
    // plans/catalogue-hook-and-audit.md: one file with no paths governs every ui path.
    expect(ctx).toContain("_talk/decisions.md (1 rules; it governs this file)");
  });
});

/**
 * **One list, in the project file, and the hook's piece said once**
 * (plans/catalogue-hook-and-audit.md): a one-file catalogue with no `paths`
 * governs every `ui` path; its instruction is printed once a session.
 */
describe("a one-file catalogue with no paths", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "catalogue-one-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "workflow.md"),
      '---\nname: One\ncatalogue: docs/decisions.md\nui:\n  - "plugins/**"\n  - "INSTALL.md"\n---\n',
    );
    writeFileSync(
      join(dir, "docs", "decisions.md"),
      "# Decisions\n\n- `one-line` **Anyone installs by pasting one line.** (Javi, 2 November)\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const edit = (file: string, session?: string) =>
    run(
      context,
      [],
      {
        ...(session ? { session_id: session } : {}),
        tool_name: "Edit",
        tool_input: { file_path: join(dir, file), new_string: "x" },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
  const said = (out: string) =>
    out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "";

  it("governs every ui path, and nothing outside ui", () => {
    for (const file of ["INSTALL.md", "plugins/workflow/bin/plans"]) {
      const ctx = said(edit(file));
      expect(ctx, file).toContain(`Recorded design decisions cover \`${file}\``);
      expect(ctx, file).toContain("docs/decisions.md (1 rules; it governs this file)");
      expect(ctx, file).toContain("Anyone installs by pasting one line.");
    }
    expect(edit("test/a.test.ts")).toBe("");
    // An all-caps name is one word, so INSTALL.md finds the rules on installing.
    expect(nameWords("INSTALL.md")).toEqual(["install"]);
    expect(nameWords("PlayCalculator.tsx")).toEqual(["calculator"]);
    expect(nameWords("URLInput.tsx")).toEqual(["input"]);
    expect(nameWords("HTMLEditor.tsx")).toEqual(["editor"]);
    expect(nameWords("Step2Toolbar.tsx")).toEqual(["toolbar"]);
  });

  it("prints its instruction on a session's first context and not on the second, the header on both", () => {
    const session = `one-${process.pid}`;
    try {
      const first = said(edit("INSTALL.md", session));
      const second = said(edit("plugins/a.mjs", session));
      for (const ctx of [first, second]) expect(ctx).toContain("Recorded design decisions cover");
      expect(first).toContain("A rule with a person's name is their call");
      expect(second).not.toContain("A rule with a person's name is their call");
    } finally {
      rmSync(join(tmpdir(), `workflow-catalogue-${session}.json`), { force: true });
    }
  });
});

/**
 * **The kinds a small model names** (plans/catch-inconsistent-ui-at-build.md):
 * the Account case replayed, a settings page writing a confirmation as a
 * paragraph where the catalogue says the shared toast, caught though no path
 * or keyword reaches the toast rule; every call bounded and logged.
 */
describe("the kinds a small model names", () => {
  let dir: string;
  let marker: string;
  const log = () => {
    try {
      return readFileSync(join(dataDir, "catalogue-kinds.log"), "utf8");
    } catch {
      return "";
    }
  };
  const calls = () =>
    existsSync(marker) ? readFileSync(marker, "utf8").split("\n").length - 1 : 0;
  let n = 0;
  const session = () => `kinds-${process.pid}-${++n}`;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "catalogue-kinds-"));
    marker = join(dir, "called");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, "docs", "ui"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "workflow.md"),
      '---\nname: Kinds\ncatalogue: docs/ui\nui:\n  - "src/**"\n---\n',
    );
    writeFileSync(
      join(dir, "docs", "ui", "settings.md"),
      '---\npaths:\n  - "src/settings/**"\n---\n\n# The settings page\n\n- **Settings are grouped under a heading per service.** (Javi, 1 November)\n',
    );
    writeFileSync(
      join(dir, "docs", "ui", "toasts.md"),
      "# Confirmations and messages after an action\n\n- **A confirmation after an action is the shared toast.** (Javi, 30 October)\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const edit = (
    text: string,
    env: Record<string, string> = {},
    id = session(),
    file = "src/settings/Account.tsx",
  ) => {
    const out = run(
      context,
      [],
      { session_id: id, tool_input: { file_path: join(dir, file), new_string: text } },
      { CLAUDE_PROJECT_DIR: dir, FAKE_MARKER: marker, ...env },
    );
    rmSync(join(tmpdir(), `workflow-catalogue-${id}.json`), { force: true });
    return out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "";
  };
  const reset = () => {
    rmSync(marker, { force: true });
    rmSync(join(dataDir, "catalogue-kinds.log"), { force: true });
  };

  it("replays the Account case: the toast rule is loaded and listed first", () => {
    reset();
    const ctx = edit("<p>Google is connected</p>", { FAKE_ANSWER: "toasts.md" });
    expect(ctx).toContain(
      "toasts.md (1 rules; the text you are writing reads as Confirmations and messages after an action)",
    );
    expect(ctx).toContain("settings.md (1 rules; it governs this file)");
    expect(ctx.indexOf("the shared toast")).toBeLessThan(ctx.indexOf("grouped under a heading"));
    expect(calls()).toBe(1);
    expect(log()).toMatch(/ src\/settings\/Account\.tsx \d+ 0\.0003 docs\/ui\/toasts\.md\n$/);
  });

  it("lists only the path's rules when the model answers none", () => {
    reset();
    const ctx = edit("<p>Google is connected</p>");
    expect(ctx).toContain("settings.md");
    expect(ctx).not.toContain("toasts.md");
    expect(log()).toMatch(/ none\n$/);
  });

  it("makes no call for a text that neither draws nor reads, or in a project with no catalogue", () => {
    reset();
    edit("const n = 1;", { FAKE_ANSWER: "toasts.md" });
    expect(calls()).toBe(0);
    const bare = mkdtempSync(join(tmpdir(), "catalogue-bare-"));
    try {
      mkdirSync(join(bare, ".claude"), { recursive: true });
      writeFileSync(
        join(bare, ".claude", "workflow.md"),
        '---\nname: Bare\nui:\n  - "src/**"\n---\n',
      );
      run(
        context,
        [],
        {
          session_id: session(),
          tool_input: {
            file_path: join(bare, "src/a.tsx"),
            new_string: "<p>Google is connected</p>",
          },
        },
        { CLAUDE_PROJECT_DIR: bare, FAKE_MARKER: marker },
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(calls()).toBe(0);
  });

  it("leaves the context as it is and logs one line when the call fails or times out", () => {
    const plain = (reset(), edit("<p>Google is connected</p>"));
    for (const env of [{ FAKE_EXIT: "1" }, { FAKE_SLEEP: "2", WORKFLOW_KINDS_TIMEOUT_MS: "200" }]) {
      reset();
      expect(edit("<p>Google is connected</p>", { FAKE_ANSWER: "toasts.md", ...env })).toBe(plain);
      const lines = log().trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/ not run: (failed|timeout)$/);
    }
  });

  it("asks once for the same text in a session, and not past sixty calls", () => {
    reset();
    const id = `kinds-twice-${process.pid}`;
    const state = join(tmpdir(), `workflow-catalogue-${id}.json`);
    try {
      for (let i = 0; i < 2; i++)
        run(
          context,
          [],
          {
            session_id: id,
            tool_input: {
              file_path: join(dir, "src/settings/Account.tsx"),
              new_string: "<p>Google is connected</p>",
            },
          },
          { CLAUDE_PROJECT_DIR: dir, FAKE_MARKER: marker, FAKE_ANSWER: "toasts.md" },
        );
      expect(calls()).toBe(1);
      expect(log()).toMatch(/ cached\n$/);
      reset();
      writeFileSync(state, JSON.stringify({ shown: [], calls: 60, answers: {} }));
      run(
        context,
        [],
        {
          session_id: id,
          tool_input: {
            file_path: join(dir, "src/settings/Account.tsx"),
            new_string: "<p>Saved</p>",
          },
        },
        { CLAUDE_PROJECT_DIR: dir, FAKE_MARKER: marker },
      );
      expect(calls()).toBe(0);
      expect(log()).toMatch(/ budget\n$/);
    } finally {
      rmSync(state, { force: true });
    }
  });

  it("names files by their label, the bare name an alias only when no other file shares it", () => {
    const file = (label: string) => ({
      single: false,
      name: "toasts.md",
      label,
      title: "Toasts",
      entries: [{}],
    });
    expect(menuOf([file("docs/ui/toasts.md")])).toEqual([
      { name: "docs/ui/toasts.md", alias: "toasts.md", line: "docs/ui/toasts.md: Toasts" },
    ]);
    expect(
      menuOf([file("../shared/toasts.md"), file("docs/ui/toasts.md")]).map((m) => m.alias),
    ).toEqual(["", ""]);
  });

  it("takes the longest name the answer gave, and a file by its bare stem", () => {
    const menu = [
      { name: "Errors", line: "Errors: x" },
      { name: "Errors in forms", line: "Errors in forms: y" },
      { name: "docs/ui/feedback.md", alias: "feedback.md", line: "docs/ui/feedback.md: z" },
    ];
    const ask = (result: string) => () => ({ result });
    expect(kindsFor("t", menu, ask("Errors in forms")).names).toEqual(["Errors in forms"]);
    expect(kindsFor("t", menu, ask("feedback")).names).toEqual(["docs/ui/feedback.md"]);
    expect(kindsFor("t", menu, ask("none")).names).toEqual([]);
    expect(
      kindsFor("t", menu, () => {
        throw Object.assign(new Error("x"), { code: "ENOENT" });
      }),
    ).toEqual({ names: null, reason: "no claude" });
  });

  it("does not ask again for a text whose call failed", () => {
    reset();
    const id = `kinds-failed-${process.pid}`;
    const input = {
      session_id: id,
      tool_input: {
        file_path: join(dir, "src/settings/Account.tsx"),
        new_string: "<p>Google is connected</p>",
      },
    };
    try {
      for (let i = 0; i < 2; i++)
        run(context, [], input, { CLAUDE_PROJECT_DIR: dir, FAKE_MARKER: marker, FAKE_EXIT: "1" });
      expect(calls()).toBe(1);
      expect(log()).toMatch(/ cached\n$/);
    } finally {
      rmSync(join(tmpdir(), `workflow-catalogue-${id}.json`), { force: true });
    }
  });

  it("reads a chattering answer for the names in it", () => {
    reset();
    const ctx = edit("<p>Google is connected</p>", { FAKE_ANSWER: "Looking at this... toasts.md" });
    expect(ctx).toContain("toasts.md (1 rules; the text you are writing reads as");
  });

  it("offers a one-file catalogue's sections, and loads only the named one", () => {
    const one = mkdtempSync(join(tmpdir(), "catalogue-sections-"));
    try {
      mkdirSync(join(one, ".claude"), { recursive: true });
      writeFileSync(
        join(one, ".claude", "workflow.md"),
        '---\nname: One\ncatalogue: decisions.md\nui:\n  - "src/**"\n---\n',
      );
      writeFileSync(
        join(one, "decisions.md"),
        "---\n# a comment, not the title\n---\n\n# Decisions\n\n## Messages\n\n```\n## Not a section\n```\n\n- **A confirmation after an action is the shared toast.** (Javi, 30 October)\n\n## Buttons\n\n- **A destructive button is red.** (Javi, 30 October)\n",
      );
      const id = session();
      const out = run(
        context,
        [],
        {
          session_id: id,
          tool_input: {
            file_path: join(one, "src/a.tsx"),
            new_string: "<p>Google is connected</p>",
          },
        },
        { CLAUDE_PROJECT_DIR: one, FAKE_ANSWER: "Messages" },
      );
      rmSync(join(tmpdir(), `workflow-catalogue-${id}.json`), { force: true });
      const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain("decisions.md (2 rules; the text you are writing reads as Messages)");
      expect(ctx).toContain("the shared toast");
      expect(ctx).not.toContain("destructive button is red");
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  });
});
