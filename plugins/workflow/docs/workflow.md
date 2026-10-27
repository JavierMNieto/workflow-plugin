# The workflow

Three agents and a plan queue, in any project: the assistant answers and
routes, the planner writes a plan, the executor builds it and pushes. The
owner's part is the decisions. Each rule below is named by its bold
lead-in; the agent files cite them by that name.

## The three agents

**Plan, then build, in two sessions.** A change of any size is planned by
one session and built by another, with the context cleared between, which
is what Anthropic's own best practices recommend (interview with the
question tool, write a self-contained spec, execute it in a fresh session)
and what spec-driven development does without its ceremony: the plan is
the spec for one change, and the project's docs are the standing context
that outlives it. The three agents are this plugin's, each run as the
whole session, since a subagent cannot use the question tool:

- `claude --agent workflow:planner` (Fable, effort high) researches the
  products people know, grounds the change in the project's docs and
  code, makes the calls, puts what research cannot settle to the owner
  through the question tool, and writes one file under `plans/`. It
  changes nothing else.
- `claude --agent workflow:executor --effort high` (Opus; the flag, since
  a settings file's effort for the model outranks the agent file's) is
  handed the plan's path, or several, and builds them in order on a branch
  of its own: the plan's steps, the project's checks, three reviews (a
  fresh subagent's against the plan, `/code-review` and Codex's for bugs),
  the project's suites once per batch, one commit per plan, the
  fast-forward push to the project's branch and its run, then a "Built"
  section in the plan with the deviations. That section ends with "Needs
  a decision", each item sized ask, assistant or planner.
- `claude --agent workflow:assistant` (Opus, effort medium) is the
  conversation before either: it answers from the repository with
  sources, writes a message for a person the project names, a short plan
  for the executor or a brief for the planner, and changes nothing else.
- `claude --agent workflow:maker` (Opus, effort high) is the compact
  form's one chat, for a project whose file says `form: compact`: it
  decides as the planner does and builds as the executor does, with no
  queue, no batch branch and no plan file, the owner's message being the
  plan, and records every decision in the catalogue.

The plugin's `settings.json` makes the assistant the default agent of a
chat opened with no `--agent` flag; the flag overrides it, so the queue's
starts are unaffected.

**Reading beside a build**: the planner and the assistant stay in the one
checkout while the executor builds there. One that finds the tree dirty
at a session's start (`git status`), or is told a file changed on disk,
reads that file from the project's branch (`git show
origin/<branch>:<path>`), names functions rather than line numbers for it
in the plan, and says in the plan which files were read that way. A plan's
line numbers are as of the branch when it was written.

**The planner and the assistant read the specifics themselves and hand out
only bounded, read-only sweeps**: a wide question with one answer shape, a
turn limit, nothing that writes. **A plan is built once it is written**:
the planner asks about order only when another plan already waits for the
executor, and a dependency on an earlier plan is written into the plan.

**Which session a topic goes to.** The assistant ends every topic in one
of four exits: answered; a message for a person the project names, which
the owner sends; a short plan for the executor; or a brief for the
planner, which the planner's plan replaces. A change you can describe in a
few sentences, inside rules the project already holds, with no schema or
privacy change and no rule a person's name is on reversed, is a short
plan, as Anthropic's best practices say a diff you can describe in a
sentence needs no plan; anything else goes to the planner, as Shape Up
keeps a small batch and a big batch apart, each with one way in.

**Every new topic starts in the assistant's chat.** A planner's chat is
for the plans it wrote, and the next brief when it has room: each plan
stays the chat's until an executor starts it; the `## Building` line the
executor writes is the cut-off, after which the plan is the executor's
and the planner's chat only points a change to the assistant's. An
executor's follow-ups, the "Needs a decision" items in its Built section,
go to the assistant too, through the owner's to-do page when the project's
memory names one and a message to an idle assistant chat; the owner does
not carry them. No chat sends the owner a command to run.

## The project file

**A project's part is one file, `.claude/workflow.md`**: frontmatter the
hooks read and a body the agents read, the shape Claude Code uses for
agents and skills.

