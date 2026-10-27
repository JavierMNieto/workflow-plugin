---
name: design-research
description: How to decide the look and behavior of a control, screen or flow that no recorded design decision covers, so nothing a person sees is made up. Use when adding anything a user sees that the project's catalogue (catalogue in .claude/workflow.md) does not cover, when the edit-time hook says no recorded decision covers what you are writing, or when asked to research how a control should work.
---

# Deciding a control nothing covers

Nothing a person sees is made up: no label, button, control, screen or
flow. When nothing in the project's catalogue (the directory the project
file's `catalogue` names) covers what you are about to build, in this
order:

1. **Did the person say how?** If the request already says how the
   control looks or behaves, that is their call: build it and record it
   under their name. If they said to research, skip to step 3.
2. **Ask, once, with three choices.** Say that no recorded decision covers
   this control and ask (with the question tool where there is one):
   - research how the product people already know does it, and follow it
     (the default to recommend);
   - they decide now;
   - you choose, recorded as the agent's choice.
   A trivial choice (a word, an icon among standard ones) needs no
   question: choose, record it as the agent's choice, and move on.
3. **Research, in this order.**
   - **The nearest pattern the project already has.** Open the catalogue
     file for the closest kind of control and match it: the same controls
     and words as the ones beside it. Consistency with the project comes
     before any outside model.
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
4. **Say what you found before building anything large**: the product,
   what it does, and the plan, in a few words. Build after the answer, or
   at once when the choice is small.
5. **Record it.** Add the entry to the catalogue file for the control's
   kind, with the tier and today's date: `(<the person's name>, 15
   October)` when they decided, `(as GitHub does, 15 October)` when you
   followed a product, `(per <source>, 15 October)` when you followed a
   named written source (one `sources.md` lists), `(observed in <x>, 15
   October)` when you measured it in an existing artifact, `(the agent's
   choice, 15 October)` when you chose. The date as the project writes
   dates (`15 October` or `2026-10-15`). An entry another may override
   opens with an id in backticks, `` - `id` **Rule.** ``.
   One or two sentences, present tense, the reason in a sentence. Add the
   component to the file's `paths` and the control's word to its
   `signals`, so the next edit of similar UI meets the rule. A kind of
   control with no file gets one, with the same frontmatter and a row in
   the README's table.
