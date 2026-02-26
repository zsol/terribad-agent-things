---
name: tmpdir
description: "Use a session-specific temporary directory for all temp files. Create once with `mktemp -d` under $TMPDIR, reuse throughout the session to avoid conflicts between concurrent agent sessions."
---

# Temporary Files

Never write temporary files directly to `/tmp` or `$TMPDIR`. Multiple agent sessions running concurrently will clobber each other's files.

## Setup

On first need for a temp directory in a session, create one:

```bash
AGENT_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/agent.XXXXXX")
echo "$AGENT_TMPDIR"
```

Remember the path and reuse it for all subsequent temp file operations in the same session.

## Usage

```bash
# Write temp files into the session directory
some_command > "$AGENT_TMPDIR/output.log"
gh run view 12345 --log-failed > "$AGENT_TMPDIR/ci-logs.txt"
grep "ERROR" "$AGENT_TMPDIR/ci-logs.txt"
```

## Cleanup

Clean up when temp files are no longer needed:

```bash
rm -rf "$AGENT_TMPDIR"
```
