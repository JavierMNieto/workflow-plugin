# Copyedit and Grammar Guide

This guide covers the mechanical copyedit standard applied by the `edit` skill. These are in-scope, fixable violations — grammar, punctuation, spelling, and sentence mechanics. Everything here can be addressed without interpreting the author's meaning.

---

## What mechanical copyedit covers

### Core grammar and punctuation
- **Subject-verb agreement** — plural subjects take plural verbs; tense consistency within a passage.
- **Pronoun case** — "she and I" vs. "her and me", "who" vs. "whom".
- **Punctuation** — commas, semicolons, em dashes, quotation marks. Apply the Oxford comma when it disambiguates a list.
- **American English spelling** — color not colour, analyze not analyse, center not centre.
- **Hyphenation** — compound modifiers before a noun: "well-known result", "high-order term". No hyphen after adverbs ending in -ly.
- **Capitalization** — proper nouns; sentence case in headings if the project uses sentence case.
- **Whitespace mechanics** — double spaces, stray whitespace, wrong quote marks, misplaced apostrophes.

### Wheeler's Rules — mechanical targets

These rules produce fixable violations. They are not stylistic preferences — they are structural rules that make prose persuasive and readable. Apply them as additional checks alongside standard grammar and punctuation. Each fix must be safe and unambiguous; if a rewrite would change meaning or require a judgment call, put the sentence in the "Skipped" section.

**Rule 1 — Active voice over passive.**
Passive constructions where the agent is known can be mechanically fixed.
- Violation: "X is derived by", "the bound was established", "the result is shown in".
- Fix: "we derive X", "we established the bound", "we show the result in".
- Limit: If restoring the agent requires guessing who did what, skip it — do not invent a subject. "It was observed that..." with no known observer goes to Skipped.

**Rule 2 — Suppress "to be".**
Sentences that hinge on is/are/was/were often have a stronger active rewrite.
- Violation: "The result is a bound on...", "the proof is an application of..."
- Fix: "The result bounds...", "the proof applies..."
- Limit: Apply only when the rewrite is fully unambiguous. If the new verb changes scope or emphasis in any way, flag and skip.

**Rule 3 — Avoid "-ing" constructions.**
Gerund openings weaken the action verb and often produce dangling modifiers.
- Violation: "Before computing the integral...", "Applying Lemma 3 gives..."
- Fix: "Before we compute the integral...", "Lemma 3 gives..."
- Limit: Fix only where the finite-verb construction is a drop-in replacement. Do not restructure the sentence if the fix requires adding or removing a clause.

**Rule 4 — Avoid the subjunctive (except in counterexamples).**
Routine subjunctives in mathematical exposition are often misused hedges.
- Violation: "If we were to apply...", "this would give...", "this could be extended to..."
- Fix: "If we apply...", "this gives...", "this extends to..." (when the condition is actually in force)
- Limit: Leave subjunctives that frame a genuine contrary-to-fact scenario or explicit disagreement ("Were this false, then...").

