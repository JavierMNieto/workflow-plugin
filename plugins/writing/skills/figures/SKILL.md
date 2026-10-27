---
name: figures
description: Creates and changes TikZ and pgfplots figures in the project's style and compiles them, and audits float layout in the compiled LaTeX PDF (float placement, subfigure alignment, caption position, distance from a figure to its \cref). Use to draw or change a figure, or to check how the floats sit.
paths:
  - "**/*.tex"
---

# Figures and layout

Drawing or changing a figure edits in place and compiles with latexmk,
up to three tries. The layout audit reports only.

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## A figure, in order

1. Read the header file (`header.tex` where the project has one), the
   figures that exist and their index (`all_figures.tex` where there is
   one).
2. Plan the figure; ask when the request is ambiguous.
3. A caption that stands on its own, a `\label{fig:...}`, and the
   figure registered in the index.
4. Compile and look. Never edit the header or the preamble, delete a
   figure file, invent a macro, or make up data.

## The layout audit, in order

1. A float alone on a page while under 60 percent of its height.
2. `[H]` or a bare `[h]` placement.
3. Subfigures aligned differently.
4. A `\cref` more than about a hundred lines from its float.
5. The caption after the content in a table, before it in a figure.
6. A float referenced nowhere.

## The report

The figure: "Figure work": created or changed, compiled ✓ or ✗, the
caption, the label, the index, notes on style. The audit: "Layout
audit": the PDF tools (available, or the source only), then Critical,
Major, Minor and Summary sections, each finding as
`[SEVERITY: <check>] <what>`.