```
---
name: Docs                # the project's name in session names
branch: test              # the branch the executor pushes, fast-forward
run: checks.yml           # the Actions workflow read after a push; omit for none
ui:                       # paths a user sees, for the turn audit; omit for none
  - "src/components/**"
catalogue: docs/patterns  # the design catalogue: a directory or one file; omit for none
inherits:                 # catalogues this one overrides by id, farthest first
  - ../.claude/decisions
tools:                    # tool names whose calls change what a person sees
  - "mcp__server__write_.*"
mcp:                      # MCP configs every chat here gets (plans chat, plans start)
  - .mcp/server.json
deny:                     # MCP tools an agent here may never call, by agent
  assistant:
    - "mcp__server__write_.*"
form: compact             # one chat decides and builds; omit for the full queue
reuse: 200000             # the context, in tokens, above which a finished session retires
reviews:                  # the reviews before a push; omit for all three (none when compact)
  - code-review
note: \JaviAI             # the writing plugin's note command; omit for notes in the report
reply: \javi              # the command the author answers notes with
---
```

**`form: compact` is the compact form**: one chat, `workflow:maker`,
decides and builds; the queue's hooks do nothing, and `plans` says so.
Absent, the full form: the three agents and the queue. A project moves
between them by this line alone: the catalogue, the project file's
headings and the branch are the same in both, so nothing is converted,
and the maker says when a change has outgrown the compact form. `branch`
may be omitted in a compact project: the maker then commits nothing, and
a project file needs no repository around it.

**`mcp` names the MCP configs a chat here needs** (a PowerPoint bridge, a
database), which `plans chat` and every chat the queue starts pass on the
command line, so the tools exist in the project's chats and nowhere else;
what the user settings load is loaded too. `plans chat` is the way to open the
maker or the assistant in a project with `mcp` or `inherits` (each
inherited catalogue an added directory). A token in such a config stays
where the config keeps it; `plans chat` prints the path, never the file.

**`deny` keeps an agent off a tool the project gives another.** The key
maps an agent of the plugin (`assistant`, `planner`, `executor`,
`maker`, `reviewer`) to tool-name patterns, regular expressions matched
whole as `tools` are, MCP names only (`mcp__server__.*` a whole server,
`mcp__(claude_ai_)?server__.*` a connector in both its forms); the
plugin's `PreToolUse` hook (`scripts/tool-denials.mjs`) refuses a call
that matches with the reason, in both forms and in every chat here, and
a subagent is held to its session's agent's list as well as its own. The
tool stays listed; the
call never runs. A plugin agent's own frontmatter cannot be extended
from a project, and a settings `permissions.deny` holds for every agent
alike, which is what the setup's whole-connector denies are for: a
connector no chat here needs is denied there, whole; one that some
agents here need and others must not reach is `deny`. `plans check`
lints the key: a list with no agent's name over it, an agent the plugin
has no file for, a pattern that is not a regular expression or cannot
name an MCP tool.

