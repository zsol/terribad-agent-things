/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bjj\s+(new|commit|squash|edit|abandon|restore|rebase|split|describe|undo|fix|parallelize|simplify-parents)/i,
	/\bjj\s+(bookmark|branch)\s+(set|create|delete|forget|rename|track|untrack)/i,
	/\bjj\s+git\s+(push|fetch|clone|init|import|export)/i,
	/\bjj\s+workspace\s+(add|forget)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\b-delete\b/, // find -delete
];

// Destructive command names (for -exec and xargs checking)
// Note: jj is not included here since it has both safe and unsafe subcommands,
// and the main regex patterns handle the subcommand filtering
const DESTRUCTIVE_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
	"ln", "tee", "truncate", "dd", "shred", "vim", "vi", "nano", "emacs",
	"code", "subl", "sudo", "su", "kill", "pkill", "killall", "reboot", "shutdown",
]);

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*jj\s+(status|st|log|diff|show|cat|file\s+list|files|op\s+log|config\s+(list|get)|evolog|obslog|interdiff|prev|next|root)/i,
	/^\s*jj\s+(bookmark|branch)\s+list/i,
	/^\s*jj\s+workspace\s+list/i,
	/^\s*jj\s+git\s+remote\s+list/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
	/^\s*xargs\b/,
];

// Extract command names from -exec blocks: find ... -exec cmd args \;
function getExecCommands(command: string): string[] {
	const results: string[] = [];
	// Match -exec followed by a command (first non-flag word)
	const regex = /-exec\s+(\S+)/g;
	for (const match of command.matchAll(regex)) {
		// Extract just the command name (basename)
		const cmd = match[1].replace(/.*\//, "");
		results.push(cmd);
	}
	return results;
}

// Extract command from xargs: ... | xargs [-options] cmd
function getXargsCommand(command: string): string | null {
	// Match xargs followed by optional flags (-0, -I {}, -n 1, etc.) then command
	const match = command.match(/\bxargs\s+(?:-[\w]+(?:\s+\S+)?\s+)*(\S+)/);
	if (match && match[1] && !match[1].startsWith("-")) {
		// Extract just the command name (basename)
		return match[1].replace(/.*\//, "");
	}
	return null;
}

export function isSafeCommand(command: string): boolean {
	// Split on && and ; to check each part of chained commands
	const parts = command.split(/\s*(?:&&|;)\s*/);
	return parts.every((part) => {
		const trimmed = part.trim();
		if (!trimmed) return true; // Empty parts are fine
		const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed));
		const isSafe = SAFE_PATTERNS.some((p) => p.test(trimmed));
		if (isDestructive || !isSafe) return false;

		// Check commands inside -exec blocks
		for (const cmd of getExecCommands(trimmed)) {
			if (DESTRUCTIVE_COMMANDS.has(cmd.toLowerCase())) return false;
		}

		// Check command passed to xargs
		const xargsCmd = getXargsCommand(trimmed);
		if (xargsCmd && DESTRUCTIVE_COMMANDS.has(xargsCmd.toLowerCase())) return false;

		return true;
	});
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}/g, "") // Remove all markdown bold/italic markers
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
