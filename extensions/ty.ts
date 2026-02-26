/**
 * ty Type Checker Extension
 *
 * Provides tools for Python type checking and code navigation using Astral's ty.
 * 
 * Tools:
 * - ty_check: Run type checker on files/directories
 * - ty_goto: Go to definition of a symbol
 * - ty_references: Find all references to a symbol
 * - ty_hover: Get type info and docstrings for a symbol
 * 
 * Automatically detects uv-managed projects and runs ty via `uv run` to ensure
 * the correct virtualenv is used.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { resolve, relative } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  rule: string;
  message: string;
}

interface TyCheckResult {
  diagnostics: Diagnostic[];
  totalErrors: number;
  totalWarnings: number;
  exitCode: number;
}

interface Location {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  preview?: string;
}

interface HoverResult {
  type?: string;
  documentation?: string;
}

// LSP types
interface LSPPosition {
  line: number;
  character: number;
}

interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

interface LSPLocation {
  uri: string;
  range: LSPRange;
}

interface LSPHover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

// ============================================================================
// UV Detection
// ============================================================================

/**
 * Check if the project is managed by uv by walking up the directory tree
 * looking for uv.lock. Caches the result per cwd.
 */
const uvProjectCache = new Map<string, boolean>();

async function isUvProject(cwd: string): Promise<boolean> {
  if (uvProjectCache.has(cwd)) {
    return uvProjectCache.get(cwd)!;
  }

  let dir = resolve(cwd);
  const root = resolve("/");

  while (dir !== root) {
    try {
      await access(resolve(dir, "uv.lock"));
      uvProjectCache.set(cwd, true);
      return true;
    } catch {
      // Not found, try parent
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  uvProjectCache.set(cwd, false);
  return false;
}

/**
 * Get the command and args to run ty, using uv if in a uv-managed project.
 */
async function getTyCommand(cwd: string, tyArgs: string[]): Promise<{ command: string; args: string[] }> {
  if (await isUvProject(cwd)) {
    return { command: "uv", args: ["run", "ty", ...tyArgs] };
  }
  return { command: "ty", args: tyArgs };
}

// ============================================================================
// LSP Client
// ============================================================================

class TyLSPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private openDocuments = new Set<string>();
  private cwd: string;
  private useUv: boolean | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) {
      return this.initializePromise!;
    }

    // Detect uv project on first start
    if (this.useUv === null) {
      this.useUv = await isUvProject(this.cwd);
    }

    const command = this.useUv ? "uv" : "ty";
    const args = this.useUv ? ["run", "ty", "server"] : ["server"];

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });

    this.buffer = "";
    this.initialized = false;

    this.process.stdout!.on("data", (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.process.stderr!.on("data", (data: Buffer) => {
      // Log stderr for debugging but don't fail
      // console.error("ty server stderr:", data.toString());
    });

    this.process.on("exit", () => {
      this.process = null;
      this.initialized = false;
      this.initializePromise = null;
      // Reject all pending requests
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error("LSP server exited"));
      }
      this.pendingRequests.clear();
      this.openDocuments.clear();
    });

    this.initializePromise = this.initialize();
    return this.initializePromise;
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const contentStart = headerEnd + 4;
      const contentEnd = contentStart + contentLength;

      if (this.buffer.length < contentEnd) break;

      const content = this.buffer.slice(contentStart, contentEnd);
      this.buffer = this.buffer.slice(contentEnd);

      try {
        const message = JSON.parse(content);
        this.handleMessage(message);
      } catch {
        // Ignore parse errors
      }
    }
  }

  private handleMessage(message: any): void {
    if ("id" in message && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || "LSP error"));
      } else {
        resolve(message.result);
      }
    }
    // Ignore notifications and other messages
  }

  private send(message: object): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process!.stdin!.write(header + content);
  }

  private request<T>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request timeout: ${method}`));
        }
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: object): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
        },
      },
      rootUri: `file://${this.cwd}`,
      workspaceFolders: [{ uri: `file://${this.cwd}`, name: "workspace" }],
    });

    this.notify("initialized", {});
    this.initialized = true;
  }

  private async openDocument(filePath: string): Promise<void> {
    const absPath = resolve(this.cwd, filePath);
    const uri = `file://${absPath}`;

    if (this.openDocuments.has(uri)) return;

    try {
      const content = await readFile(absPath, "utf-8");
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "python",
          version: 1,
          text: content,
        },
      });
      this.openDocuments.add(uri);
    } catch (error) {
      throw new Error(`Cannot read file: ${filePath}`);
    }
  }

  async gotoDefinition(filePath: string, line: number, column: number): Promise<LSPLocation[] | null> {
    await this.ensureStarted();
    await this.openDocument(filePath);

    const absPath = resolve(this.cwd, filePath);
    const result = await this.request<LSPLocation | LSPLocation[] | null>("textDocument/definition", {
      textDocument: { uri: `file://${absPath}` },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result) return null;
    return Array.isArray(result) ? result : [result];
  }

  async findReferences(filePath: string, line: number, column: number, includeDeclaration = true): Promise<LSPLocation[] | null> {
    await this.ensureStarted();
    await this.openDocument(filePath);

    const absPath = resolve(this.cwd, filePath);
    const result = await this.request<LSPLocation[] | null>("textDocument/references", {
      textDocument: { uri: `file://${absPath}` },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration },
    });

    return result;
  }

  async hover(filePath: string, line: number, column: number): Promise<LSPHover | null> {
    await this.ensureStarted();
    await this.openDocument(filePath);

    const absPath = resolve(this.cwd, filePath);
    const result = await this.request<LSPHover | null>("textDocument/hover", {
      textDocument: { uri: `file://${absPath}` },
      position: { line: line - 1, character: column - 1 },
    });

    return result;
  }

  shutdown(): void {
    if (this.process && !this.process.killed) {
      try {
        this.notify("shutdown", {});
        this.notify("exit", {});
      } catch {
        // Ignore errors during shutdown
      }
      this.process.kill();
      this.process = null;
    }
  }
}

