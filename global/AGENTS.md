# Agent Instructions

- UNLESS you have been ASKED to implement or fix something PREFER debugging and presenting the situation to the user BEFORE changing the code

## Subagent Selection

When spawning subagents, always check the available agents in `~/.pi/agent/agents/` and pick the most appropriate one:

- **scout** - Fast codebase recon (sonnet model)
- **researcher** - Deep investigation of topics, APIs, patterns
- **planner** - Creates implementation plans from context
- **reviewer** - Code review for quality and security
- **worker** - General-purpose fallback with full capabilities

Use "worker" only as the fallback when no specialized agent fits better.

## Version Control

Always check for a jj (Jujutsu) repository before falling back to git commands. If a `.jj` directory exists, use `jj` commands instead of `git`.
