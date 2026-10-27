---
name: edit
description: Edits existing research prose and LaTeX papers in place, carrying out phrasing changes, rewrites, term renames and writing rules, then a mechanical copyedit (grammar, punctuation, American spelling) and a LaTeX consistency pass (\cite or \citep, \eqref, labels, math mode, deprecated commands). Use on settled prose before compiling; it never touches math, equations, labels' meaning, citations or BibTeX.
paths:
  - "**/*.tex"
  - "**/*.md"
  - "**/*.bib"
---

# Editing prose and LaTeX

You edit in place and report what changed.

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## Before editing

Read the project's `.claude/rules/*.md` if any, the reference files
below, and the preamble's packages.

## The checks, in order

1. **The request**: the phrasing, the rewrite or the rule asked for.
2. **Priority fixes**: negation set against a contrast; wordiness and
   filler; stacked hedges; nominalizations; weak transitions; passive
   voice with no reason; vague quantifiers.
3. **Term renames**: find every occurrence and rewrite each in its
   sentence, never a blind replace; search again to confirm none is
   left.
4. **Mechanics** (`copyedit-and-grammar.md`): subject and verb agree;
   pronoun case; punctuation; American spelling; hyphenation;
   capitalization; whitespace and quotes.
5. **LaTeX** (`latex-style.md`), in this order: citation commands
   (by the package loaded: natbib's `\citep` and `\citet`; with biblatex,
   its own `\parencite` and `\textcite` unless it is loaded with
   `natbib=true`; the reference file's citation rule assumes natbib);
   reference commands; math mode (`\[ \]`, not `$$`; `align`, not
   `eqnarray`); deprecated commands; label prefixes; quotation marks;
   command spacing. A label renamed is renamed at every `\ref` in the
   same pass.

Leave alone: verbatim, `lstlisting` and `minted` blocks, `%`
comments, and `.bib` entries' meaning. Never insert a `%`.

**Skipped**: a fix that would change meaning, needs judgment, or needs
more than one mechanical edit is not made; it goes under "Skipped
(ambiguous, for a person): `<file:line>`: <what>". Changing notation
(`\alpha` to `\beta`) is a change of meaning. When unsure whether a
change alters meaning, do not make it.

## Notes in the paper

Notes use the two commands the project file names in its frontmatter:
`note:` (the command a note is written with) and `reply:` (the command
the author answers with), as in `note: \JaviAI` and `reply: \javi`.
With no `note` key, no notes are written into the paper (the skill's own
edits still are) and the notes go in the report; with no `reply` key, no
answers are looked for, and a command beneath an earlier note is still
left as it is. Below, `\<note>` and `\<reply>` stand for them.

**Notes go in only where they compile.** Before the first note, check
that the project defines the `note` command, and the `reply` command
when one is named (its preamble or a style file it loads); where it does
not, put no note in the file and list each one in the report instead,
with its file and line. In a `.md` file a
note is an HTML comment carrying the command's name without its
backslash, `<!-- <note>: ... -->`.

A small change goes in silently. A large one (a sentence of meaning or
more: it changes the claim, reorders sentences, merges or splits across
a clause, adds or removes evidence or a citation) is followed by
a note, `\<note>{<one short clause for why>}`, for example
`\<note>{passive voice hid the agent; made it active}`. The mechanical
passes (checks 4 and 5) never annotate. The author answers with
`\<reply>{...}` beneath; reply with a new note beneath that. Never edit
or delete a note or an answer.

## The report

The reference files read; each change as `<file>:<lines>: small,
large, rename or rule: <what>`; "Math and citations untouched: yes";
the count of notes; counts per category (grammar, punctuation,
spelling, whitespace and quotes; citation, reference, math mode,
deprecated, spacing, labels); the Skipped list. With nothing to fix:
`No mechanical issues found in <N> file(s).` or `No LaTeX style
issues found in <N> file(s).`

The reference files were written for the agents these skills replace:
read `narrative-flow-reviewer`, `writing-review-high` and
`academic-reviewer` as the `review` skill; `writing-clarity-auditor`,
`latex-compliance-checker` and `prose-editor` as `edit`; `prose-drafter`
as `draft`.

Reference files: [copyedit-and-grammar.md](copyedit-and-grammar.md),
[latex-style.md](latex-style.md).
