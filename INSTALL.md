# Installing the workflow: steps for Claude Code

This file is for Claude Code. A person pasted a line like "Install the
workflow plugin from https://github.com/JavierMNieto/workflow-plugin by
following its INSTALL.md" into Claude Code, in the folder of their
project. Follow the steps below in order, in that chat. The person may
not read guides: say what you are doing in a short sentence as you go,
ask only the questions below, and end with the message in step 6.

## 1. Check the tools

- Run `claude --version`. The workflow's docs
  (`plugins/workflow/docs/workflow.md`, "Installing") name no oldest
  version. If `claude` is not found (Claude Code inside an app may not
  put it on the path), step 3 asks the person to type its two commands
  instead.
- Run `node --version`. Every hook of the plugin and its status line
  run on Node.js; when it is missing, say so plainly, point to
  https://nodejs.org (its LTS version), and stop: the plugin would
  install but none of its checks would run.
- Run `gh auth status`. Signed in or not, go on: the install reads a
  public repository. When it is not signed in, or `gh` is missing, keep
  one line for the end: pushing from a chat needs GitHub access, and
  `gh auth login` gives it.

## 2. Ask the person's first name

Once, with the question tool: "What first name should the helpers call
you?" When `git config user.name` gives a name, offer its first word as
the first option; the person can always type another. The answer is
`<name>` below.

## 3. Install the plugin

```
claude plugin marketplace add JavierMNieto/workflow-plugin#main
claude plugin install workflow@workflow --config owner="<name>"
```

The name goes in quotes, as written. If the marketplace is already
added, the first command says so; go on. The second may say one option
is not set yet: that is `machine`, the name the helpers give this
computer, which is its hostname until set; go on. If the plugin is
installed already, the second says so and keeps the name it had: set it
with
`echo '{"owner":"<name>"}' | claude plugin configure workflow@workflow --values-stdin`.

When `claude` was not found in step 1, ask the person to type
`/plugin marketplace add JavierMNieto/workflow-plugin#main`, then
`/plugin install workflow@workflow` (it asks for their name), and go on
when they say it is done.

## 4. Add the user settings, with the person's yes

The plugin needs these keys in the person's Claude Code settings,
`~/.claude/settings.json`. They are copied from
`plugins/workflow/docs/workflow.md`, "Installing", which is the source:
a change there is made here too, and `test/plugin.test.ts` fails while
the two differ.

```json
{
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
}
```

Show the block to the person. Then ask with the question tool, putting
what the settings do in the question itself, since the person may read
only the question: "Add these to your Claude Code settings? They keep
the plugin updating itself from its tested version, turn it on in every
project, show your usage at the bottom of the screen, let background
chats work in your project's own folder, and stop a helper from starting
more than one level of helpers." When their settings already have a
`statusLine`, add "This replaces the status line you have now." The
options: "Yes, add them (recommended)": the plugin updates itself and
everything works; "No, leave my settings as they are": the plugin works
but does not update itself, with no status line.

On yes: read `~/.claude/settings.json` (create it as `{}` when there is
none), merge the block in key by key at every level, so every key
already there stays and the objects above (`extraKnownMarketplaces`,
`enabledPlugins`, `worktree`, `env`) keep their other entries; step 3
usually wrote a `workflow` marketplace there already, which gains
`autoUpdate`. Then write it. Read it back
and check that it parses as JSON and holds every key of the block. On
no: write nothing, and keep one line for the end: the plugin works, but
it will not update itself, and has no status line or background
settings, until these are added.

## 5. The project

- When the current folder has no `.claude/workflow.md` and is not the
  home folder: say that `/workflow:setup` sets this project up in a
  short interview (a git repository or not), and that it is there once
  Claude Code restarts. Ask whether they want that; on yes, the end
  message tells them to type `/workflow:setup` after the restart.
- When it has a `.claude/workflow.md`: say the project is set up
  already, by whoever shares it, and nothing more is needed here. Read
  its frontmatter: when it says `form: compact`, keep a line for the
  end: in this project the helper is the maker, one chat that decides
  and builds (`claude --agent workflow:maker`), not the assistant. When
  it names `mcp` or `inherits`, keep a line: `plans chat` in this folder
  prints the command that opens a chat with this project's settings.
- When it is the home folder: say nothing about a project.

## 6. Tell the person

End with this message, adding only the lines kept above (GitHub access,
settings declined, `/workflow:setup` after the restart, the maker, `plans
chat`):

"Done. You now have three helpers in Claude Code. Start a chat with the
assistant (`claude --agent workflow:assistant`, or pick it in the Claude
app) and just say what you want. It answers questions, and for a change
it writes a plan and hands it to a planner or a builder, which work in
the background and ask you only what they can't decide. Restart Claude
Code once so everything loads."
