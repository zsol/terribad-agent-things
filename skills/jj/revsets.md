# Revset Reference

Revsets are jj's powerful query language for selecting commits. Use with `-r` flag on most commands.

## Symbols

| Symbol | Description |
|--------|-------------|
| `@` | Working copy change |
| `root()` | Root commit (empty base) |
| `trunk()` | Main branch from origin (main/master/trunk) |
| `visible_heads()` | All visible head commits |
| `<change-id>` | Specific change by ID (e.g., `yyrsmnoo`) |
| `<commit-id>` | Specific commit by SHA |
| `<bookmark>` | Bookmark name |

## Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `x-` | Parent(s) of x | `@-` (parent of working copy) |
| `x+` | Children of x | `trunk()+` |
| `x--` | Grandparent | `@--` |
| `::x` | Ancestors of x (inclusive) | `::@` |
| `x::` | Descendants of x (inclusive) | `trunk()::` |
| `x::y` | x to y (DAG range) | `trunk()::@` |
| `x & y` | Intersection | `mine() & trunk()::` |
| `x \| y` | Union | `@ \| trunk()` |
| `x ~ y` | Difference (x minus y) | `::@ ~ ::trunk()` |
| `~x` | Complement (not x) | `~merges()` |

## Functions

### Basic
| Function | Description |
|----------|-------------|
| `all()` | All visible commits |
| `none()` | Empty set |
| `root()` | Root commit |
| `trunk()` | Main branch (origin/main, origin/master, or origin/trunk) |
| `visible_heads()` | Head commits |

### Relationships
| Function | Description |
|----------|-------------|
| `parents(x)` | Parent commits of x |
| `children(x)` | Child commits of x |
| `ancestors(x)` | All ancestors (same as `::x`) |
| `ancestors(x, depth)` | Ancestors limited to depth |
| `descendants(x)` | All descendants (same as `x::`) |
| `heads(x)` | Commits in x with no descendants in x |
| `roots(x)` | Commits in x with no ancestors in x |
| `connected(x)` | Commits reachable from x in both directions |

### Filtering
| Function | Description |
|----------|-------------|
| `mine()` | Commits by current user |
| `author(pattern)` | Commits by author matching pattern |
| `committer(pattern)` | Commits by committer matching pattern |
| `description(pattern)` | Commits with matching description |
| `empty()` | Empty commits (no diff) |
| `merges()` | Merge commits (multiple parents) |
| `conflict()` | Commits with conflicts |

### Bookmarks and Remotes
| Function | Description |
|----------|-------------|
| `bookmarks()` | All local bookmarks |
| `bookmarks(pattern)` | Bookmarks matching pattern |
| `remote_bookmarks()` | All remote bookmarks |
| `remote_bookmarks(pattern)` | Remote bookmarks matching pattern |
| `tracked_remote_bookmarks()` | Tracked remote bookmarks |

## Useful Examples

### View work in progress
```bash
# Changes between trunk and current
jj log -r 'trunk()::@'

# All my recent work
jj log -r 'mine() & ancestors(@, 20)'

# Uncommitted branches (not on any remote)
jj log -r 'heads(all() ~ remote_bookmarks())'
```

### Find specific commits
```bash
# Commits mentioning "fix" by me
jj log -r 'mine() & description(fix)'

# Non-empty commits on current branch
jj log -r '::@ ~ empty()'

# Merge commits in history
jj log -r '::@ & merges()'

# Conflicted commits
jj log -r 'conflict()'
```

### Branch analysis
```bash
# What's on feature branch but not trunk
jj log -r 'feature:: ~ trunk()::'

# Common ancestor of two branches
jj log -r 'heads(::branch1 & ::branch2)'
```

### Good default log view
```bash
# Show working copy, recent work, and trunk
jj log -r '@ | ancestors(remote_bookmarks().., 2) | trunk()'
```

## Pattern Matching

Functions like `author()`, `description()`, `bookmarks()` support:
- Literal strings: `description("fix bug")`
- Glob patterns: `bookmarks(glob:"feature-*")`
- Substrings: `description(substring:"WIP")`
- Regular expressions: `author(regex:"^John")`

Default is substring matching for most functions.

## Combining Revsets

Revsets compose naturally:
```bash
# Complex query: my non-empty commits since trunk with "api" in description
jj log -r 'mine() & trunk()::@ & ~empty() & description(api)'
```

## Tips

1. Use `jj log -r <revset>` to test revsets before using with other commands
2. Quote revsets with spaces or special characters: `jj log -r 'x & y'`
3. The unique prefix of a change ID works as a revset: `jj log -r y` if only one change starts with "y"
4. Aliases can be defined in config for frequently used revsets
