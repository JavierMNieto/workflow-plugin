# Prose Drafting Guide

This guide covers the standards and approach used by the `draft` skill when composing new long-form prose. The focus is on original composition — new sections, introductions, related work, blog posts, documentation — not revision of existing prose.

---

## When to draft vs. when to review

- **Draft** when the content is new: new section, new paper, new README, new introduction from scratch.
- **Review** (narrative-flow-reviewer) when the content exists and needs structural critique.
- **Copyedit** (writing-clarity-auditor) when the content is settled and needs mechanics fixed.

A valid drafting brief contains at minimum:
- **Target file** — absolute path; either a new file or an existing file with a clear insertion point.
- **What to draft** — section name, topic, length hint (word/paragraph count, or "one section").
- **Purpose** — what this prose is for (intro, related work, blog paragraph, README section, etc.).

If the brief is vague ("write the intro") without style guides or neighboring prose to constrain the voice, escalate rather than invent scope.

---

## Loading project conventions (mandatory first step)

Before drafting anything, load the project's style constraints:

1. Glob `.claude/rules/*.md` in the current working directory. Read all matches.
2. Look for style guides at project root: `writing-style.md`, `introduction-style.md`, `latex-style.md`, `CLAUDE.md`, `STYLE.md`, `CONTRIBUTING.md`. Read any that exist.
3. Read the target file (if it exists) and 1-2 sibling files in the same directory — these carry the voice to match.
4. If zero style guidance is discoverable, proceed using general academic/technical prose conventions and note this.

These constraints are hard: a draft that ignores the project's documented rules is a failed draft, regardless of prose quality.

---

## Voice-matching

Voice-matching happens before composition, not after. Open any neighboring prose files and read at least one full section before writing a word. The checklist:

1. **Sentence length and rhythm.** Does the author write short declarative sentences, or longer periodic ones with embedded clauses? Count roughly — short (≤15 words), medium (15–30), long (30+). Aim for the same distribution.
2. **Signposting phrases.** How does this author open and close sections? Do they use forward-references ("In the next section we show..."), backward-references ("Having established X, we now..."), or neither?
3. **Hedging patterns.** Is the author tentative ("may suggest", "appears to", "it is possible that") or confident ("we show", "the bound is tight", "the method fails when")? Match the confidence register, not a generic academic voice.
4. **Register.** Formal academic (passive voice, impersonal "one"), technical-but-accessible (active "we", explanatory asides), or conversational (direct address, contractions)? Do not drift register mid-draft.
5. **Vocabulary density.** Technical terms per sentence — dense (assumes expert reader) or sparse (explains as it goes)? Match the assumed knowledge level of the target audience.
6. **Distinctive quirks or signatures.** Unusual punctuation habits, preferred transition words, recurring sentence openers, preference for lists vs. prose. If the author always introduces a new concept with "Recall that...", use it. If they never use em dashes, don't start.

The draft must read as if the same author wrote it on the same day. Voice-matching is not cosmetic — a mismatched draft forces the author to rewrite everything.

---

## Wheeler's Rules — drafting application

These are structural rules, not stylistic preferences. Apply them in every draft.

**Motivate! Motivate! Motivate!** The reader must never wonder why they are reading this sentence. Open each section by making the reader want the result. Treat the argument like a detective story: the answer is withheld just long enough to make finding it satisfying.

**Simplify! Simplify! Simplify!** If a sentence is hard to write, the idea is not yet clear. Cut, recast, restart. Everything important is utterly simple.

**Singular, specific, committed.** Prefer "the method" over "a method"; "the reader" over "readers". Use "when" not "if" — commit to the scenario. Avoid hedging plurals.

**Power of the present tense.** "We show" not "we showed"; "the proof relies" not "the proof relied". Reserve past tense for genuinely historical events.

**Power of the active voice.** "We derive X" not "X is derived". Every passive clause is a drag on the reader.

**Suppress "to be".** "The function satisfies P" not "P is satisfied by the function". Find the real verb.

**Avoid the subjunctive.** Except when presenting a disagreement or counterexample, do not write "would", "might", "could" where a present or future tense is honest.

**Avoid "-ing" constructions.** "Before it escapes" not "before escaping". "To find the bound, apply Lemma 3" not "Applying Lemma 3 gives the bound."

**Key word placement.** Put the key word first, early, or last — never buried in the middle. The first and last positions carry weight; the middle is where attention dies.

**Rule of threes.** Three descriptions establish a pattern; two feel incomplete; four feel padded. When listing qualities, use exactly three.

**Use "we" to include the reader.** "We see that..." draws the reader in. "You should note..." lectures.

**Infinitive construction.** "To find X, apply Y" not "Let us find X." The infinitive creates forward momentum.

**Commands sparingly.** "Find the fixed point." "Observe that the bound is tight." Reserve imperatives for moments where you want the reader to act sharply. Overuse dulls them.

**Appeal to experiment or logic, not authority.** "The data show" or "the proof yields" — not "it is well known" or "experts agree." Ground every claim in what can be checked.

---

## One-pass composition

Draft in one coherent pass. Do not draft a paragraph, edit it, and rewrite it. The three-step process:

1. **Load conventions.** Before writing, load style constraints from the project's style guide or neighboring prior work (see "Loading project conventions" above). Also complete voice-matching (see above). These are prerequisites, not optional.
2. **Voice-match.** Confirm the checklist items above are internalized before the first sentence. The mental model of the target voice should be active during composition, not retrofitted afterward.
3. **Compose without iteration.** Plan the argument arc in full, then write. Do not stop to revise mid-draft. If a structural problem surfaces mid-composition — a gap in the argument, a section boundary that is in the wrong place — stop, re-plan, then restart from the problem point. Do not patch around it.

One-pass composition produces more coherent prose than iterative refinement because it forces a complete mental model before pen meets paper. Iterative refinement optimizes locally; one-pass composition optimizes globally.

---

## Format and container rules

- **New files**: use Write.
- **Insertions into existing files**: use Edit at the specified anchor (section heading, marker comment, or line number). If no anchor is given, place the draft and report the exact insertion point.
- **`.tex` files**: use the project's macros, citation commands, and label conventions as inferred from style guides and the preamble. Specifically:
  - Respect the project's citation command choice (`\cite` vs `\citep`/`\citet` — infer from preamble, do not mix).
  - Use the project's established label prefixes (`eq:`, `fig:`, `sec:`, `thm:`, etc.).
  - Match existing math environment choices (`align` vs `equation`, `$...$` vs `\(...\)`).
  - Use macros defined in the preamble rather than their expanded forms (if `\R` is defined for `\mathbb{R}`, use `\R`).
- **`.md` files**: match heading depth, list style, and code-fence style of siblings.

---

## The "no placeholders" rule

Never emit `[TODO]`, `[CITATION]`, `[EXPAND HERE]`, or `Lorem ipsum`. Every sentence in the output must be a sentence the user can ship. If a citation is needed but unavailable, omit the claim or phrase it without the citation; flag the gap in the report. If a figure is needed, describe it in words and flag it.

Never invent citations, page numbers, theorem numbers, equation references, dataset names, or URLs.

---

## What prose-drafter does NOT do

- Does not revise or rewrite prose the user already wrote — existing prose is context, not input to edit.
- Does not fix grammar or LaTeX style in neighboring files.
- Does not touch code, config, build files, `.bib` files, or non-prose formats.
- Does not compile LaTeX or run build tools.
- Does not produce partial drafts if a spec is vague — escalates instead.
- Maximum ~2000 words per dispatch; longer drafts split across dispatches with explicit continuation points.
