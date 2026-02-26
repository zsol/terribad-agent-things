import { readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const BLOCKED_ACTIONS = new Set(["eval"]);

const TOOL_DESCRIPTION = `Browser automation via trusted agent-browser CLI (vercel-labs/agent-browser).

Safety defaults:
- No automatic npm installs
- Blocks unsafe subcommands (currently: eval) unless allowUnsafe=true
- Returns structured JSON output when available

Workflow:
open <url> -> snapshot -i -> interact (@e refs) -> re-snapshot -> screenshot -> close`;

function splitCommand(input: string): string[] {
	const matches = input.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [];
	return matches
		.map((token) => token.trim())
		.filter(Boolean)
		.map((token) => {
			if (
				(token.startsWith('"') && token.endsWith('"')) ||
				(token.startsWith("'") && token.endsWith("'"))
			) {
				return token.slice(1, -1);
			}
			return token;
		});
}

function parseJson(stdout: string): any | null {
	const text = stdout.trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isUnsafeCommand(parts: string[]): boolean {
	return parts.some((part) => BLOCKED_ACTIONS.has(part.toLowerCase()));
}

function extractScreenshotPath(data: any): string | null {
	if (!data || typeof data !== "object") return null;
	if (typeof data.path === "string" && data.path.trim()) return data.path.trim();
	return null;
}

function toMimeType(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return "image/png";
}

async function ensureAgentBrowserAvailable(pi: ExtensionAPI): Promise<boolean> {
	const check = await pi.exec("agent-browser", ["--version"], { timeout: 8000 });
	return check.code === 0;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			command: Type.String({ description: "agent-browser command (without the 'agent-browser' prefix)" }),
			allowUnsafe: Type.Optional(
				Type.Boolean({
					description: "Allow blocked unsafe subcommands like 'eval'. Defaults to false.",
				}),
			),
		}),

		renderCall(args, theme) {
			const text = theme.fg("toolTitle", theme.bold("browser ")) + theme.fg("muted", args.command);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "running..."), 0, 0);
			}

			if (result.isError) {
				const msg = result.details?.error ?? result.content?.find((c: any) => c.type === "text")?.text ?? "error";
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
			}

			const action = result.details?.action ?? "done";
			const prefix = theme.fg("success", `✓ ${action}`);

			if (expanded) {
				const body = result.content?.find((c: any) => c.type === "text")?.text ?? "(no output)";
				return new Text(`${prefix}\n${theme.fg("dim", body)}`, 0, 0);
			}

			return new Text(prefix, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			if (!(await ensureAgentBrowserAvailable(pi))) {
				return {
					content: [
						{
							type: "text",
							text: "agent-browser not found. Install trusted package manually: npm install -g agent-browser && agent-browser install",
						},
					],
					details: { error: "agent-browser-not-found" },
					isError: true,
				};
			}

			const command = params.command.trim();
			if (!command) {
				return {
					content: [{ type: "text", text: "Command is required." }],
					details: { error: "empty-command" },
					isError: true,
				};
			}

			const parts = splitCommand(command);
			if (parts.length === 0) {
				return {
					content: [{ type: "text", text: "Could not parse command." }],
					details: { error: "parse-failed" },
					isError: true,
				};
			}

			const allowUnsafe = params.allowUnsafe ?? false;
			if (!allowUnsafe && isUnsafeCommand(parts)) {
				return {
					content: [
						{
							type: "text",
							text: "Blocked unsafe browser command. Re-run with allowUnsafe=true only if you explicitly trust this action.",
						},
					],
					details: { error: "blocked-unsafe-command", command },
					isError: true,
				};
			}

			const hasJson = parts.includes("--json");
			const execArgs = hasJson ? parts : ["--json", ...parts];
			const result = await pi.exec("agent-browser", execArgs, {
				signal,
				timeout: 90000,
			});

			if (result.code !== 0) {
				const errorText = (result.stderr || result.stdout || "").trim() || `agent-browser exited with ${result.code}`;
				return {
					content: [{ type: "text", text: errorText }],
					details: { error: errorText, code: result.code, command },
					isError: true,
				};
			}

			const parsed = parseJson(result.stdout);
			if (parsed && parsed.success === false) {
				const errorText = typeof parsed.error === "string" ? parsed.error : "agent-browser command failed";
				return {
					content: [{ type: "text", text: errorText }],
					details: { error: errorText, command, response: parsed },
					isError: true,
				};
			}

			const action = parts[0]?.toLowerCase();
			if (action === "screenshot" && parsed?.success === true) {
				const screenshotPath = extractScreenshotPath(parsed.data);
				if (screenshotPath) {
					try {
						const resolvedPath = isAbsolute(screenshotPath) ? screenshotPath : resolve(screenshotPath);
						const imageData = readFileSync(resolvedPath);
						return {
							content: [
								{ type: "text", text: `Screenshot saved: ${resolvedPath}` },
								{ type: "image", data: imageData.toString("base64"), mimeType: toMimeType(resolvedPath) },
							],
							details: { command, action, screenshotPath: resolvedPath },
						};
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{ type: "text", text: `Screenshot created but could not be read: ${message}` },
							],
							details: { command, action, screenshotPath, readError: message },
						};
					}
				}
			}

			const textOutput = parsed ? JSON.stringify(parsed, null, 2) : result.stdout.trim();
			const truncation = truncateHead(textOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let finalText = truncation.content || "(no output)";
			if (truncation.truncated) {
				finalText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				finalText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text: finalText }],
				details: { command, action, parsed: !!parsed, truncated: truncation.truncated },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		try {
			await pi.exec("agent-browser", ["close"], { timeout: 5000 });
		} catch {
			// Ignore cleanup errors
		}
	});
}
