---
name: sources
description: Audits a paper's BibTeX and citations (required fields, arXiv entries since published, brace protection, consistent author and venue names, prior work named without a \cite), collects papers from DBLP and OpenAlex, and writes a related-work positioning brief from the papers the author approves, with venue tiers (CCS, S&P, USENIX Security, CRYPTO, EUROCRYPT, DISC, PODC, STOC, FOCS). Use before submission, or to survey the literature around a project.
paths:
  - "**/*.bib"
  - "**/*.tex"
---

# Sources and citations

You report; the `.bib` is changed only when told to fix it or apply
the fixes. A crawl writes `papers.json`, and the related-work pass its
brief.

**The project's writing decisions come first.** A rule the owner gives
in chat (a word they prefer, a citation style, how an introduction opens)
is recorded in the project's catalogue under their name, by the rules of
"Decisions" in the workflow plugin's docs, and the catalogue's entries
covering the file are read before this skill's reference files, since the
project's decision outranks the standard. A project with no catalogue
(the project file's `catalogue`) follows the reference files alone.

## The audit, in order

1. The required fields for each entry type.
2. arXiv and CoRR entries since published (search DBLP).
3. Brace protection in titles (`{SHA}`, `{Bitcoin}`).
4. The same spelling of each author and venue throughout.
5. Prior work named in the `.tex` with no `\cite` within fifty
   characters.
6. The `.blg` file's warnings.

## The crawl

Three to five variants of the query; DBLP, then OpenAlex, fifty results
each; duplicates dropped by normalized title; a venue filter and topic
buckets when asked.

## Related work

1. **Survey** the project, in 150 words at most.
2. **Propose** a list of papers, each tagged T1, T2 or outside the
   field, and wait for the author's pick. Never fetch a paper not
   approved.
3. **Read** the approved papers and write the brief.

## The report

The audit: `# Bibliography audit: <project>`, then Critical, Major,
Minor and Summary sections, each finding as
`[CRITICAL|MAJOR|MINOR: <axis>] @key: <what>`. The brief: Research
context; the papers (authors, venue, year, summary, why it matters,
full text or abstract only); a positioning summary; the citation keys to
use. About 1500 words at most.
