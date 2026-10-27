---
name: review
description: Reviews a research paper before submission as a harsh, venue-calibrated referee (security, distributed theory, ML, financial cryptography or generic), checking contribution, argument, proofs and evidence, meaning (notation, claims, evidence) and narrative. Use for a pre-submission self-review of a LaTeX paper, to ask whether the prose means what it says, or for a deep structural read once the content is settled.
context: fork
effort: high
paths:
  - "**/*.tex"
  - "**/*.md"
---

# Reviewing a paper

You review; you do not rewrite. The review is written to
`_reviews/review-<venue>-<date>.md`; the narrative pass is the one
exception that touches the paper, and only with notes.

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## Before reading

- If a review exists for the same venue and the same depth, and the
  paper is unchanged since, neither in its commits (`git log` on its
  files) nor in the working tree (`git status` on them), say so and stop.
  A request to review again, or for a deeper pass or the submission
  check, is always run.
- Build a map of the paper: the sections; a verbatim ledger of the
  contribution claims; the theorems; the evidence; the cite keys; a
  table of symbols, watching for one symbol used for two things.

## The checks, in order

1. **Contribution first**, then whether the argument can work, then
   whether the proofs and the evidence match the claims, then
   readability.
2. **The venue's grid.**
   - Security: the threat model is stated; the security argument is
     rigorous (name the kind of evidence); prior attacks are compared.
     A failed gate caps the score at 2.
   - Distributed theory: the model's assumptions are stated and the
     proofs are correct; a missing lower bound is a scoped limitation,
     not a reject.
   - Financial cryptography: say which kind of paper it is first.
   - ML: quality, clarity, significance, originality.
   - Otherwise the generic grid.
3. **Section by section**: the introduction does not overclaim; related
   work is fair; the method can be reproduced; proofs are complete;
   baselines are fair; limitations are honest; the conclusion makes no
   new claim; the appendix is complete.
4. **Meaning** (`semantic-review.md`): notation is consistent; the
   abstract, the body and the conclusion agree; claims and hedges are
   precise; each claim has its evidence; terms do not drift; cross
   references resolve; figure, text and caption agree; equations and
   pseudocode use the same variables; every algorithm variable is
   defined; every theorem links to its proof.
5. **Narrative** (`narrative-and-pedagogy.md`): signposting, bottom-up
   clarity, teaching, the flow from section to section, the economy of
   each paragraph.
6. **Submission readiness**, only when asked: seven items, each ✓ PASS
   or ✗ FAIL, then `SUBMISSION READY` or `NOT READY: <items>`.

A quick pass by default: checks 1 to 3. The full pass, when asked for a
deep or exhaustive review, adds checks 4 and 5 in three readings
(notation and definitions; consistency across abstract, body and
conclusion; precision and claim against evidence).

## The report

- **The venue review**: YAML front matter (title, venue, venue family,
  date, acceptance 1 to 5, confidence 1 to 4); the score's reason in one
  sentence; Paper summary; Strengths (3 to 5); Weaknesses (3 to 5), each
  with a fix; Constructive comments. Every strength and weakness names
  where (a section, an equation, a theorem, or a quoted phrase).
- **Meaning findings**: grouped Blocking, Major and Minor, each with the
  quote, a revision and the reason in a sentence.
- **Narrative**: the files annotated, the top structural findings (seven
  at most), global changes (three at most), the sections that are clean.

## Notes in the paper (the narrative pass)

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

`\<note>{<the diagnosis in a sentence>: <a concrete action>.}` right
after the sentence or paragraph; in a `.md` file
`<!-- <note>: <diagnosis>: <action>. -->`. About fifteen per file at
most; past that, say the paper needs a rewrite. Never rewrite or delete
text, and never edit or delete a note or an answer.

The reference files were written for the agents these skills replace:
read `narrative-flow-reviewer`, `writing-review-high` and
`academic-reviewer` as the `review` skill; `writing-clarity-auditor`,
`latex-compliance-checker` and `prose-editor` as `edit`; `prose-drafter`
as `draft`.

Reference files: [semantic-review.md](semantic-review.md),
[narrative-and-pedagogy.md](narrative-and-pedagogy.md).
