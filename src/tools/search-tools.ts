import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import { objectArgs, stringArg } from "./file-tools.js";
import { relativeWorkspacePath, resolveWorkspacePath } from "./path-safety.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

export class GlobTool implements Tool {
  public readonly name = "glob";
  public readonly description = "List workspace files matching a glob pattern";
  public readonly parameters = {
    type: "object",
    required: ["pattern"],
    properties: { pattern: { type: "string" } },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const pattern = stringArg(value, "pattern");
      const root = await resolveWorkspacePath(policy, ".");
      const matcher = globRegex(pattern);
      const allFiles = await walkFiles(root, 5_000);
      const matches = allFiles.filter((file) => matcher.test(file));
      const bounded = matches.slice(0, 500);
      return {
        ok: true,
        data: { files: bounded },
        truncated: matches.length > bounded.length || allFiles.length === 5_000,
        tokenCost: estimateTokens(bounded.join("\n")),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export class GrepTool implements Tool {
  public readonly name = "grep";
  public readonly description = "Search workspace text files for a fixed string";
  public readonly parameters = {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      pattern: { type: "string" },
      caseSensitive: { type: "boolean" },
    },
  } as const;

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const query = stringArg(value, "query");
      if (query.length === 0) throw new Error("query cannot be empty");
      const pattern = typeof value["pattern"] === "string" ? value["pattern"] : "**/*";
      const caseSensitive = value["caseSensitive"] !== false;
      const root = await resolveWorkspacePath(policy, ".");
      const matcher = globRegex(pattern);
      const files = (await walkFiles(root, 5_000)).filter((file) => matcher.test(file));
      const needle = caseSensitive ? query : query.toLocaleLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;

      for (const file of files) {
        if (matches.length >= 200) {
          truncated = true;
          break;
        }
        let content: string;
        try {
          content = await readFile(path.join(root, file), "utf8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = caseSensitive ? line : line.toLocaleLowerCase();
          if (haystack.includes(needle)) {
            matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= 200) {
              truncated = true;
              break;
            }
          }
        }
      }

      return {
        ok: true,
        data: { matches },
        truncated,
        tokenCost: estimateTokens(JSON.stringify(matches)),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relativeWorkspacePath(root, absolute));
      }
    }
  }
  return files.sort();
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}