**Rule 5 — "When" not "if/suppose" for committed scenarios.**
In a running argument, the condition is already established — "when" commits to the setting; "if" frames a fresh hypothesis.
- Violation: "Suppose f is continuous. Then..." (when f's continuity has already been asserted or assumed in the theorem statement)
- Fix: "When f is continuous, ..."
- Limit: Do not touch genuine conditional hypotheses — cases where the author is genuinely introducing an "if P then Q" argument structure. Only fix where the condition is already in force.

**Rule 6 — Prefer present tense.**
Mathematical exposition is timeless; past tense implies the work has ended or is historical.
- Violation: "We showed that...", "the theorem stated...", "the algorithm returned..."
- Fix: "We show that...", "the theorem states...", "the algorithm returns..."
- Limit: Do not fix past tense in genuinely historical passages ("In 1975, Knuth introduced...") or in sections that explicitly narrate prior work.

**Rule 7 — Singular, specific, committed.**
Hedging plurals and indefinite articles diffuse the argument.
- Violation: "We present a method for...", "algorithms of this type often..."
- Fix: "We present the method for...", "the algorithm..." (when the referent is specific and established)
- Limit: Apply only when the definite article or singular is clearly the right choice from context. If the author is genuinely discussing a class of things, leave the plural.

**Rule 8 — "We" to include the reader.**
Second-person constructions lecture; passive impersonal constructions distance.
- Violation: "You should note that...", "the reader will observe...", "it can be seen that..."
- Fix: "We note that...", "we observe...", "we see that..."
- Limit: Do not apply in tutorial or instructional contexts where the second person is deliberate and appropriate.

**Rule 9 — Infinitive construction for forward momentum.**
"Let us" and "we now" create false intimacy or slow the argument.
- Violation: "Let us find the fixed point.", "We now apply Lemma 3."
- Fix: "To find the fixed point, ...", "Applying Lemma 3, ..." (or restructure to make the infinitive the sentence opener)
- Limit: Do not touch constructions where "let us" introduces a shared assumption or counterfactual ("Let us assume, for contradiction, that...").

**Rule 10 — Key word first or last; never buried.**
The first and last positions of a sentence carry weight; the middle is where attention dies.
- Violation: "We have, by a standard compactness argument applied to the unit ball, that the sequence converges."
- Fix: "By a standard compactness argument on the unit ball, the sequence converges." (key result last)
- Limit: This is a structural rewrite; only apply where the fix is a mechanical reordering, not a reconstruction.

**Rule 11 — Appeal to experiment or logic, not authority.**
Claims grounded in "it is well known" or "experts agree" are unfalsifiable.
- Violation: "It is well known that...", "it is widely accepted that...", "experts agree that..."
- Fix: "The data show that...", "the proof yields...", "Theorem 3 implies..." — ground the claim in a checkable source
- Limit: Apply only when a concrete grounding exists in the document. Do not invent a citation or reference to replace the authority appeal; flag in Skipped if no grounding is available.

---

## What mechanical copyedit does NOT cover

- **Word choice** beyond obvious errors ("affect"/"effect").
- **Sentence restructuring**, paragraph reordering, or rewriting for flow — route to `narrative-flow-reviewer`.
- **Technical or notation choices** — route to `latex-compliance-checker`.
- **Narrative, pedagogy, argument structure** — route to `narrative-flow-reviewer`.
- **Anything requiring a judgment call about meaning** — flag it, skip it.

---

## Project-specific rules (CWD layering)

Before applying defaults, check for project-local style rules. This is the mandatory first step — global defaults are the fallback, not the starting point.

1. **Glob `.claude/rules/*.md`** in the current working directory. If files are found, read them all before touching any prose.
2. **Treat project rules as authoritative overrides.** If a project rule conflicts with a global default (e.g., the project uses British English, or the project explicitly forbids the Oxford comma), the project rule wins. Do not apply the global default.
3. **Typical conventions to look for:**
   - **American vs. British English** — color/colour, analyze/analyse, center/centre, -ize vs. -ise suffixes. A project working in British English is not a violation; it is a choice. Do not "fix" it.
   - **Serial comma policy** — the Oxford comma is applied by default only when it disambiguates. A project rule may require it always or prohibit it; follow the rule.
   - **Dash style** — em dash (—) vs. en dash (–) for parenthetical asides; some projects use spaced en dashes. Match what the project specifies or what is already consistent in the document.
   - **Smart-quote usage** — some projects (especially those generating plain text or web output) prefer straight quotes `"..."`. In LaTeX projects, LaTeX-style ` ``...'' ` is the default, but a plain-text output project may not want ligature sequences.
4. **If no `.claude/rules/` directory exists**, proceed with the global defaults above and note this at the top of the report.

---

## The "skip it" rule

If a fix would alter meaning, skip it. If a sentence has a structural problem that cannot be fixed by a single mechanical edit, flag it in the "Skipped" section and move on. The standard is: every change is safe, mechanical, and reversible.

Never touch:
- `.bib` files
- Code inside `\begin{lstlisting}`, `\begin{verbatim}`, or fenced code blocks
- LaTeX notation (`\alpha`, `\beta`) — notation changes are meaning changes
- **LaTeX `%` comments** — any text from an unescaped `%` to end of line is a LaTeX comment. Treat the `%` character and everything after it on that line as opaque. Never delete a `%`-prefixed line, never strip a trailing `% comment` from a code line, and never alter the text inside a comment.
- **New `%` insertions** — never insert a `%` character anywhere in a `.tex` file. A trailing `%` suppresses the following newline's whitespace and is a meaningful typesetting change, not a copyedit. If two wrapped prose lines appear to have an unwanted inter-line space, leave them as-is.
- **Escaped percent (`\%`)** — `\%` is a literal percent sign in LaTeX prose and is fine to leave. Only the unescaped `%` is the comment/suppression trigger covered by the two rules above.