// ============================================================================
// Tool Parameters
// ============================================================================

const TyCheckParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "File or directory to check. Defaults to current project.",
    })
  ),
  python_version: Type.Optional(
    Type.String({
      description: "Python version to assume (e.g., '3.11', '3.12')",
    })
  ),
  ignore: Type.Optional(
    Type.Array(Type.String(), {
      description: "Rules to ignore (e.g., ['unresolved-import'])",
    })
  ),
});

const LocationParams = Type.Object({
  file: Type.String({ description: "Path to the Python file" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  column: Type.Number({ description: "Column number (1-indexed)" }),
});

const ReferencesParams = Type.Object({
  file: Type.String({ description: "Path to the Python file" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  column: Type.Number({ description: "Column number (1-indexed)" }),
  include_declaration: Type.Optional(
    Type.Boolean({ description: "Include the declaration in results (default: true)" })
  ),
});

type TyCheckInput = Static<typeof TyCheckParams>;
type LocationInput = Static<typeof LocationParams>;
type ReferencesInput = Static<typeof ReferencesParams>;

// ============================================================================
// Helpers
// ============================================================================

function parseTyOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split("\n");
  const pattern = /^(.+?):(\d+):(\d+): (error|warning)\[([^\]]+)\] (.+)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as "error" | "warning",
        rule: match[5],
        message: match[6],
      });
    }
  }

  return diagnostics;
}

