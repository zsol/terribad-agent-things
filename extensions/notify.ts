/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
const OSC_UNSAFE_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

const sanitizeOscField = (text: string): string =>
	text.replace(OSC_UNSAFE_CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

const notify = (title: string, body: string): void => {
	// OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
	const safeTitle = sanitizeOscField(title);
	const safeBody = sanitizeOscField(body);
	process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: "Ready for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

function shouldSendDesktopNotification(): boolean {
	const args = process.argv.slice(2);
	if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
	if (args.includes("--print") || args.includes("-p")) return false;
	const modeIndex = args.findIndex((arg) => arg === "--mode");
	if (modeIndex !== -1) {
		const mode = args[modeIndex + 1];
		if (mode === "json" || mode === "rpc") return false;
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		if (!shouldSendDesktopNotification()) return;
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});
}
