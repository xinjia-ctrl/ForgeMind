import { estimateTokens } from "../core/token-budget.js";
import { keywords } from "../memory/keywords.js";

export interface ContextSection {
  readonly name: string;
  readonly content: string;
  readonly source: "contract" | "retrieval" | "memory" | "rework";
  readonly references?: readonly string[];
}

export interface PromptInput {
  readonly sections: readonly ContextSection[];
  readonly content: string;
  readonly tokenEstimate: number;
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface RankWorkspaceFilesOptions {
  readonly files: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly query: string;
  readonly grepMatches?: readonly GrepMatch[];
  readonly limit: number;
}

export function assemblePromptInput(sections: readonly ContextSection[]): PromptInput {
  const normalized = sections.filter((section) => section.content.trim().length > 0);
  const content = normalized
    .map((section) => `## ${section.name} [source=${section.source}]\n${section.content}`)
    .join("\n\n");
  return { sections: normalized, content, tokenEstimate: estimateTokens(content) };
}

export function rankWorkspaceFiles(options: RankWorkspaceFilesOptions): readonly string[] {
  const expected = new Map(options.expectedFiles.map((file, index) => [file, index]));
  const queryTerms = keywords(options.query);
  const matchedPaths = new Map<string, number>();
  for (const match of options.grepMatches ?? []) {
    const relevance = Math.max(1, overlapCount(queryTerms, `${match.path} ${match.text}`));
    matchedPaths.set(match.path, (matchedPaths.get(match.path) ?? 0) + relevance);
  }
  return [...new Set(options.files)]
    .map((file) => {
      const expectedIndex = expected.get(file);
      const grep = matchedPaths.get(file) ?? 0;
      const relevance = overlapCount(queryTerms, file);
      return {
        file,
        tier: expectedIndex !== undefined ? 0 : grep > 0 ? 1 : relevance > 0 ? 2 : 3,
        expectedIndex: expectedIndex ?? Number.MAX_SAFE_INTEGER,
        grep,
        relevance,
      };
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        left.expectedIndex - right.expectedIndex ||
        right.grep - left.grep ||
        right.relevance - left.relevance ||
        left.file.localeCompare(right.file),
    )
    .slice(0, options.limit)
    .map((item) => item.file);
}

function overlapCount(queryTerms: readonly string[], value: string): number {
  const valueTerms = new Set(keywords(value));
  return queryTerms.reduce((count, term) => count + (valueTerms.has(term) ? 1 : 0), 0);
}

export function searchTerms(query: string, limit = 3): readonly string[] {
  return keywords(query)
    .filter((term) => term.length >= 3)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, limit);
}
