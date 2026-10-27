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

function run(script: string, args: string[], input: object, env: Record<string, string> = {}) {
  return execFileSync("node", [script, ...args], {
    input: JSON.stringify(input),
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

  it("says that nothing covers a control drawn where no rule matches, and asks for the question", () => {
    const out = run(context, [], {
      tool_input: {
        file_path: join(repo, "apps/forum/src/components/Wizard.tsx"),
        content: "export function Wizard() {\n  return <ol><li>First</li></ol>;\n}\n",
      },
    });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("No recorded design decision covers");
    expect(ctx).toContain("design-research");
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
