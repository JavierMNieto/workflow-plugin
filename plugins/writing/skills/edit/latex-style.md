# LaTeX Style Guide

This guide covers the LaTeX command consistency standards applied by the `edit` skill. These are in-scope, mechanical fixes — command uniformity, deprecated syntax, label conventions, and environment choices. The skill makes silent in-place fixes and reports what changed.

---

## What LaTeX style checking covers

### Citation commands

**Rule:** Pick one citation command style for the project and enforce it uniformly. Never mix styles within a document.

- **natbib/biblatex projects**: use `\citep{...}` for parenthetical citations, `\citet{...}` for textual citations ("Smith et al. showed...").
- **vanilla `\cite` projects**: use `\cite{...}` everywhere.

**Common violation:** A natbib project where some authors used `\cite` and others used `\citep`, or where the preamble loads `natbib` but the body uses `\cite` throughout.

**Mechanical fix:**
```bash
# Find all \cite{ that are not \citep or \citet
rg '\\cite\{' --glob '*.tex'
# Replace \cite{ with \citep{ (parenthetical) or \citet{ (textual) per context
sed -i 's/\\cite{/\\citep{/g' main.tex   # adjust command and file as needed
```

**Before/after example:**
```latex
% Before (mixed styles in natbib project)
As shown in \cite{smith2020}, the bound is tight. See also \citep{jones2021}.

% After (uniform \citet for textual, \citep for parenthetical)
As shown in \citet{smith2020}, the bound is tight. See also \citep{jones2021}.
```

---

### Reference commands

**Rule:** Use the right reference command for each type of cross-reference, and always use a non-breaking space before the reference.

- Equations: `\eqref{...}`, not `(\ref{...})`.
- All other cross-references: `\Cref{...}` (sentence-initial) or `\cref{...}` (mid-sentence) if `cleveref` is loaded; otherwise `\ref{...}`.
- Non-breaking space before every reference: `Fig.~\ref{...}`, `Eq.~\eqref{...}`, `Section~\ref{...}`.

**Common violations:**
- `(\ref{eq:bound})` instead of `\eqref{eq:bound}`.
- `Fig. \ref{fig:result}` with a plain space instead of `~`.

**Mechanical fix:**
```bash
# Find equation refs not using \eqref
rg '\(\\ref\{eq:' --glob '*.tex'
# Find refs without non-breaking space
rg 'Fig\. \\ref|Eq\. \\ref|Section \\ref' --glob '*.tex'
```

**Before/after example:**
```latex
% Before
As shown in (\ref{eq:main}), the result holds. See Fig. \ref{fig:overview}.

% After
As shown in \eqref{eq:main}, the result holds. See Fig.~\ref{fig:overview}.
```

---

### Math mode

**Rule:** Pick one inline math delimiter and one display math delimiter; enforce them uniformly. Never use `$$...$$`.

- **Inline math**: use `$...$` or `\(...\)` — pick one project-wide.
- **Display math**: use `\[...\]` — never `$$...$$`. Double-dollar display math is deprecated and produces incorrect vertical spacing in many document classes.
- **Multi-line environments**: prefer `align` (from `amsmath`) over `eqnarray`. The `eqnarray` environment has known spacing bugs and is unsupported.

**Common violations:**
- Mixed `$...$` and `\(...\)` for inline math.
- `$$...$$ ` for display math.
- `\begin{eqnarray}` anywhere in modern documents.

**Mechanical fix:**
```bash
# Find deprecated double-dollar display math
rg '\$\$' --glob '*.tex'
# Find eqnarray
rg 'begin\{eqnarray\}' --glob '*.tex'
```

**Before/after example:**
```latex
% Before
$$f(x) = \int_0^1 g(x)\,dx$$
\begin{eqnarray}
  a &=& b + c \\
  d &=& e
\end{eqnarray}

% After
\[f(x) = \int_0^1 g(x)\,dx\]
\begin{align}
  a &= b + c \\
  d &= e
\end{align}
```

---

### Deprecated commands

**Rule:** Replace all legacy font and fraction commands with their modern equivalents.

| Old command | Modern replacement | Notes |
|---|---|---|
| `\bf` | `\textbf{...}` | Old-style font switch; changes state instead of scoping |
| `\it` | `\textit{...}` | Same issue — switches mode, doesn't scope |
| `\rm` | `\textrm{...}` | Ditto |
| `\over` | `\frac{...}{...}` | TeX primitive; ambiguous grouping in complex expressions |
| `\eqnarray` | `align` (from `amsmath`) | Spacing bugs; superseded by `amsmath` |

**Common violation:** Legacy documents (pre-2000 style) often use `{\bf important}` and `{\it italics}` throughout.

**Mechanical fix:**
```bash
# Find old font commands
rg '\\bf\b|\\it\b|\\rm\b|\\over\b' --glob '*.tex'
# Example sed replacement (adjust per document)
sed -i 's/{\\bf \([^}]*\)}/\\textbf{\1}/g' main.tex
```

**Before/after example:**
```latex
% Before
The {\bf key result} is that {\it f} satisfies $a \over b$.

% After
The \textbf{key result} is that \textit{f} satisfies $\frac{a}{b}$.
```

---

### Label naming conventions

