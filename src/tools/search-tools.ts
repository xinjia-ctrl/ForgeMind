import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import { objectArgs, stringArg } from "./file-tools.js";
import { relativeWorkspacePath, resolveWorkspacePath } from "./path-safety.js";
import type { Tool, ToolPolicy, ToolResult } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);
const MAX_FILES = 5_000;
const MAX_MATCHES_PER_QUERY = 200;

export class WorkspaceFileIndex {
  readonly #primed = new Map<string, readonly string[]>();

  public prime(root: string, files: readonly string[]): void {
    this.#primed.set(root, files);
  }

  public take(root: string): readonly string[] | undefined {
    const files = this.#primed.get(root);
    this.#primed.delete(root);
    return files;
  }
}

export class GlobTool implements Tool {
  public readonly name = "glob";
  public readonly description = "List workspace files matching a glob pattern";
  public readonly parameters = {
    type: "object",
    required: ["pattern"],
    properties: { pattern: { type: "string" } },
  } as const;

  public constructor(private readonly fileIndex = new WorkspaceFileIndex()) {}

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const pattern = stringArg(value, "pattern");
      const root = await resolveWorkspacePath(policy, ".");
      const matcher = globRegex(pattern);
      const allFiles = await walkFiles(root, MAX_FILES);
      this.fileIndex.prime(root, allFiles);
      const matches = allFiles.filter((file) => matcher.test(file));
      const bounded = matches.slice(0, 500);
      return {
        ok: true,
        data: { files: bounded },
        truncated: matches.length > bounded.length || allFiles.length === MAX_FILES,
        tokenCost: estimateTokens(bounded.join("\n")),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export class GrepTool implements Tool {
  public readonly name = "grep";
  public readonly description = "Search workspace text files for one or more fixed strings";
  public readonly parameters = {
    type: "object",
    anyOf: [{ required: ["query"] }, { required: ["queries"] }],
    properties: {
      query: { type: "string" },
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10,
      },
      pattern: { type: "string" },
      caseSensitive: { type: "boolean" },
    },
  } as const;

  public constructor(private readonly fileIndex = new WorkspaceFileIndex()) {}

  public async execute(args: unknown, policy: ToolPolicy): Promise<ToolResult> {
    try {
      const value = objectArgs(args);
      const queries = queryArgs(value);
      const pattern = typeof value["pattern"] === "string" ? value["pattern"] : "**/*";
      const caseSensitive = value["caseSensitive"] !== false;
      const root = await resolveWorkspacePath(policy, ".");
      const matcher = globRegex(pattern);
      const indexedFiles = this.fileIndex.take(root) ?? (await walkFiles(root, MAX_FILES));
      const files = indexedFiles.filter((file) => matcher.test(file));
      const needles = queries.map((query) => (caseSensitive ? query : query.toLocaleLowerCase()));
      const matches = queries.map(() => [] as Array<{ path: string; line: number; text: string }>);
      const truncated = queries.map(() => false);

      search: for (let offset = 0; offset < files.length; offset += 8) {
        const batch = files.slice(offset, offset + 8);
        const contents = await Promise.all(
          batch.map(async (file) => {
            try {
              return await readFile(path.join(root, file), "utf8");
            } catch {
              return null;
            }
          }),
        );
        for (let fileIndex = 0; fileIndex < batch.length; fileIndex += 1) {
          if (matches.every((items) => items.length >= MAX_MATCHES_PER_QUERY)) break search;
          const file = batch[fileIndex];
          const content = contents[fileIndex];
          if (file === undefined || content === undefined || content === null) continue;
          const lines = content.split("\n");
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex] ?? "";
            const haystack = caseSensitive ? line : line.toLocaleLowerCase();
            for (let queryIndex = 0; queryIndex < needles.length; queryIndex += 1) {
              const queryMatches = matches[queryIndex];
              const needle = needles[queryIndex];
              if (
                queryMatches !== undefined &&
                needle !== undefined &&
                queryMatches.length < MAX_MATCHES_PER_QUERY &&
                haystack.includes(needle)
              ) {
                queryMatches.push({
                  path: file,
                  line: lineIndex + 1,
                  text: line.slice(0, 500),
                });
                if (queryMatches.length >= MAX_MATCHES_PER_QUERY) truncated[queryIndex] = true;
              }
            }
          }
        }
      }

      const flattened = matches.flat();

      return {
        ok: true,
        data: { matches: flattened },
        truncated: truncated.some(Boolean) || indexedFiles.length === MAX_FILES,
        tokenCost: estimateTokens(JSON.stringify(flattened)),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

function queryArgs(value: Readonly<Record<string, unknown>>): readonly string[] {
  const query = value["query"];
  const queries = value["queries"];
  if (query !== undefined && queries !== undefined) {
    throw new Error("Provide query or queries, not both");
  }
  if (typeof query === "string") {
    if (query.length === 0) throw new Error("query cannot be empty");
    return [query];
  }
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > 10) {
    throw new Error("query must be a non-empty string or queries must contain 1-10 strings");
  }
  const result: string[] = [];
  const candidates: readonly unknown[] = queries;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("query must be a non-empty string or queries must contain 1-10 strings");
    }
    result.push(candidate);
  }
  return result;
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
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isDirectory()) {
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
