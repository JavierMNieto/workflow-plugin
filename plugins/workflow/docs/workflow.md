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
few sentences, inside rules the project already holds, every new string
resting on one of them or on a product the assistant looked up (at most
two such strings; more, or products that disagree where the house rules
do not settle it, is the planner's) or free, written by the everywhere
rules and the copy rules and counting against nothing, with no schema or
privacy change and no rule a person's name is on reversed, is a short
plan, as Anthropic's best practices say a diff you can describe in a
sentence needs no plan; anything else goes to the planner, as Shape Up
keeps a small batch and a big batch apart, each with one way in.

**Every new topic starts in the assistant's chat.** A planner's chat is
for the plans it wrote, and the next brief when it has room: each plan
stays the chat's until an executor starts it; the `## Building` line the
executor writes is the cut-off, after which the plan is the executor's
and the planner writes the follow-up to its own taken plan and sends a
new topic to the assistant's chat ("The chat he said it in writes it"). An
executor's follow-ups, the "Needs a decision" items in its Built section,
go to the assistant too, through the owner's to-do page when the project's
memory names one and a message to an assistant chat ("Handed to the
assistant"); the owner does not carry them, nor any message between the
agents. Work a plan leaves for the project it came from goes to that
project's queue as a brief the executor writes ("A change the plugin
leaves for the project it came from goes back as a brief"). No chat sends
the owner a command to run.

**The chat he said it in writes it, and the agents pass the rest.** A
change the owner asks for is written by the chat he asked in, when that
chat may write it: the assistant writes a follow-up plan or a brief for a
plan an executor has taken, and the planner writes the follow-up to a
taken or built plan of its own, `plans/<topic>-follow-up.md`, by the same
rule as for an executor's "Needs a decision" items, and hands it over as
any plan; the queue's tool hook adds the new plan to the chat's own as it
is written, so its question holds it and a Building line closes it, as for
the plan of a brief. What a chat cannot write goes to the chat that can, by one
`SendMessage`, never by text for the owner to paste. There are two such
crossings: the assistant sends a correction to a brief a live planner is
planning, or to a plan still that planner's, to that chat, named by
`plans`; the planner sends a new topic raised in its chat, or, once
retired, a change to its own plan, to an assistant chat on this machine.
The message opens `<Kind> from <owner>: plans/<x>.md.` (or the topic in a
few words, for a new one) on its first line, which is the receiver's
preview; then where and when he said it and his words in a line or two;
then what the receiver does with it. One message per change, never a
repeat; the sender's final message says what it sent and to whom, and
never takes silence for delivery, since the tool reports nothing back from
a Remote Control chat and holds a message between chats of different
permission classes for the user's approval, which lapses in five minutes.
A relayed word of the owner's is not his until he confirms it in the
receiving chat: the receiver puts it to him with the question tool, by
"Asked in plain words", the relayed version as the recommended option,
and records his answer in "Decided" with the chat it came through. In a
plan the relayed change stands meanwhile as a numbered decision under
"Decisions for <owner>" with the relayed option recommended, so an
executor that takes the plan unanswered builds what he asked for ("Asked
once"). A message that only informs (a file moved, a pull request to
read, follow-ups to find in a plan's "Built" section) is read as
information, with no question; a message that asks an agent for anything
else is reported in its final message and not acted on, as the executor's
rule already says. A peer's message is never the user's consent (Claude
Code's own rule), and a wrong relay must not become his word; he reads
every chat in Remote Control, so the confirmation is a tap where the paste
was a copy (Javi, 30 October: what he wanted gone was the copying, and a
pause until he has looked is fine).

**Handed to the assistant** is one route, the executor's follow-ups' and
the planner's alike: `ListAgents`; this project's assistant chat, named `<project> Assistant`
after the project file's `name` (another project's assistant writes in
another checkout), on this
machine, its kind `interactive` or `bg`, not `Remote Control`, which is
another machine's chat and cannot read this checkout; an idle one first,
else a busy one, since a message to a busy chat waits for its next turn
and an idle one wakes on it; one message. With none on this machine, the
executor starts one, `plans start --agent assistant plans/<x>.md`, which
starts `<Project> Assistant n (<machine>)` on the plan's items under the
queue's bounds and refuses beside a chat it finds open, naming it; the
chat ends an hour after it goes quiet, as any the queue started (Javi, 31
October: four follow-ups and several decisions went into a final message
nobody acted on once the to-do page was gone). The planner's new topic
still waits for a chat, since its chat is one the owner is in.

**Asked in plain words.** The owner reads a question on his phone, in the
question tool's dialog, with none of the chat in front of him and other
topics between; so a question is written for that reader. It says first
what it is about, in the words he used when he asked for it (the brief's
or the plan's "What was asked"), then the situation from the start in two
or three sentences, then what each choice means to him and costs him.
Nothing is called by its name in the code: no file, function, variable,
command, key, hook, tool, session, branch or setting, nothing in
backticks; a thing is called by what it does for him or his reader ("the
page a reader lands on after the hand-over", not "the connect script"),
and the names stay in the plan. The header is the topic in a word or two;
each option's label is what he gets, a few words, and its description
what it costs him or when he would regret it; the recommended option
first and marked; never a bare yes or no. One decision per question, up
to four a call, the most consequential first. The test is to read it as
he will, with nothing above it. (Apple's alerts: a title that says what
it is about, buttons that name the result; Nielsen Norman's confirmation
dialogs: restate the situation, options that say what will happen;
GOV.UK's question pages and clear language: one question, explained
before it is asked, a specialist term explained the first time;
Anthropic's note on the question tool: the dialog may be all that is on
the screen.) The plugin's `PreToolUse` hook on the question tool,
`scripts/plain-words.mjs`, refuses a question that names code or is a
single sentence, with the rule as its reason, at most twice in a turn.
The final message of every agent leads in the same words: what happened
for the owner and what waits on him, in a few short sentences, before any
path, commit, count or table, which follow under it as the record. Not
this: header `Connect`, question `Should the connect script keep the
terminal open after the hand-over, or exit on Ctrl+C?`, options `Keep
open` / `Exit`. But this: header `Hand-over`, question `This is about
what a reader sees after they hand a document over to someone else, the
change you asked for this morning. Today the page they land on stays open
until they close it themselves, which some readers take as the hand-over
having failed. The choice is whether that page closes on its own once the
hand-over is confirmed.`, options `Closes on its own (Recommended)`,
description `The reader sees a confirmation and the page goes; costs
nothing unless they wanted to go back to it`; `Stays open`, description
`As today; costs the readers who think it failed`.

## The project file

**A project's part is one file, `.claude/workflow.md`**: frontmatter the
hooks read and a body the agents read, the shape Claude Code uses for
agents and skills.

```
---
name: Docs                # the project's name in session names
branch: test              # the branch the executor pushes, fast-forward
run: checks.yml           # the Actions workflow read after a push; omit for none
land: pull-request        # a pull request per topic and one a day for small fixes; omit to push everything
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

**`land: pull-request` lands by pull request.** A plan says where it
lands in a `Lands` line under its header paragraph, which its author
writes: the planner on a plan, the assistant on a short plan, since the
author is the one who heard the owner say whether he wanted the thing or
only a start. There are three landings:

- **A topic** (`Lands: topic <name>, ready.` or `Lands: topic <name>,
  waiting.`): the plans on one topic are built on one branch, the
  topic's name, one commit per plan, the branch pushed after each so it
  survives the container and the people can look at it. Its pull request
  opens with the first plan marked `ready`, when the topic holds its
  central decision or two substantial ones, from every plan of the topic
  so far, titled by the ready plan's title; until then the topic waits on
  its branch, brought up to date by merging `branch` in when its next
  plan starts, never force-pushed. A later plan joins an open pull request: the
  description is written again and one comment says what was added,
  since GitHub tells the people of a comment and not of a push. A later
  plan with a central decision of its own is a new topic. A plan with no
  `Lands` line is a topic of its own, ready: nothing lands unread by
  omission.
- **A fix** (`Lands: fix.`): a short plan with no decision in it, that
  changes no catalogue rule and no doc rule, goes into the day's fixes
  pull request ("The day's fixes", below).
- **A fix wanted now** (`Lands: fix, now.`, only on the owner's word):
  pushed straight to `branch`, fast-forward, after the project's "Before
  the push" list, its `run` read as the push mode reads it, and listed in
  the day's fixes pull request under what is already on `branch`.

A fix whose commit turns out to change a rule lands as a waiting topic
instead, and the owner says through the assistant whether it is ready.
The description is the catalogue's diff: under `New`, `Changed` and
`Retired`, each entry the topic's commits add, replace or retire as the
catalogue stores it, the rule, its tier and date, its reason in a
sentence and its id, a changed one with the replaced line struck through
under it and a conflict (a struck line with another person's name)
first; each screenshot under the decision it shows, with one line saying
what changed in it, attached with `gh pr create --attach`; then where to
try it in a line; nothing else, the whole, screenshots aside, on one
screen (Javi, 31 October: the diff of the decisions, what is new, what
changed, what conflicted; Keep a Changelog's grouped kinds and no commit
log; MADR's superseded record kept in sight; GOV.UK Frontend's effect
under each change). The project's "Before the push" runs once per
plan, the reviews included, a fix's as well; the Stop hook reads the
pull requests' checks, then the run a fix pushed straight set off ("The
queue"); the merge is the people's, and the executor never merges. A
plan that rests on an open pull request (uses what it adds) is stacked
on it; one that only changes the same file is not, and merges its base
in if it conflicts once the other merges. A stacked plan's branch starts at that
pull request's head, its base is that branch, and GitHub retargets it
when the first's head branch is deleted on merge (the executor retargets
it at its next batch otherwise). At a batch's start the executor brings
each open pull request GitHub reports as conflicting up to date by
merging its own base into its head as GitHub has it, the conflicts
settled in the merge commit, runs its checks again and pushes it with a
plain push to its own head branch, never to the branch (Javi, 29
October: each pull request is merged or held alone). A branch is
brought up to date by merging, never force-pushed: the refreshed pull
request, the waiting topic and the day's fixes branch alike (Javi, 21
October: merge, never force, which a project may enforce in its
settings; a squash merge keeps the merge commit off `branch`, and
another person's commits on the branch stay as they are). The executor refreshes only its own person's pull requests, with
the checks alone: those opened by its machine's GitHub account (`gh pr
list --author @me`) whose number or head branch a plan in its
checkout's `plans/` names (a fix's "Built" names the day's pull request
by its number), never another person's, which their own executor
refreshes, and not the suites, since the pull request's CI runs on the
push (Javi, 30 October). The compact form has no pull request mode: the maker reads no
`land`, and a compact project that wants pull requests is the full
form's. Absent, the executor pushes everything to the branch,
fast-forward, and the `Lands` line means nothing. A pull request per
topic, opened when the topic has its central decision or two substantial
ones; the day's fixes, with no decision in them, one pull request a day;
and one wanted on the site at once straight to the branch and listed
there (Javi, 30 October, with the other person; from 28 to 30 October
one per plan, which made nine in a day). **A topic's pull request opens
as a draft and stays one until its owner has reviewed it himself**: he
reads its description, the decisions and the screenshots, and marks it
ready for review on GitHub, the one act that lets anyone merge it and
asks for anyone else's reading; no agent marks it ready, and the
plugin refuses an agent's `gh pr ready` (`--undo` allowed); a later
plan's work he has not reviewed makes it a draft again, while a merge of
the base changes nothing he must read and leaves it as it is. The day's
fixes pull request opens ready, since a fix has nothing to decide, and a
fix wanted now opens no pull request; neither asks for a reading. (GitHub's draft
pull requests, which nobody can merge until the author marks them ready;
Gerrit's work in progress, visible to anyone and asking nothing of a
reviewer. Javi, 30 October: no pull request asks anyone else's time
until he has reviewed it himself; replaces "opened ready, never as a
draft", Javi, 28 October, whose reason, that a draft hides a pull
request whose checks never finish, the Stop hook answers, since it reads
a draft's checks as any open pull request's.) `run` keeps its meaning:
the push of a fix wanted now is read by it, and the project file's
**After the push** says what a merge or that push sets off.

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
`mcp__(claude_ai_)?server__.*` a connector in both its forms; a
connector named alone, `mcp__(claude_ai_)?server`, means its every
tool); the
plugin's `PreToolUse` hook (`scripts/tool-denials.mjs`) refuses a call
that matches with the reason, in both forms and in every chat here, and
a subagent is held to its session's agent's list as well as its own. The
tool stays listed; the
call never runs. A plugin agent's own frontmatter cannot be extended
from a project, and a settings `permissions.deny` holds for every agent
alike, which is what the setup's whole-connector denies are for: a
connector no chat here needs is denied there, whole; one that some
agents here need and others must not reach is `deny`. `plans check`
lints the key: a line under it that it cannot read, a list with no
agent's name over it, an agent the plugin has no file for, a pattern
that is not a regular expression or cannot name an MCP tool, a connector
named alone.

The name defaults to the directory's, the branch to the remote's default
(with no remote, `plans init` writes the branch checked out when the file
was written).
The body's headings are the executor's steps for this project: **Before a
build** (installs, generated code), **While working** (which tests to run
for one change), **Before the push** (screenshots, checks, suites, in
order), **After the push** (what to watch), **Reading** (which tools read
code and docs here), **Products** (one line per kind of thing the project
makes, the product people know for it, which the `design-research` skill
follows first). Its **People** heading names the people whose calls are
theirs and what each decides (the assistant's second exit, and the
group's message, "The queue"); the body may also name the tools that
publish under the owner's name (which no agent calls), and headings of
its own for the assistant.
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
depth) or one file, each rule a bold list item with its tier and date
right after the bold statement or ending the rule. The tier is read
there and nowhere else: a parenthesis inside the statement
(`**Per-step (per row) toggle.**`) or in the middle of the body is never
one, and a fenced example is no rule. The README's bulleted rules are
entries like any file's, checked the same; its prose and its table are
not rules. What is not there was not decided, as far as the next agent
can tell. **The catalogue is only for well-formed opinions, researched or
given by a person; anything not in it is assumed to have no reason and is
free to change** (Javi, 30 October). An entry is one of two things: a
person's call, with its why, the README's everywhere rules being the
principles that shape the whole product; or a product or source
followed, named. A detail nobody decided for a reason, a tooltip's
words, an icon among a set, spacing, a line kept or cut, is free: judged
against the principles and the nearest pattern, changed on sight, never
recorded, landing as a fix when it is a plan's whole change; one that
turns out to matter becomes a person's call and gets its entry then.
(Nygard's and MADR's records are for the significant decisions; Bezos's
two-way doors get a light process; GOV.UK admits a pattern that is
useful and unique. Javi, 30 October: the first project's catalogue had
grown to over six hundred rules, 138 of them the agent's choice, a
record of details anyone can see by looking.) The long reasoning is in `plans/`; the entry names the plan
when there is one, which is on the machine that planned it; the pull
request is the record another machine reads ("A change one person
started is anyone's to go on with"). An entry may open with an id in backticks,
``- `presenter-bold` **The presenter's name is bold.** (Javi, 2026-10-21)``,
and is then cited as `file#id` in replies, plans and the project's own
notes; a rule that replaces one keeps the old line struck through under
it. The date is written as the project writes dates, `21 October` or
`2026-10-21`.

**A catalogue inherits others.** `inherits` lists catalogues above the
project's (a workspace's, every talk's), farthest first; the project's
entry of the same id overrides an inherited one, says so with
`overrides <file>#<id>`, and the edit-time hook shows the project's with
the one it overrides named. `plans check` lints every catalogue the
project file names: the tier and date on every entry, an id used twice,
an override naming no inherited id, an entry at the retired agent's
choice;
and the `deny` key (above).

**The tier says who may change a rule.** A person's name is their call; a
named product (`as GitHub does`) is replaced only by a better-grounded
standard, named, as is one `per <source>` (a written source) or
`observed in <x>` (measured in an existing artifact); `the agent's
choice` is retired (Javi, 30 October; from 11 to 30 October the tier for
what nothing covered, carrying what was looked at since 29 October): it
is read so it can be named, and an entry at it is a fault, today's
refused by the audit and every one listed by `plans check`, until its
project re-tiers it to the product it followed, confirms it as a
person's call or deletes it, since a detail with no well-formed opinion
behind it is free and not the catalogue's. The address of a product or
source followed is written once, in the plan's Sources when there is a
plan, which the entry names, else in the entry (the compact form). A
replaced rule stays struck through under its replacement with its date; a
retired one is struck through with "retired". (MADR's accepted,
superseded and deprecated, in the catalogue's shape.)

**A decision has a name; a part has none.** When anyone can have Claude
build anything, who carries a change out no longer matters, and nobody
owns a file, a screen or a feature: anyone changes anything, through a
plan, the reviews and a pull request, which is where a disagreement is
settled, and nothing lands but by a merge. A rule with a person's name is
that person's call, not a fence around a part: a change to it brings its
reason, the group's message goes out, and the pull request's description
names who decided the rule it replaces, so the person overruled reads why
and answers there. The project file's **People** heading names calls, not
parts, for the same reason. (Collective code ownership, XP's shared code
as Fowler names it, whose one condition is a discipline the team keeps,
which here is the catalogue; MADR's `decision-makers`, which records who
decided, not who maintains. GitHub's CODEOWNERS, ownership by path, is
the model not followed.) Javi, 30 October.

**A change one person started is anyone's to go on with.** A waiting
topic's branch and an open pull request's are pushed, so another person,
or their Claude, pushes to them or comments; a commit another person
pushed to a topic's branch is kept as theirs when the executor builds the
topic's next plan, which squashes only its own work, and GitHub's
commits list and the squash merge's `Co-authored-by` lines credit it. A
plan's reasoning is on the machine that planned it (`plans/` is not
tracked); what reaches another machine is the pull request's
description, which carries the decisions, the catalogue entry, and, once
merged, the squash commit titled `<title> (#<n>)`, so `git log -S<id>`
on an entry's id finds the pull request where the rule was discussed. What the other person's Claude is told before an
edit is what the repository carries, the catalogue and the project's own
copy of the edit-time hook, not this plugin.

**A string rests on what produced it.** Every word a person sees, a
label, a button, a message, a sentence they are told to paste, is
written in the plan with what produced it, one of three, or free: a
catalogue entry or a house rule that produces the string (`file#id`, or
the doc's rule name; a rule that merely allows the string is not it), a
product looked up and named, whose address the plan's Sources keeps, a
person's decision; or free, named with the principle or copy rule it
follows, when no product people know has a version of it and no person
decided it: a tooltip's words, a line kept or cut. Research is for a
string that carries a decision, one a known product has its version of
or a person will be asked why about; a free string is written by the
principles and changed on sight. Nothing a known product settles is too
small to look up, and nothing is asked first but a new screen or flow: any other control,
large or small, skips the question to the owner, not the research, and
he is asked only when the research leaves a choice the house rules do
not settle. A plan's "Words" section holds them, the executor types
nothing outside it, and the review against the plan checks the diff's
strings against it. (Javi, 29 October: even simple text goes through
the research; a grounded answer exists before he asks why.) (Javi, 30
October: only a string that carries a decision is researched and
recorded.)

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
tier and date; an entry at the retired agent's choice dated today. Each is
refused once, and the second stop passes.

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
(its commit the first eight-hex word there, and the pull request it
opened, joined or was opened with when a line of it starts `Pull request
#<n>`, as in `Pull request #<n> (<url>) to <branch> from branch <name>,
commit <sha>; draft, checks green.`, which `plans` lists as `#<n>,
<draft|open|merged|closed>`; a fix pushed straight, whose section opens
`Pushed straight to <branch> as a fix`, as `<sha>, on <branch>, a fix`;
a topic waiting, whose section opens `On topic <name>`, as `topic
<name>, waiting`, with a line of the topics waiting for a pull request
under the built plans); `## Dropped, <date>`, written by the plan's
author on the owner's word with one line of why, is dropped: never
ready, never started, refused by path, out of the asking deferral,
listed under "Dropped today" and kept as the record of why (GitHub
closes an issue as not planned or as a duplicate with the reason on it;
MADR keeps a rejected record); in pull request mode a ready plan's row says
where its `Lands` line lands it; `## Building, <date>,
session <id>`, written by the executor when it starts the plan, is being
built while that session lives; `## Handing over` with no Built is handed
over and resumed first; a `Plan only` or `Short plan` header dated 24
October 2026 or later (as `26 October 2026` or `2026-10-26`) with none of
these is ready; older unbuilt plans are listed by path. The header is
looked for past the queue's own status sections (Planning, Building,
Resumed and Handing over, with their bodies), wherever an agent wrote
them, and a `plans/*.md` with neither a header nor a brief's line is
listed under "Not read by the queue", never dropped.
`plans` prints the table, which every executor message ends with. The
planner and the assistant hand a finished plan over themselves: one
`SendMessage` to the live executor, which an idle one acts on in seconds,
or `plans start` when none is alive.

In pull request mode, under each brief and each ready plan, `plans` says
what it looks related to: the open pull requests and the pushed branches
that change a file the text names, three at most ("A change one person
started is anyone's to go on with"); the author answers with a `Related`
line, which the pull request's description carries.

`scripts/plan-queue.mjs` does the rest on the hooks: the executor's prompt
hook takes the lock (`.claude/executor.lock`), and its tool hook refuses
edits and writing commands to an executor that does not hold it, so one
checkout has one executor; its Stop hook refuses a stop on a red or
unfinished run of the session's push (the project's `run`), or, with
`land: pull-request`, on a red or unfinished pull request of the
checkout (an open one whose head branch is a local branch here at the
same commit, its checks read with `gh pr list`; no checks is green), and
then on the run of a fix pushed straight, then names the
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
deferred starts and the resume re-arms them. A start nobody is watching,
a timer's, takes only the plans still waiting; the window's ("Asked
once") replaces an idle executor whatever its warmth, since no command
can message a session, and re-arms the plans asked again since; a busy
executor refuses it and takes the plans at its next stop, and one
waiting on the owner's answer is never replaced. A usage limit mid-build
(`StopFailure`, `rate_limit`) releases the lock, hands the plan over and
defers its resumption to the reset. A start waits ten seconds to see its
session in `claude agents`, and says why when it does not appear, logging
nothing.

Sessions the queue starts are Remote Control chats named after the
project and the machine, `<Project> Executor 2 (lab)`, `<Project>
Planner 3 (lab)`, `<Project> Assistant 4 (lab)`, started by `claude --bg --remote-control`, counted per
project and per machine from the starts log and the live list; the
machine's label is the plugin's `machine` option, the hostname when
unset, and `plans` names it in its first line.

**A finished chat ends an hour after it goes quiet.** A replaced session
is stopped three minutes after its successor starts. Any other session
the queue started arms, at each of its stops, a timer at the cache's life
(sixty minutes); when it fires, a session whose turn is done (`claude
agents` says `done`), whose last turn is older than the warm span and
that has no plan or brief under way is stopped with `claude stop`, which
keeps its conversation; a session used again in the hour is left, and
its next stop re-arms the timer. A session that asked the owner a
question (`blocked`) is never ended by the queue, and `plans` says it is
waiting for input. `plans end` ends this queue's finished chats now, and
`plans end <id>` one of them; `plans` says when each will end. **`plans
end <id> --now` ends a named chat whatever it is doing**, a stuck turn or
a question included, with its subagents' tmux server. Once it is
stopped, the plan it had under way gets a "Handing over, <date>, ended by
<owner>" section in place of its Building line, on the branch its worktree
was on, or the brief loses its Planning line; the lock is released and a
fresh executor or planner is started on it, as any start is. The
assistant runs it when the owner names the chat or agrees to it
(plans/end-a-stuck-chat.md). Claude
Code's own supervisor stops a done background session on its own clock,
about an hour by its docs and eight by this machine's log, which is why
idle chats lingered.

**Archiving a chat in the Claude app does not stop it.** The app is a
window into the session; an archived one is hidden there and reopened by
`/remote-control`, while its process runs on, still counted by `plans` as
alive and still refusing a start. The process's exit is what archives
the chat (Claude Code 2.1.113), so a chat is ended by `claude stop`, the
timer's or `plans end`, and never by archiving; the transcript stays on
the machine for `claude --resume`.

**A background session works in
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
checkout at `origin/<branch>` after its batch's last push. The queue's
own files in `.claude/` are git-ignored, one line per kind
(`.claude/executor.*`, `.claude/planner.*`, `.claude/asking.*`,
`.claude/assistant.*`), and so is
`.claude/worktrees/`, where Claude Code puts the worktrees it makes: `plans
init` writes them into `.gitignore`, and `plans sync` and `plans start`
add any a project set up earlier lacks to `.git/info/exclude`, which git
never tracks, so the checkout stays clean.

**Each project's queue runs apart from every other, in parallel.** A
change to the workflow goes through the plugin's own queue, never the
queue of the project it was noticed in, and the two run at the same
time. What is a project's is in its checkout (`.claude/executor.lock`,
`executor.pause`, the deferrals) or named after it (its sessions,
`<Project> Executor n (<machine>)`); what is the subscription's is shared on
purpose (the usage numbers); and a queue counts a session as its own
only when the session's working directory is in its checkout or one
of its worktrees, or its own files name the session. A session the
queue starts gets a clean environment: the project and plugin
variables a hook exports are not handed down, and `plans` run as a
command acts in the working directory. A start waits up to ten
seconds to see its session in `claude agents`, and says why when it
does not appear (an untrusted folder, most often) instead of logging
a start that never ran. **A checkout is a queue**: the same repository
checked out on two machines is two queues, each with its `plans/`, its
lock and its log, both pushing the project's branch, each executor
branching from a fresh `origin/<branch>`; nothing is shared between
them, and what crosses is a message, or a brief one queue's executor
writes into another's `plans/`, so an executor's follow-ups go to an
assistant on its own machine.

**Briefs are queued like plans**: a file headed `Brief for the planner` is
a brief, listed under "Briefs, oldest first"; `## Planning, <date>,
session <id>`, written by the planner as its first edit, marks it taken
while that session lives. The assistant ends a brief with `plans start
--agent planner plans/<topic>.md`, which starts a planner as a
background Remote Control chat at high effort, one at a time, and a
second beside a busy one whose context is past the reuse ceiling or gone
cold, under the
executor's bounds (the usage windows and the pause shared, the names, the
quick-death rule and the tripwire counted per kind), and `plans start
--agent assistant plans/<x>.md` an assistant chat on a built plan's
follow-ups, one at a time per project and machine. **A planner with room
left takes the next brief**: its Stop hook applies the executor's rule to
briefs, so with a brief waiting a planner that has not compacted takes the
oldest, one that has compacted once takes the oldest related brief (the
brief names a file one of its plans names, `plans/` and `.claude/` paths
included, or one of those plans), and one that has compacted twice, or
once with nothing related waiting, is retired and the hook starts the
next planner; a brief it was named and did not take goes to a fresh
planner at its next stop. With nothing waiting it stays alive and
unretired for the hour its cache is warm, then ends, and while it lives
`plans start --agent planner` refuses beside it and prints
the message to send it, which the assistant sends with `SendMessage`. A
chat holds every plan it wrote: it may still edit each until an
executor's Building line takes it, and the hook tells it on every prompt
where each plan stands, and `plans` says it on the planner's line; a
retired chat is stopped when every plan of its own is taken or the next
planner starts, or an hour after it goes quiet, its plans standing in the
queue.

A decision the plan left to the owner is taken in its "Decided" section
before that part is built; a question a plan did not foresee goes through
the question tool in the executor's session, not back to the planner.

**Asked once.** A decision a plan leaves to the owner is asked by its
planner, in its chat, and by nobody else. For thirty minutes from the
question the plan is the planner's: `plans` lists it under "Asking
<owner>" with the chat's name and the time the executor takes over, the
executor's Stop hook does not name it, and `plans start` neither takes it
by default nor accepts it by path, and an executor handed its path, by the
owner or in a message, waits for it too, unless the owner says in its chat
to build it now (his word goes in "Decided" first). The queue's tool
hook refuses an executor's Building line on a plan still asking, and its
`wrote` hook takes out one a shell command wrote. Answered in time, the
planner records
"Decided" and hands the plan over; it writes the section only once every
decision is answered, since a "Decided" section lets the plan go (Javi,
28 October: a plan asked in two rounds keeps its hold until the last).
The thirty minutes are counted from the question: the queue's tool hook,
run on the question tool in the planner's chat, records the time for
each of its plans that asks and defers a start of them to thirty minutes
later, in a deferral of its own (`.claude/asking.deferred`, held by a
pause, re-armed by a resume, printed by `plans`), so a question never
moves a usage limit's restart. A plan leaves that deferral once it is
decided or taken: the planner's write of a "Decided" that covers every
decision, an executor's Building line and a start of it each take it out.
A started chat's PATH drops the plugins' `bin` folders it inherited, so
its `plans` is the installed version's. Talking does not restart the window;
another question inside it does, and a plan whose window ran out is not
held again by a question about another. Between writing the plan and
asking, the plan is held from when it was written. Past the thirty
minutes, or once the planner's chat has
ended, the plan is ready: the deferred start takes it, and any
executor's next stop names it, and the executor builds it as any other,
building each decision with no "Decided" by its recommended option and
writing it there as taken for the owner, unanswered; the executor never
asks a plan's listed decision. The planner's chat keeps its question
standing, since the queue never ends such a chat; an answer that comes
late and differs is a change to a taken plan: the planner writes the
follow-up plan itself ("The chat he said it in writes it"). A planner the owner opened himself, which the queue
gave no brief, holds nothing: its plan is ready at once. (Javi, 28
October: wait thirty minutes, then decide for him.)

**The group's message.** A change to another person's part, a catalogue
rule whose tier carries their name or a thing the project file's
**People** heading gives them, is built as any other plan, and the pull
request, whose decisions name who decided each rule it replaces, is
where the people discuss it. What the workflow adds is the message: the
assistant notes the part in the brief (`Touches <name>'s part`), and the
planner writes a "For the group" section with the message in the owner's
words, what he wants to change, which of the person's decisions it
touches and why, what he asks, and that the detail comes as a pull
request, and gives it in its final message ready to paste, so he can
send it while the plan is built. The plan is not held for the group's
answer and the queue has no state for it (Javi, 28 October: the speed,
since nothing lands until a person merges); a group that has already
agreed is written in "Decided", with no message.

**The day's fixes.** With `land: pull-request`, the day's `Lands: fix.`
plans are one pull request, `Small fixes, <d Month yyyy>` from the branch
`fixes-<yyyy-mm-dd>` (the owner, 30 October: a daily pull request for
the small fixes, rather than a message for the group, which would look
odd there; Rust's rollups and Dependabot's grouped updates batch small
changes the same way). The executor opens it with the day's first fix
and rewrites its description with each next one, with no comment, since
a fix has nothing to decide; the people merge it when they like, and
nobody has to read it. Its description lists every fix, a line each, the
commit's title (Javi, 31 October: a path nobody reading the pull
request can open), each fix's screenshots under it with their line;
under `Already on <branch>`, the day's fixes pushed straight, read off
`git log`, the commits whose title does not end in GitHub's squash
suffix ` (#<n>)`; and where to try it. The queue keeps no state for it:
the day's pull request is found by its branch, and an earlier day's
still open is left to the people. A fix that comes after
the day's pull request was merged or closed waits for tomorrow (the
owner, 30 October: never two in a day): it is built on the next day's
branch, pushed, and listed with the topics waiting for a pull request,
which the next day's first fix, or the next batch on that day, opens.

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
with a rule that lacks its tier and date is asked to add them, and an
entry at the retired agent's choice dated today is asked to be taken out
or tiered by what it followed. A session is
charged only with its own writes; the planner and the assistant are never
audited. The refusal is one per turn, so nothing loops. The plain-words
hook (`scripts/plain-words.mjs`) checks every question to the owner the
same way, refused twice at most in a turn.

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
picks the change up after its next session starts. On a second machine,
`/workflow:change` keeps a second checkout, and that machine's queue
builds what is written there; the plugin's `main` carries it to the
other.

**A change the plugin leaves for the project it came from goes back as a
brief.** The brief `/workflow:change` writes says where it came from,
`From: <Project>, <path>.` under its header paragraph (the project
file's `name` and the checkout's absolute path), and the plan keeps the
line. Work the plan leaves to that project, its docs, its catalogue, its
hooks' copies of the plugin's readers, is never a bullet under "Not in
this plan": the planner writes it as a brief for that project's planner,
in a section `## For <Project>: plans/<topic>.md` in the assistant's
brief shape, naming the plugin's plan by its path in this checkout and
the project's files by theirs, with a name free in that project's
`plans/`. After the push, the executor writes the file into that
checkout's `plans/` and starts its queue (`cd <path> && plans start
--agent planner plans/<topic>.md`, or the message the command prints to
a live planner there), and its "Built" section says which happened. The
file is the carrier and the start the nudge: a queue paused or over its
window there lists the brief all the same. The executor's Stop hook
holds the first stop until the file exists, as it holds it on a red run,
and a plan whose section names a checkout the `From` line does not is
held once too, so the brief is written or the gap said. (Jira's linked
issue created in another project with the summary carried over;
GitHub's issue transfer, which moves the item into the other list and
leaves the address behind; Actions' `repository_dispatch`, which pokes
the other repository's own workflow. Javi, 31 October: four built plans
left the project's half under "Not in this plan" and nobody carried it.)

## Installing

```
claude plugin marketplace add JavierMNieto/workflow-plugin#main
claude plugin install workflow@workflow --config owner="<name>"
```

A newcomer pastes one line into Claude Code, "Install the workflow
plugin from https://github.com/JavierMNieto/workflow-plugin by following
its INSTALL.md", and Claude does the rest: `INSTALL.md` at the
repository's root, written for Claude, runs these two commands, merges
the settings below into the person's own with their yes, offers
`/workflow:setup` for a project not set up yet, and ends with a short
plain message. Its JSON block is a copy of the one below, and a test
fails while they differ.

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
(`claude plugin install workflow@workflow --config owner=<name>`), and
the machine's label in session names is the option `machine`, set once
per machine (`echo '{"machine":"<label>"}' | claude plugin configure
workflow@workflow --values-stdin`).

**A push needs a token in the container.** The queue's chats run where
no VS Code window may be, and VS Code's git credential helper answers
only while its window is attached; so the owner keeps a fine-grained
GitHub token in `GH_TOKEN` on the host (their repositories; Contents
read and write, Actions read, Metadata read, Workflows read and write,
so a plan that changes a file under `.github/workflows/` is pushed too:
Javi, 27 October; and, for a project with `land: pull-request`, Pull
requests read and write for `gh pr create`, with Checks read and Commit
statuses read for the checks the Stop hook reads), each project's
`.devcontainer/devcontainer.json` carries it in as
`"containerEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }` (the setup
writes the line; a rebuild makes it take), and the dotfiles install
`gh` and run `gh auth setup-git --hostname github.com` when the
variable is set, so `git push` over HTTPS and `gh run watch` work in
every chat. The token's value is in no file; the setup's final message
says where access stands. A token expires: `gh auth status` says so,
and a new one on the host and a rebuild renew it. **Screenshots on a
pull request** go up through `gh pr create --attach`, which needs gh
2.99 or newer and authenticates, by GitHub's changelog, with the OAuth
token or a classic token; if a fine-grained token's upload is refused,
the fix is a classic token with `repo` on the host. Debian's packaged gh
is 2.23, so a container that attaches installs gh from GitHub's own apt
repository; with an older gh the executor opens the pull request without
them and says so.

The research-writing skills are a second plugin of the same marketplace,
`writing@workflow`, that a project turns on in its own
`.claude/settings.json`; its skills load when the project works on
`.tex`, `.bib` or `.md` files, and the project's own writing decisions
are its catalogue. `/workflow:setup` in a new project writes its project
file and turns the plugins it needs on, and the others off.
