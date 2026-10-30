---
name: design-research
description: How to decide the look and behavior of a control, screen or flow that no recorded design decision covers, so nothing a person sees is made up. Use when adding anything a user sees that the project's catalogue (catalogue in .claude/workflow.md) does not cover, when the edit-time hook says no recorded decision covers what you are writing, or when asked to research how a control should work.
---

# Deciding a control nothing covers

Nothing a person sees is made up: no label, button, control, screen or
flow; and nothing is recorded that nobody decided: the catalogue is only
for well-formed opinions, researched or given by a person, and anything
not in it is free to change (the workflow's docs, "The catalogue is the
record"). When nothing in the project's catalogue (the directory the project
file's `catalogue` names) covers what you are about to build, in this
order:

1. **Did the person say how?** If the request already says how the
   control looks or behaves, that is their call: build it and record it
   under their name. If they said to research, skip to step 3.
2. **A new screen or flow: ask, once, with two choices.** Say that no
   recorded decision covers it and ask (with the question tool where
   there is one, by "Asked in plain words" in the workflow's docs):
   - research how the product people already know does it, and follow it
     (the default to recommend);
   - they decide now.
   **Any other control is researched when there is something to
   research**: a control, flow or string people know from a product (a
   date-range picker, a sign-in form, the label a known product uses for
   this action) skips the question, never the research: go to step 3,
   follow what you find, and record it under the product or source
   followed. **A detail no product settles is free**: a tooltip's words,
   an icon among a standard set, spacing, a line kept or cut; write it by
   the catalogue's everywhere rules and the nearest pattern, record
   nothing, ask nothing. Ask the person only when the research leaves a
   choice the house rules do not settle, as one question with the options
   found, by "Asked in plain words". Nothing is the agent's choice: what
   research found nothing for is free, and becomes a person's call when
   one says so.
3. **Research, in this order.**
   - **The nearest pattern the project already has.** Open the catalogue
     file for the closest kind of control and match it: the same controls
     and words as the ones beside it. Consistency with the project comes
     before any outside model. A string's nearest pattern is the entry or
     house rule that produces it; one that only allows it is not a
     grounding.
   - **The product people know for this exact control**, named: the
     products the project file's body names under **Products** (one line
     per kind of thing, the product people know for it), then the ones
     the catalogue's README names, then the written sources the
     catalogue's `sources.md` lists when it has one, then the familiar
     product for this exact control, named and looked up, never recalled.
     Prefer a product of the same kind and the same flow, and say which
     you looked at.
   - **The house rules**: the docs the project's `CLAUDE.md` names for
     copy and look, and the catalogue's README.
4. **Say what you found before building a new screen or flow**: the
   product, what it does, and the plan, in a few words, and build after
   the answer. Any other control is built at once, unless the research
   left a choice the house rules do not settle (step 2).
5. **Record it.** Add the entry to the catalogue file for the control's
   kind, with the tier and today's date: `(<the person's name>, 15
   October)` when they decided, `(as GitHub does, 15 October)` when you
   followed a product, `(per <source>, 15 October)` when you followed a
   named written source (one `sources.md` lists), `(observed in <x>, 15
   October)` when you measured it in an existing artifact. The date as
   the project writes
   dates (`15 October` or `2026-10-15`). An entry another may override
   opens with an id in backticks, `` - `id` **Rule.** ``.
   One or two sentences, present tense, the reason in a sentence. An
   entry that followed a product or a source names the plan whose
   Sources keeps the address, or carries the address itself when there
   is no plan. A string's entry goes in the file for its control, with
   the string in full. Add the
   component to the file's `paths` and the control's word to its
   `signals`, so the next edit of similar UI meets the rule. A kind of
   control with no file gets one, with the same frontmatter and a row in
   the README's table. A free detail gets no entry. A person's call that
   applies to the whole product, a principle, goes in the README's
   everywhere rules under their name.
