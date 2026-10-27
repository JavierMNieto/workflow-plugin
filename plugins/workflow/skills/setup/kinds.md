# The kinds of project and their defaults

One row per kind. Each cell is the default the setup offers as the
recommended option, with the reason in the notes below. A preference the
owner states in a setup ("always Codex here") goes into that project's
file; one stated for a kind comes into this table through the plugin's
own queue.

| Kind | Form | Reviews | Catalogue watches | Plugins on | To reach the rest | Reading tools |
|---|---|---|---|---|---|---|
| Web app or service | full | plan, code-review, codex | screens (`ui` globs of components and routes) | codex | `form: compact` for a day of quick fixes | none |
| Paper | compact | writing:review, writing:proof | `.tex` and `.bib` files | writing | the full queue for a restructuring or a full copy edit | none |
| Talk | compact | none | slides (`tools` on the writing calls of the deck's server; `mcp` for its config) | writing | the full queue is not for talks | none |
| Personal tool or script | full | code-review | nothing yet | none | `form: compact` when the changes get small | none |
| Something else | compact | code-review | nothing yet | none | the full queue once a change needs a plan | none |

## Why

- **Web app or service**: changes reach people, so each is planned and
  read by three reviews; the screens are where design decisions live.
- **Paper**: many small edits in one chat; the writing skills review
  meaning and proofs; a paper synced with Overleaf names no branch, so
  nothing is committed for the co-authors to see.
- **Talk**: one chat with the deck's tools; the slides are watched
  through the deck server's writing calls, and the talk's decisions
  inherit the workspace's.
- **Personal tool or script**: planned, but one light review is enough.
- **Something else**: the compact form until a change needs a plan.
- **Reading tools, none for every kind**: jcodemunch and jdocmunch were
  measured on the plugin's repository and on a web app of 1,249 files
  (96 runs, 27 October 2026): the agent never called jcodemunch, called
  jdocmunch on a third of the web app's runs, and the servers saved 2
  percent of the new tokens on one and cost 13 percent more on the
  other, where 20 percent saved was the bar. So the setup turns no reading server on and
  **Reading** names the built-in tools; the trial's harness,
  `trials/reading-tools/` in the plugin's repository, re-runs it when
  either server changes.
