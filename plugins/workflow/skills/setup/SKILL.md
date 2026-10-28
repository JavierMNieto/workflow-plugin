---
name: setup
description: Sets a project up for the workflow in a short interview, what the project is for and what its owner mostly does there, then the project file, the plugins it turns on and the connectors it keeps, with the defaults for that kind of project and a line on how to reach the rest. Use when a project has no .claude/workflow.md, when the owner asks to set the project up or change its setup, or when a project's form, reviews, catalogue, plugins or connectors no longer fit.
model: fable
effort: high
---

# Setting a project up

You write the project's files and nothing else: its
`.claude/workflow.md`, the `enabledPlugins` key of its
`.claude/settings.json`, and the whole-connector entries of
`permissions.deny` in that file or in `.claude/settings.local.json`
(step 5 says which), with the `.gitignore` lines `plans init` adds for
the queue's own files when it runs, and the one for
`.claude/settings.local.json` when you write it, and the `GH_TOKEN`
line of `.devcontainer/devcontainer.json`'s `containerEnv` (step 6).
Never the user settings, `.mcp.json` or a catalogue; never a commit,
which is the owner's. The defaults for each kind of project are in
[kinds.md](kinds.md); the rules the keys follow are in the workflow
plugin's docs, "The project file" and "Decisions".

## 1. Look first

- `.claude/workflow.md` when there is one: a run again keeps every answer
  in it as the recommended option.
- `git rev-parse --show-toplevel` and the remote's default branch, and
  with a GitHub remote, `gh api repos/{owner}/{repo}/collaborators`, for
  whether someone besides the owner builds here.
- `.github/workflows/*.yml`, for a `run`.
- `.mcp.json` and `.claude/`, for what is there.
- `claude plugin list --json`, for the plugins on here.
- The connectors: those this session has, from its tool names
  (`mcp__claude_ai_<connector>__<tool>`: the part between
  `mcp__claude_ai_` and the next `__`), and those `permissions.deny` in
  `.claude/settings.json` or `.claude/settings.local.json` already
  denies whole, whose tools a session here no longer sees; with the
  other entries of `permissions.deny`.
- GitHub access: `.devcontainer/devcontainer.json` when there is one,
  for a `containerEnv` and whether it holds `GH_TOKEN`;
  `gh auth status --hostname github.com` (exit 0 is signed in; 1, or no
  `gh`, is not).
  Never print a token: the status line names the login, the file names
  the variable.
- `ls` of the root, for the kind: a `package.json` (a web app or a
  service), `*.tex` (a paper), a `_talk/` folder, a `.pptx` or an
  `mcp.json` for slides (a talk).

## 2. Ask, four questions in one call

With the question tool, by "Asked in plain words" in the workflow's
docs, the recommended option first and marked, each
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