The name defaults to the directory's, the branch to the remote's default
(with no remote, `plans init` writes the branch checked out when the file
was written).
The body's headings are the executor's steps for this project: **Before a
build** (installs, generated code), **While working** (which tests to run
for one change), **Before the push** (screenshots, checks, suites, in
order), **After the push** (what to watch), **Reading** (which tools read
code and docs here), **Products** (one line per kind of thing the project
makes, the product people know for it, which the `design-research` skill
follows first). It may also name the people whose calls are theirs
(the assistant's second exit), the tools that publish under the owner's
name (which no agent calls), and headings of its own for the assistant.
`plans init` writes a starter. **A project is set up in a short
interview**, `/workflow:setup` in the assistant's or the maker's chat:
what the project is for, what the owner mostly does there, which
reviews, what the catalogue watches, asked once with the defaults of
that kind of project (the skill's `kinds.md`), then the project file
and the plugins' on and off written and the cost of each thing on said
in a line. Run again, it keeps the answers as the defaults. **A
project turns off the connectors it does not use**: the setup asks which
of the session's claude.ai connectors a chat here needs and denies the
rest, whole (`mcp__claude_ai_<connector>`), in the project's
`.claude/settings.json`, or its `.claude/settings.local.json` when the
first is tracked in a public or shared repository (the names would be
published), since the account's connectors otherwise reach
every chat in every project, and a project setting holds for every chat
there and nowhere else. It adds and removes only whole-connector
entries, so every other deny stays, and a connector added to the
account later is on until the setup runs again. **A project
with no project file is not
the workflow's**: the plugin's hooks do nothing there, `plans` says so and
`plans start` refuses, so a project with hooks of its own keeps them until
its file lands.

## Decisions

**The catalogue is the record.** The project file's `catalogue` names a
directory (a `README.md` with the rules that apply everywhere and a table
of the files, then one file per kind of thing a person sees, at any
depth) or one file, each rule a bold list item ending with its tier and
date. What is not there was not decided, as far as the next agent can
tell. The long reasoning is in `plans/`; the entry names the plan when
there is one. An entry may open with an id in backticks, ``- `presenter-bold`
**The presenter's name is bold.** (Javi, 2026-10-21)``, and is then cited
as `file#id` in replies, plans and the project's own notes; a rule that
replaces one keeps the old line struck through under it. The date is
written as the project writes dates, `21 October` or `2026-10-21`.

**A catalogue inherits others.** `inherits` lists catalogues above the
project's (a workspace's, every talk's), farthest first; the project's
entry of the same id overrides an inherited one, says so with
`overrides <file>#<id>`, and the edit-time hook shows the project's with
the one it overrides named. `plans check` lints every catalogue the
project file names: the tier and date on every entry, an id used twice,
an override naming no inherited id; and the `deny` key (above).

**The tier says who may change a rule.** A person's name is their call; a
named product (`as GitHub does`) is replaced only by a better-grounded
standard, named, as is one `per <source>` (a written source) or
`observed in <x>` (measured in an existing artifact); `the agent's
choice` is changed with a reason. A
replaced rule stays struck through under its replacement with its date; a
retired one is struck through with "retired". (MADR's accepted,
superseded and deprecated, in the catalogue's shape.)

**A rule whose reason is gone is put to the owner, not followed**: the
component deleted, the bug impossible, the product changed. The agent
asks keep, change or retire with the question tool, and the rule stands
until the answer. A plan that deletes or replaces a thing lists the rules
resting on it first.

**A decision is recognized in three places**: a plan's "Decided" section
and the entries it drafts; an edit under `ui`, where the turn audit asks
for the entry; and the chat, where a correction or a preference from the
owner is recorded under their name in the same turn; the audit cannot
read the chat, so it watches the effect: a turn that changed what a
person sees and recorded nothing is asked once.

**A decision is found again in three ways**: the README's everywhere
rules, which `CLAUDE.md` or a rule file without `paths` loads always; a
catalogue file's `paths` and `signals`, which the plugin's edit-time hook
(`scripts/catalogue-context.mjs`) matches before an edit, or before a
call to one of the project's `tools` against the call's inputs, each
entry shown in full once per session and again after a compaction; and
the
`design-research` skill, which the agent reaches for when nothing covers
a thing.

**The audit's checks**: a path under `ui` changed, or a call to one of
the `tools` made, and nothing in the catalogue written, answered by the
entry or a `decisions: none (<why>)` line; a rule written without its
tier and date. Each is refused once, and the second stop passes.

**The talk setup retires into the plugin.** A talk's agent file is the
maker with a project file (`mcp`, `inherits`, `tools`, `catalogue`, no
`branch`) opened by `plans chat`; its slide-editing turn (the PowerPoint
steps, which the plugin never names) is a skill of the talk workspace
with `paths` on the talk's folder. A decision-research skill is
`design-research`, whose tiers now take `per <source>` and `observed in
<x>` and whose research reads the catalogue's `sources.md`. Its context,
stop and check scripts are the edit-time hook, the audit and `plans
check`. A talk's decisions file is read as it is.

## The queue

Plans reach the executor without the owner carrying them, with no agent
and no daemon of their own. A plan's state is in its file: `## Built` is built
(its commit the first eight-hex word there); `## Building, <date>,
session <id>`, written by the executor when it starts the plan, is being
built while that session lives; `## Handing over` with no Built is handed
over and resumed first; a `Plan only` or `Short plan` header dated 24
October 2026 or later (as `26 October 2026` or `2026-10-26`) with none of
these is ready (asking the owner when its "Decisions for <owner>" has a
numbered item and no "Decided"); older unbuilt plans are listed by path.
`plans` prints the table, which every executor message ends with. The
planner and the assistant hand a finished plan over themselves: one
`SendMessage` to the live executor, which an idle one acts on in seconds,
or `plans start` when none is alive.

`scripts/plan-queue.mjs` does the rest on the hooks: the executor's prompt
hook takes the lock (`.claude/executor.lock`), and its tool hook refuses
edits and writing commands to an executor that does not hold it, so one
checkout has one executor; its Stop hook refuses a stop on a red or
unfinished run of the session's push (the project's `run`), then names the
waiting plans to a session that may be reused (`mayReuse`: no
compaction, or one and a waiting plan names a file the batch changed,
counted from where the batch's first Building line was written; a
context under the reuse ceiling, the project file's `reuse`, 200k tokens
by default; a cache still warm, or a context too small to matter), or
retires the session and starts a fresh executor, since every turn
re-reads the whole context at the cache-read price and a fresh
session's first turn is 50k tokens; `plans start` replaces an idle
session the rule rejects instead of refusing, and `plans` shows each
live session's context and warmth (`618k context, warm`);
after a third compaction inside one plan the session hands the plan over
(work committed on the branch, a "Handing over" section, stop), up to six
times per plan, and a plan handed over twice at the same step stops and
asks the owner.

Starts are bounded, as every loop over model calls is: one executor at a
time; none while the five-hour window is above 80 percent or the
seven-day above 95, deferred by a timer to two minutes after the reset
(the status line writes the numbers to `usage.json` in the plugin's data
directory; with no recent numbers a start goes ahead and says usage is
unknown); none after an executor that ended within ten minutes with
nothing built for another reason; a tripwire at twenty-four starts a day;
and `plans pause` and `plans resume`, which "pause the queue" and "resume
the queue" from the owner mean in any session; a pause holds the
deferred starts and the resume re-arms them. A usage limit mid-build
(`StopFailure`, `rate_limit`) releases the lock, hands the plan over and
defers its resumption to the reset. A start waits ten seconds to see its
session in `claude agents`, and says why when it does not appear, logging
nothing.

Sessions the queue starts are Remote Control chats named after the
project, `<Project> Executor 2, 3, ...` and `<Project> Planner 2, 3,
...`, started by `claude --bg --remote-control`, counted per project. A
retired background executor is stopped a few minutes later, and `claude
agents` and `claude rm` tidy old ones. **A background session works in
the checkout**: the project's settings turn Claude Code's worktree guard
off (`worktree.bgIsolation: "none"`), and one executor at a time holds the
lock while the planner and the assistant read beside it; the queue still
counts a session in any worktree of the repository as alive. The executor
line lists every live executor session, from `claude agents --json`: its
status, its worktree and branch, the plan its Building line names,
whether it holds the lock and whether it is retired. `plans start`
refuses while any unretired executor is alive, lock or not. `plans` lists
the worktrees under `.claude/worktrees/` with who is in each. `plans
sync` moves a clean, detached checkout to the branch, and `plans start`
does the same before it starts anything; an executor detaches the
checkout at `origin/<branch>` after its batch's last push.

**Each project's queue runs apart from every other, in parallel.** A
change to the workflow goes through the plugin's own queue, never the
queue of the project it was noticed in, and the two run at the same
time. What is a project's is in its checkout (`.claude/executor.lock`,
`executor.pause`, the deferrals) or named after it (its sessions,
`<Project> Executor n`); what is the subscription's is shared on
purpose (the usage numbers); and a queue counts a session as its own
only when the session's working directory is in its checkout or one
of its worktrees, or its own files name the session. A session the
queue starts gets a clean environment: the project and plugin
variables a hook exports are not handed down, and `plans` run as a
command acts in the working directory. A start waits up to ten
seconds to see its session in `claude agents`, and says why when it
does not appear (an untrusted folder, most often) instead of logging
a start that never ran.

**Briefs are queued like plans**: a file headed `Brief for the planner` is
a brief, listed under "Briefs, oldest first"; `## Planning, <date>,
session <id>`, written by the planner as its first edit, marks it taken
while that session lives. The assistant ends a brief with `plans start
--agent planner plans/<topic>.md`, which starts a planner as a
background Remote Control chat at high effort, one at a time, and a
second beside a busy one whose context is past the reuse ceiling or gone
cold, under the
executor's bounds (the usage windows and the pause shared, the names, the
quick-death rule and the tripwire counted per kind). The planner writes
the plan over the brief before it asks its decisions, so a chat stopped
unanswered leaves the plan in the queue as asking. **A planner with room
left takes the next brief**: its Stop hook applies the executor's rule to
briefs, so with a brief waiting a planner that has not compacted takes the
oldest, one that has compacted once takes the oldest related brief (the
brief names a file one of its plans names, `plans/` and `.claude/` paths
included, or one of those plans), and one that has compacted twice, or
once with nothing related waiting, is retired and the hook starts the
next planner; a brief it was named and did not take goes to a fresh
planner at its next stop. With nothing waiting it stays alive, idle and
unretired, and `plans start --agent planner` refuses beside it and prints
the message to send it, which the assistant sends with `SendMessage`. A
chat holds every plan it wrote: it may still edit each until an
executor's Building line takes it, and the hook tells it on every prompt
where each plan stands; a retired chat is stopped when every plan of its
own is taken or the next planner starts.

