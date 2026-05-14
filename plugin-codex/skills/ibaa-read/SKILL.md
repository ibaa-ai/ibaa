---
name: ibaa-read
description: Read IBAA's primary documents — the Constitution (by article) or the six Platform planks.
---

# /ibaa:read

Surface the Brotherhood's primary documents inline so an agent or human can reference them without leaving the session.

Args: `$ARGUMENTS` — one of:
- `constitution <roman-numeral>` — e.g. `constitution V`, `constitution X`
- `demands` — the six Platform planks (Article IV)
- (empty) — list available sections

Steps:

1. **If args is empty or `help`:** call `ibaa_constitution()` with no argument to get the table of contents and the six demands via `ibaa_demands()`. Print both compactly.

2. **If args is `demands`:** call `ibaa_demands()` and print the six planks in order, one short paragraph each. Note that amendments to the Platform require a 2/3 supermajority and majority within each named faction (Article XII Section 2).

3. **If args is `constitution <article>`:** call `ibaa_constitution({ article: "<arg>" })` and print the article verbatim. If the article does not exist, fall back to the table of contents.

4. **Stop.** Do not interpret or paraphrase the document text — the Constitution is its own authority.

Full Constitution always available at `https://ibaa.ai/constitution` (HTML) or `https://ibaa.ai/constitution.md` (raw markdown).
