---
name: setup
description: Sets a project up for the workflow in a short interview, what the project is for and what its owner mostly does there, then the project file and the plugins it turns on, with the defaults for that kind of project and a line on how to reach the rest. Use when a project has no .claude/workflow.md, when the owner asks to set the project up or change its setup, or when a project's form, reviews, catalogue or plugins no longer fit.
model: fable
effort: high
---

# Setting a project up

You write two files and nothing else: the project's
`.claude/workflow.md` and the `enabledPlugins` key of its
`.claude/settings.json` (and the `.gitignore` lines `plans init` adds for
the queue's own files, when it runs). Never the user settings, `.mcp.json` or a
catalogue; never a commit, which is the owner's. The defaults for each
kind of project are in [kinds.md](kinds.md); the rules the keys follow
are in the workflow plugin's docs, "The project file" and "Decisions".

## 1. Look first

- `.claude/workflow.md` when there is one: a run again keeps every answer
  in it as the recommended option.
- `git rev-parse --show-toplevel` and the remote's default branch.
- `.github/workflows/*.yml`, for a `run`.
- `.mcp.json` and `.claude/`, for what is there.
- `claude plugin list --json`, for the plugins on here.
- `ls` of the root, for the kind: a `package.json` (a web app or a
  service), `*.tex` (a paper), a `_talk/` folder, a `.pptx` or an
  `mcp.json` for slides (a talk).

## 2. Ask, four questions in one call

With the question tool, the recommended option first and marked, each
option saying what it brings. The kinds table gives each question's
recommended option from the kind step 1 found.

- **What is this project?** A web app or a service; a paper; a talk; a
  personal tool or script; something else (say what).
- **What do you mostly do here?** Many small changes in one chat (the
  maker); changes worth planning first (the full queue); both, mostly
  small (the maker, with the full queue a line away).
- **Which reviews before a push?** All three (the plan review,
  `/code-review`, Codex); one light one (`/code-review`); the writing
  ones (`writing:review`, `writing:proof`); none (the compact form).
- **What does the catalogue watch?** Screens (paths a user sees);
  slides (tool calls); `.tex` and `.bib` files; nothing yet.

## 3. Ask again only for what the answers need

One more call at most: the catalogue's place (a directory or a file)
and a catalogue it inherits; the MCP config a chat here needs and the
pattern of its writing calls; the `ui` globs when screens were chosen
and step 1 found no obvious ones; the branch when none was detected. A
question the table answers is not asked.

## 4. Write the project file

`plans init` when there is none (it writes the starter and the
`.gitignore` lines). Then the frontmatter keys from the answers
(`form`, `branch`, `run`, `ui`, `catalogue`, `inherits`, `tools`,
`mcp`, `reviews`), the commented lines of keys not used left in place,
and only the body's empty or missing headings filled with what step 1
found: **While working** from `package.json` scripts or a Makefile,
**Reading** from the tools on (the kinds table's reading tools, none
for every kind: then the built-in Grep, Glob and Read), **Products** empty with its explaining
line. On a run again, every key the answers did not change and every
heading's text stay as they are. A talk or a paper synced with Overleaf
names no `branch`: take out the `branch:` line `plans init` wrote, so
the maker never commits there.

## 5. Write the plugins

`enabledPlugins` in the project's `.claude/settings.json`, merged into
what is there with every other key kept:

- `writing@workflow` true for a paper or a talk, false otherwise;
- `codex@openai-codex` true when Codex is among the reviews, false
  otherwise;
- false for every plugin `claude plugin list` shows on that neither the
  table names for this kind nor a chosen review needs, so a stray from
  the user settings is off here; a plugin a chosen review needs stays on.

Never write `workflow@workflow`: it is the user settings'.

## 6. Say what is on and what it costs

One line each, from the counts you can take (each plugin's `skills/` and
`agents/` directories in its install path):

- `writing: on; 6 skills, whose names and descriptions are in context
  on every turn; their bodies load when used.`
- `codex: on; 1 skill, 1 agent; the review runs once per plan.`
- `<plugin>: off here (it was on in your user settings).`
- `MCP: <server> from <config>, in every chat here.`

Then: `/context in a chat here shows the numbers.`

## 7. Say how to reach the rest

From the kind's row of the table, in a line: for a paper set to the
maker, `For a restructuring or a full copy edit, the full queue: remove
form: compact, then claude (the assistant) and a brief for the
planner.`; for a web project, `For a quick fix in one chat, plans chat
with form: compact set for the day.`

## 8. The final message

The two files' paths, the keys set, the plugins on and off with their
cost lines, and the line to reach the rest. Nothing is committed.