function uriToPath(uri: string, cwd: string): string {
  const absPath = uri.replace(/^file:\/\//, "");
  return relative(cwd, absPath) || absPath;
}

async function getLinePreview(filePath: string, line: number, cwd: string): Promise<string | undefined> {
  try {
    const absPath = resolve(cwd, filePath);
    const content = await readFile(absPath, "utf-8");
    const lines = content.split("\n");
    if (line > 0 && line <= lines.length) {
      return lines[line - 1].trim();
    }
  } catch {
    // Ignore errors
  }
  return undefined;
}

async function lspLocationsToLocations(lspLocations: LSPLocation[], cwd: string): Promise<Location[]> {
  const locations: Location[] = [];
  for (const loc of lspLocations) {
    const file = uriToPath(loc.uri, cwd);
    const line = loc.range.start.line + 1;
    const column = loc.range.start.character + 1;
    const preview = await getLinePreview(file, line, cwd);
    locations.push({
      file,
      line,
      column,
      endLine: loc.range.end.line + 1,
      endColumn: loc.range.end.character + 1,
      preview,
    });
  }
  return locations;
}

function formatLocations(locations: Location[]): string {
  if (locations.length === 0) return "No results found.";

  return locations
    .map((loc) => {
      let line = `${loc.file}:${loc.line}:${loc.column}`;
      if (loc.preview) {
        line += `\n    ${loc.preview}`;
      }
      return line;
    })
    .join("\n\n");
}

function parseHoverContents(contents: LSPHover["contents"]): HoverResult {
  const result: HoverResult = {};
  
  const extractText = (item: string | { kind: string; value: string }): string => {
    if (typeof item === "string") return item;
    return item.value || "";
  };

  let text: string;
  if (Array.isArray(contents)) {
    text = contents.map(extractText).join("\n\n");
  } else {
    text = extractText(contents);
  }

  // Try to separate type signature from documentation
  // Usually the type is in a code block at the start
  const codeBlockMatch = text.match(/^```[\w]*\n?([\s\S]*?)\n?```\s*([\s\S]*)$/);
  if (codeBlockMatch) {
    result.type = codeBlockMatch[1].trim();
    result.documentation = codeBlockMatch[2].trim() || undefined;
  } else {
    // Check if first line looks like a type signature
    const lines = text.split("\n");
    const firstLine = lines[0];
    if (firstLine && (firstLine.includes("->") || firstLine.includes(":") || firstLine.startsWith("def ") || firstLine.startsWith("class "))) {
      result.type = firstLine;
      result.documentation = lines.slice(1).join("\n").trim() || undefined;
    } else {
      result.documentation = text;
    }
  }

  return result;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let lspClient: TyLSPClient | null = null;

  const getClient = (ctx: ExtensionContext): TyLSPClient => {
    if (!lspClient) {
      lspClient = new TyLSPClient(ctx.cwd);
    }
    return lspClient;
  };

  // Shutdown LSP server when session ends
  pi.on("session_shutdown", async () => {
    lspClient?.shutdown();
    lspClient = null;
  });

  // ---- ty_check ----
  pi.registerTool({
    name: "ty_check",
    label: "ty Check",
    description: `Run ty Python type checker on files or directories.

Returns structured diagnostics with file, line, column, severity, rule, and message.

Examples:
- Check current project: ty_check
- Check specific file: ty_check path="src/main.py"
- Check with Python 3.11: ty_check python_version="3.11"
- Ignore specific rules: ty_check ignore=["unresolved-import"]

For detailed usage guidance, read the ty skill first.`,
    parameters: TyCheckParams,

    async execute(toolCallId, params: TyCheckInput, signal, onUpdate, ctx) {
      const tyArgs = ["check", "--output-format", "concise"];

      if (params.python_version) {
        tyArgs.push("--python-version", params.python_version);
      }

      if (params.ignore) {
        for (const rule of params.ignore) {
          tyArgs.push("--ignore", rule);
        }
      }

      if (params.path) {
        const cleanPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
        tyArgs.push(cleanPath);
      }

      const { command, args } = await getTyCommand(ctx.cwd, tyArgs);
      const result = await pi.exec(command, args, { signal, timeout: 60000 });
      const output = (result.stdout + "\n" + result.stderr).trim();
      const diagnostics = parseTyOutput(output);

      const totalErrors = diagnostics.filter((d) => d.severity === "error").length;
      const totalWarnings = diagnostics.filter((d) => d.severity === "warning").length;

      const checkResult: TyCheckResult = {
        diagnostics,
        totalErrors,
        totalWarnings,
        exitCode: result.code ?? 0,
      };

      let text: string;
      if (diagnostics.length === 0) {
        text = "No type errors found.";
      } else {
        const lines = diagnostics.map(
          (d) => `${d.file}:${d.line}:${d.column} ${d.severity}[${d.rule}]: ${d.message}`
        );
        text = lines.join("\n");
        text += `\n\nSummary: ${totalErrors} error(s), ${totalWarnings} warning(s)`;
      }

      return {
        content: [{ type: "text", text }],
        details: checkResult,
      };
    },

    renderCall(args: TyCheckInput, theme) {
      let text = theme.fg("toolTitle", theme.bold("ty_check "));
      if (args.path) {
        text += theme.fg("path", args.path);
      } else {
        text += theme.fg("muted", "(project)");
      }
      if (args.python_version) {
        text += theme.fg("muted", ` py${args.python_version}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as TyCheckResult | undefined;

      if (!details) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "No output", 0, 0);
      }

      const { totalErrors, totalWarnings, diagnostics } = details;

      if (diagnostics.length === 0) {
        return new Text(theme.fg("success", "✓ No type errors"), 0, 0);
      }

      const parts: string[] = [];
      if (totalErrors > 0) {
        parts.push(theme.fg("error", `${totalErrors} error${totalErrors !== 1 ? "s" : ""}`));
      }
      if (totalWarnings > 0) {
        parts.push(theme.fg("warning", `${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""}`));
      }
      let text = parts.join(", ");

      if (expanded) {
        for (const d of diagnostics) {
          const severityColor = d.severity === "error" ? "error" : "warning";
          text += "\n  ";
          text += theme.fg("path", `${d.file}:${d.line}:${d.column}`);
          text += " ";
          text += theme.fg(severityColor, `[${d.rule}]`);
          text += " ";
          text += theme.fg("dim", d.message);
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ---- ty_goto ----
  pi.registerTool({
    name: "ty_goto",
    label: "ty Go to Definition",
    description: `Find the definition of a symbol at a given location in a Python file.

Use this to navigate to where a class, function, variable, or import is defined.

Parameters:
- file: Path to the Python file
- line: Line number (1-indexed)
- column: Column number (1-indexed) - position the cursor on the symbol

Example: ty_goto file="src/main.py" line=10 column=15

For detailed usage guidance including how to find column numbers, read the ty skill first.`,
    parameters: LocationParams,

    async execute(toolCallId, params: LocationInput, signal, onUpdate, ctx) {
      try {
        const client = getClient(ctx);
        const cleanPath = params.file.startsWith("@") ? params.file.slice(1) : params.file;
        
        const results = await client.gotoDefinition(cleanPath, params.line, params.column);

        if (!results || results.length === 0) {
          return {
            content: [{ type: "text", text: "No definition found at this location." }],
            details: { locations: [] },
          };
        }

        const locations = await lspLocationsToLocations(results, ctx.cwd);
        const text = formatLocations(locations);

        return {
          content: [{ type: "text", text }],
          details: { locations },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },

    renderCall(args: LocationInput, theme) {
      const cleanPath = args.file.startsWith("@") ? args.file.slice(1) : args.file;
      let text = theme.fg("toolTitle", theme.bold("ty_goto "));
      text += theme.fg("path", `${cleanPath}:${args.line}:${args.column}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { locations?: Location[]; error?: string } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const locations = details?.locations ?? [];
      if (locations.length === 0) {
        return new Text(theme.fg("warning", "No definition found"), 0, 0);
      }

      let text = theme.fg("success", `Found ${locations.length} definition${locations.length !== 1 ? "s" : ""}`);
      if (expanded) {
        for (const loc of locations) {
          text += "\n  ";
          text += theme.fg("path", `${loc.file}:${loc.line}:${loc.column}`);
          if (loc.preview) {
            text += "\n    " + theme.fg("dim", loc.preview);
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ---- ty_references ----
  pi.registerTool({
    name: "ty_references",
    label: "ty Find References",
    description: `Find all references to a symbol at a given location in a Python file.

Use this to find everywhere a class, function, variable, or import is used.

Parameters:
- file: Path to the Python file
- line: Line number (1-indexed)
- column: Column number (1-indexed) - position the cursor on the symbol
- include_declaration: Whether to include the declaration itself (default: true)

Example: ty_references file="src/main.py" line=10 column=15

For detailed usage guidance including how to find column numbers, read the ty skill first.`,
    parameters: ReferencesParams,

    async execute(toolCallId, params: ReferencesInput, signal, onUpdate, ctx) {
      try {
        const client = getClient(ctx);
        const cleanPath = params.file.startsWith("@") ? params.file.slice(1) : params.file;
        const includeDecl = params.include_declaration !== false;

        const results = await client.findReferences(cleanPath, params.line, params.column, includeDecl);

        if (!results || results.length === 0) {
          return {
            content: [{ type: "text", text: "No references found at this location." }],
            details: { locations: [] },
          };
        }

        const locations = await lspLocationsToLocations(results, ctx.cwd);
        let text = `Found ${locations.length} reference${locations.length !== 1 ? "s" : ""}:\n\n`;
        text += formatLocations(locations);

        return {
          content: [{ type: "text", text }],
          details: { locations },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },

    renderCall(args: ReferencesInput, theme) {
      const cleanPath = args.file.startsWith("@") ? args.file.slice(1) : args.file;
      let text = theme.fg("toolTitle", theme.bold("ty_references "));
      text += theme.fg("path", `${cleanPath}:${args.line}:${args.column}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { locations?: Location[]; error?: string } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const locations = details?.locations ?? [];
      if (locations.length === 0) {
        return new Text(theme.fg("warning", "No references found"), 0, 0);
      }

      let text = theme.fg("success", `Found ${locations.length} reference${locations.length !== 1 ? "s" : ""}`);
      if (expanded) {
        for (const loc of locations) {
          text += "\n  ";
          text += theme.fg("path", `${loc.file}:${loc.line}:${loc.column}`);
          if (loc.preview) {
            text += "\n    " + theme.fg("dim", loc.preview);
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ---- ty_hover ----
  pi.registerTool({
    name: "ty_hover",
    label: "ty Hover",
    description: `Get type information and documentation for a symbol at a given location.

Use this to see:
- The inferred or declared type of a symbol
- Docstrings and documentation
- Function signatures

Parameters:
- file: Path to the Python file
- line: Line number (1-indexed)
- column: Column number (1-indexed) - position the cursor on the symbol

Example: ty_hover file="src/main.py" line=10 column=15

For detailed usage guidance including how to find column numbers, read the ty skill first.`,
    parameters: LocationParams,

    async execute(toolCallId, params: LocationInput, signal, onUpdate, ctx) {
      try {
        const client = getClient(ctx);
        const cleanPath = params.file.startsWith("@") ? params.file.slice(1) : params.file;

        const result = await client.hover(cleanPath, params.line, params.column);

        if (!result) {
          return {
            content: [{ type: "text", text: "No information available at this location." }],
            details: { hover: null },
          };
        }

        const hover = parseHoverContents(result.contents);
        
        let text = "";
        if (hover.type) {
          text += `Type: ${hover.type}\n`;
        }
        if (hover.documentation) {
          text += `\nDocumentation:\n${hover.documentation}`;
        }
        if (!text) {
          text = "No type or documentation information available.";
        }

        return {
          content: [{ type: "text", text: text.trim() }],
          details: { hover },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },

    renderCall(args: LocationInput, theme) {
      const cleanPath = args.file.startsWith("@") ? args.file.slice(1) : args.file;
      let text = theme.fg("toolTitle", theme.bold("ty_hover "));
      text += theme.fg("path", `${cleanPath}:${args.line}:${args.column}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { hover?: HoverResult; error?: string } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const hover = details?.hover;
      if (!hover || (!hover.type && !hover.documentation)) {
        return new Text(theme.fg("warning", "No information available"), 0, 0);
      }

      let text = "";
      if (hover.type) {
        text += theme.fg("accent", hover.type);
      }
      if (expanded && hover.documentation) {
        text += (text ? "\n" : "") + theme.fg("dim", hover.documentation);
      } else if (hover.documentation && !expanded) {
        text += theme.fg("muted", " (expand for docs)");
      }

      return new Text(text, 0, 0);
    },
  });
}
