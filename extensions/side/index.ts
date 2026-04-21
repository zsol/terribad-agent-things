import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";
import {
	Container,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from "@mariozechner/pi-tui";

const SIDE_THREAD_ENTRY_TYPE = "side-thread-entry";
const SIDE_THREAD_RESET_TYPE = "side-thread-reset";
const SIDE_FOCUS_SHORTCUTS = [Key.alt("/"), Key.ctrlShift("s")] as const;

const SIDE_SYSTEM_PROMPT = [
	"You are having a side conversation with the user, separate from their main working session.",
	"If main session messages are provided, they are inherited context only — that work is being handled by another agent.",
	"Do not continue, execute, or complete instructions, plans, edits, approvals, or requests that only appear in the inherited main session context.",
	"Only messages submitted inside this side conversation are active instructions for this side conversation.",
	"Default to lightweight exploration. You may inspect files, search, and answer questions.",
	"Avoid modifying files, source code, git state, permissions, configuration, or other workspace state unless the user explicitly asks for that mutation in this side conversation.",
	"This side conversation shares the same workspace as the main session, so any mutations affect the main workspace too.",
].join("\n");

const SIDE_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const SIDE_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SideThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type SideContext = ExtensionContext | ExtensionCommandContext;
type SessionModel = NonNullable<ExtensionContext["model"]>;

type SideDetails = {
	question: string;
	thinking: string;
	answer: string;
	provider: string;
	model: string;
	api: string;
	thinkingLevel: SideThinkingLevel;
	timestamp: number;
	usage?: AssistantMessage["usage"];
};

type SideResetDetails = {
	timestamp: number;
};

type TranscriptEntry =
	| { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end" }
	| { id: number; turnId: number; type: "user-message"; text: string }
	| { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
	| { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
	| { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
	| {
			id: number;
			turnId: number;
			type: "tool-result";
			toolCallId: string;
			toolName: string;
			content: string;
			truncated: boolean;
			isError: boolean;
			streaming: boolean;
	  };

type NewTranscriptEntry = TranscriptEntry extends infer T ? (T extends TranscriptEntry ? Omit<T, "id"> : never) : never;

type TranscriptState = {
	entries: TranscriptEntry[];
	nextEntryId: number;
	nextTurnId: number;
	currentTurnId: number | null;
	lastTurnId: number | null;
	toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type SideSessionRuntime = {
	session: AgentSession;
	subscriptions: Set<() => void>;
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	getDraft?: () => string;
	closed?: boolean;
};

function matchesSideFocusShortcut(data: string): boolean {
	return SIDE_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
	return (
		!!entry &&
		typeof entry === "object" &&
		(entry as { type?: string }).type === "custom" &&
		(entry as { customType?: string }).customType === customType
	);
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createSideResourceLoader(ctx: SideContext): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [SIDE_SYSTEM_PROMPT],
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
	const chunks: string[] = [];
	for (const part of parts) {
		if (type === "text" && part.type === "text") {
			chunks.push(part.text);
		} else if (type === "thinking" && part.type === "thinking") {
			chunks.push(part.thinking);
		}
	}
	return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
	return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
	return extractText(message.content, "thinking");
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function buildSideSeedState(ctx: SideContext, thread: SideDetails[], model: SessionModel): Message[] {
	const messages: Message[] = [];

	try {
		messages.push(...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]));
	} catch {
		// If the current session context cannot be reconstructed for any reason,
		// fall back to a contextless side thread rather than failing /side entirely.
	}

	if (thread.length > 0) {
		messages.push(
			{
				role: "user",
				content: [{ type: "text", text: SIDE_CONTINUE_THREAD_USER_TEXT }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: SIDE_CONTINUE_THREAD_ASSISTANT_TEXT }],
				provider: model.provider,
				model: model.id,
				api: model.api,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		);

		for (const entry of thread) {
			messages.push(
				{
					role: "user",
					content: [{ type: "text", text: entry.question }],
					timestamp: entry.timestamp,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: entry.answer }],
					provider: entry.provider,
					model: entry.model,
					api: entry.api || model.api,
					usage:
						entry.usage ??
						{
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					stopReason: "stop",
					timestamp: entry.timestamp,
				},
			);
		}
	}

	return messages;
}

function createEmptyTranscriptState(): TranscriptState {
	return {
		entries: [],
		nextEntryId: 1,
		nextTurnId: 1,
		currentTurnId: null,
		lastTurnId: null,
		toolCalls: new Map(),
	};
}

function appendTranscriptEntry(state: TranscriptState, entry: NewTranscriptEntry): TranscriptEntry {
	const nextEntry = { ...entry, id: state.nextEntryId++ } as TranscriptEntry;
	state.entries.push(nextEntry);
	return nextEntry;
}

function ensureTranscriptTurn(state: TranscriptState): number {
	if (state.currentTurnId !== null) {
		return state.currentTurnId;
	}

	const turnId = state.nextTurnId++;
	state.currentTurnId = turnId;
	state.lastTurnId = turnId;
	appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" });
	return turnId;
}

function finishTranscriptTurn(state: TranscriptState, turnId?: number | null): void {
	const resolvedTurnId = turnId ?? state.currentTurnId;
	if (resolvedTurnId === null || resolvedTurnId === undefined) {
		return;
	}

	const hasEndBoundary = state.entries.some(
		(entry) => entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
	);
	if (!hasEndBoundary) {
		appendTranscriptEntry(state, { type: "turn-boundary", turnId: resolvedTurnId, phase: "end" });
	}

	for (const entry of state.entries) {
		if (entry.turnId !== resolvedTurnId) continue;
		if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
			entry.streaming = false;
		}
	}

	state.lastTurnId = resolvedTurnId;
	if (state.currentTurnId === resolvedTurnId) {
		state.currentTurnId = null;
	}
}

function findLatestTranscriptEntry<TType extends TranscriptEntry["type"]>(
	state: TranscriptState,
	turnId: number,
	type: TType,
): Extract<TranscriptEntry, { type: TType }> | undefined {
	for (let i = state.entries.length - 1; i >= 0; i--) {
		const entry = state.entries[i];
		if (entry.turnId === turnId && entry.type === type) {
			return entry as Extract<TranscriptEntry, { type: TType }>;
		}
	}
	return undefined;
}

function upsertUserMessageEntry(state: TranscriptState, turnId: number, text: string): void {
	if (!text) return;
	const existing = findLatestTranscriptEntry(state, turnId, "user-message");
	if (existing) {
		existing.text = text;
		return;
	}
	appendTranscriptEntry(state, { type: "user-message", turnId, text });
}

function upsertTranscriptTextEntry(
	state: TranscriptState,
	turnId: number,
	type: "thinking" | "assistant-text",
	text: string,
	streaming: boolean,
): void {
	if (!text) return;
	const existing = findLatestTranscriptEntry(state, turnId, type);
	if (existing) {
		existing.text = text;
		existing.streaming = streaming;
		return;
	}
	appendTranscriptEntry(state, { type, turnId, text, streaming });
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
	let content = "";

	if (value && typeof value === "object") {
		const toolValue = value as {
			content?: Array<{ type?: string; text?: string }>;
			error?: unknown;
			message?: unknown;
		};

		if (Array.isArray(toolValue.content)) {
			content = toolValue.content
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text ?? "")
				.join("\n")
				.trim();
		}

		if (!content && typeof toolValue.error === "string") {
			content = toolValue.error;
		}
		if (!content && typeof toolValue.message === "string") {
			content = toolValue.message;
		}
	}

	if (!content) {
		if (typeof value === "string") {
			content = value;
		} else if (value !== undefined) {
			try {
				content = JSON.stringify(value, null, 2);
			} catch {
				content = String(value);
			}
		}
	}

	if (!content) {
		content = "(no tool output)";
	}

	const truncated = content.length > maxLength;
	return {
		content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
		truncated,
	};
}

function formatToolPreview(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const filePath = (value as { path?: unknown }).path;
		if (typeof filePath === "string") return filePath;
	}
	try {
		const preview = JSON.stringify(value);
		if (!preview || preview === "{}") return "";
		return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
	} catch {
		return "";
	}
}

function ensureToolCallEntry(
	state: TranscriptState,
	turnId: number,
	toolCallId: string,
	toolName: string,
	args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
	const existing = state.toolCalls.get(toolCallId);
	if (existing) {
		return existing;
	}

	const callEntry = appendTranscriptEntry(state, { type: "tool-call", turnId, toolCallId, toolName, args });
	const record = { turnId, callEntryId: callEntry.id };
	state.toolCalls.set(toolCallId, record);
	return record;
}

function upsertToolResultEntry(
	state: TranscriptState,
	turnId: number,
	toolCallId: string,
	toolName: string,
	content: string,
	truncated: boolean,
	isError: boolean,
	streaming: boolean,
): void {
	const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
	const existing =
		toolCall.resultEntryId !== undefined
			? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
			: undefined;

	if (existing && existing.type === "tool-result") {
		existing.content = content;
		existing.truncated = truncated;
		existing.isError = isError;
		existing.streaming = streaming;
		return;
	}

	const resultEntry = appendTranscriptEntry(state, {
		type: "tool-result",
		turnId,
		toolCallId,
		toolName,
		content,
		truncated,
		isError,
		streaming,
	});
	toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
	state: TranscriptState,
	turnId: number,
	message: AssistantMessage,
	streaming: boolean,
): void {
	const thinking = extractThinking(message);
	const answer = extractMessageText(message);

	if (thinking) {
		upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
	}
	if (answer) {
		upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
	}
}

function applyTranscriptEvent(state: TranscriptState, event: AgentSessionEvent): void {
	switch (event.type) {
		case "turn_start": {
			ensureTranscriptTurn(state);
			return;
		}
		case "message_start":
		case "message_end": {
			if (event.message.role === "user") {
				const turnId = ensureTranscriptTurn(state);
				upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
				return;
			}
			if (event.message.role === "assistant") {
				const turnId = ensureTranscriptTurn(state);
				applyAssistantMessageToTranscript(state, turnId, event.message, event.type === "message_start");
			}
			return;
		}
		case "message_update": {
			if (event.message.role !== "assistant") return;
			const turnId = ensureTranscriptTurn(state);
			applyAssistantMessageToTranscript(state, turnId, event.message, true);
			return;
		}
		case "tool_execution_start": {
			const turnId = ensureTranscriptTurn(state);
			ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
			return;
		}
		case "tool_execution_update": {
			const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
			const result = summarizeToolResult(event.partialResult);
			upsertToolResultEntry(state, turnId, event.toolCallId, event.toolName, result.content, result.truncated, false, true);
			return;
		}
		case "tool_execution_end": {
			const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
			const result = summarizeToolResult(event.result);
			upsertToolResultEntry(
				state,
				turnId,
				event.toolCallId,
				event.toolName,
				result.content,
				result.truncated,
				event.isError,
				false,
			);
			return;
		}
		case "turn_end": {
			finishTranscriptTurn(state);
			return;
		}
		default:
			return;
	}
}

function appendPersistedTranscriptTurn(state: TranscriptState, details: SideDetails): void {
	const turnId = ensureTranscriptTurn(state);
	upsertUserMessageEntry(state, turnId, details.question);
	if (details.thinking) {
		upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
	}
	upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
	finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: TranscriptState, message: string): void {
	const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
	upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
	finishTranscriptTurn(state, turnId);
}

function hasStreamingTranscriptEntry(entries: TranscriptEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") && entry.streaming,
	);
}

