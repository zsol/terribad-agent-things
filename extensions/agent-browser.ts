import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
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
const OUTPUT_MODES = ["markdown", "structure"] as const;
const DEFUDDLE_PINNED_VERSION = "0.8.0";
const DEFUDDLE_BUNX_PACKAGE = `defuddle@${DEFUDDLE_PINNED_VERSION}`;
const DEFUDDLE_BUNX_RUNNER = `bunx ${DEFUDDLE_BUNX_PACKAGE}`;
type OutputMode = (typeof OUTPUT_MODES)[number];

const TOOL_DESCRIPTION = `Browser automation via trusted agent-browser CLI (vercel-labs/agent-browser).

Safety defaults:
- No automatic global npm installs
- Blocks unsafe subcommands (currently: eval) unless allowUnsafe=true
- Uses defuddle markdown output for snapshot commands by default
- Defuddle execution: local defuddle binary first, then fallback to ${DEFUDDLE_BUNX_RUNNER}
- Use output="structure" for raw snapshot/refs JSON (@e interactions)

Workflow:
open <url> -> snapshot -> interact (@e refs via output="structure") -> re-snapshot -> screenshot -> close`;

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

function getOutputMode(value: unknown): OutputMode {
	return OUTPUT_MODES.includes(value as OutputMode) ? (value as OutputMode) : "markdown";
}

function toNullableString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

function toDefuddleHtmlDocument(html: string, origin: string | null): string {
	const baseTag = origin ? `<base href="${origin.replace(/"/g, "&quot;")}">` : "";
	const content = html.trim();

	if (!content) return `<html><head>${baseTag}</head><body></body></html>`;

	if (/<html[\s>]/i.test(content)) {
		if (!baseTag || /<base[\s>]/i.test(content)) return content;
		if (/<head[\s>]/i.test(content)) {
			return content.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
		}
		return content.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
	}

	if (/<head[\s>]/i.test(content)) {
		if (!baseTag || /<base[\s>]/i.test(content)) return `<html>${content}</html>`;
		return `<html>${content.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)}</html>`;
	}

	if (/<body[\s>]/i.test(content)) {
		return `<html><head>${baseTag}</head>${content}</html>`;
	}

	return `<html><head>${baseTag}</head><body>${content}</body></html>`;
}

async function ensureAgentBrowserAvailable(pi: ExtensionAPI): Promise<boolean> {
	const check = await pi.exec("agent-browser", ["--version"], { timeout: 8000 });
	return check.code === 0;
}

async function ensureDefuddleAvailable(pi: ExtensionAPI): Promise<boolean> {
	const check = await pi.exec("defuddle", ["--version"], { timeout: 8000 });
	return check.code === 0;
}

async function runDefuddleParse(
	pi: ExtensionAPI,
	tempHtmlPath: string,
	signal?: AbortSignal,
): Promise<{ result: Awaited<ReturnType<ExtensionAPI["exec"]>>; runner: string; usedFallback: boolean }> {
	const parseArgs = ["parse", tempHtmlPath, "--markdown", "--json"];

	if (await ensureDefuddleAvailable(pi)) {
		const result = await pi.exec("defuddle", parseArgs, {
			signal,
			timeout: 90000,
		});
		return {
			result,
			runner: "defuddle",
			usedFallback: false,
		};
	}

	const result = await pi.exec("bunx", ["--yes", DEFUDDLE_BUNX_PACKAGE, ...parseArgs], {
		signal,
		timeout: 120000,
	});
	return {
		result,
		runner: DEFUDDLE_BUNX_RUNNER,
		usedFallback: true,
	};
}

async function getCurrentPageHtml(pi: ExtensionAPI, signal?: AbortSignal): Promise<{ html: string; origin: string | null } | null> {
	for (const selector of ["html", "body"]) {
		const result = await pi.exec("agent-browser", ["--json", "get", "html", selector], {
			signal,
			timeout: 45000,
		});

		if (result.code !== 0) continue;

		const parsed = parseJson(result.stdout);
		const html = toNullableString(parsed?.data?.html);
		if (!html) continue;

		return {
			html,
			origin: toNullableString(parsed?.data?.origin),
		};
	}

	return null;
}

