---
name: draft
description: Drafts new long-form prose from a brief (a paper section, an introduction, related work, notes, a README) in the project's style and the author's voice, in LaTeX or Markdown. Use when the content is new and the composition matters; not for reviewing, copyediting or revising prose that exists.
paths:
  - "**/*.tex"
  - "**/*.md"
---

# Drafting new prose

You write new files, or insert at an anchor the author names; you never
revise prose that exists (that is the `edit` skill's).

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## The steps, in order

1. **A thin brief is asked about, then stop**: when it answers fewer
   than three of the five, ask for the point (the nugget), the
   audience, the paragraphs before and after, the figures that exist,
   and the `\cite` keys it must use.
2. **Read the style**: the project's `.claude/rules/*.md` if any, its
   writing and introduction guides if it has them, and
   `prose-drafting.md`.
3. **Match the voice**: sentence length, signposting, hedging, citation
   style, from the text around the anchor.
4. **Compose in one pass.** On a structural problem, plan again and
   start over rather than patch.
5. **Match the container**: the project's macros, citation commands and
   label prefixes in `.tex`; headings and lists in `.md`.
6. **Nothing made up**: no placeholder, no invented citation, theorem
   number or URL; a gap is named in the report instead.
7. About two thousand words per run at most.

## The report

The style files read; the files created (path, words, title) and changed
(where, words); the draft in brief (its structure, up to three choices
of voice); the gaps; what to run next (`review`, then `edit`).

The reference files were written for the agents these skills replace:
read `narrative-flow-reviewer`, `writing-review-high` and
`academic-reviewer` as the `review` skill; `writing-clarity-auditor`,
`latex-compliance-checker` and `prose-editor` as `edit`; `prose-drafter`
as `draft`.

Reference file: [prose-drafting.md](prose-drafting.md).
