# Landing by pull request

The executor reads this file at a batch's start in a project whose file
says `land: pull-request`; there, "push" in its agent file means the
landing below (decisions.md#topic-landing). The merge is the people's:
never `gh pr merge`, never `gh pr ready` without `--undo`, and the
branch itself is pushed only for a `Lands: fix, now.` plan, as a
fast-forward. In a project whose file has an **Issues** heading, every
write to GitHub but the push runs as `plans gh` (`gh pr create`, `gh pr
edit`, `gh pr ready --undo`); the push stays on `GH_TOKEN`.

**The `Lands` line**, under the plan's header paragraph, is one of
`Lands: fix.`, `Lands: fix, now.`, `Lands: topic <name>, waiting.` and
`Lands: topic <name>, ready.`, a topic's with `; lands in #<n>.` or `;
stacked on #<n>.` after its state when the author names the pull
request, kept when the line is rewritten. A plan with none is `topic
<the plan's file name without .md>, ready`. The author judges whether a
topic is ready and whether a change is a fix; follow the line.

**A topic's pull request is a draft until ${user_config.owner} has
reviewed it** (decisions.md#draft-until-reviewed): `gh pr create` takes
`--draft`, and a plan that joins a pull request he has marked ready (`gh
pr view <n> --json isDraft` says false) runs `gh pr ready --undo <n>`
before its commit is pushed; a conversion that fails stops the push. The
day's fixes pull request opens ready. A word from him to mark one ready
is answered with the step (the Ready for review button), not the
command.

**A branch is brought up to date by a merge**, never a rebase and a
forced push (decisions.md#merge-never-force): `git merge --no-edit -m
"Merge origin/<base> into <name>" -m "<the attribution lines the session
gives>" origin/<base>`, a conflict settled from the plans and committed
with `git commit --no-edit`; one that cannot be is left (`git merge
--abort`) and named in the final message. Its push is a plain push to
that branch only; refused, `git fetch origin`, the same merge of
`origin/<name>`, the project's checks again on the merged tree, and one
more push; refused again, it is left and named. Each merge gets a line
in the plan's "Built", `Merged <base> <date>, commit <sha>: <the files
whose conflicts were settled, or none>`.

**A topic's branch** is the topic's name, after `git fetch --prune`; a
name that is the branch, `main` or `fixes-` followed by anything is no
topic's, and the plan is built as `topic <the plan's file name without
.md>`, its "Built" saying why.

- **A plan that rests on an open pull request** (its header names an
  earlier plan, one whose additions it uses, whose pull request is open)
  is settled first, by `gh pr view <n> --json isDraft,headRefName`
  (decisions.md#stack-only-on-use). **A draft of this queue's own** (one
  a plan in this checkout's `plans/` names as its own) takes it: the plan
  lands in that pull request whatever topic its `Lands` line names, its
  topic that head branch, built as "An open pull request's branch" says
  and described as "A pull request already open" says. One marked ready,
  or another person's, is stacked on ("No branch yet"), the plan built as
  `topic <the plan's file name without .md>` when its `Lands` line names
  that pull request's own topic, with `-2` after it when that too is the
  pull request's head branch. A plan sent to another topic has its
  `Lands` line rewritten to it, its "Built" saying why. A plan that only
  changes a file an open pull request changes is neither joined to it
  nor stacked on it.
- **No branch yet** (no `origin/<name>`, no local `<name>`): `git switch
  -c <name> origin/<branch>`. Stacked, `git switch -c <name> <that head
  branch>`, the pull request's `--base` that branch and the first line of
  its body `Builds on #<n>; merge that first.`
- **A waiting branch** (`origin/<name>` exists and no open pull request
  has it as head): `git switch -C <name> origin/<name>`, unless the local
  branch holds commits the remote lacks (then the local one, pushed
  first), then `origin/<branch>` (or `origin/<the head branch it is
  stacked on>`) merged in ("A branch is brought up to date by a merge"),
  the plan's push carrying the merge. A conflict that cannot be settled
  leaves the plan built on the branch as it is.
- **An open pull request's branch**: `git switch -C <name>
  origin/<name>`, no merge, unless the local branch holds commits the
  remote lacks (then the local one, pushed first).
- **The tip it starts from** is recorded before the first edit, `git
  rev-parse HEAD` once the branch is taken and merged: the plan's squash
  goes back to it and no further.

**At a batch's start**, `git fetch --prune`; then each open pull request
of this queue (one a plan in this checkout's `plans/` names as its own,
by its "Built" or its `Lands` topic) whose
base is a branch whose pull request has merged is retargeted, `gh pr
edit <n> --base <branch>`, and `origin/<branch>` merged into its head
and pushed, the refresh's way (decisions.md#refresh-only-your-own); then
a local branch is deleted (`git branch -D`) only when `gh pr view <name>
--json state,headRefOid` says MERGED at the branch's own commit. A
branch whose pull request was closed unmerged, or that holds commits
past it, stays, named in the final message.

**Then a conflicting pull request is refreshed**: each open pull request
of this queue that GitHub reports as conflicting (`gh pr view <n> --json
mergeable,baseRefName,headRefName,headRefOid`, `mergeable`
`CONFLICTING`; one still `UNKNOWN` is asked again once the others are
done, and named if it stays so), a pull request before the ones stacked
on it. Its work starts from its head as GitHub has it, `git switch -C
<head branch> origin/<head branch>`, unless the local branch holds
commits that head lacks: then it is left and named. Its own base,
`origin/<baseRefName>`, is merged in ("A branch is brought up to date by
a merge"; one stacked on a pull request just refreshed merges that one's
new head), the conflicts settled from the two plans. The project's
checks run again (not the suites), and it is pushed with `git push
origin <head branch>`, a plain push to its own head branch only, never
to the branch. Its plan's "Built" gets `Refreshed <date>: merged <base>,
commit <sha>, <the files whose conflicts were settled>`. One that cannot
be settled is left and named; then `git checkout --detach
origin/<branch>` before the first plan's branch.

**"Before the push" runs once per plan**, a fix's included.

**A topic's plan**: one commit per plan on the topic's branch, the
squash going back to the tip the branch had when this plan started,
never to the previous plan's commit, so a commit another person pushed
stays theirs. When the topic's pull request is open and no draft, `gh pr
ready --undo <n>` first; then `git push -u origin <name>`, a plain push
to the topic's branch only, retried as "A branch is brought up to date
by a merge" says. Where the squash would rewrite a commit already pushed,
the plan's commits are pushed as they are, and "Built" names each. Then,
by the topic:

- **Waiting, no pull request**: nothing opens. "Built" opens with `On
  topic <name>, commit <sha>, branch pushed; its pull request waits.`
- **Ready, no pull request**: the description (below) written from every
  plan of the topic so far, oldest first, to `plans/<the ready
  plan>/pull-request.md`, read back as the reviewer will, then:

  ```
  gh pr create --draft --base <branch, or the head branch it is stacked on> \
    --title "<the ready plan's title>" \
    --body-file plans/<the ready plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  one `--attach` per screenshot of each plan of the topic. "Built" opens
  with `Pull request #<n> (<url>) to <branch> from branch <name>, commit
  <sha>; draft, checks green.`, and each earlier plan of the topic gets,
  after its "Built" section's first line, `Pull request #<n> (<url>)
  opened <date> with plans/<x>.md.`
- **A pull request already open**: the description written again from
  every plan of the topic, this one included, to `plans/<this
  plan>/pull-request.md`, keeping the uploaded image addresses of its
  current body (`gh pr view <n> --json body`) and writing this plan's
  screenshots as local paths under the decisions they show; made a draft
  again before the push when it was not one; then

  ```
  gh pr edit <n> --body-file plans/<this plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  No comment: the description is the record
  (decisions.md#joined-pull-request). "Built" opens with `Pull request
  #<n> (<url>) joined, commit <sha>; draft, checks green.`

**A fix**, `Lands: fix.`: built on the day's branch,
`fixes-<yyyy-mm-dd>` (the day of the plan's push), its pull request
found by `gh pr list --state open --head fixes-<yyyy-mm-dd> --json
number,url` (decisions.md#days-fixes). With one open: `git switch -C
fixes-<yyyy-mm-dd> origin/fixes-<yyyy-mm-dd>` (or the local branch when
it holds commits the remote lacks), one commit, `git push -u origin
fixes-<yyyy-mm-dd>`, a plain push, and its description rewritten,
keeping its uploaded image addresses, `gh pr edit <n> --body-file
plans/<the plan>/pull-request.md --attach plans/<x>/<file>.png#<the
line> ...`, no comment. With none open and none merged or closed that
day (`gh pr list --state all --head fixes-<yyyy-mm-dd>`): the branch off
`origin/fixes-<yyyy-mm-dd>` when an earlier fix waits on it,
`origin/<branch>` merged in after ("A branch is brought up to date by a
merge"), else off `origin/<branch>`; one commit, the push, then `gh pr
create --base <branch> --title "Small fixes, <d Month yyyy>" --body-file
plans/<the plan>/pull-request.md --attach ...`, the date as the plans
write it (`30 October 2026`). With the day's pull request merged or
closed already, the fix **waits for tomorrow**: built the same way on
`fixes-<the next day's yyyy-mm-dd>`, pushed, no pull request; "Built"
opens with `On topic fixes-<the next day's yyyy-mm-dd>, commit <sha>,
branch pushed; its pull request waits.` At a batch's start, a
`fixes-<yyyy-mm-dd>` branch whose day has come, with no pull request,
has it opened by the same command. The squash goes back to the tip the day's
branch had once taken and merged, never to `origin/<branch>`. "Built"
opens with `Pull request #<n> (<url>) of the day's fixes, commit <sha>;
open, checks green.`

**A fix wanted now**, `Lands: fix, now.`: a branch of its own off
`origin/<branch>`; one commit; `git push origin HEAD:<branch>` as a
fast-forward, retried after `git fetch origin && git rebase
origin/<branch>` once, as the agent file's push says; the project's
`run` read (decisions.md#fix-now-landing). Then it is listed under
`Already on <branch>` in the day's fixes pull request when one is open,
or by the day's first fix that opens one; a day with none leaves it
recorded by its commit alone, which the final message says. "Built"
opens with `Pushed straight to <branch> as a fix, commit <sha>; <run>
green.` (with no `run`, `no run to read.` in place of `<run> green.`).

**A fix that is not one**: a commit that adds, changes or strikes a
catalogue rule, or changes a rule in the project's docs, lands as `topic
<the plan's file name without .md>, waiting`, its "Built" saying why, and
the final message names it, so ${user_config.owner} says through the
assistant whether the topic is ready (decisions.md#fix-landing).

**The screenshots, when `--attach` fails** (gh under 2.99.0, or the
upload refused; decisions.md#screenshots-attach): the body's images are
taken out, each one's line kept where it stood, one line goes under `##
To try it` before its own, and the pull request is created, or its
description set, without `--attach`; an image already uploaded stays.
When the refused `gh pr create` opened one anyway (`gh pr view <name>
--json number,url`), its body is replaced, never a second pull request;
when a refused `gh pr edit` set part of the body, it is read back (`gh pr
view <n> --json body`) into the file and set again with the failed images
taken out. The line: `Screenshots: sent in the executor's chat; attaching
them needs gh 2.99 or newer in this container, signed in with a token
that can upload (the plugin's docs, "Installing").` The final message
and "Built" say the same.

**The checks are watched**: `gh pr checks <n> --watch --fail-fast` (exit
8 is pending, any other nonzero a failure), then a failed job's log (`gh
run view <run id> --log-failed`, the id from `gh pr checks <n> --json
link`), fix, push again, watch again. A red pull request is fixed before
the next plan starts. The project's `run` is read only for a fix pushed
straight.

**After the batch's last plan**, `git checkout --detach
origin/<branch>`; the local branches stay, since the hook matches pull
requests to them.

**The final message leads with** each pull request opened or joined, its
link, what it was marked related to in the same sentence, and: `Pull
request #<n> (<link>) is a draft and waits on you: read its description
and screenshots, then mark it ready for review on GitHub (the Ready for
review button at the bottom of the pull request). Until then it asks
nothing of anyone else.`; then the topics left waiting, the day's fixes
pull request, and the fixes pushed straight.

**The description** is the catalogue's diff in the catalogue's order, not
a story (decisions.md#description-is-the-diff): plain words, no dashes,
the project's spelling, every string from the plans or the catalogue,
the titles of the commits under `Also` aside; screenshots aside, it fits
one screen:

```
For #<n>.                                     <- plans with an Issue line only
Builds on #<n>; merge that first.             <- stacked plans only
Related: #<n>.                                <- plans with a Related line only

## New

- **<The rule, as the catalogue entry words it.>** (<tier and date, as
  the entry has them>) <The reason, one sentence.> `<catalogue file>#<id>`

  <What changed in the screenshot, in one line.>

  ![<the same line>](plans/<topic>/<file>.png)

## Changed

- **<The rule, as the entry words it.>** (<tier and date>) <The
  reason, one sentence.> `<catalogue file>#<id>`
  - ~~<The rule it replaces, as the catalogue keeps it.>~~ (<its tier
    and date>)

## Retired

- ~~<The rule, as the catalogue keeps it.>~~ (<its tier and date>;
  retired <date>) <Why, one sentence.> `<catalogue file>#<id>`

## Also

- <A change with no decision in it, in a line.>
- <The commit's title.> (<author>)

## To try it

<One line.>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **Related**: the plans' `Related` lines as written (`Related: #31.`),
  one line, after `For` and `Builds on`, or first. Never look for related
  work yourself, and never comment on another person's pull request.
- **For**: `For #<n>.`, the issue of each plan of the topic with an
  `Issue` line, one line, first, no closing keyword.
- **New, Changed, Retired**: every catalogue entry the topic's commits
  add, replace or retire, and every "Decided" item with no entry, under
  the heading of what the commit did to it, in the catalogue's order, as
  the template shows; a "Decided" item with no entry the same way from
  the plan, who decided it and when in the parenthesis, no id. A changed
  or retired rule whose struck line carries another person's name is a
  conflict and goes first under its heading. Nothing else in a bullet. A decision taken after thirty minutes
  unanswered keeps `taken by the executor for ${user_config.owner},
  unanswered ("Asked once")` in place of his name and date.
- **Screenshots**: each under the bullet of the decision it shows, one
  level in, its one line above it saying what changed in the image, also
  its `--attach` alt text. One that shows no decision goes under `## To
  try it`.
- **Also**: a line per change with no decision in it, from the plans'
  "Building it"; then a line per commit on the topic's branch that this
  checkout's plans do not account for, from `git log
  origin/<base>..origin/<name> --format='%H%x09%an%x09%s'` after the
  push: `- <the commit's title> (<author>)`, a merge another person made
  included (decisions.md#plans-account-for-commits). Accounted for, and
  left out: this plan's own commit and the merges it made, `git log
  --first-parent <tip>..HEAD --format=%H`, with a merge this plan made
  before its tip; a commit a plan of the topic names in its "Built"
  (`commit <sha>` in its first line, its `Merged` and `Refreshed` lines,
  a line that names a pushed commit), matched by hash, the shorter a
  prefix of the longer; and, on a branch stacked on a pull request since
  merged, the commits of each merged pull request down the stack, each
  found by the `Builds on #<n>` line its body opens with (`gh api
  --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`).
  Nothing is left out by author or by title. With none, the heading is
  left out.
- **To try it**: one line from the project file's "After the push" (else
  "Check out the branch.").
- **The title** is the title of the plan that marks the topic ready.
- **The attribution** is the lines the session gives for a pull request,
  less any line that carries a `claude.ai/code/session_` address, an old
  one in a body being rewritten included.

**The day's fixes pull request**, `Small fixes, <d Month yyyy>` from
`fixes-<yyyy-mm-dd>`, has its own description, written to `plans/<the
plan>/pull-request.md` each time a fix joins, with no words of yours:

```
## Fixes

- <The commit's title.>

  <What changed in the screenshot, in one line.>

  ![<the same line>](plans/<x>/<file>.png)

## Already on <branch>

- <The commit's title.> (<the commit's short sha, linked>)

## To try it

<One line.>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **Fixes**: every fix on the day's branch, oldest first.
- **Already on <branch>**: the day's fixes pushed straight, from `git log
  origin/<branch> --first-parent --since=<the day's start> --format='%h
  %s'`, keeping the commits whose title does not end in ` (#<n>)` and are
  not merge commits; with none, the heading is left out.
- **To try it** and **the attribution**: as the topic's description.
