---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output.  You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```

## Caching Output Locally

GitHub API usage is a limited resource. When output needs to be searched, filtered, or post-processed multiple times, save it to a temporary file first and work from that:

```bash
# Fetch once, save locally
gh run view <run-id> --repo owner/repo --log-failed > /tmp/gh-run-<run-id>.log

# Then filter/search the local copy as many times as needed
grep "error" /tmp/gh-run-<run-id>.log
grep "FAIL" /tmp/gh-run-<run-id>.log
```

Avoid re-running `gh` commands just to apply different filters. One fetch, multiple local passes.
