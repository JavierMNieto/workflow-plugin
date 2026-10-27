# The workflow plugin: working notes

This repository is a Claude Code marketplace with two plugins. The
research-writing skills are `plugins/writing` (six skills, no agents or
hooks, which a project turns on). The workflow is `plugins/workflow`:
the assistant, the planner, the executor, the maker and the reviewer
(`agents/`), the plan queue, the turn audit and the catalogue's
edit-time hook (`scripts/`, run by `hooks/hooks.json`), the status line,
the `/workflow:change` and `design-research` skills and the `plans`
command (`bin/plans`). The rules the agents follow are
`plugins/workflow/docs/workflow.md`; read it before changing an agent or
a script.

**The plugin's own queue builds changes to it.** A change arrives as a
brief or a short plan in `plans/`, through `/workflow:change` from any
project; `.claude/workflow.md` is this repository's project file. `plans/`
is not tracked: a plan is a working file of the queue, and a brief may
quote the project it came from.

**Public, and names no project.** `test/public.test.ts` refuses a host
address, a personal email, the home lab's domain or the name of the
project the workflow was first written in, in every tracked file.

**Nothing from a project is in the plugin.** A project's specifics belong
in its `.claude/workflow.md`; an agent file or a script reads them from
there (`scripts/project.mjs`), never names them.

**The scripts import `node:` modules only**: no dependency reaches a
user's machine. `vitest` and `prettier` are for this repository's checks.

**`main` moves on green CI from `test`**, and nothing else writes it:
`checks.yml` runs the format check, the tests and `claude plugin
validate`, then fast-forwards `main`, which every machine installs from.

## Commands

```bash
npm test                 # the hooks' tests and the public check
npm run format           # Prettier writes; CI runs format:check
npm run validate         # claude plugin validate, plugin and marketplace
node plugins/workflow/bin/plans   # the queue here
```

Prettier at `printWidth: 100`; `*.md` is hand-wrapped prose, ignored.
