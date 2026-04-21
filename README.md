# pi-plugins

[pi](https://github.com/badlogic/pi-mono) extensions, skills, agents, and prompts — installed via symlinks into `~/.pi/agent/`.

## Install

```bash
./install
```

Use `--force` to overwrite existing symlinks or directories.

Use `--global` to also symlink files in `global/` to `~/.pi/agent/` (e.g. `AGENTS.md`). This is opt-in since those files are personal and may conflict with other setups.

Respects `PI_CODING_AGENT_DIR` environment variable (defaults to `~/.pi/agent`).

## Contents

- `extensions/` — pi extensions (TypeScript modules loaded by the agent)
- `skills/` — pi skills (markdown instructions for specific tasks)
- `agents/` — subagent definitions (markdown configs for specialized agents)
- `prompts/` — pi prompt templates (markdown snippets that expand via `/name`)
- `global/` — files symlinked directly into `~/.pi/agent/` (installed with `--global`)

## Extensions

| Extension | Description |
|-----------|-------------|
| `agent-browser` | Browser automation via the `agent-browser` CLI, with defuddled markdown output by default |
| `answer` | `/answer` command — extract questions from assistant messages into interactive Q&A |
| `ask-user` | `ask_user` tool — lets the model ask you questions interactively |
| `control` | Session control tools (`send_to_session`, `list_sessions`) |
| `cwd-history` | Tracks working directory changes across the session |
| `kagi-login` | `kagi_login` tool — authenticates the browser with Kagi for web search |
| `loop` | `/loop` command — run the agent in a loop until a condition is met |
| `notify` | System notifications on turn end |
| `review` | `/review` command — code review for PRs, branches, or uncommitted changes |
| `side` | `/side` side conversations — in-memory overlay thread with `/side-back`, `/side:new`, and `/side:clear` |
| `subagent` | `subagent` tool — delegate tasks to specialized agents in parallel or chains |
| `todos` | `todo` tool and `/todos` command — file-based task management |
| `ty` | `ty_check`, `ty_goto`, `ty_references`, `ty_hover` — Python type checking and navigation |
| `uv` | Intercepts `pip`/`python` calls to use `uv` instead |

## Skills

| Skill | Description |
|-------|-------------|
| `github` | Interact with GitHub using the `gh` CLI |
| `jj` | Jujutsu (jj) version control system commands and workflows |
| `pi-share` | Load and parse session transcripts from pi-share URLs |
| `sentry` | Fetch and analyze Sentry issues, events, and logs |
| `tmpdir` | Use a session-specific temporary directory for all temp files |
| `ty` | Python type checking and code navigation with ty |
| `uv` | Use `uv` instead of pip/python/venv |
| `web-search` | Search the web using Kagi via the browser tool |

## Agents

| Agent | Description |
|-------|-------------|
| `scout` | Fast codebase recon (sonnet model) |
| `researcher` | Deep investigation of topics, APIs, patterns |
| `planner` | Creates implementation plans from context |
| `reviewer` | Code review for quality and security |
| `worker` | General-purpose fallback with full capabilities |

## Prompts

| Prompt | Description |
|--------|-------------|
| `implement` | Scout → plan → implement chain |
| `implement-and-review` | Worker implements, reviewer reviews, worker applies feedback |
| `scout-and-plan` | Scout gathers context, planner creates plan (no implementation) |
