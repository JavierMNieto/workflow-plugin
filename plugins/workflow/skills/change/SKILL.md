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
2. **Ground the change in the plugin's files there**: the agent files, the
   scripts, `plugins/workflow/docs/workflow.md`, its `plans/`; not in the
   project the chat is in. What the project showed is the example in "What
   was asked".
3. **Write the brief or the short plan** in that checkout's `plans/`, by
   the assistant's own rules for exits 3 and 4.
4. **Hand it on from that directory**: `cd <checkout> && plans start
   --agent planner plans/<topic>.md` for a brief; `cd <checkout> && plans`
   then the message, or `plans start plans/<topic>.md`, for a short plan.
   The sessions it starts are `Workflow Planner n` and `Workflow Executor
   n` in Remote Control; they build, test, validate and push `test` there;
   CI moves `main`; the plugin updates after the next session starts.
5. **Say in the final message** that the change is in the workflow's own
   queue, with the path.