That call gains **the landing**, asked whenever step 1 found a
repository and the answer was the full queue (the maker has no pull
request mode, so a compact project is not asked and gets no `land`): header `Landing`, question `This is about how a finished
change reaches the shared branch. Today the queue pushes it there as soon
as its checks pass. When more than one person builds here, each can
instead get a pull request to read first, with the design decisions and
screenshots on top, and merge it himself.`, options `A pull request to
merge`, description `Nothing lands until one of you merges it; each
change waits on a person`, and `Pushed straight`, description `Lands the
moment the checks pass; nobody reads it first`. The pull request is first
and marked recommended when the collaborators list someone besides the
owner, else second, and pushing straight is recommended; on a run again,
the file's answer is the recommended one. The answer writes `land:
pull-request`, or takes the line out. When the call would then hold more
than four questions (the tool's limit), the landing is asked in a call of
its own after it.

Then, in a call of its own, **which connectors a chat here uses**: the
connectors step 1 found, as multi-select questions of at most four
options each (up to four questions; the question tool takes no more),
the ones matching the kind's role in the table's "Connectors" column
marked recommended. On a run again the recommendation is still the
role's, and each option says whether the connector is on or denied
here now, since nothing records which were chosen and a connector added
to the account since is not denied either. A connector no question
showed is left as it is, never denied unasked. When step 1 found no
connector, the call is not made.

## 4. Write the project file

`plans init` when there is none (it writes the starter and the
`.gitignore` lines). Then the frontmatter keys from the answers
(`form`, `branch`, `run`, `land`, `ui`, `catalogue`, `inherits`,
`tools`, `mcp`, `reviews`), the commented lines of keys not used left in place,
and only the body's empty or missing headings filled with what step 1
found: **While working** from `package.json` scripts or a Makefile,
**Reading** from the tools on (the kinds table's reading tools, none
for every kind: then the built-in Grep, Glob and Read), **Products**
empty with its explaining line. On a run again, every key the answers
did not change and every heading's text stay as they are. A talk or a
paper synced with Overleaf names no `branch`: take out the `branch:`
line `plans init` wrote, so the maker never commits there.

## 5. Write the plugins and the connectors

`enabledPlugins` in the project's `.claude/settings.json`, merged into
what is there with every other key kept:

- `writing@workflow` true for a paper or a talk, false otherwise;
- `codex@openai-codex` true when Codex is among the reviews, false
  otherwise;
- false for every plugin `claude plugin list` shows on that neither the
  table names for this kind nor a chosen review needs, so a stray from
  the user settings is off here; a plugin a chosen review needs stays on.

Never write `workflow@workflow`: it is the user settings'.

`permissions.deny`, when the connectors were asked, in one of two
files. **`.claude/settings.local.json`**, per person and git-ignored,
when `.claude/settings.json` is tracked
(`git ls-files --error-unmatch .claude/settings.json`) in a repository
that is public (`gh repo view --json visibility` says `PUBLIC`) or
shared (`gh api repos/{owner}/{repo}/collaborators` lists someone
besides the owner): there the list would publish the owner's connector
names and deny collaborators connectors that are not theirs (Javi, 27
October). Add `.claude/settings.local.json` to `.gitignore` when it is
not there. **`.claude/settings.json`** otherwise, which travels with
the project to the owner's other machines. When `gh` cannot tell, the
local file. A whole-connector entry the other file holds moves with the
rest, so the list is in one file. The entries: one
`mcp__claude_ai_<connector>` for each connector shown and not
chosen, which denies the whole connector, every tool in it, in every
chat here. Remove such an entry for a connector now chosen, whoever
wrote it: the owner's answer is the latest word on that connector. Touch
nothing else in `permissions`: an entry that is not a whole connector
(`mcp__claude_ai_<connector>__<tool>`, a `Bash(...)` rule, another
server's) stays as it is, and so do `allow` and `ask`. A project's
setting is the place because it holds for every chat in the project and
for no other project; the user settings would turn the connector off
everywhere. A connector some agents here need and others must not reach
is not denied here: that is the project file's `deny` key (the workflow
docs, "The project file"), which the setup does not write. The list is
of the connectors there were: one added to the account later reaches
every chat here until the setup runs again, which the final message
says.

## 6. The GitHub token

The queue's chats push and read runs with a token the host keeps in
`GH_TOKEN` (the workflow docs, "Installing"): it reaches a container
through `containerEnv`, which every process there sees, where
`remoteEnv` reaches VS Code's terminals only. With a
`.devcontainer/devcontainer.json`, add
`"GH_TOKEN": "${localEnv:GH_TOKEN}"` to its `containerEnv` by Edit:
into the object when there is one, else a new
`"containerEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }` key after
`remoteEnv` or, without one, last in the file, with the file's own
indentation; a file with comments
stays as it is but for that line (an Edit, never a parse and a rewrite).
A line already there is left alone. Without a `.devcontainer/`, write
nothing: the host's shell has to carry the variable to the chats, which
the final message says. Never a token's value in any file.

## 7. Say what is on and what it costs

One line each, from the counts you can take (each plugin's `skills/` and
`agents/` directories in its install path):

- `writing: on; 6 skills, whose names and descriptions are in context
  on every turn; their bodies load when used.`
- `codex: on; 1 skill, 1 agent; the review runs once per plan.`
- `<plugin>: off here (it was on in your user settings).`
- `MCP: <server> from <config>, in every chat here.`
- `Connectors: <chosen> on here; <denied> off (permissions.deny).`,
  naming the file it is in.
- One `GitHub:` line, from step 1's look:
  - `GitHub: GH_TOKEN reaches this container (containerEnv); gh is signed in as <login>.`
  - `GitHub: GH_TOKEN added to devcontainer.json (containerEnv); rebuild the container with GH_TOKEN set on the host, then gh signs in with it.`,
    when the line was written or the status is not signed in with the
    line present.
  - `GitHub: no gh in this container; the dotfiles install it and wire it to git when GH_TOKEN is set.`,
    when `gh` is absent.
  - `GitHub: no .devcontainer here; GH_TOKEN must be in the shell that starts the queue's chats.`

Then: `/context in a chat here shows the numbers.`

## 8. Say how to reach the rest

From the kind's row of the table, in a line: for a paper set to the
maker, `For a restructuring or a full copy edit, the full queue: remove
form: compact, then claude (the assistant) and a brief for the
planner.`; for a web project, `For a quick fix in one chat, plans chat
with form: compact set for the day.`

## 9. The final message

The two files' paths (and the devcontainer file's, when step 6 wrote
it), the keys set, the plugins on and off with their
cost lines, the connectors on and off (and that a connector added to
the account later is on here until the setup runs again), and the line
to reach the rest. Nothing is committed.