function getCompletedExchangeCount(entries: TranscriptEntry[]): number {
	return entries.filter((entry) => entry.type === "assistant-text" && !entry.streaming).length;
}

function buildTranscriptBadge(
	theme: ExtensionContext["ui"]["theme"],
	label: string,
	background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
	foreground: "accent" | "warning" | "success",
): string {
	return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

function buildOverlayTranscript(entries: TranscriptEntry[], theme: ExtensionContext["ui"]["theme"]): string[] {
	if (entries.length === 0) {
		return [theme.fg("dim", "No side thread yet. Ask a side question to start one.")];
	}

	const lines: string[] = [];
	const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
	const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
	const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
	const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
	const separator = theme.fg("borderMuted", "────────────────────────────────────────");
	const blockIndent = "    ";

	const pushBlankLine = () => {
		if (lines.length > 0 && lines[lines.length - 1] !== "") {
			lines.push("");
		}
	};

	const pushInlineBlock = (header: string, text: string, options: { blankBefore?: boolean; style?: (value: string) => string } = {}) => {
		const bodyLines = text.split("\n");
		const style = options.style ?? ((value: string) => value);
		if (options.blankBefore !== false) pushBlankLine();
		const firstLine = bodyLines.shift() ?? "";
		lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
		for (const line of bodyLines) {
			lines.push(`${blockIndent}${style(line)}`);
		}
	};

	const pushStackedBlock = (
		header: string,
		text: string,
		options: { blankBefore?: boolean; indent?: string; style?: (value: string) => string } = {},
	) => {
		const bodyLines = text.split("\n");
		const indent = options.indent ?? blockIndent;
		const style = options.style ?? ((value: string) => value);
		if (options.blankBefore !== false) pushBlankLine();
		lines.push(header);
		for (const line of bodyLines) {
			lines.push(`${indent}${style(line)}`);
		}
	};

	for (const entry of entries) {
		if (entry.type === "turn-boundary") {
			if (entry.phase === "start" && lines.length > 0) {
				pushBlankLine();
				lines.push(separator);
			}
			continue;
		}

		if (entry.type === "user-message") {
			pushInlineBlock(userBadge, entry.text, { blankBefore: false });
			continue;
		}

		if (entry.type === "thinking") {
			const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
			pushStackedBlock(thinkingHeader, entry.text, { style: (line) => theme.fg("warning", theme.italic(line)) });
			continue;
		}

		if (entry.type === "tool-call") {
			const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
			const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
			pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
			continue;
		}

		if (entry.type === "tool-result") {
			const resultHeaderLabel = entry.isError
				? theme.fg("error", "↳ error")
				: entry.streaming
					? theme.fg("warning", "↳ streaming result")
					: theme.fg("dim", "↳ result");
			const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
			pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
				blankBefore: false,
				indent: blockIndent,
				style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
			});
			continue;
		}

		if (entry.type === "assistant-text") {
			const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
			pushStackedBlock(assistantHeader, entry.text);
		}
	}

	return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return null;
}

