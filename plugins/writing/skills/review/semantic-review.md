# Semantic Review Guide

This guide covers the semantic review standard applied by the `review` skill. Semantic review asks whether the prose *means* what it says — not whether it reads well, flows well, or is grammatically correct. This is a multi-pass analytical review, not a copyedit.

---

## What semantic review covers

Semantic problems are errors of meaning: a claim that is imprecise, a symbol that is overloaded, a conclusion that outruns its evidence. Semantic review works at the level of logic and commitment, not at the level of style or structure.

### The four check categories (in order)

**1. Notation consistency**

Every symbol means the same thing throughout the document. Checks:
- Same symbol always means the same thing (no silent overloading of indices, operators, or function names).
- Every symbol is introduced before its first use.
- Notation matches field conventions — a reader from the field should recognize it.
- No silent overloading of notation that was already defined.

**2. Conceptual consistency**

The claims in the introduction match what is actually shown in the body. Checks:
- Abstract, body, and conclusion agree on scope and strength of claims.
- No drift between what the introduction promises and what Section 4 delivers.
- Definitions are used consistently with how they were introduced — no silent broadening or narrowing.

**3. Precision of claims**

Hedges are used honestly; quantitative claims are grounded. Checks:
- "Might", "could", "suggests" are used where they reflect genuine uncertainty, not as evasions for overreaching claims.
- Quantitative claims have sources, derivations, or citations.
- No sleight of hand between "we proved", "we observed", and "it is known that" — these have different epistemic weights.
- Approximations are flagged as approximations, not presented as equalities.

**4. Claim-evidence alignment**

Every load-bearing claim is supported. Checks:
- Each major claim is backed by a cited result, a derivation in the paper, or an experiment actually reported in this paper.
- No claim outruns its evidence — the conclusion does not extend beyond what the proof shows.
- No evidence is described more strongly than what it actually demonstrates.

---

## Wheeler's Rules — semantic dimension

These rules surface semantic problems that look like style issues but are actually precision failures.

**Simplify! Simplify! Simplify!** Complexity in a claim often signals imprecision rather than depth. When a claim is hard to paraphrase, check whether it is genuinely precise or merely vague in an elaborate way.

**Avoid the subjunctive.** "Would suggest", "might imply", "could indicate" — are these honest hedges reflecting genuine uncertainty, or evasions protecting an overreaching claim? Flag subjunctives that misrepresent confidence.

**Present tense for live results.** "We showed X" implies the showing happened once, in the past, rather than that X holds now. "We show X" commits the paper to the claim. Flag past tense in result statements where present tense is the semantically accurate choice.

**Power of the active voice.** Passive constructions around load-bearing claims can obscure who proved what, making claim-evidence alignment harder to verify. "X is proved by" is harder to trace to evidence than "we prove X".

**Key word placement.** If the key claim is buried mid-sentence, a careful reader can miss or misread it. The main claim should be in a position of emphasis: first, early, or final position.

**Singular, specific, committed.** "A bound", "some constants", "certain conditions" are semantic problems, not style problems. Every load-bearing claim must be specific enough to falsify. Vague quantifiers make truth-value indeterminate.

**Appeal to experiment or logic, not authority.** "It is well known that", "experts agree", "clearly" are substitutes for evidence. Every such phrase should be replaced by a citation, a derivation, or an experimental result.

---

## Severity levels

**Blocking** — must fix before the paper is correct:
- Factual error, conceptual inconsistency, unsupported claim.
- Notation collision (same symbol, two meanings).
- Claim-evidence mismatch (conclusion exceeds what the proof shows).

**Major** — should fix; a careful reader could be misled:
- Semantic ambiguity resolvable two ways.
- Missing definition for a load-bearing symbol.
- Hedge that misrepresents the evidence (false modesty or false confidence).

**Minor** — optional but worth considering:
- Borderline precision issues.
- Optional tightening of a claim.
- Notation that is technically fine but locally confusing.

---

## What semantic review does NOT cover

This is the scope boundary. Do not drift into these areas:

- **Narrative flow, signposting, paragraph transitions, topic sentences, pedagogy** — route to `narrative-flow-reviewer`.
- **Grammar, spelling, punctuation, sentence-level style** — route to `writing-clarity-auditor`.
- **LaTeX syntax or formatting** unless it directly affects meaning — route to `latex-compliance-checker`.
- **Silently "fixing" notation** — flag it; let the author decide.
- **Rewriting whole sections** — propose at the sentence or short-paragraph level.
- **`.bib` file entries**.
- **Compiling LaTeX** or running build tools.

---

## When the document is clean

List all four semantic check categories, confirm no blocking or major issues in any, and stop. Do not manufacture concerns. Do not drift into narrative or copyedit territory just to justify the review. A clean document is a clean document.
