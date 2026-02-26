# GitHub Workflow with jj

How to use jj with GitHub for pull requests and collaboration.

## Initial Setup

```bash
# Clone existing repo
jj git clone git@github.com:user/repo.git
cd repo

# Or init in existing directory
jj git init
jj git remote add origin git@github.com:user/repo.git
jj git fetch
```

## Creating a Pull Request

### Method 1: Auto-create branch (recommended)
```bash
# Make your changes on a new change
jj new trunk -m "add new feature"
# ... make changes ...

# Push with auto-created branch name
jj git push -c @
# Creates branch like "push-vmunwxsksqvk"
```

### Method 2: Named branch
```bash
# Create bookmark first
jj bookmark create feature-branch

# Make changes
jj new -m "implement feature"
# ... work ...

# Update bookmark and push
jj bookmark set feature-branch
jj git push
```

## Updating a Pull Request

### Adding commits (preserves review comments)
```bash
# Create new change on top
jj new -m "address review feedback"
# ... make changes ...

# Update bookmark to include new commit
jj bookmark set <branch-name>
jj git push
```

### Rebasing/amending (cleaner history)
```bash
# Edit the existing change directly
jj edit <change-id>
# ... make changes ...

# Push (may need --allow-new for force push)
jj git push
```

## Syncing with Upstream

### Fetch latest changes
```bash
jj git fetch
```

### Rebase work onto updated trunk
```bash
# Rebase current branch onto trunk
jj rebase -s <branch-start> -d trunk

# Or start fresh work on trunk
jj new trunk -m "new work"
```

### Update local trunk bookmark
```bash
jj bookmark set trunk -r trunk@origin
```

## Working with Forks

### Setup fork as default push target
Add to `.jj/repo/config.toml` or global config:
```toml
[git]
fetch = ["origin", "upstream"]
push = "origin"
```

Then:
```bash
jj git remote add upstream git@github.com:original/repo.git
jj git fetch --all-remotes
```

### Push to fork
```bash
jj git push --remote origin
```

## Common Scenarios

### Stacked PRs
```bash
# Create base PR
jj new trunk -m "PR 1: base feature"
# ... work ...
jj bookmark create pr1
jj git push -c pr1

# Create dependent PR
jj new -m "PR 2: builds on PR 1"
# ... work ...
jj bookmark create pr2
jj git push -c pr2
```

### Cherry-pick from another branch
```bash
# Duplicate a change onto current branch
jj duplicate <change-id> -d @
```

### Squash before merge
```bash
# Combine multiple changes into one
jj squash --from <start> --into <end>
```

### Resolve merge conflicts before PR
```bash
# Rebase onto trunk (conflicts recorded, not blocking)
jj rebase -s <branch-start> -d trunk

# If conflicts, edit and resolve
jj edit <conflicted-change>
# ... fix conflicts in files ...

# Verify resolution
jj diff
```

## Tips

1. **Push creates immutable commits**: After pushing, jj creates a new empty change for you to work on
2. **Check bookmark position before push**: Use `jj log` to verify bookmarks point where expected
3. **Use `jj git push --dry-run`**: See what would be pushed without actually pushing
4. **Bookmark names can be short**: GitHub sees the full name, you can use short IDs locally
5. **Don't forget `jj git fetch`**: Remote bookmarks don't update automatically
