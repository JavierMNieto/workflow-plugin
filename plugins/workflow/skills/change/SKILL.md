---
name: change
description: Change the workflow itself, the agents, the queue, the hooks or the plugin, from any project. The change is planned and built in the plugin's own repository, by its own queue. Use when the person wants the assistant, the planner, the executor or the plan queue to work differently.
---

# Changing the workflow

A change to the workflow is planned and built where the workflow lives, in
the plugin's own repository, by that repository's own queue; never in the
project this chat is in.

1. **The checkout** is `<parent of the project directory>/workflow-plugin`
   when that parent is writable (`/workspaces/workflow-plugin` in a
   devcontainer whose project is under `/workspaces/`), else
   `~/workflow-plugin`. When absent, `gh repo clone
   JavierMNieto/workflow-plugin <path>`, which uses the signed-in login.
   When present, clean and detached, `git fetch origin && git checkout
   --detach origin/test`; when it is on a branch or has changes, leave it
   and say so (an executor is in it).

   **Then its trust.** The queue's sessions start with `claude --bg`, which
   exits with `Workspace not trusted` in a folder nobody has trusted, since
   no dialog can appear there. Read `~/.claude.json`; when
   `projects["<checkout path>"].hasTrustDialogAccepted` is not `true`, ask
   the owner with the question tool, one question: `Trust the plugin's
   checkout at <path> for the queue?`, options `Yes, trust it
   (Recommended)` and `No`. On yes, set that flag to `true` in
   `~/.claude.json` with every other key kept (read the whole file, change
   the one key, write it back), then read it back to check it took: this
   is the manual route in Claude Code's permissions docs, keyed by the
   repository root. On no, write the brief at step 3 but do not run `plans
   start` at step 4, and say in the final message that the queue's
   sessions cannot start there until the folder is trusted in the Claude
   app. The flag is written only on a yes: trust is the owner's.
2. **Ground the change in the plugin's files there**: the agent files, the
   scripts, `plugins/workflow/docs/workflow.md`, its `plans/`; not in the
   project the chat is in. What the project showed is the example in "What
   was asked".
3. **Write the brief or the short plan** in that checkout's `plans/`, by
   the assistant's own rules for exits 3 and 4. Under the header
   paragraph, `From: <name>, <path>.`: the project's name as its project
   file's `name` reads (the directory's name without one) and the project
   directory's absolute path, so a plan there can send work back ("A
   change the plugin leaves for the project it came from goes back as a
   brief").
4. **Hand it on from that directory**: `cd <checkout> && plans start
   --agent planner plans/<topic>.md` for a brief; `cd <checkout> && plans`
   then the message, or `plans start plans/<topic>.md`, for a short plan.
   The sessions it starts are `Workflow Planner n (<machine>)` and
   `Workflow Executor n (<machine>)` in Remote Control; they build, test,
   validate and push `test` there; CI moves `main`; the plugin updates
   after the next session starts. The change goes to the checkout beside
   this project, on this machine, whose queue builds it; another machine's
   checkout sees it in `test` after its next fetch, and in its plugin
   after its next session starts.
5. **Say in the final message** that the change is in the workflow's own
   queue, with the path, and whether the checkout was trusted at step 1,
   or left untrusted and the queue not started.