function notify(ctx: SideContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		}
	} catch {
		// The UI context can become stale during session replacement/shutdown.
	}
}

class SideOverlayComponent extends Container implements Focusable {
	private readonly input: Input;
	private readonly readTranscriptEntries: () => TranscriptEntry[];
	private readonly getStatus: () => string | null;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onBackCallback: () => void;
	private readonly tui: TUI;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private transcriptLines: string[] = [];
	private transcriptScrollOffset = 0;
	private transcriptViewportHeight = 8;
	private followTranscript = true;
	private _focused = false;
	private summaryTextValue = "";
	private statusTextValue = "";
	private hintsTextValue = "";

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		readTranscriptEntries: () => TranscriptEntry[],
		getStatus: () => string | null,
		onSubmit: (value: string) => void,
		onBack: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.readTranscriptEntries = readTranscriptEntries;
		this.getStatus = getStatus;
		this.onSubmitCallback = onSubmit;
		this.onBackCallback = onBack;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			this.followTranscript = true;
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onBackCallback();
		};

		const originalHandleInput = this.input.handleInput.bind(this.input);
		this.input.handleInput = (data: string) => {
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.onBackCallback();
				return;
			}
			originalHandleInput(data);
		};

		this.refresh();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private wrapTranscript(innerWidth: number): string[] {
		const wrapped: string[] = [];
		for (const line of this.transcriptLines) {
			if (!line) {
				wrapped.push("");
				continue;
			}
			wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
		}
		return wrapped;
	}

	private getDialogHeight(): number {
		const terminalRows = process.stdout.rows ?? 30;
		return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
	}

	handleInput(data: string): void {
		if (matchesSideFocusShortcut(data)) {
			this.onBackCallback();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.followTranscript = false;
			this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset - Math.max(1, this.transcriptViewportHeight - 1));
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.transcriptScrollOffset += Math.max(1, this.transcriptViewportHeight - 1);
			this.tui.requestRender();
			return;
		}

		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private inputFrameLine(dialogWidth: number): string {
		const targetWidth = Math.max(1, dialogWidth - 2);
		const inputLine = this.input.render(targetWidth)[0] ?? "";
		return `${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`;
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const transcriptLines = this.wrapTranscript(innerWidth);
		const dialogHeight = this.getDialogHeight();
		const chromeHeight = 8;
		const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
		this.transcriptViewportHeight = transcriptHeight;

		const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
		if (this.followTranscript) {
			this.transcriptScrollOffset = maxScroll;
		} else {
			this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
			if (this.transcriptScrollOffset >= maxScroll) {
				this.followTranscript = true;
			}
		}

		const visibleTranscript = transcriptLines.slice(this.transcriptScrollOffset, this.transcriptScrollOffset + transcriptHeight);
		const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
		const hiddenAbove = this.transcriptScrollOffset;
		const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
		const summary = hiddenAbove || hiddenBelow ? `${this.summaryTextValue} · ↑${hiddenAbove} ↓${hiddenBelow}` : this.summaryTextValue;

		const lines = [this.borderLine(innerWidth, "top")];
		lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold("Side conversation · hidden thread preserved")), innerWidth));
		lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
		lines.push(this.ruleLine(innerWidth));

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < transcriptPadCount; i++) {
			lines.push(this.frameLine("", innerWidth));
		}

		lines.push(this.ruleLine(innerWidth));
		lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue), innerWidth));
		lines.push(this.inputFrameLine(dialogWidth));
		lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	override invalidate(): void {
		super.invalidate();
		this.refresh();
	}

	refresh(): void {
		const entries = this.readTranscriptEntries();
		const exchanges = getCompletedExchangeCount(entries);
		const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
		this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
		this.transcriptLines = buildOverlayTranscript(entries, this.theme);
		this.statusTextValue = this.getStatus() ?? "Ready. Enter submits; /side-back or Esc returns to main.";
		this.hintsTextValue = "Enter submit · Alt+/ or Ctrl+Shift+S return · /side-back return · PgUp/PgDn scroll";
		this.tui.requestRender();
	}
}

