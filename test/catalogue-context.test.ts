import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * **The catalogue's hook** (`catalogue-context.mjs`, docs/workflow.md,
 * "Decisions"): the rules recorded for the control being edited, in the
 * context before the edit, read through the project file's `catalogue` and
 * `ui`. A port of the first project's own hook and its cases.
 */
const context = new URL("../plugins/workflow/scripts/catalogue-context.mjs", import.meta.url)
  .pathname;

let repo: string;

/** The hook as Claude Code runs it: an input with no tool named is an Edit's. */
function run(script: string, args: string[], input: object, env: Record<string, string> = {}) {
  return execFileSync("node", [script, ...args], {
    input: JSON.stringify({ tool_name: "Edit", ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_OPTION_OWNER: "Javi", ...env },
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
    expect(ctx).toContain("2 more rules");
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

  it("says that nothing covers a control drawn where no rule matches, and sends it to the research", () => {
    const out = run(context, [], {
      tool_input: {
        file_path: join(repo, "apps/forum/src/components/Wizard.tsx"),
        content: "export function Wizard() {\n  return <ol><li>First</li></ol>;\n}\n",
      },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("No recorded design decision covers");
    expect(ctx).toContain("design-research");
    expect(ctx).toContain("skips the question, never the research");
    expect(ctx).not.toContain("make your own call");
    expect(ctx).toContain("for a new screen or flow, the skill's question comes first");
    expect(ctx).toContain(
      "any control other than a new screen or flow, large or small, skips the question, never the research",
    );
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
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("did Javi say how");
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
    expect(ctx).toContain("_talk/decisions.md (1 rules; its rules name this control)");
  });
});
