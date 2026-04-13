/**
 * Kagi Login Extension
 *
 * Provides a `kagi_login` tool and `/kagi-login` command that authenticate the
 * browser session with Kagi using the private session URL stored in 1Password,
 * without ever exposing the secret token in any LLM-visible output.
 *
 * The URL is fetched from 1Password and passed directly to agent-browser via
 * pi.exec(), bypassing the browser tool (and therefore the LLM context) entirely.
 *
 * Usage:
 * - LLM: call the `kagi_login` tool before performing searches
 * - Human: run `/kagi-login` to log in manually
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const OP_ITEM_DEFAULT = "kagi private url";

interface KagiConfig {
	opAccount?: string;
	opItem?: string;
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

		const url = opResult.stdout.trim();

		// Navigate using the same agent-browser CLI that the browser tool uses.
		// The URL never appears in any LLM-visible output.
		const browserResult = await pi.exec("agent-browser", ["open", url], { signal });

		if (browserResult.code !== 0) {
			return {
				success: false,
				error: `agent-browser failed to open the login URL: ${browserResult.stderr.trim()}`,
			};
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