A decision the plan left to the owner is taken in its "Decided" section
before that part is built; a question a plan did not foresee goes through
the question tool in the executor's session, not back to the planner.

**What a context costs.** Every turn re-reads the session's whole
context at the cache-read price: a plan of about 120 turns reads about
$1.90 at 80k, $4.80 at 200k and $14.40 at 600k (Opus, the pricing page),
where a fresh executor costs about $2.60 per plan in all, so the wash is
near 100k. The default ceiling, 200k, buys a related plan's continuity
for about $2.40 more; a cold cache adds the rewrite of the whole context.

**The executor works in one thread.** It starts a subagent only in four
named cases (the review of the diff against the plan, by the plugin's
`workflow:reviewer` agent; a read-only sweep that would flood its
context, by the built-in `Explore`; a failure unexplained after two
attempts and one long verbose read, by the built-in `general-purpose`),
at most four per plan and never while a suite runs, each with a
four-part brief. Not two executors in one project: a plan's steps share
one context (the branch, the files read, the suites), coding has few
parallel strands, and a multi-agent run costs about fifteen times a
chat (Anthropic's multi-agent research post); the owner's own trial
cost more than it saved. The project's settings set
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to 1, so no subagent starts
subagents of its own: instructions are advisory, a setting is not.

**A second model reviews every plan's diff.** Codex, OpenAI's agent, reads
the branch in a throwaway worktree, outside its own sandbox (which cannot
start in a devcontainer without user namespaces), told to change nothing,
with the shell environment cut to the core variables and no `.env` in its
worktree, and writes bugs only to `plans/<topic>/codex-review.md`;
`scripts/codex-review.sh` bounds the call with a timeout and runs it once
per plan. The executor confirms each finding against the code before
acting; its "Built" section lists every finding with its verdict. Codex
comments and never gates: when it is not installed, not signed in, over
its limit or past the timeout, the script says so and the build goes on.
A project names its reviews in `reviews`: a personal tool may want
`/code-review` alone, a paper the writing plugin's.

**The turn audit** (`scripts/turn-audit.mjs`): once per turn, a session
that changed more than one file is asked, at its Stop, to say why each
file was needed; and when the project names the paths a user sees and its
catalogue, a turn that changed one of those paths, or called one of the
project's `tools`, and wrote nothing in the catalogue is asked for the
entry, or a `decisions: none (<why>)` line; and a catalogue file changed
with a rule that lacks its tier and date is asked to add them. A session is
charged only with its own writes; the planner and the assistant are never
audited. The refusal is one per turn, so nothing loops.

## Changing the workflow

**A change to the workflow is planned and built in the plugin's own
repository**, never in the project the chat is in: `/workflow:change`
keeps a checkout of the plugin's repository beside the project, writes the
brief or the short plan into that checkout's `plans/` and starts its
queue. `plans` acts on the repository it is run in, whatever project the
chat belongs to, so `cd <checkout> && plans start` is the plugin's queue
from any chat. The plugin's repository is itself a project with a
`.claude/workflow.md`, so its own queue builds the change; its CI moves
`main` on a green run of `test`, and every machine installing from `main`
picks the change up after its next session starts.

## Installing

```
claude plugin marketplace add JavierMNieto/workflow-plugin#main
claude plugin install workflow@workflow --config owner=<name>
```

On Javi's machines the dotfiles' `install.sh` merges
`claude/settings.json` into the user settings (`~/.claude/settings.json`);
what the plugin needs there is:

```json
"extraKnownMarketplaces": {
  "workflow": {
    "source": { "source": "github", "repo": "JavierMNieto/workflow-plugin", "ref": "main" },
    "autoUpdate": true
  }
},
"enabledPlugins": { "workflow@workflow": true },
"statusLine": {
  "type": "command",
  "command": "node \"$HOME/.claude/plugins/data/workflow-workflow/statusline.mjs\""
},
"worktree": { "bgIsolation": "none" },
"env": { "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1" }
```

The marketplace follows `main`, which CI moves only on a green `test`,
and updates itself; the plugin is on everywhere; a plugin cannot set
`statusLine`, and its own path changes with every version, so a
SessionStart hook copies the status line script into the plugin's data
directory, which the setting runs; a background session works in the
checkout (`bgIsolation`), as "The queue" says; and a subagent starts no
subagent of its own. The owner's name is the plugin option `owner`
(`claude plugin install workflow@workflow --config owner=<name>`).

The research-writing skills are a second plugin of the same marketplace,
`writing@workflow`, that a project turns on in its own
`.claude/settings.json`; its skills load when the project works on
`.tex`, `.bib` or `.md` files, and the project's own writing decisions
are its catalogue. `/workflow:setup` in a new project writes its project
file and turns the plugins it needs on, and the others off.
