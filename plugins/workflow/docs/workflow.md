# The workflow

Three agents and a plan queue, in any project; the owner's part is the
decisions. Each rule is named by its bold lead-in, which the agent files
cite; they hold the steps, and why each rule was decided is its entry in
`decisions.md`, cited at the end of its paragraph.

## The three agents

**Plan, then build, in two sessions.** A change of any size is planned by
one session and built by another, with the context cleared between: the
plan is the spec for one change, and the project's docs are the standing
context. Each agent runs as the whole session, since a subagent cannot use
the question tool: `workflow:planner` (Fable, effort high) writes the
plan; `workflow:executor` (Opus, `--effort high`, which outranks a
settings file's effort) builds it through the checks, three reviews and
the push; `workflow:assistant` (Opus, effort medium, the default agent)
answers and routes; `workflow:maker` (Opus, effort high) is the compact
form's one chat, which decides, builds and records.
(decisions.md#plan-then-build)

**A brief or a plan is a prompt for the agent that reads it**, and is
written as one. Four parts, in this order, under these headings: *What
was asked*, the outcome and why, in the owner's words as a paragraph of
the writer's; *Decided*, what is already settled, each with its reason
(left out when nothing is); *Done when*, each line a check the reader can
run or see and that comes back pass or fail, with the command where there
is one and a number where there is one; *Where to look*, the reference to
follow by its path, the earlier decisions by their plan or entry, and the
artifact itself (the message quoted, the log, the address), never a
description of it. The answer's form is the reader's agent file, so the
prompt does not repeat it. A line whose removal would cause the reader no
mistake is cut; what the reader will find by opening the file it is
pointed at is not copied in. The executor's briefs to its subagents, the
planner's `For` brief and the plan's own sections are the same four parts
with the plan's detail between them. (decisions.md#brief-is-a-prompt)

For example, the brief that asked for this rule:

```
# Briefs and plans are written as prompts for the agent that reads them

Brief for the planner, 2 November 2026, by the assistant with Javi.
The planner's plan replaces this file.

## What was asked

The planner reads every brief and the executor every plan, so each is a
prompt: Javi wants them written by Anthropic's current prompt guidance,
and the docs every agent reads written the same way.

## Done when

- The assistant's brief, the short plan and the planner's plan each
  follow the guidance.
- One real brief and one real plan, rewritten under the new rules, are
  shorter and still complete.
- When two fresh readers are given only a rewritten file, then each
  says what to do and how to check it is done.

## Where to look

- The guidance:
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview,
  https://code.claude.com/docs/en/best-practices (cut any line whose
  removal causes no mistake) and
  https://code.claude.com/docs/en/prompt-library.md (the outcome, a
  check, a reference, a measurable target, the artifact, the answer's
  form).
- The example: the first project's
  `plans/audit-duplication-and-reinvention.md`, rewritten on 2 November
  from 466 to about 250 words by those patterns, its content approved by
  Javi.
- What changes: `agents/assistant.md` (the short plan and the brief),
  `agents/planner.md` (the plan's shape), `agents/executor.md` (where it
  reads them) and `docs/workflow.md`.
```

**A behavior is written as a scenario**, When <what the person does>,
then <what they see>, one per line: in a brief's and a plan's "Done
when", in a plan's decisions where they state a behavior, and in the
agents' messages to the owner. "**When** I connect Google from the
account page, **then** a toast at the bottom says "Google is connected"
and goes after a few seconds." Each scenario in a plan's "Done when"
names the test that checks it or says it is looked at on screen, and for
one looked at on screen the executor names the screenshot that shows it,
which the reviewer reads; the executor writes one test per scenario where a test fits; a
check by command (a test, a lint, a grep) stays a command.
(decisions.md#behavior-as-scenario)

**Reading beside a build**: the planner and the assistant stay in the
checkout while the executor builds there; one that finds the tree dirty
(`git status`), or is told a file changed, reads it from the branch (`git
show origin/<branch>:<path>`), names functions rather than lines for it,
and says so in the plan. (decisions.md#reading-beside-a-build)

**The planner and the assistant read the specifics themselves and hand out
only bounded, read-only sweeps**: one answer shape, a turn limit, nothing
that writes. (decisions.md#bounded-sweeps)

**A plan is built once it is written**: order is asked only when another
plan already waits, and a dependency is written into the plan.
(decisions.md#built-once-written)

**Which session a topic goes to.** The assistant ends every topic in one
of four exits: answered; a call for a person the project names, said in
a line, with a message drafted only when the owner asks; a short plan
for the executor; or a brief for the planner, which holds the four
parts. A change described in a few sentences, inside rules the
project holds, with at most two strings resting on a product looked up
(any number free), no schema or privacy change and no person's rule
reversed, is a short plan; anything else is a brief.
(decisions.md#which-session)

**An idea is asked about before anything is written**: the assistant
answers it, then asks the owner with the question tool whether it becomes
an issue (in a project with an Issues heading), a brief or nothing yet; a
clear bug, an objective fix or a request to build, plan or file asks
nothing, and a doubt between the two is asked (the assistant's "Where
each topic ends"). (decisions.md#idea-asked-first)

**Every new topic starts in the assistant's chat.** A planner's chat holds
the plans it wrote until an executor's `## Building` line takes each; an
executor's "Needs a decision" items go to the assistant ("Handed to the
assistant"); work for the project a plan came from goes back as a brief.
The owner carries no message between agents, and no chat sends him a
command to run. (decisions.md#new-topic-to-assistant)

**The chat he said it in writes it, and the agents pass the rest.** A
change the owner asks for is written by the chat he asked in when that
chat may write it: the assistant writes a follow-up for a taken plan, the
planner one for its own taken or built plan (`plans/<topic>-follow-up.md`).
What a chat cannot write goes by one `SendMessage` to the chat that can,
opening `<Kind> from <owner>: plans/<x>.md.`, then where and when he said
it and his words, then what to do; one per change, never repeated, never
taken as delivered by silence. A relayed
word is his only once he confirms it in the receiving chat, by "Asked in
plain words", the relayed version recommended, and meanwhile stands in
the plan as a numbered decision with it recommended ("Asked once"). A
message that only informs is information; one that asks anything else is
reported and not acted on. (decisions.md#chat-that-heard-it)

**Handed to the assistant** is one route for the executor's and the
planner's follow-ups: `ListAgents`; this project's `<project> Assistant`
chat on this machine (kind `interactive` or `bg`, never `Remote
Control`), idle first, else busy; one message. With none, the executor
runs `plans start --agent assistant plans/<x>.md`.
(decisions.md#handed-to-the-assistant)

**Asked in plain words.** The owner reads a question on his phone, in the
question tool's dialog, with none of the chat in front of him: first what
it is about, in his words, then the situation in two or three sentences,
then what each choice means to him and costs him. Nothing is called by its
name in the code, nothing in backticks; the header is the topic in a word
or two; each label is what he gets, each description what it costs; the
recommended option first and marked; one decision per question, up to four
a call. `scripts/plain-words.mjs` refuses a question that names code or is
one sentence. Every final message leads the same way: what happened for
him and what waits on him, then the record. A behavior is described as
When … then …, what he does and what he sees. Not this: header `Connect`,
question `Should the connect script keep the terminal open after the
hand-over, or exit on Ctrl+C?`, options `Keep open` / `Exit`. But this:
header `Hand-over`, question `This is about what a reader sees after they
hand a document over to someone else, the change you asked for this
morning. Today the page they land on stays open until they close it
themselves, which some readers take as the hand-over having failed. The
choice is whether that page closes on its own once the hand-over is
confirmed.`, options `Closes on its own (Recommended)`, description `The
reader sees a confirmation and the page goes; costs nothing unless they
wanted to go back to it`; `Stays open`, description `As today; costs the
readers who think it failed`. (decisions.md#asked-in-plain-words)

## The project file

**A project's part is one file, `.claude/workflow.md`**: frontmatter the
hooks read and a body the agents read; `plans init` writes a starter, the
name defaulting to the directory's and the branch to the remote's
default, or the branch checked out. (decisions.md#project-file)

```
---
name: Docs                # the project's name in session names
branch: test              # the branch the executor pushes, fast-forward
run: checks.yml           # the Actions workflow read after a push; omit for none
land: pull-request        # a pull request per topic and one a day for small fixes; omit to push everything
ui:                       # paths a user sees, for the turn audit and the edit-time hook; a one-file catalogue with no paths governs them all
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
reuse: 200000             # the context above which a finished session retires: a number for every agent, or a map of executor, executor-related, planner, planner-related
reviews:                  # the reviews before a push; omit for all three (none when compact)
  - code-review
note: \JaviAI             # the writing plugin's note command; omit for notes in the report
reply: \javi              # the command the author answers notes with
---
```

**`form: compact` is the compact form**: one chat, `workflow:maker`,
decides and builds, and the queue's hooks do nothing. A project moves
between the forms by this line alone; `branch` may be omitted, and the
maker then commits nothing; it reads no `land`. (decisions.md#compact-form)

**`land: pull-request` lands by pull request.** A plan's author writes
where it lands in a `Lands` line under its header paragraph; absent the
key, the executor pushes everything to the branch and the line means
nothing. A topic's pull request is a draft until the owner has reviewed
it (below); the executor's "In pull request mode" holds the steps.
(decisions.md#land-by-pull-request)

- **A topic** (`Lands: topic <name>, ready.` or `, waiting.`): one
  branch named for the topic, a commit per plan, pushed after each; its
  pull request opens with the first plan marked `ready`; a plan with no
  `Lands` line is a topic of its own, ready. (decisions.md#topic-landing)
  A later plan joins an open pull request: the description is written
  again, its screenshots attached with `gh pr edit --attach`, and nothing
  is posted. (decisions.md#joined-pull-request)
- **A fix** (`Lands: fix.`): no decision, no catalogue or doc rule
  changed; it goes into the day's fixes pull request, and one whose
  commit changes a rule lands as a waiting topic. (decisions.md#fix-landing)
- **A fix wanted now** (`Lands: fix, now.`, on the owner's word only):
  pushed straight to the branch, its `run` read, and listed in the day's
  fixes. (decisions.md#fix-now-landing)

**The description is the catalogue's diff**: `New`, `Changed` and
`Retired`, each entry as the catalogue stores it, a conflict (a struck
line with another person's name) first, each screenshot under the
decision it shows; then the other changes and the commits no plan here
accounts for, with their author, under `Also`; then where to try it; on
one screen. "Before the push" runs once per plan; the merge is the
people's, and no agent merges. (decisions.md#description-is-the-diff)

**A plan that rests on an open draft pull request of the queue's own
lands in it; one that rests on a pull request marked ready, or someone
else's, is stacked on it; one that only changes the same file is
neither.** To rest on a pull request is to use what it adds; landing in
it, the plan's `Lands` is that pull request's topic.
(decisions.md#stack-only-on-use)

**A branch is brought up to date by merging, never force-pushed**, a
conflicting pull request at a batch's start included, pushed to its own
head branch only. (decisions.md#merge-never-force)

**The executor refreshes only the queue's own pull requests, with the
checks alone**: those a plan in its `plans/` names as its own, the pull
request its "Built" opened or joined or its `Lands` topic's branch, never
one a `Related` line names. (decisions.md#refresh-only-your-own)

**A topic's pull request opens as a draft and stays one until its owner
has reviewed it himself**: he marks it ready on GitHub, the one act that
asks anyone else's reading; the plugin refuses an agent's `gh pr ready`
(`--undo` allowed), and a later plan's work makes it a draft again. The
day's fixes pull request opens ready. (decisions.md#draft-until-reviewed)

**`mcp` names the MCP configs a chat here needs**, which `plans chat` and
every chat the queue starts pass on the command line; `plans chat` opens
the maker or the assistant in a project with `mcp` or `inherits`, and
prints a config's path, never the file. (decisions.md#mcp-configs)

**`deny` keeps an agent off a tool the project gives another**: it maps a
plugin agent to MCP tool-name patterns matched whole (a connector named
alone means its every tool), which `scripts/tool-denials.mjs` refuses in
every chat, a subagent included; `plans check` lints it. (decisions.md#deny-key)

**The body's headings are the executor's steps for this project**:
**Before a build**, **While working** (which tests for one change),
**Before the push** (screenshots, checks, suites, in order), **After the
push** (what to watch), **Reading** (which tools read code and docs),
**Products** (the product people know for each kind of thing, which
`design-research` follows first), **People** (whose calls are theirs,
and what each decides) and **Issues** (`Detail:`, a skill or command that
turns a plan into an address an issue links, and `Check:`, a command that
fails on what may not leave the repository; its presence turns issues on);
the body may also name the tools that publish under the owner's name,
which no agent calls. (decisions.md#body-headings)

**A project is set up in a short interview**, `/workflow:setup`, asked
once with its kind's defaults (`kinds.md`), each thing's cost said; run
again, it keeps the answers. (decisions.md#setup-interview)

**A project turns off the connectors it does not use**: the setup denies
the claude.ai connectors no chat here needs, whole
(`mcp__claude_ai_<connector>`), in `.claude/settings.json`, or
`.claude/settings.local.json` when the first is tracked in a public or
shared repository, touching no other deny. (decisions.md#connectors-off)

**A project with no project file is not the workflow's**: the hooks do
nothing there, and `plans start` refuses. (decisions.md#no-project-file)

## Decisions

**The catalogue is the record.** The project file's `catalogue` names a
directory (a `README.md` with the everywhere rules and a table of the
files, then one file per kind of thing a person sees) or one file, each
rule a bold list item with its tier and date right after the bold
statement or ending the rule. The tier is read there and nowhere else: a
parenthesis inside the statement (`**Per-step (per row) toggle.**`) or in
the middle of the body is never one, and a fenced example is no rule. An
entry may open with an id, ``- `presenter-bold` **The presenter's name is
bold.** (Javi, 2026-10-21)``, cited as `file#id`; it names the plan that
decided it, and a rule that replaces one keeps the old line struck
through under it. What is not there was not decided.
(decisions.md#catalogue-is-the-record)

**The catalogue is only for well-formed opinions, researched or given by
a person; anything not in it is assumed to have no reason and is free to
change.** An entry is a person's call with its why, or a product or
source followed, named; a detail nobody decided for a reason is judged
against the principles, changed on sight and never recorded, until it
turns out to matter. (decisions.md#only-well-formed-opinions)

**A catalogue inherits others.** `inherits` lists catalogues above the
project's, farthest first; the project's entry of the same id overrides
an inherited one and says `overrides <file>#<id>`. `plans check` lints
every catalogue named: a missing tier and date, an id used twice, an
override naming no inherited id, an entry at the agent's choice.
(decisions.md#catalogue-inherits)

**The tier says who may change a rule.** A person's name is their call; a
named product (`as GitHub does`), a written source (`per <source>`) or a
measurement (`observed in <x>`) is replaced only by a better-grounded one,
named. `the agent's choice` is retired: an entry at it is a fault, until
it is re-tiered, confirmed as a person's call or deleted. A replaced rule stays
struck through under its replacement; a retired one says "retired".
(decisions.md#tier-says-who)

**A decision has a name; a part has none.** Nobody owns a file, a screen
or a feature: anyone changes anything through a plan, the reviews and a
pull request, where a disagreement is settled. A rule with a person's
name is their call: a change to it brings its reason, the group's
message goes out, and the description names who decided the rule it
replaces. **People** names calls, not parts.
(decisions.md#decision-has-a-name)

**A change one person started is anyone's to go on with.** Another
person's commits on a pushed branch are kept as theirs, the executor
squashing only its own, and listed under `Also`. (decisions.md#anyone-goes-on)

**The plans account for the queue's commits.** Every queue commits as
`Claude <noreply@anthropic.com>`; a plan's "Built" names its commit and
its merges by hash, so `Also` lists every commit on the branch no plan in
this checkout accounts for and no merged pull request down the stack
already showed, with its author; none is left out by author or title.
(decisions.md#plans-account-for-commits)

**A string rests on what produced it.** Every word a person sees is in the
plan's "The words" with what produced it: an entry or house rule
(`file#id`), a product named in Sources, a person, or free, with the
principle it follows. Only a string that carries a decision is researched;
only a new screen or flow is asked about first, any other control after
the research, when it leaves a choice the house rules do not settle. The
executor types nothing outside "The words", and the plan review checks the
diff against it. Each string's row gives its kind, the catalogue file or
section that governs it, and what shows it, and the plan review checks the
diff shows it so. (decisions.md#string-rests-on-source)

**A rule whose reason is gone is put to the owner, not followed**: keep,
change or retire, by the question tool, the rule standing until he
answers; a plan that deletes a thing lists the rules resting on it.
(decisions.md#reason-gone-ask)

**A decision is recognized in three places**: a plan's "Decided" and the
entries it drafts; an edit under `ui`, where the audit asks for the
entry; and the chat, where the owner's correction is recorded under his
name in the same turn. (decisions.md#recognized-three-places)

**A decision is found again in three ways**: the README's everywhere
rules, loaded always; a catalogue file's `paths` and `signals` (a one-file
catalogue with no `paths` governs every `ui` path), which
`scripts/catalogue-context.mjs` matches before an edit or a `tools` call,
each entry, and the hook's instruction, shown once per session and again
after a compaction; and, for an edit whose text draws a control or carries
words a person could read, a small model's naming of the catalogue's files
or sections it touches, loaded beside them (one call per distinct text,
about 1.5k tokens and seven seconds a call, sixty a session, twenty
seconds each, a log line per call; none without a catalogue); and the
`design-research` skill, when nothing covers a thing.
(decisions.md#found-three-ways)

**The audit's checks**: a `ui` path changed or a `tools` call made with no
entry added or changed in the catalogue, answered by the entry or a
`decisions: none (<why>)` line; a rule without its tier and date; an entry
at the agent's choice dated today. Each is refused once.
(decisions.md#audit-checks)

**The talk setup retires into the plugin.** A talk is the maker with a
project file (`mcp`, `inherits`, `tools`, `catalogue`, no `branch`),
opened by `plans chat`, its slide steps a skill of the talk workspace.
(decisions.md#talk-setup-retires)

## The queue

**A plan's state is in its file**, which `plans` reads and prints: `##
Built` (its commit, and a `Pull request #<n>`, `Pushed straight to
<branch> as a fix` or `On topic <name>` line); `## Dropped, <date>`,
written by the plan's author on the owner's word with one line of why, is
dropped: never ready, never started, refused by path, out of the asking
deferral; `## Building, <date>, session <id>`, the executor's while that
session lives; `## Handing over`, resumed first; an `Issue: #<n>.` line
with no `## Ready, <date>` is planned, waiting on GitHub; else a `Plan
only` or `Short plan` header dated 24 October 2026 or later is ready. In pull
request mode `plans` names what each brief and plan looks related to, and
the author answers with a `Related` line.
(decisions.md#plan-state-in-file, decisions.md#related-line)

**One checkout has one executor**, which holds `.claude/executor.lock`;
another's edits are refused. Its Stop hook holds the stop on a red or
unfinished run of its push, or pull request of the checkout, whose fix
is pushed where the red one was, before anything else, then names
the waiting plans to a session it may reuse (no compaction, or one and a
waiting plan naming a file the batch changed; a context under its
ceiling (the project file's `reuse`: 200k for an executor by default); a
cache still warm), else retires it and starts the
next executor. At a third compaction inside one plan the session hands
it over (work committed, a "Handing over" section, stop), up to six times
a plan; twice at the same step, the owner is asked.
(decisions.md#one-executor, decisions.md#context-cost)

**Starts are bounded**: one executor at a time; none while the five-hour
window is above 80 percent or the seven-day above 95, deferred to the
reset; none after a quick death; twenty-four a day at most; `plans pause`
and `plans resume` on the owner's "pause the queue" and "resume the
queue".
(decisions.md#starts-bounded)

**`plans cost` measures the queue**: each session's turns, context and
cost by agent, from the transcripts, at the prices the script names with
the date they were read. (decisions.md#context-cost)

**Sessions the queue starts are Remote Control chats named after the
project and the machine**, `<Project> Executor 2 (lab)`.
(decisions.md#session-names)

**A finished chat ends an hour after it goes quiet**, by `claude stop`,
which keeps its conversation; a replaced one three minutes after its
successor starts; one that asked the owner a question never. `plans end`
ends this queue's finished chats now, `plans end <id>` one of them.
(decisions.md#chat-ends-after-an-hour)

**`plans end <id> --now` ends a named chat whatever it is doing**, writes
its plan a "Handing over, <date>, ended by <owner>" section, releases
the lock and starts a fresh session on it; the assistant runs it on the
owner's word. (decisions.md#end-now)

**Archiving a chat in the Claude app does not stop it**; `claude stop` or
`plans end` does. (decisions.md#archiving)

**A background session works in the checkout** (`worktree.bgIsolation:
"none"`): no executor makes a worktree, and `plans` lists any under
`.claude/worktrees/`; `plans start` refuses while an unretired executor
lives; an executor detaches the checkout at `origin/<branch>` after its
batch, and `plans sync` moves a clean, detached one to the branch. The
queue's files in `.claude/` and `.claude/worktrees/` are git-ignored.
(decisions.md#background-in-checkout)

**Each project's queue runs apart from every other, in parallel**: a
change to the workflow goes through the plugin's own queue; a queue's
lock, pause and deferrals are in its checkout and its sessions named for
it.
(decisions.md#queues-in-parallel)

**A checkout is a queue**: two machines' checkouts of one repository are
two queues, sharing only the branch, a message or a brief one writes
into the other's `plans/`. (decisions.md#checkout-is-a-queue)

**Briefs are queued like plans**: a file headed `Brief for the planner`,
taken by the planner's `## Planning, <date>, session <id>` line; `plans
start --agent planner` starts a planner under the executor's bounds.
(decisions.md#briefs-queued)

**A planner with room left takes the next brief**: none compacted and
under 160k, the oldest; under 480k, or compacted once, the oldest brief
related to its plans (one that names a file they name, or one of them);
else it retires, and `plans start` sends a brief to a live planner only
when it is under its ceiling for that brief. A chat holds every plan it
wrote until a Building line takes it.
(decisions.md#planner-takes-next-brief)

**Asked once.** A decision a plan leaves to the owner is asked by its
planner, in its chat, and by nobody else; a question a plan did not
foresee is asked in the executor's session. For thirty minutes from the
question the plan is the planner's: `plans` lists it under "Asking
<owner>", no executor takes it, by default or by path, unless the owner
says in its chat to build it now (his word goes in "Decided" first), and
the tool hook refuses a Building line on it. The planner writes "Decided"
only once every decision is answered, which lets the plan go at once, and
sends it to the executor. Talking does not restart the window; another
question does. Past it, or once the planner's chat has ended, the executor
builds each undecided decision by its recommended option and writes it in
"Decided" as taken for the owner, unanswered; a later, different answer is
a follow-up plan. A planner the owner opened himself holds nothing.
(decisions.md#asked-once)

**The group's message.** A change to another person's part (a rule whose
tier carries their name, or a thing **People** gives them) is built as
any plan, and the pull request is where it is discussed; the brief and
the plan say `Touches <name>'s part`, so the owner knows. No agent drafts
a message for another person unless the owner asked for one in the
conversation; asked, it is in his words, ready to paste. A group that has
already agreed is written in "Decided". (decisions.md#group-message)

**A topic the people discuss is a GitHub issue**: one sentence of what
should be true, the decisions and what is left out under it, the plan
behind it as a collapsed comment or the project's Detail address, never
the body; anyone opens one, the assistant writes them on the owner's
word, the planner adds the plan's overview, the executor writes `For
#<n>` on the pull request. (decisions.md#issue-is-the-overview)

**An issue nobody plans yet carries no status label and no plan line**
until a brief carries its number, and its topic ends as answered, with
the issue's address. (decisions.md#issue-alone)

**The queue speaks on GitHub as the project's own app**, through `plans
gh`, pull requests included; the push alone is the person's token.
(decisions.md#project-app)

**A plan with an issue waits for Ready**: `plans` lists it as planned,
nobody starts it, and the label `status: ready` or the owner's word
writes the section, comments folded by whose call each is; the issue's
stage is one `status:` label, `planning`, `planned`, `ready`, `building`.
(decisions.md#ready-before-built)

**What people with write access write on GitHub reaches the queue by the
app's webhook**: `plans webhook` listens on the container behind the
host's reverse proxy, checks each delivery's signature, notes each event in
`plans/github/`, starts the assistant on it, and closes an issue when its
pull request merges; `plans github` reads what was missed; the assistant
answers as the app, writes the brief, or writes Ready and starts the
build. (decisions.md#github-webhook)

**The day's fixes.** With `land: pull-request`, the day's `Lands: fix.`
plans are one pull request, `Small fixes, <d Month yyyy>`, from
`fixes-<yyyy-mm-dd>`, opened ready with the first fix and rewritten with
each next one, with no comment; it lists each fix's commit title and
screenshots, and under `Already on <branch>` the fixes pushed straight. A
fix after the day's pull request was merged or closed waits for
tomorrow's branch. (decisions.md#days-fixes)

**The executor works in one thread**: a subagent only for the review
against the plan (`workflow:reviewer`), a sweep that would flood its
context (`Explore`), a failure unexplained after two attempts, or one long
verbose read (`general-purpose`), at most four a plan, never during a
suite, each with a four-part brief; never a second executor;
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is 1. (decisions.md#one-thread)

**A second model reviews every plan's diff.** Codex reads the branch in a
throwaway worktree and writes bugs only to
`plans/<topic>/codex-review.md`, through `scripts/codex-review.sh`, once
per plan, under a timeout; the executor checks each finding and lists its
verdict in "Built". It never gates: when it cannot run, the build goes
on. (decisions.md#second-model)

**The plan review reads the screenshots too.** The executor's brief to the
reviewer names each screenshot and the catalogue files the Words table's
kinds name, and the review says what on screen is unlike those rules;
nothing without screenshots or a catalogue. A scenario's screenshot is
read for its "then" ("A behavior is written as a scenario").
(decisions.md#screens-reviewed)

**The turn audit** (`scripts/turn-audit.mjs`): once per turn, a session
that changed more than one file says at its Stop why each was needed,
and "The audit's checks" apply where the project names `ui` and its
catalogue; a session answers only for its own writes, and the planner and
the assistant are never audited. (decisions.md#turn-audit)

## Changing the workflow

**A change to the workflow is planned and built in the plugin's own
repository**: `/workflow:change` keeps its checkout beside the project,
writes the brief or short plan into its `plans/` and starts its queue;
`plans` acts on the repository it runs in; CI moves `main` on a green
`test`, and every machine picks the change up at its next session.
(decisions.md#change-in-plugin-repo)

**A change the plugin leaves for the project it came from goes back as a
brief.** The brief carries `From: <Project>, <path>.`, and the plan keeps
it; the planner writes that project's half as a `## For <Project>:
plans/<topic>.md` section in the four parts, and after the push the
executor writes it into that checkout's `plans/` and starts its planner,
the Stop hook holding the first stop until the file exists.
(decisions.md#leave-back-as-brief)

## Installing

```
claude plugin marketplace add JavierMNieto/workflow-plugin#main
claude plugin install workflow@workflow --config owner="<name>"
```

A newcomer pastes one line into Claude Code, "Install the workflow
plugin from https://github.com/JavierMNieto/workflow-plugin by following
its INSTALL.md", and Claude runs these two commands, merges the settings
below with the person's yes, and offers `/workflow:setup`; `INSTALL.md`'s
JSON block is a copy of this one, and a test fails while they differ.
(decisions.md#install-one-line)

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

The owner's name is the plugin option `owner`; the machine's label is
`machine` (`echo '{"machine":"<label>"}' | claude plugin configure
workflow@workflow --values-stdin`).

**The plugin checks its own install at every session's start.** An
installed copy missing any of the plugin's files is said in the
session's first context and `plans`'s first line, with the files and
the fix (the files put back from the marketplace's clone at the copy's
commit, or the newer version installed when there is one; nothing is
deleted; a copy loaded from a folder, or an older version than the
installed one, gets no command, only a new chat); the agent says it to
the owner first, asks once whether to install again, and does nothing
else in that chat.
(decisions.md#install-checks-itself)

**A push needs a token in the container**: a fine-grained `GH_TOKEN` on
the host (Contents and Workflows read and write, Actions and Metadata
read; with `land: pull-request`, Pull requests read and write, Checks
and Commit statuses read), carried in by the devcontainer's
`"containerEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }`, which the setup
writes, with `gh auth setup-git --hostname github.com` from the
dotfiles; its value is in no file, and `gh auth status` says when it
expires. A project with issues carries its app's id and private key the
same way, `WORKFLOW_APP_ID` and `WORKFLOW_APP_KEY` (the PEM's text),
from which `plans gh` mints the app's token, and its webhook's secret
and port, `WORKFLOW_WEBHOOK_SECRET` and `WORKFLOW_WEBHOOK_PORT` (8789
when unset). (decisions.md#push-token)

**Screenshots on a pull request** go up through `gh pr create --attach`
and `gh pr edit --attach`, which need gh 2.99 or newer (from GitHub's apt
repository; Debian's is 2.23) and a token that can upload (a classic one
with `repo` when a fine-grained one is refused); with an older gh the
pull request opens without them and says so.
(decisions.md#screenshots-attach)

The research-writing skills are a second plugin, `writing@workflow`, that
a project turns on in its `.claude/settings.json`.