async function defuddleCurrentPage(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<
	| { ok: true; markdown: string; title: string | null; origin: string | null; runner: string; usedFallback: boolean }
	| { ok: false; error: string; runner: string | null; usedFallback: boolean }
> {
	const page = await getCurrentPageHtml(pi, signal);
	if (!page) {
		return {
			ok: false,
			error: "Could not retrieve current page HTML for defuddle conversion.",
			runner: null,
			usedFallback: false,
		};
	}

	const tempDir = mkdtempSync(join(tmpdir(), "pi-browser-defuddle-"));
	const tempHtmlPath = join(tempDir, "page.html");

	try {
		const htmlDocument = toDefuddleHtmlDocument(page.html, page.origin);
		writeFileSync(tempHtmlPath, htmlDocument, "utf8");

		const { result: defuddleResult, runner, usedFallback } = await runDefuddleParse(pi, tempHtmlPath, signal);

		if (defuddleResult.code !== 0) {
			const message =
				(defuddleResult.stderr || defuddleResult.stdout || "").trim() ||
				`${runner} exited with ${defuddleResult.code}`;
			return {
				ok: false,
				error: `${runner} failed: ${message}`,
				runner,
				usedFallback,
			};
		}

		const parsed = parseJson(defuddleResult.stdout);
		const content = toNullableString(parsed?.content);
		if (!content) {
			return {
				ok: false,
				error: `${runner} returned empty markdown content.`,
				runner,
				usedFallback,
			};
		}

		const title = toNullableString(parsed?.title);
		const origin = page.origin;
		const sections = [
			title ? `# ${title}` : null,
			origin ? `Source: ${origin}` : null,
			content,
		].filter((section): section is string => !!section);

		return {
			ok: true,
			markdown: sections.join("\n\n"),
			title,
			origin,
			runner,
			usedFallback,
		};
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	}
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
			output: Type.Optional(
				Type.Union([Type.Literal("markdown"), Type.Literal("structure")], {
					description:
						`Output mode. 'markdown' (default) uses defuddle for snapshot output (local defuddle, then ${DEFUDDLE_BUNX_RUNNER}). 'structure' returns raw page structure/refs JSON.`,
				}),
			),
		}),

		renderCall(args, theme) {
			const outputMode = getOutputMode(args.output);
			const outputSuffix = outputMode === "structure" ? " (structure)" : "";
			const text =
				theme.fg("toolTitle", theme.bold("browser ")) +
				theme.fg("muted", `${args.command}${outputSuffix}`);
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
			const title = result.details?.title;
			const summary = title ? `${action} — ${title}` : action;
			const prefix = theme.fg("success", `✓ ${summary}`);

			if (expanded) {
				const snapshot: string | null = result.details?.snapshot ?? null;
				const refs: Record<string, { role: string }> | null = result.details?.refs ?? null;

				const lines: string[] = [];

				// Headings from snapshot ARIA tree, with first-N-lines fallback
				if (snapshot) {
					const headings = snapshot
						.split("\n")
						.filter((line) => /heading "/.test(line))
						.map((line) => line.match(/heading "([^"]+)"/)?.[1] ?? "")
						.filter(Boolean);

					if (headings.length > 0) {
						lines.push(...headings.map((h) => `  ${h}`));
					} else {
						lines.push(...snapshot.split("\n").slice(0, 10));
					}
				}

				// Ref type summary
				if (refs) {
					const counts: Record<string, number> = {};
					for (const { role } of Object.values(refs)) {
						counts[role] = (counts[role] ?? 0) + 1;
					}
					const refSummary = Object.entries(counts)
						.sort((a, b) => b[1] - a[1])
						.map(([role, count]) => `${count} ${role}${count !== 1 ? "s" : ""}`)
						.join(" · ");
					if (refSummary) lines.push(refSummary);
				}

				const body = lines.length > 0
					? lines.join("\n")
					: result.content?.find((c: any) => c.type === "text")?.text ?? "(no output)";

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

			const outputMode = getOutputMode(params.output);
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
							details: { command, action, screenshotPath: resolvedPath, output: outputMode },
						};
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{ type: "text", text: `Screenshot created but could not be read: ${message}` },
							],
							details: { command, action, screenshotPath, readError: message, output: outputMode },
						};
					}
				}
			}

			let textOutput = parsed ? JSON.stringify(parsed, null, 2) : result.stdout.trim();
			let effectiveOutputMode = outputMode;
			let title = toNullableString(parsed?.data?.title);
			const hasSnapshot = typeof parsed?.data?.snapshot === "string";
			const refs = parsed?.data?.refs ?? null;
			let snapshot = parsed?.data?.snapshot ?? null;
			let defuddleError: string | null = null;
			let defuddleRunner: string | null = null;
			let defuddleUsedFallback = false;

			if (outputMode === "markdown" && hasSnapshot) {
				const defuddled = await defuddleCurrentPage(pi, signal);
				defuddleRunner = defuddled.runner;
				defuddleUsedFallback = defuddled.usedFallback;

				if (defuddled.ok) {
					textOutput = defuddled.markdown;
					title = defuddled.title ?? title;
					snapshot = null;
				} else {
					effectiveOutputMode = "structure";
					defuddleError = defuddled.error;
					textOutput = `${defuddled.error}\n\n${textOutput}`;
				}
			}

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
				details: {
					command,
					action,
					parsed: !!parsed,
					truncated: truncation.truncated,
					title,
					output: effectiveOutputMode,
					requestedOutput: outputMode,
					defuddleError,
					defuddleRunner,
					defuddleUsedFallback,
					snapshot: effectiveOutputMode === "structure" ? snapshot : null,
					refs: effectiveOutputMode === "structure" ? refs : null,
				},
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
