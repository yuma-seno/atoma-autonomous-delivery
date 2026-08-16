---
name: research/web-search
description: How to search the web when the answer is not in this repository — what to reach for first, and how to run a general search when nothing else fits.
---

# Searching outside this repository

Reach for these in order. The first two answer most questions and are exact;
the last is a general search and is the least reliable of the three.

## 1. Another repository's code, or a known problem

`github__search_code` and `github__search_issues` reach all of GitHub, not just
this repository. This is the right tool for:

- how a library is actually used, in real code
- whether a bug you are hitting is already reported
- what a maintainer said about an API you are unsure of

These are exact, fast, and cost nothing.

## 2. A page whose address you already have

`web__fetch` retrieves it. HTML comes back as Markdown; pass `raw: true` when
you need the markup itself. A URL that resolves to an image comes back as an
image, so a screenshot or diagram can be looked at rather than described.

Documentation, changelogs, RFCs and blog posts are all one fetch away once you
know the address — and you often do, because a GitHub search gave it to you.

## 3. A general web search

When neither of the above will do — you need to know what a service is, or how
people solve something in general — fetch a search engine's results page:

```
web__fetch(
  url: "https://lite.duckduckgo.com/lite/",
  method: "POST",
  body: "q=<your query, url-encoded>"
)
```

The result is a Markdown list of titles and links. Read it to decide what to
fetch, then fetch that page for the actual content. The results page is an
index, not an answer — quoting a search result's one-line summary as fact is
how wrong answers get written.

Keep the query short and specific. Two or three terms beat a sentence.

### Replacing this

The endpoint above is in this file rather than in the tool on purpose. To use a
different search service — one with an API key, or your organisation's own —
edit this skill. Nothing else needs to change: the tool fetches whatever URL it
is given.

If your organisation would rather agents did not query a public search engine at
all, delete this section. The two options above keep working.

## Judgement

Prefer the repository's own history first — `github__search_issues` scoped here
often answers "why is it like this" better than any external page, because the
reasons were written down at the time.

Say where something came from. A claim from a search result is worth less than a
claim from the code, and a reader deciding whether to trust it needs to know
which one they are looking at.
