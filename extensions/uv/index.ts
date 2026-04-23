/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * This extension wraps the bash tool to prepend intercepted-commands to PATH,
 * which contains shim scripts that intercept common Python tooling commands
 * and redirect agents to use uv instead.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected to `uv run python`, with special handling to
 *   block `python -m pip` and `python -m venv`
 *
 * The shim scripts are located in the intercepted-commands directory and
 * provide helpful error messages with the equivalent uv commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");
const commandPrefix = `export PATH="${interceptedCommandsPath}:$PATH"`;

export default function (pi: ExtensionAPI) {
	const baseBashTool = createBashToolDefinition("/", {
		commandPrefix,
	});

	pi.registerTool({
		...baseBashTool,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const bashTool = createBashToolDefinition(ctx.cwd, {
				commandPrefix,
			});
			return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify("UV interceptor loaded", "info");
		}
	});
}
