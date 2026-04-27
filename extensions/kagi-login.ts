/**
 * Kagi Login Extension
 *
 * Provides a `kagi_login` tool and `/kagi-login` command that authenticate the
 * browser session with Kagi using the private session URL stored in 1Password,
 * without ever exposing the secret token in any LLM-visible output.
 *
 * The URL is fetched from 1Password and written to a short-lived private local
 * redirect page. agent-browser opens that file URL so the secret URL is not
 * exposed through tool arguments or the LLM context.
 *
 * Usage:
 * - LLM: call the `kagi_login` tool before performing searches
 * - Human: run `/kagi-login` to log in manually
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OP_ITEM_DEFAULT = "kagi private url";
const REDIRECT_FILE_MODE = 0o600;

interface KagiConfig {
	opAccount?: string;
	opItem?: string;
}

function redactSecrets(text: string, secrets: string[] = []): string {
	let redacted = text;
	for (const secret of secrets) {
		if (!secret) continue;
		redacted = redacted.split(secret).join("[REDACTED]");
	}
	return redacted.replace(/https:\/\/[^\s"'<>]*\bkagi\.com\b[^\s"'<>]*/gi, "[REDACTED_KAGI_URL]");
}

function validateKagiUrl(rawUrl: string): string | { error: string } {
	try {
		const url = new URL(rawUrl);
		const hostname = url.hostname.toLowerCase();
		if (url.protocol !== "https:" || (hostname !== "kagi.com" && !hostname.endsWith(".kagi.com"))) {
			return { error: "1Password item did not contain an HTTPS Kagi URL." };
		}
		return url.toString();
	} catch {
		return { error: "1Password item did not contain a valid Kagi URL." };
	}
}

