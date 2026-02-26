---
name: web-search
description: Search the web using Kagi via the headless browser tool. Use when you need to look up current information, documentation, news, or any web content. Requires the browser tool (agent-browser extension) and a Kagi account.
---

# Web Search Skill

Search the web using the `browser` tool and Kagi. Kagi requires a logged-in session — use the `kagi_login` tool. 

## Basic Search Workflow

### 1. Log in (if not already)

Call the `kagi_login` tool (no parameters needed):

```
kagi_login
```

You only need to do this once per pi session — the browser stays open and logged in between searches. It closes automatically when pi exits.

### 2. Search

Encode the query in the URL — spaces → `+`, special chars → percent-encoded:

```
browser: open https://kagi.com/search?q=your+search+query
```

### 3. Read the results

```
browser: snapshot
```

Results include titles, URLs, and snippets. The first result is usually the most relevant.

### 4. Navigate to a result

```
browser: open https://example.com/the-result-url
browser: snapshot
```

Or use an interactive snapshot to click a link:

```
browser: snapshot -i
browser: click @eN
browser: snapshot
```

## Tips

- **Include the current year** in queries about current information (e.g. `best+python+libraries+2026`) to avoid outdated results.
- **Encode queries in the URL** — it's faster than typing into a form.
- **Use `snapshot`** (non-interactive) to read page text; add `-i` when you need to click elements.
- **Scroll for more results**: `browser: scroll down` then `browser: snapshot`.
- **For code/docs searches**, append `site:docs.example.com` to narrow results.
- **Screenshots**: use `browser: screenshot` to capture the visual state if helpful.
