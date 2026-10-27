# Narrative and Pedagogy Guide

This guide covers the structural and pedagogical standards applied by the `review` skill. The focus is on whether prose teaches, guides, and earns the reader's attention — not on grammar or semantics. This is an opinionated, expensive pass; invoke it when the content is conceptually settled and you want a deep structural read.

---

## The five review axes (in priority order)

### 1. Signposting

Does the reader always know where they are in the argument?

- Each section should open by stating what it will do and close by stating what it established.
- Transitions must be load-bearing, not decorative. "We now turn to..." is decorative. "The bound from Section 3 lets us now show..." is load-bearing.
- A well-signposted document reads like a map: the reader knows their location at every step.

### 2. Bottom-up clarity

Can a competent reader who does not already know the result follow the argument linearly?

- Concepts must be introduced before they are used.
- Forward references that require the reader to "trust and catch up" are failures of bottom-up clarity.
- The argument should be followable in a single linear pass.

### 3. Pedagogy

Does the text teach, or does it merely assert?

- Examples belong where they do the most work, not appended as afterthoughts.
- Intuition comes before formalism, not after. A reader who encounters a definition before any motivation is being asked to memorize, not understand.
- Cognitive load management: introduce one new idea at a time. Paragraphs that smuggle in two ideas violate this.

### 4. Section-to-section flow

Does section N+1 begin by picking up where section N ended?

- Each section should acknowledge what was established and state what comes next.
- Sections that restart from scratch feel like separate papers. Sections that open with a backward link feel like one paper.

### 5. Paragraph economy

Does each paragraph do exactly one job?

- Orphan paragraphs that could be cut without loss should be flagged.
- Paragraphs that smuggle in two unrelated points should be split.
- If cutting a paragraph does not change the reader's understanding, the paragraph is filler.

---

## Wheeler's Rules — structural application

These rules are diagnostic lenses for narrative review. A document that violates them consistently will feel dull or inaccessible regardless of how correct its content is.

**Motivate! Motivate! Motivate!** Every section should open by making the reader want the result. Structure the argument like a detective story: tension before resolution. Flag any section that answers a question the reader was not yet asking.

**Simplify! Simplify! Simplify!** Complexity in prose signals an unresolved idea, not a sophisticated one. When a passage is hard to follow, ask whether the underlying concept has been fully digested by the author. Complexity is a symptom, not a feature.

**Power of the active voice.** Passive constructions slow the narrative and obscure agency. Sustained passive voice, especially in method descriptions and proof steps, is a pedagogy failure — the reader cannot tell who is doing what.

**Suppress "to be".** Prose built on is/are/was/were describes states rather than actions. State-description feels static; action-description creates forward momentum.

**Singular, specific, committed.** Vague quantifiers ("some methods", "various approaches") weaken signposting. Thesis statements, section openers, and conclusions must be specific. "We address three problems" is weaker than "We address the stability problem, the scalability problem, and the correctness problem."

**Present tense for live mathematics.** Past tense in a proof ("we obtained") implies the argument happened somewhere else, to someone else. Present tense ("we obtain") makes the reader a participant.

**Key word placement.** The key concept of a paragraph belongs in the first sentence, not surfaced in the third. Topic sentences that bury the point force the reader to re-read the paragraph to understand what it was about.

**Rule of threes.** Two properties feel incomplete; four feel padded. Lists of motivations, qualities, or applications should have exactly three entries.

**Use "we" to include the reader.** "We see", "we now ask", "we expect" is collaborative. "The reader will note" is condescending. "You might wonder" is patronizing. "We" draws the reader into the argument.

**Infinitive construction for forward momentum.** "To prove X, we need Y" creates forward pull. "In order to prove X, we will need Y" is leaden. Bloated constructions at section transitions kill momentum.

---

## The annotation system: `\JaviAI`

The `narrative-flow-reviewer` annotates findings inline rather than rewriting. Every finding gets a `\JaviAI{...}` annotation placed immediately after the sentence or paragraph it critiques.

**Format:**
```latex
\JaviAI{<one-sentence diagnosis>: <concrete suggested action>.}
```

For non-`.tex` files (e.g., `.md` notes):
```html
<!-- JaviAI: <one-sentence diagnosis>: <concrete suggested action>. -->
```

**What makes a good annotation:**
- One sentence of diagnosis — what is wrong and why.
- One concrete action — exactly what the author should do.
- No hedging: "You might consider perhaps" is failure. "Split this paragraph into two — one for the claim, one for the justification" is success.

**Cap:** Maximum ~15 annotations per file. If that cap would be exceeded, the document needs a rewrite, not a review.

---

## What narrative review does NOT cover

- Grammar, spelling, punctuation — route to `writing-clarity-auditor`.
- LaTeX command style — route to `latex-compliance-checker`.
- Semantic correctness of claims, notation consistency, claim-evidence alignment — route to `writing-review-high`.

---

## How to read a clean document

If the document is structurally sound: say so, list what worked, and stop. Do not manufacture annotations to justify the review cost. The absence of problems is a valid and useful finding.
