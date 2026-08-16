---
name: research/web-search
description: How to find something that is not in this repository — fetching a page you can name, and running a general search when you cannot.
---

# Looking outside this repository

## A page whose address you already have

`web__fetch` retrieves it. HTML comes back as Markdown, so the result is prose
rather than markup; pass `raw: true` when the markup itself is what you need. A
URL that resolves to an image comes back as an image, so a screenshot or a
diagram can be looked at rather than described.

Documentation, changelogs, release notes and RFCs are one fetch away once you
know the address. Reach for this first — it is exact, and it costs one call.

## A general search

When you cannot name the page, fetch a search engine's results:

```
web__fetch(
  url: "https://lite.duckduckgo.com/lite/",
  method: "POST",
  body: "q=<your query, url-encoded>"
)
```

The result is a list of titles and links in Markdown. **It is an index, not an
answer.** Read it to decide which page to fetch, then fetch that page for the
content. Quoting a search result's one-line summary as fact is how wrong answers
get written — the summary is written to attract a click, not to be correct.

Keep the query short. Two or three specific terms beat a sentence.

## Judgement

Search the repository's own history before searching the web. `github__get_issue`
and the issue tools answer "why is it like this" better than any external page,
because the reason was written down here at the time it was decided.

Say where a claim came from. Something read off a web page is worth less than
something read out of the code, and whoever reads your report needs to know
which one they are looking at.

## Replacing this

The search endpoint above is in this skill rather than inside the tool, on
purpose. To use a different service — one with an API key, or your own — edit
this file; the tool fetches whatever URL it is handed, so nothing else changes.

If you would rather agents did not query a public search engine at all, delete
that section. Fetching a named page keeps working.
