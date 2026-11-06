# Landing by pull request

The executor reads this file at a batch's start in a project whose file
says `land: pull-request`; there, "push" in its agent file means the
landing below (decisions.md#topic-landing). The merge is the people's:
run no `gh pr merge` and no `gh pr ready` without `--undo`; push the
branch itself only for a `Lands: fix, now.` plan, as a fast-forward. In a
project whose file has an **Issues** heading, every write to GitHub but
the push runs as `plans gh` (`gh pr create`, `gh pr edit`, `gh pr ready
--undo`); the push stays on `GH_TOKEN`.

**The `Lands` line**, under the plan's header paragraph, is one of
`Lands: fix.`, `Lands: fix, now.`, `Lands: topic <name>, waiting.` and
`Lands: topic <name>, ready.`, a topic's with `; lands in #<n>.` or
`; stacked on #<n>.` after its state when the author names the pull
request, kept when the line is rewritten. A plan with none is `topic
<the plan's file name without .md>, ready`. Follow the line: the author
judges whether a topic is ready and whether a change is a fix.

**A topic's pull request is a draft until ${user_config.owner} has
reviewed it** (decisions.md#draft-until-reviewed): `gh pr create` takes
`--draft`, and a plan that joins one he has marked ready (`gh pr view
<n> --json isDraft` says false) runs `gh pr ready --undo <n>` before its
commit is pushed; a conversion that fails stops the push. The day's
fixes pull request opens ready; the refresh and the retarget leave the
state as it is. His word to mark one ready is answered
with the step, the Ready for review button.

**A branch is brought up to date by a merge**, not a rebase and a forced
push (decisions.md#merge-never-force): `git merge --no-edit -m "Merge
origin/<base> into <name>" -m "<the session's attribution lines>"
origin/<base>`, a conflict settled from the plans and committed with
`git commit --no-edit`; one that cannot be is left (`git merge --abort`)
and named in the final message. Push it to that branch only; refused,
`git fetch origin`, merge `origin/<name>` the same way, run the checks
and push once more; refused again, leave it and name it. Each merge gets a line in "Built": `Merged <base> <date>, commit <sha>: <files or none>`, the files whose conflicts were settled.

**A topic's branch** is the topic's name, after `git fetch --prune`. A
name that is the branch, `main` or `fixes-` followed by anything is no
topic's: build the plan as `topic <the plan's file name without .md>`,
its "Built" saying why.

- **A plan that rests on an open pull request** (it uses what an earlier
  plan adds) is settled first, by
  `gh pr view <n> --json isDraft,headRefName`
  (decisions.md#stack-only-on-use). **A draft of this queue's own** takes
  it: the plan
  lands in that pull request whatever its `Lands` line names, its topic
  that head branch. One marked ready, or another person's, is stacked on
  ("No branch yet"), as `topic <the plan's file name without .md>` (with
  `-2` when that is the head branch) when its `Lands` line names that
  pull request's topic. A plan sent to another topic has its `Lands` line
  rewritten to it. A plan that only changes a file an open pull request
  changes is neither joined to it nor stacked on it.
- **No branch yet** (no `origin/<name>`, no local `<name>`): `git switch
  -c <name> origin/<branch>`. Stacked: `git switch -c <name> <that head
  branch>`, that branch the pull request's `--base` and the first line
  of its body `Builds on #<n>; merge that first.`
- **A waiting branch** (`origin/<name>`, no open pull request): `git
  switch -C <name> origin/<name>`, then its base merged in, the plan's
  push carrying the merge; an unsettled conflict leaves it as it is.
- **An open pull request's branch**: `git switch -C <name>
  origin/<name>`, no merge.
- In both, a local branch holding commits the remote lacks is taken
  instead, and pushed first.
- **The tip it starts from** is recorded before the first edit, `git
  rev-parse HEAD` once the branch is taken and merged; the plan's squash
  goes back to it and no further.

**At a batch's start**, `git fetch --prune`. The queue's own pull
requests are the open ones a plan in this checkout's `plans/` names as
its own, by its "Built" or its `Lands` topic; a `Related` line names
another's (decisions.md#refresh-only-your-own). Each whose base branch's
pull request has merged is retargeted, `gh pr edit <n>
--base <branch>`, and `origin/<branch>` merged into its head and pushed.
Delete a local branch only when `gh pr view <name> --json
state,headRefOid` says MERGED at its own commit; others stay, named in
the final message.

**Then a conflicting pull request is refreshed**: each of the queue's
own that GitHub reports as conflicting (`gh pr view <n> --json
mergeable,baseRefName,headRefName,headRefOid`, `mergeable`
`CONFLICTING`; one still `UNKNOWN` is asked again once the others are
done, and named if it stays so), a pull request before the ones stacked
on it. Start from its head as GitHub has it, `git switch -C <head
branch> origin/<head branch>`; a local branch holding commits that head
lacks is left and named. Merge its base, `origin/<baseRefName>`, in (one
stacked on a pull request just refreshed merges that one's new head),
the conflicts settled from the two plans; run the project's checks, not
the suites; push it with `git push origin
<head branch>`, never to the branch. Its plan's "Built" gets `Refreshed <date>: merged <base>, commit <sha>, <files>`. One that cannot be settled
is left and named. Then `git checkout --detach origin/<branch>`.

**"Before the push" runs once per plan**, a fix's included.

**A topic's plan**: one commit per plan on the topic's branch, squashed
back to the plan's tip, so a commit another person pushed stays theirs;
where that would rewrite a pushed commit, push the plan's commits as
they are and name each in "Built". With the pull request open and no
draft, `gh pr ready --undo <n>` first; then `git push -u origin <name>`,
retried as for a merge. Then, by the topic:

- **Waiting, no pull request**: nothing opens. "Built" opens with
  `On topic <name>, commit <sha>, branch pushed; its pull request waits.`
- **Ready, no pull request**: the description (below), written from
  every plan of the topic so far, oldest first, to `plans/<the ready
  plan>/pull-request.md` and read back as the reviewer will, then:

  ```
  gh pr create --draft --base <branch, or the head branch it is stacked on> \
    --title "<the ready plan's title>" \
    --body-file plans/<the ready plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  one `--attach` per screenshot of each plan of the topic. "Built" opens
  with `Pull request #<n> (<url>) to <branch> from branch <name>, commit <sha>; draft, checks green.`, and each earlier plan of the topic gets,
  after its "Built" section's first line,
  `Pull request #<n> (<url>) opened <date> with plans/<x>.md.`
- **A pull request already open**: the description written again from
  every plan of the topic to `plans/<this plan>/pull-request.md`, keeping
  the uploaded image addresses of its body (`gh pr view <n> --json
  body`), this plan's screenshots as local paths; a draft again before
  the push; then

  ```
  gh pr edit <n> --body-file plans/<this plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  A plan marked waiting says in "Built" that it was open already.
  No comment: the description is the record
  (decisions.md#joined-pull-request). "Built" opens with
  `Pull request #<n> (<url>) joined, commit <sha>; draft, checks green.`

**A fix**, `Lands: fix.`, is built on the day's branch,
`fixes-<yyyy-mm-dd>`, the day of its push (decisions.md#days-fixes),
one commit pushed with `git push -u origin fixes-<yyyy-mm-dd>`. Its pull
request open (`gh pr list --state open --head fixes-<yyyy-mm-dd> --json
number,url`): the branch is `origin/fixes-<yyyy-mm-dd>`, and its
description rewritten by `gh pr edit` with `--attach`, keeping its
uploaded image addresses; no comment. None open and
none merged or closed that day (`gh pr list --state all --head
fixes-<yyyy-mm-dd>`): the branch is `origin/fixes-<yyyy-mm-dd>` when an
earlier fix waits on it, `origin/<branch>` merged in, else
`origin/<branch>`; after the push, `gh pr create --base <branch> --title "Small fixes, <d Month
yyyy>" --body-file plans/<the plan>/pull-request.md --attach ...`, the
date as the plans write it (`30 October 2026`). With the day's pull
request merged or closed, the fix **waits for tomorrow**: built the same
way on `fixes-<the next day's yyyy-mm-dd>`, pushed, no pull request;
"Built" opens with `On topic fixes-<the next day's yyyy-mm-dd>, commit
<sha>, branch pushed; its pull request waits.` At a batch's start, a
`fixes-` branch whose day has come and that has no pull request gets one
by the same command, each of its plans' "Built" getting
`Pull request #<n> (<url>) opened <date> with plans/<x>.md.` A local `fixes-` branch with commits the remote lacks is taken as it
is. Pushes are plain, retried as a merge's; the squash goes back to the
branch's tip once taken and merged. "Built" opens with
`Pull request #<n> (<url>) of the day's fixes, commit <sha>; open, checks green.`

**A fix wanted now**, `Lands: fix, now.`: a branch of its own off
`origin/<branch>`; one commit; `git push origin HEAD:<branch>` as a
fast-forward, retried as the agent file's push says; the project's `run`
read (decisions.md#fix-now-landing). It is listed under `Already on
<branch>` in the day's fixes pull request, when there is one. "Built" opens with
`Pushed straight to <branch> as a fix, commit <sha>; <run> green.`
(with no `run`, `no run to read.` in place of `<run> green.`).

**A fix that is not one**, a commit that adds, changes or strikes a
catalogue rule or a rule in the project's docs, lands as `topic <the
plan's file name without .md>, waiting`, its "Built" and the final
message saying why (decisions.md#fix-landing).

**The screenshots, when `--attach` fails** (gh under 2.99.0, or the
upload refused; decisions.md#screenshots-attach): take the images that
failed out of the body, each one's line kept, and set it without
`--attach`, one line under `## To try it`. A refused `gh pr create` that
opened one anyway (`gh pr view <name> --json number,url`) gets its body
replaced, never a second; a refused `gh pr edit` that set part of the
body is read back (`gh pr view <n> --json body`) and set again. The
line: `Screenshots: sent in the executor's chat; attaching them needs gh
2.99 or newer in this container, signed in with a token that can upload
(the plugin's docs, "Installing").` "Built" and the final message say
the same.

**The checks are watched**: `gh pr checks <n> --watch --fail-fast` (exit
8 is pending), a failed job's log by `gh run view <run id> --log-failed`
(the id from `gh pr checks <n> --json link`), fixed and pushed before
the next plan. The project's `run` is read only for a fix pushed
straight.

**After the batch's last plan**, `git checkout --detach
origin/<branch>`; keep the local branches, which the hook matches to
pull requests.

**The final message leads with** each pull request opened or joined, its
link and what it was marked related to, and: `Pull request #<n>
(<link>) is a draft and waits on you: read its description and
screenshots, then mark it ready for review on GitHub (the Ready for
review button at the bottom of the pull request). Until then it asks
nothing of anyone else.`; then the topics left waiting, the day's fixes
pull request, and the fixes pushed straight.

**The description** is the catalogue's diff in the catalogue's order
(decisions.md#description-is-the-diff): plain words, no dashes, the
project's spelling, every string from the plans or the catalogue, the
titles of the commits under `Also` aside; screenshots aside, it fits one screen.

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

- **For** and **Related**: `For #<n>.` for each plan's `Issue` line, no
  closing keyword; the plans' `Related` lines as written (`Related:
  #31.`). Look for no related work yourself, and comment on no other
  person's pull request.
- **New, Changed, Retired**: every catalogue entry the topic's commits
  add, replace or retire, and every "Decided" item with no entry (who
  decided it and when in the parenthesis, no id; under New, or under
  Changed with the struck rule it replaces), under the heading of what
  the commit did to it, in the catalogue's order; only headings with a
  bullet. A bullet is the entry's line: the rule in bold, its tier and
  date, its reason cut to the first sentence, the id last. A changed or
  retired rule whose struck line carries another person's name is a
  conflict and goes first under its heading. Nothing else in a bullet. A
  decision taken after thirty minutes unanswered keeps `taken by the
  executor for ${user_config.owner}, unanswered ("Asked once")` in place
  of his name and date.
- **Screenshots**: each under the decision it shows, its line (what
  changed, also its alt text) above it; one that shows no decision under
  `## To try it`.
- **Also**: a line per change with no decision in it, from the plans'
  "Building it"; then a line per commit on the topic's branch that this
  checkout's plans do not account for (`git log
  origin/<base>..origin/<name> --format='%H%x09%an%x09%s'` after the
  push), as `- <the commit's title> (<author>)`, another person's merge
  included (decisions.md#plans-account-for-commits). Accounted for: this
  plan's commits and merges (`git log --first-parent <tip>..HEAD
  --format=%H`, and a merge this plan made before its tip); a commit a
  plan of the topic names by hash in its "Built", the shorter a prefix
  of the longer; on a branch stacked on a pull
  request since merged, the commits of each merged pull request down the
  stack, found by the `Builds on #<n>` line of its body (`gh api
  --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`).
  Nothing is left out by author or by title. With none, no heading.
- **To try it**: a line from the project file's "After the push", else
  "Check out the branch."
- **The title** is the title of the plan that marks the topic ready.
- **The attribution**: the session's lines for a pull request, less
  any line with a `claude.ai/code/session_` address, old ones included.

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
  %s'`, without merge commits and commits whose title ends in ` (#<n>)`;
  with none, no heading.
- **To try it** and **the attribution**: as the topic's description.
