import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import { truncateUtf8 } from "../core/text.js";
import { relativeWorkspacePath, resolveWorkspacePath } from "./path-safety.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

export class ReadFileTool implements Tool {
  public readonly name = "read_file";
  public readonly description = "Read a bounded line range from a workspace file";
  public readonly parameters = {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const requestedPath = stringArg(value, "path");
      const target = await resolveWorkspacePath(policy, requestedPath);
      const content = await readFile(target, "utf8");
      const lines = content.split("\n");
      const start = positiveIntegerArg(value, "startLine", 1);
      const end = positiveIntegerArg(value, "endLine", lines.length);
      const selected = lines.slice(start - 1, end).join("\n");
      const bounded = boundText(selected, policy.maxResultBytes);
      return {
        ok: true,
        data: {
          path: relativeWorkspacePath(policy.workspaceRoot, target),
          startLine: start,
          endLine: Math.min(end, lines.length),
          content: bounded.text,
        },
        truncated: bounded.truncated,
        tokenCost: estimateTokens(bounded.text),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export class WriteFileTool implements Tool {
  public readonly name = "write_file";
  public readonly description = "Atomically write a UTF-8 workspace file";
  public readonly parameters = {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const requestedPath = stringArg(value, "path");
      const content = stringArg(value, "content");
      const target = await resolveWorkspacePath(policy, requestedPath, {
        forWrite: true,
      });
      await atomicWrite(target, content);
      return {
        ok: true,
        data: {
          path: relativeWorkspacePath(policy.workspaceRoot, target),
          bytes: Buffer.byteLength(content),
        },
        tokenCost: estimateTokens(content),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export class EditFileTool implements Tool {
  public readonly name = "edit_file";
  public readonly description = "Replace an exact, uniquely-counted string in a file";
  public readonly parameters = {
    type: "object",
    required: ["path", "search", "replacement"],
    properties: {
      path: { type: "string" },
      search: { type: "string" },
      replacement: { type: "string" },
      expectedOccurrences: { type: "integer", minimum: 1 },
    },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const requestedPath = stringArg(value, "path");
      const search = stringArg(value, "search");
      const replacement = stringArg(value, "replacement");
      const expected = positiveIntegerArg(value, "expectedOccurrences", 1);
      if (search.length === 0) throw new Error("search cannot be empty");
      const target = await resolveWorkspacePath(policy, requestedPath, {
        forWrite: true,
      });
      const original = await readFile(target, "utf8");
      const actual = countOccurrences(original, search);
      if (actual !== expected) {
        throw new Error(`Expected ${expected} occurrences but found ${actual}`);
      }
      const updated = original.split(search).join(replacement);
      await atomicWrite(target, updated);
      return {
        ok: true,
        data: {
          path: relativeWorkspacePath(policy.workspaceRoot, target),
          replacements: actual,
        },
        tokenCost: estimateTokens(replacement),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode;
  } catch {
    mode = undefined;
  }
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, target);
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let cursor = 0;
  let index = content.indexOf(search, cursor);
  while (index >= 0) {
    count += 1;
    cursor = index + search.length;
    index = content.indexOf(search, cursor);
  }
  return count;
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const result = truncateUtf8(text, maxBytes);
  return { text: result.text, truncated: result.truncated };
}

export function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

export function stringArg(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`${key} must be a string`);
  return result;
}

function positiveIntegerArg(value: Record<string, unknown>, key: string, fallback: number): number {
  const result = value[key];
  if (result === undefined) return fallback;
  if (!Number.isInteger(result) || (result as number) < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return result as number;
}