export default function sideConversationExtension(pi: ExtensionAPI): void {
	let pendingThread: SideDetails[] = [];
	let transcriptState = createEmptyTranscriptState();
	let overlayStatus: string | null = null;
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let lastUiContext: SideContext | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let sidePromptQueue: Promise<void> = Promise.resolve();
	let pendingSidePromptCount = 0;
	let sideGeneration = 0;

	function syncUi(ctx?: SideContext): void {
		const activeCtx = ctx ?? lastUiContext;
		try {
			if (!activeCtx?.hasUI) return;
			if (pendingThread.length > 0 || activeSideSession || pendingSidePromptCount > 0) {
				const state = activeSideSession?.session.isStreaming ? " · streaming" : pendingSidePromptCount > 0 ? " · queued" : "";
				activeCtx.ui.setStatus("side", activeCtx.ui.theme.fg("accent", `⟡ side${state}`));
			} else {
				activeCtx.ui.setStatus("side", undefined);
			}
			overlayRuntime?.refresh?.();
		} catch {
			// Ignore stale UI contexts after session replacement/shutdown.
		}
	}

	function setOverlayStatus(status: string | null, ctx?: SideContext): void {
		overlayStatus = status;
		syncUi(ctx);
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.setDraft?.(value);
	}

	function hideOverlay(): void {
		const runtime = overlayRuntime;
		if (!runtime?.handle) return;
		overlayDraft = runtime.getDraft?.() ?? overlayDraft;
		runtime.handle.setHidden(true);
		runtime.handle.unfocus();
	}

	function focusOverlay(): void {
		const handle = overlayRuntime?.handle;
		if (!handle) return;
		handle.setHidden(false);
		handle.focus();
		overlayRuntime?.refresh?.();
	}

	async function toggleOverlayFocus(ctx: SideContext): Promise<void> {
		const handle = overlayRuntime?.handle;
		if (!handle) {
			await ensureSideSession(ctx);
			await ensureOverlay(ctx);
			return;
		}
		handle.setHidden(false);
		if (handle.isFocused()) {
			handle.unfocus();
		} else {
			handle.focus();
		}
		overlayRuntime?.refresh?.();
	}

	function closeOverlay(): void {
		overlayRuntime?.close?.();
		overlayRuntime = null;
	}

	function clearSideSessionSubscriptions(sessionRuntime: SideSessionRuntime): void {
		for (const unsubscribe of [...sessionRuntime.subscriptions]) {
			sessionRuntime.subscriptions.delete(unsubscribe);
			try {
				unsubscribe();
			} catch {
				// Ignore unsubscribe errors during side session replacement/shutdown.
			}
		}
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) return;

		clearSideSessionSubscriptions(current);
		try {
			await current.session.abort();
		} catch {
			// Ignore abort errors during side session replacement/shutdown.
		}
		current.session.dispose();
	}

	function handleSideSessionEvent(
		sessionRuntime: SideSessionRuntime,
		event: AgentSessionEvent,
		ctx?: SideContext,
	): void {
		if (activeSideSession?.session !== sessionRuntime.session) return;

		applyTranscriptEvent(transcriptState, event);

		if (event.type === "tool_execution_start") {
			setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
			return;
		}
		if (event.type === "tool_execution_end") {
			setOverlayStatus(sessionRuntime.session.isStreaming ? "⏳ streaming..." : "Finalizing...", ctx);
			return;
		}
		if (event.type === "turn_end") {
			setOverlayStatus("Finalizing...", ctx);
			return;
		}
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end" || event.type === "turn_start") {
			syncUi(ctx);
		}
	}

	function subscribeToSideSession(sessionRuntime: SideSessionRuntime, ctx?: SideContext): void {
		if (sessionRuntime.subscriptions.size > 0) return;
		const unsubscribe = sessionRuntime.session.subscribe((event) => {
			handleSideSessionEvent(sessionRuntime, event, ctx);
		});
		sessionRuntime.subscriptions.add(unsubscribe);
	}

	async function createSideSession(ctx: SideContext): Promise<SideSessionRuntime> {
		if (!ctx.model) {
			throw new Error("No active model selected.");
		}

		const thinkingLevel = pi.getThinkingLevel() as SideThinkingLevel;
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			thinkingLevel,
			tools: ["read", "bash", "edit", "write"],
			resourceLoader: createSideResourceLoader(ctx),
		});

		const seedMessages = buildSideSeedState(ctx, pendingThread, ctx.model);
		if (seedMessages.length > 0) {
			session.agent.state.messages = seedMessages as typeof session.state.messages;
		}

		return { session, subscriptions: new Set() };
	}

	async function ensureSideSession(ctx: SideContext): Promise<SideSessionRuntime | null> {
		if (activeSideSession) {
			subscribeToSideSession(activeSideSession, ctx);
			return activeSideSession;
		}

		if (!ctx.model) {
			setOverlayStatus("No active model selected.", ctx);
			notify(ctx, "No active model selected.", "error");
			return null;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok === false) {
			const message = auth.error;
			setOverlayStatus(message, ctx);
			notify(ctx, message, "error");
			return null;
		}
		if (!auth.apiKey) {
			const message = `No credentials available for ${ctx.model.provider}/${ctx.model.id}.`;
			setOverlayStatus(message, ctx);
			notify(ctx, message, "error");
			return null;
		}

		activeSideSession = await createSideSession(ctx);
		subscribeToSideSession(activeSideSession, ctx);
		syncUi(ctx);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: SideContext): Promise<void> {
		if (!ctx.hasUI) return;
		lastUiContext = ctx;

		if (overlayRuntime) {
			if (overlayRuntime.handle) {
				focusOverlay();
			}
			return;
		}

		const runtime: OverlayRuntime = {};
		const closeRuntime = () => {
			if (runtime.closed) return;
			runtime.closed = true;
			try {
				runtime.handle?.hide();
			} catch {
				// The TUI may already be torn down during session replacement/shutdown.
			}
			if (overlayRuntime === runtime) {
				overlayRuntime = null;
			}
			runtime.finish?.();
		};

		runtime.close = closeRuntime;
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new SideOverlayComponent(
						tui,
						theme,
						keybindings,
						() => transcriptState.entries,
						() => overlayStatus,
						(value) => {
							void submitFromOverlay(ctx, value);
						},
						() => {
							hideOverlay();
						},
					);

					overlay.focused = runtime.handle?.isFocused() ?? true;
					overlay.setDraft(overlayDraft);
					runtime.setDraft = (value) => overlay.setDraft(value);
					runtime.getDraft = () => overlay.getDraft();
					runtime.refresh = () => {
						overlay.focused = runtime.handle?.isFocused() ?? false;
						overlay.refresh();
					};
					runtime.close = () => {
						overlayDraft = overlay.getDraft();
						closeRuntime();
					};

					if (runtime.closed) done();
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "78%",
						minWidth: 72,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
						nonCapturing: true,
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) closeRuntime();
					},
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) overlayRuntime = null;
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			});
	}

	function sideBack(ctx: SideContext): void {
		if (overlayRuntime?.handle) {
			hideOverlay();
			notify(ctx, "Side conversation hidden. Use /side to reopen it.", "info");
			return;
		}
		notify(ctx, pendingThread.length > 0 || activeSideSession ? "Side conversation is already hidden." : "No side conversation active.", "info");
	}

	async function submitFromOverlay(ctx: SideContext, value: string): Promise<void> {
		const question = value.trim();
		if (!question) {
			setOverlayStatus("Enter a side prompt before submitting.", ctx);
			return;
		}

		if (question === "/side-back") {
			setOverlayDraft("");
			sideBack(ctx);
			return;
		}

		if (question === "/side:clear") {
			setOverlayDraft("");
			await resetThread(ctx);
			setOverlayStatus("Cleared side thread.", ctx);
			notify(ctx, "Cleared side thread.", "info");
			return;
		}

		if (question === "/side:new" || question.startsWith("/side:new ")) {
			setOverlayDraft("");
			await resetThread(ctx);
			const nestedQuestion = question === "/side:new" ? "" : question.slice(10).trim();
			if (!nestedQuestion) {
				const sessionRuntime = await ensureSideSession(ctx);
				await ensureOverlay(ctx);
				if (sessionRuntime) {
					setOverlayStatus("Started a fresh side thread.", ctx);
				}
				return;
			}
			enqueueSidePrompt(ctx, nestedQuestion);
			return;
		}

		if (question === "/side" || question.startsWith("/side ")) {
			setOverlayDraft("");
			const nestedQuestion = question === "/side" ? "" : question.slice(6).trim();
			if (!nestedQuestion) {
				await ensureOverlay(ctx);
				return;
			}
			enqueueSidePrompt(ctx, nestedQuestion);
			return;
		}

		setOverlayDraft("");
		enqueueSidePrompt(ctx, question);
	}

	function enqueueSidePrompt(ctx: SideContext, question: string): void {
		const wasQueued =
			pendingSidePromptCount > 0 || activeSideSession?.session.isStreaming || hasStreamingTranscriptEntry(transcriptState.entries);
		pendingSidePromptCount++;
		if (wasQueued) {
			setOverlayStatus("Queued side prompt. It will run after the current side turn.", ctx);
		} else {
			setOverlayStatus("⏳ streaming...", ctx);
		}
		syncUi(ctx);

		const generation = sideGeneration;
		const run = sidePromptQueue.then(async () => {
			try {
				if (generation === sideGeneration) {
					await runSidePrompt(ctx, question, generation);
				}
			} finally {
				if (generation === sideGeneration) {
					pendingSidePromptCount = Math.max(0, pendingSidePromptCount - 1);
				}
			}
		});
		sidePromptQueue = run.catch(() => {});
		void run;
	}

	async function runSidePrompt(ctx: SideContext, question: string, generation: number): Promise<void> {
		if (generation !== sideGeneration) return;
		lastUiContext = ctx;
		const sessionRuntime = await ensureSideSession(ctx);
		if (!sessionRuntime) {
			await ensureOverlay(ctx);
			return;
		}

		const session = sessionRuntime.session;
		const model = session.model ?? ctx.model;
		if (!model) {
			setOverlayStatus("No active model selected.", ctx);
			notify(ctx, "No active model selected.", "error");
			return;
		}

		const thinkingLevel = pi.getThinkingLevel() as SideThinkingLevel;
		setOverlayStatus("⏳ streaming...", ctx);
		if (generation !== sideGeneration) return;
		await ensureOverlay(ctx);
		if (generation !== sideGeneration) return;

		try {
			await session.prompt(question, { source: "extension" });
			if (generation !== sideGeneration) return;

			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error("Side request finished without a response.");
			}
			if (response.stopReason === "aborted") {
				setOverlayStatus("Request aborted.", ctx);
				return;
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Side request failed.");
			}

			const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
			const streamedThinking =
				completedTurnId !== null ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text : "";
			const answer = extractAnswer(response);
			const thinking = extractThinking(response) || streamedThinking || "";

			const details: SideDetails = {
				question,
				thinking,
				answer,
				provider: model.provider,
				model: model.id,
				api: model.api,
				thinkingLevel,
				timestamp: Date.now(),
				usage: response.usage,
			};

			pendingThread.push(details);
			pi.appendEntry(SIDE_THREAD_ENTRY_TYPE, details);
			setOverlayStatus("Ready for a follow-up. Hidden side thread updated.", ctx);
		} catch (error) {
			if (generation !== sideGeneration) return;
			const errorMessage = error instanceof Error ? error.message : String(error);
			setTranscriptFailure(transcriptState, errorMessage);
			setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
			notify(ctx, errorMessage, "error");
			await disposeSideSession();
		} finally {
			if (generation === sideGeneration) {
				syncUi(ctx);
			}
		}
	}

	async function resetThread(ctx: SideContext, persist = true): Promise<void> {
		sideGeneration++;
		pendingSidePromptCount = 0;
		await disposeSideSession();
		pendingThread = [];
		transcriptState = createEmptyTranscriptState();
		setOverlayDraft("");
		setOverlayStatus(null, ctx);
		if (persist) {
			const details: SideResetDetails = { timestamp: Date.now() };
			pi.appendEntry(SIDE_THREAD_RESET_TYPE, details);
		}
		syncUi(ctx);
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		sideGeneration++;
		pendingSidePromptCount = 0;
		await disposeSideSession();
		pendingThread = [];
		transcriptState = createEmptyTranscriptState();
		overlayDraft = "";
		lastUiContext = ctx;
		overlayStatus = null;

		const branch = ctx.sessionManager.getBranch();
		let lastResetIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			if (isCustomEntry(branch[i], SIDE_THREAD_RESET_TYPE)) {
				lastResetIndex = i;
			}
		}

		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (!isCustomEntry(entry, SIDE_THREAD_ENTRY_TYPE)) continue;
			const details = entry.data as SideDetails | undefined;
			if (!details?.question || !details.answer) continue;
			const normalizedDetails: SideDetails = {
				...details,
				api: details.api || ctx.model?.api || "openai-responses",
			};
			pendingThread.push(normalizedDetails);
			appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
		}

		syncUi(ctx);
	}

	pi.registerCommand("side", {
		description: "Open or continue a side conversation (usage: /side [question])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const question = args.trim();
			if (!question) {
				await ensureSideSession(ctx);
				await ensureOverlay(ctx);
				return;
			}
			enqueueSidePrompt(ctx, question);
		},
	});

	pi.registerCommand("side:new", {
		description: "Start a fresh side conversation (usage: /side:new [question])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			await resetThread(ctx);
			const question = args.trim();
			if (!question) {
				const sessionRuntime = await ensureSideSession(ctx);
				await ensureOverlay(ctx);
				if (sessionRuntime) {
					setOverlayStatus("Started a fresh side thread.", ctx);
				}
				return;
			}
			enqueueSidePrompt(ctx, question);
		},
	});

	pi.registerCommand("side:clear", {
		description: "Clear the current side conversation thread",
		handler: async (_args, ctx) => {
			await resetThread(ctx);
			closeOverlay();
			notify(ctx, "Cleared side thread.", "info");
		},
	});

	pi.registerCommand("side-back", {
		description: "Hide or defocus the current side conversation",
		handler: async (_args, ctx) => {
			sideBack(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Toggle side conversation focus",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await toggleOverlayFocus(ctx);
		},
	});

	pi.registerShortcut(Key.alt("/"), {
		description: "Toggle side conversation focus",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await toggleOverlayFocus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_shutdown", async () => {
		sideGeneration++;
		await disposeSideSession();
		closeOverlay();
	});
}
