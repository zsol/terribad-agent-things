/**
 * Ask User Extension
 *
 * Provides a tool the model can call to ask the user questions directly.
 * Supports free-form input, multi-line text, multiple choice, and yes/no confirmation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

const AskUserParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  type: Type.Optional(
    StringEnum(["input", "confirm", "select", "multiline"] as const, {
      description: "Type of response: 'input' for free text (default), 'confirm' for yes/no, 'select' for multiple choice, 'multiline' for multi-line text editor",
    })
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Options for 'select' type questions",
    })
  ),
  default: Type.Optional(
    Type.String({ description: "Default value or placeholder for 'input' type, or prefill for 'multiline' type" })
  ),
});

type AskUserInput = Static<typeof AskUserParams>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: `Ask the user a question and wait for their response.

IMPORTANT: When there are multiple viable approaches and the user hasn't specified which to use, ASK rather than assuming. Don't make arbitrary decisions on their behalf.

IMPORTANT: When you want to present options or ask for a decision, ALWAYS use this tool (with type="select") instead of listing choices in your text response. You can write explanatory text first, then call this tool in the same turn. 

Use this tool when:
- Multiple valid approaches exist and the choice affects the outcome significantly
- Requirements are ambiguous and you need clarification
- You need confirmation before destructive or irreversible actions
- You need information only the user can provide (credentials, preferences, project-specific conventions)

Do NOT use this tool when:
- The user has already indicated a preference
- One approach is clearly superior or standard practice
- The decision is trivial or easily reversible

Types:
- "input" (default): Free-form text response
- "confirm": Yes/no question  
- "select": Choose from provided options (preferred when you can enumerate the choices)
- "multiline": Multi-line text editor (for code, longer text, or structured input)`,
    parameters: AskUserParams,

    async execute(toolCallId, params: AskUserInput, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: ask_user requires interactive mode" }],
          details: { error: true },
        };
      }

      const { question, type = "input", options, default: defaultValue } = params;

      let answer: string | boolean | undefined;

      switch (type) {
        case "confirm":
          answer = await ctx.ui.confirm("Question", question);
          break;

        case "select":
          if (!options || options.length === 0) {
            return {
              content: [{ type: "text", text: "Error: 'select' type requires options array" }],
              details: { error: true },
            };
          }
          answer = await ctx.ui.select(question, options);
          break;

        case "multiline":
          answer = await ctx.ui.editor(question, defaultValue);
          break;

        case "input":
        default:
          answer = await ctx.ui.input(question, defaultValue ?? "");
          break;
      }

      // Handle cancellation
      if (answer === undefined || answer === null) {
        return {
          content: [{ type: "text", text: "User cancelled the prompt" }],
          details: { cancelled: true },
        };
      }

      // Format response
      const responseText = typeof answer === "boolean" 
        ? (answer ? "Yes" : "No")
        : answer;

      return {
        content: [{ type: "text", text: responseText }],
        details: { 
          question,
          type,
          answer: responseText,
        },
      };
    },

    renderCall(args: AskUserInput, theme) {
      const typeLabel = args.type === "confirm" ? "confirm" 
        : args.type === "select" ? "select" 
        : args.type === "multiline" ? "multiline"
        : "input";
      
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", `[${typeLabel}] `);
      text += theme.fg("dim", `"${args.question}"`);
      
      if (args.type === "select" && args.options) {
        text += theme.fg("muted", ` (${args.options.length} options)`);
      }
      
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { cancelled?: boolean; answer?: string; error?: boolean };
      
      if (details?.error) {
        return new Text(theme.fg("error", result.content?.[0]?.type === "text" ? result.content[0].text : "Error"), 0, 0);
      }
      
      if (details?.cancelled) {
        return new Text(theme.fg("warning", "User cancelled"), 0, 0);
      }

      const answer = details?.answer ?? "No response";
      return new Text(theme.fg("success", "→ ") + answer, 0, 0);
    },
  });
}