function parseJson(text: string): any | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function createPrivateRedirectPage(privateUrl: string): Promise<{ dir: string; fileUrl: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-kagi-login-"));
	const filePath = join(dir, "login.html");
	const redirectTarget = JSON.stringify(privateUrl).replace(/<\//g, "<\\/");
	const html = [
		"<!doctype html>",
		'<meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		"<title>Kagi login redirect</title>",
		`<script>location.replace(${redirectTarget});</script>`,
		"Redirecting to Kagi...",
	].join("\n");
	await writeFile(filePath, html, { encoding: "utf8", mode: REDIRECT_FILE_MODE });
	return { dir, fileUrl: pathToFileURL(filePath).toString() };
}

async function waitForRedirectToLeaveFileUrl(
	pi: ExtensionAPI,
	redirectFileUrl: string,
	signal?: AbortSignal,
): Promise<boolean> {
	for (let attempt = 0; attempt < 10; attempt++) {
		await pi.exec("agent-browser", ["wait", "500"], { signal, timeout: 2000 }).catch(() => undefined);
		const result = await pi.exec("agent-browser", ["--json", "get", "url"], { signal, timeout: 5000 }).catch(() => null);
		if (!result || result.code !== 0) continue;
		const parsed = parseJson(result.stdout);
		const currentUrl = typeof parsed?.data?.url === "string" ? parsed.data.url : undefined;
		if (currentUrl && currentUrl !== redirectFileUrl && !currentUrl.startsWith("file:")) return true;
	}
	return false;
}

export default function kagiLoginExtension(pi: ExtensionAPI) {
	let opAccount: string | undefined;
	let opItem: string = OP_ITEM_DEFAULT;

	function persistConfig(): void {
		pi.appendEntry<KagiConfig>("kagi-config", { opAccount, opItem });
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		opAccount = undefined;
		opItem = OP_ITEM_DEFAULT;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "kagi-config") {
				const data = entry.data as KagiConfig | undefined;
				if (data) {
					opAccount = data.opAccount;
					opItem = data.opItem ?? OP_ITEM_DEFAULT;
				}
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => { restoreFromBranch(ctx); });
	pi.on("session_tree", async (_event, ctx) => { restoreFromBranch(ctx); });

	async function login(signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
		// Fetch the secret URL from 1Password.
		// opAccount and opItem can be configured via /kagi-setup.
		const opArgs = ["item", "get", opItem, "--fields", "url"];
		if (opAccount) {
			opArgs.splice(2, 0, "--account", opAccount);
		}

		const opResult = await pi.exec("op", opArgs, { signal });

		if (opResult.code !== 0) {
			return {
				success: false,
				error: `Failed to retrieve Kagi session URL from 1Password: ${opResult.stderr.trim()}`,
			};
		}

		const privateUrlResult = validateKagiUrl(opResult.stdout.trim());
		if (typeof privateUrlResult !== "string") {
			return { success: false, error: privateUrlResult.error };
		}
		const privateUrl = privateUrlResult;

		// Navigate using the same agent-browser CLI that the browser tool uses.
		// Open a short-lived local redirect file so the private URL never appears
		// in process argv, command renderers, or LLM-visible output.
		let redirectDir: string | undefined;
		try {
			const redirect = await createPrivateRedirectPage(privateUrl);
			redirectDir = redirect.dir;
			const browserResult = await pi.exec("agent-browser", ["open", redirect.fileUrl], { signal });

			if (browserResult.code !== 0) {
				const errorText = redactSecrets(browserResult.stderr.trim() || browserResult.stdout.trim(), [privateUrl]);
				return {
					success: false,
					error: `agent-browser failed to open the login redirect: ${errorText}`,
				};
			}

			if (!(await waitForRedirectToLeaveFileUrl(pi, redirect.fileUrl, signal))) {
				return {
					success: false,
					error: "agent-browser did not complete the Kagi login redirect.",
				};
			}
		} finally {
			if (redirectDir) {
				await rm(redirectDir, { recursive: true, force: true }).catch(() => undefined);
			}
		}

		return { success: true };
	}

	// Tool the LLM can call
	pi.registerTool({
		name: "kagi_login",
		label: "Kagi Login",
		promptSnippet: "Log in to Kagi search using the private session URL stored in 1Password. Call this once before performing any Kagi searches.",
		description:
			"Log in to Kagi search using the private session URL stored in 1Password. " +
			"Call this once before performing any Kagi searches. " +
			"The secret token is never exposed — it is fetched from 1Password and passed directly to the browser. " +
			"Use /kagi-setup to configure the 1Password account and item.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
			const result = await login(signal);

			if (!result.success) {
				return {
					content: [{ type: "text", text: result.error! }],
					details: { loggedIn: false, error: result.error },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Logged in to Kagi successfully. You can now search at https://kagi.com/search?q=your+query",
					},
				],
				details: { loggedIn: true },
			};
		},
	});

	// Command for manual use
	pi.registerCommand("kagi-login", {
		description: "Log in to Kagi using the private session URL from 1Password",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Logging in to Kagi...", "info");
			const result = await login();

			if (!result.success) {
				ctx.ui.notify(result.error!, "error");
			} else {
				ctx.ui.notify("Logged in to Kagi successfully.", "info");
			}
		},
	});

	// Command to configure 1Password account and item
	pi.registerCommand("kagi-setup", {
		description: "Configure the 1Password account and item used for Kagi login",
		handler: async (_args, ctx) => {
			// Try to enumerate available 1Password accounts
			interface OpAccount { url: string; email: string; }
			const DEFAULT_OPTION = "(default signed-in account)";
			let accountValue: string | undefined;

			const opResult = await pi.exec("op", ["account", "list", "--format", "json"]);
			if (opResult.code === 0) {
				let accounts: OpAccount[] = [];
				try { accounts = JSON.parse(opResult.stdout); } catch { /* fall through */ }

				if (accounts.length > 0) {
					const options = [
						DEFAULT_OPTION,
						...accounts.map((a) => `${a.email} (${a.url})`),
					];
					const selected = await ctx.ui.select("1Password account:", options);
					if (selected === undefined) return; // cancelled
					if (selected === DEFAULT_OPTION) {
						accountValue = "";
					} else {
						// Extract the url from "email (url)"
						const match = selected.match(/\(([^)]+)\)$/);
						accountValue = match ? match[1] : selected;
					}
				}
			}

			// Fall back to free-text input if op failed or returned no accounts
			if (accountValue === undefined) {
				accountValue = await ctx.ui.input(
					"1Password account (leave blank to use default signed-in account):",
					opAccount ?? "",
				);
				if (accountValue === undefined) return; // cancelled
			}

			const itemValue = await ctx.ui.input("1Password item name:", opItem);
			if (itemValue === undefined) return; // cancelled

			opAccount = accountValue.trim() || undefined;
			opItem = itemValue.trim() || OP_ITEM_DEFAULT;
			persistConfig();

			const accountMsg = opAccount ? `account: ${opAccount}` : "account: (default)";
			ctx.ui.notify(`Kagi config saved — ${accountMsg}, item: ${opItem}`, "info");
		},
	});
}
