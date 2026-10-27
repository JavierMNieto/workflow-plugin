---
name: proof
description: Checks the logic of mathematical proofs in a LaTeX paper (valid steps, unstated assumptions, the technique, gaps, edge cases, cited results' hypotheses, completeness), for one proof, a set of lemmas or the whole paper before submission. Use for proofs, theorems and lemmas; not for grammar, flow, empirical claims or LaTeX style.
context: fork
effort: high
paths:
  - "**/*.tex"
---

# Checking proofs

You report; you do not change the proofs. The full pass adds
`\JaviAI` notes.

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## The axes

1. Logical validity of each step.
2. Assumptions and hypotheses, stated and used.
3. The technique: induction, contradiction, construction, case
   analysis, the order of quantifiers.
4. Gaps ("clearly", "obviously").
5. Notation and scope.
6. Edge cases: the empty set, n equal to 0 or 1, limits, degenerate
   positions.
7. Cited results: their hypotheses are met here.
8. Completeness: it proves exactly what is claimed.

A quick pass by default: axes 1 to 4. The full pass, when asked for a
deep or exhaustive check: all eight over the whole document, the
dependency graph of the lemmas traced (does Lemma 2 support Theorem 5;
is a lemma used nowhere), an audit of the notation, Minor findings, and
a challenge to the choice of technique and to whether each result is
stated at its full generality.

With no note on context: classical logic, ZFC, an expert reader; a note
can set the notation, the logic or the reader. A gap the author has
acknowledged is not flagged.

## The report

One block per proof: `PROOF-CHECK: <id>`, `Axes checked:`, then
`BLOCKING`, `MAJOR` and `MINOR` sections (an empty one left out,
Minor in the full pass only), each finding as
`- [Axis N] <what> | <where>`, `Reason:` and, when it is mechanical,
`Fix hint:`. Then `CLEAN AXES:`. A clean proof: "All axes clean. No
blocking, major, or minor issues found."

## `\JaviAI` notes (the full pass)

**Notes go in only where they compile.** Before the first
`\JaviAI` note, check that the project defines `\JaviAI` and `\javi`
(its preamble or a style file it loads); where it does not, put no note in
the file and list each one in the report instead, with its file and line.
In a `.md` file a note is an HTML comment, `<!-- JaviAI: ... -->`.

`\JaviAI{<type>: <diagnosis>. <action>.}` right after the step, the
type one of gap, error, assumption, simplification, notation,
edge-case; in a `.md` file `<!-- JaviAI [type]: diagnosis. action. -->`.
About fifteen per file at most. The owner answers with `\javi{...}`
beneath, and the thread goes on downward; never edit or delete a note.
