---
name: jj
description: "Jujutsu (jj) version control system commands and workflows. Use when working with jj repositories, commits, branches, rebasing, or interacting with git remotes like GitHub."
---

# Jujutsu (jj) Skill

## Agent Guidelines

**⚠️ NEVER USE `jj squash` ⚠️** - Do not squash commits unless the user explicitly asks for it. Each commit should remain separate and intact.

**Work directly in your own change:**
- Create a new change with `jj new -m "description"`
- Make your modifications there
- When done, create a new change for the next task with `jj new`

Do NOT:
- `jj squash` - NEVER squash, not even your own work
- `jj abandon` user's changes
- `jj edit` user's existing commits to modify them directly
- Rewrite history of changes the user created

---

Jujutsu is a Git-compatible DVCS that's simpler yet more powerful than git. Key differences:
- No staging area/index - all changes are automatically tracked
- Changes have stable **change IDs** (letters only, e.g., `yyrsmnoo`) separate from **commit IDs**
- Rebases always succeed (conflicts are recorded in commits, not blocking)
- Anonymous branches are first-class citizens

## Quick Reference

| Task | Command |
|------|---------|
| Initialize repo | `jj git init` |
| View status | `jj st` |
| View history | `jj log` |
| Describe current change | `jj describe -m "message"` |
| Create new change | `jj new` |
| Create change with message | `jj new -m "message"` |
| Squash into parent | `jj squash` |
| Edit a specific change | `jj edit <rev>` |
| Move to next change | `jj next` |
| Move to previous change | `jj prev` |
| Abandon change | `jj abandon` |
| Undo last operation | `jj undo` |
| Show diff | `jj diff` |

## Core Concepts

### Change ID vs Commit ID
- **Change ID**: Stable identifier (letters k-z only), doesn't change when you modify the commit
- **Commit ID**: Changes every time commit content changes (like git)
- Use change IDs to refer to work-in-progress; they stay stable as you edit

### The Working Copy (@)
- `@` always refers to the current working copy
- Unlike git's HEAD, `@` represents uncommitted changes too
- `@-` refers to the parent of `@`

### No Staging Area
All file changes are automatically part of the current change. No `git add` needed.

## Common Workflows

### Squash Workflow (index-like)
```bash
# 1. Describe work to do
jj describe -m "implement feature X"

# 2. Create scratch space
jj new

# 3. Make changes, then squash into parent
jj squash              # squash all changes
jj squash file.txt     # squash specific file
jj squash -i           # interactive (TUI picker)
```

### Edit Workflow (direct editing)
```bash
# 1. Create and describe change
jj new -m "implement feature X"

# 2. Make changes directly (auto-tracked)

# 3. When done, create new change for next task
jj new -m "next feature"
```

### Insert Change Before Current
```bash
# Create change BEFORE current one (auto-rebases descendants)
jj new -B @ -m "refactor needed first"
```

## Branching and Merging

### Anonymous Branches
No need to name branches! Just create changes with different parents:
```bash
# Create branch from specific change
jj new <change-id> -m "feature branch"

# View branches in log
jj log
```

### Merging
Merging is just creating a change with multiple parents:
```bash
# Merge two branches
jj new <change1> <change2> -m "merge feature"

# Merge three or more
jj new <change1> <change2> <change3> -m "mega merge"
```

### Rebasing
```bash
# Rebase change onto new parent
jj rebase -r <change> -d <new-parent>

# Rebase change and descendants
jj rebase -s <change> -d <new-parent>

# Rebase onto multiple parents (merge)
jj rebase -r <change> -d <parent1> -d <parent2>
```

## Bookmarks (Named Branches)

Bookmarks are jj's equivalent to git branches (needed for GitHub interop):
```bash
# Create bookmark at current change
jj bookmark create mybranch

# Move bookmark to current change
jj bookmark set mybranch

# Move bookmark backwards (requires flag)
jj bookmark set mybranch -r @- --allow-backwards

# List bookmarks
jj bookmark list
```

**Note**: Bookmarks don't auto-advance like git branches. Update them before pushing.

## Working with Git Remotes

### Setup
```bash
# Add remote
jj git remote add origin git@github.com:user/repo.git

# Fetch from remote
jj git fetch

# Push bookmark
jj git push
```

### Creating Pull Requests
```bash
# Push current change, auto-creating a branch
jj git push -c @

# This creates a branch like "push-vmunwxsksqvk" (based on change ID)
```

### Updating PRs
```bash
# After making changes, update the bookmark and push
jj bookmark set <branch-name>
jj git push

# Or with force push if rebased
jj git push --allow-new
```

### Fetching Updates
```bash
jj git fetch
jj new trunk   # Start new work on top of trunk
```

## Revsets

Revsets are a powerful query language for selecting commits:

### Symbols
- `@` - working copy
- `root()` - root commit
- `trunk()` - main/master/trunk branch from origin
- `<change-id>` - specific change
- `<bookmark>` - bookmark name

### Operators
- `@-` or `x-` - parent of x
- `@+` or `x+` - child of x
- `::x` - ancestors of x
- `x::` - descendants of x
- `x & y` - intersection
- `x | y` - union

### Functions
- `parents(x)` - parent changes
- `children(x)` - child changes
- `ancestors(x)` / `ancestors(x, depth)` - ancestors with optional depth limit
- `heads(x)` - commits not ancestors of others in x
- `mine()` - changes by current user
- `description(text)` - changes with text in description
- `author(text)` - changes by author matching text

### Examples
```bash
# Log ancestry of current change
jj log -r '::@'

# Find my changes with "fix" in description
jj log -r 'mine() & description(fix)'

# Show trunk and work in progress
jj log -r '@ | ancestors(remote_bookmarks().., 2) | trunk()'
```

## Handling Conflicts

Conflicts don't block operations in jj - they're recorded in the commit:
```bash
# After a rebase with conflicts
jj log   # Shows "conflict" marker on affected commits

# Edit the conflicted commit
jj edit <conflicted-change>

# Fix conflict markers in files, then done!
# Or use the resolve tool
jj resolve
```

## Useful Commands

```bash
# Show what files changed
jj diff

# Show diff for specific change
jj diff -r <change>

# Show file at specific revision
jj file show <file> -r <change>

# Split a change into multiple
jj split

# Combine changes
jj squash --from <change> --into <target>

# Duplicate a change
jj duplicate <change>

# View operation log (undo history)
jj op log

# Restore to previous operation
jj op restore <op-id>
```

## Configuration

```bash
# Set user info
jj config set --user user.name "Your Name"
jj config set --user user.email "you@example.com"

# Configure default push remote (in repo config)
# Add to .jj/repo/config.toml:
[git]
push = "myfork"
```

## Tips

1. **Use change IDs, not commit IDs** - they're stable as you edit
2. **Don't fear rebasing** - conflicts are recorded, not blocking
3. **Bookmarks before push** - remember to update bookmarks before `jj git push`
4. **Use `jj undo`** - most operations can be undone
5. **`jj log` is your friend** - shows the full picture including branches
6. **Unique prefixes work** - `jj edit y` works if only one change starts with "y"