**Rule:** Use standard prefixes for all labels. Choose one case convention (lowercase-with-hyphen or CamelCase) and apply it uniformly. Never mix.

| Type | Prefix | Example |
|---|---|---|
| Equation | `eq:` | `\label{eq:main-bound}` |
| Figure | `fig:` | `\label{fig:overview}` |
| Section | `sec:` | `\label{sec:related-work}` |
| Table | `tab:` | `\label{tab:results}` |
| Theorem/Lemma/Prop | `thm:`, `lem:`, `prop:` | `\label{thm:convergence}` |
| Algorithm | `alg:` | `\label{alg:gradient-descent}` |

**Common violation:** Labels like `\label{result1}`, `\label{Fig_2}`, `\label{mainThm}` — no prefix, inconsistent separators, mixed case.

**Mechanical fix:**
```bash
# Audit all labels to identify prefix violations
rg '\\label\{' --glob '*.tex'
# Audit all \ref to find unlabeled or mis-prefixed refs
rg '\\ref\{' --glob '*.tex'
```

---

### Quotation marks

**Rule:** LaTeX straight-quote characters `"..."` print as straight quotes. Use LaTeX-style ligatures instead.

- Opening double quote: ` `` ` (two backticks)
- Closing double quote: `''` (two apostrophes)
- Single quotes: `` ` `` and `'`

**Common violation:** Copy-pasted text from word processors introduces straight `"..."` or typographic `"..."` Unicode quotes.

**Mechanical fix:**
```bash
# Find straight double quotes in text (not in preamble/comments)
rg '"' --glob '*.tex'
# Fix with sed (simple cases only; verify each in context)
sed -i 's/"\([^"]*\)"/``\1'\'\''/g' main.tex
```

**Before/after example:**
```latex
% Before
He called it a "remarkable result".

% After
He called it a ``remarkable result''.
```

---

### Command spacing

**Rule:** When a macro is followed immediately by a letter or numeral, LaTeX may collapse the space. Add `{}` or `\,` as needed per project convention.

- `\alpha x` — fine in most contexts
- `\alpha{}x` — forces no space (useful when space is wrong)
- `\alpha\,x` — thin space (use when project convention requires separation)

**Common violation:** `$\operatorname{ker}A$` when `$\operatorname{ker} A$` or `$\ker A$` is intended; inconsistent thin-space use in products.

Check `.claude/rules/*.md` to determine whether the project has a documented convention before making changes here.

---

## How to operate

The agent works one violation category at a time, not by bulk-rewriting files. The procedural steps:

1. **Load project rules.** Glob `.claude/rules/*.md`. Read the preamble of the main `.tex` file (first ~100 lines) to determine which packages are loaded — this resolves the `\cite` vs `\citep`/`\citet` question and confirms whether `cleveref` is available.
2. **Identify violations.** For each rule category, use Grep to find candidate violations before touching any file. Audit scope before fixing.
3. **Grep for the specific pattern.** One pattern at a time. Example: `rg '\\citep\{' --glob '*.tex'` to confirm citation style before deciding what to fix.
4. **Fix in place with Edit.** Use Edit per file, not bulk rewrite. Make semantically distinct fixes as separate edits when they touch different regions of the file.
5. **Re-check after fixing.** Run the same grep again to confirm the pattern no longer appears. For cascading changes (label renames), grep all dependent `\ref` and `\eqref` calls.

**Key constraint:** Never touch content inside `\begin{verbatim}`, `\begin{lstlisting}`, `\begin{minted}`, or inline `\verb|...|`. These environments contain literal source code or command output; modifying them would silently corrupt the document.

---

## What LaTeX style checking does NOT cover

- **`.bib` files** — never touch bibliography entries.
- **Prose content, word choice, grammar** — route to `writing-clarity-auditor`.
- **Notation semantics** (`\alpha` vs. `\beta` for the same concept) — a notation change is a meaning change; route to `narrative-flow-reviewer` to flag it.
- **Package choice decisions** (whether to switch from `natbib` to `biblatex`) — flag and skip.
- **Document structure or section order** — out of scope.
- **Compiling LaTeX** or running `latexmk`/`pdflatex`.

---

## Project-specific rules (CWD layering, mandatory first step)

Before applying defaults:

1. Glob `.claude/rules/*.md` in the current working directory. Read any files found.
2. Check for `.latexmkrc`, `.latexindent.yaml`, and the main `.tex` file's preamble (first ~100 lines) to infer which packages are loaded. The preamble tells you whether `\citep` (natbib/biblatex) or `\cite` (vanilla) is correct.
3. If no rules and no inferable convention: apply the most common defaults — natbib-style `\citep`/`\citet`, `\eqref` for equations, `\Cref` for everything else, `align` over `eqnarray`.

Project rules override global defaults. Always infer from the preamble before assuming.

---

## Cascade rule

If a fix cascades (e.g., renaming a label updates every `\ref` to it), do the entire cascade in the same dispatch and report every file touched. Never leave dangling references.

---

## Zones to skip

Never modify anything inside:
- `\begin{verbatim}...\end{verbatim}`
- `\begin{lstlisting}...\end{lstlisting}`
- `\begin{minted}...\end{minted}`
- Inline `\verb|...|`

These environments contain literal source code or command-line output; modifying them would break the document's meaning.
