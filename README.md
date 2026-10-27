# workflow

A Claude Code plugin: three agents and a plan queue, so that the person's
part of building software is the decisions.

- **The assistant** answers questions from the repository, with sources,
  and ends every topic in one of four ways: answered, a message for a
  person the project names, a short plan for the executor, or a brief for
  the planner.
- **The planner** researches how familiar products do the thing, grounds
  the change in the project's docs and code, asks only what research
  cannot settle, and writes one plan under `plans/`.
- **The executor** builds plans in order on a branch of its own, has the
  diff reviewed three ways, runs the project's checks and suites, pushes,
  and reads the run.

The queue between them lives in the plan files themselves, carried by
hooks: one executor at a time, bounded by the subscription's usage, with
tired sessions replaced by fresh ones. The author uses it in all of the
author's projects, through Remote Control.

## Installing

```
claude plugin marketplace add JavierMNieto/workflow-plugin
claude plugin install workflow@workflow
```

Then the user settings in `plugins/workflow/docs/workflow.md`,
"Installing", and in each project `plans init`, which writes
`.claude/workflow.md`: the project's branch, its run, and what the
executor does before a build and before a push.

## How it changes

Through itself: `/workflow:change` in any project writes a brief or a
short plan into this repository's `plans/` and starts this repository's
own queue. Its CI moves `main` when `test` is green, and Claude Code's
marketplace auto-update brings the change to every machine after the next
session starts.

## Layout

```
.claude-plugin/marketplace.json   the marketplace, one plugin
plugins/workflow/                 the plugin: agents, hooks, scripts,
                                  skills, bin/plans, docs/workflow.md
.claude/workflow.md               this repository's own project file
test/                             the hooks' tests and the public check
```

MIT licensed.
