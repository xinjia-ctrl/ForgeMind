import { readFile } from "node:fs/promises";
import type { StageId } from "../core/types.js";

export const PROMPT_VERSIONS = {
  PLAN: "plan.v1",
  ARCH: "architecture.v1",
  CODE: "code.v1",
  REVIEW: "review.v1",
  TEST: "test.v1",
  COMMIT: "commit.v1",
} as const satisfies Readonly<Record<StageId, string>>;

const PROMPT_FILES = {
  PLAN: "plan.v1.md",
  ARCH: "architecture.v1.md",
  CODE: "code.v1.md",
  REVIEW: "review.v1.md",
  TEST: "test.v1.md",
  COMMIT: "commit.v1.md",
} as const satisfies Readonly<Record<StageId, string>>;

const SCHEMAS: Readonly<Record<StageId, Readonly<Record<string, unknown>>>> = {
  PLAN: objectSchema(["objective", "steps", "acceptanceCriteria", "summary"], {
    objective: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      items: objectSchema(["id", "title", "description"], {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      }),
    },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  }),
  ARCH: objectSchema(["decisions", "files", "risks", "alternatives", "summary"], {
    decisions: { type: "array", items: { type: "string" } },
    files: {
      type: "array",
      items: objectSchema(["path", "purpose"], {
        path: { type: "string" },
        purpose: { type: "string" },
      }),
    },
    risks: { type: "array", items: { type: "string" } },
    alternatives: {
      type: "array",
      items: objectSchema(["position", "tradeoffs"], {
        position: { type: "string" },
        tradeoffs: { type: "array", minItems: 1, items: { type: "string" } },
      }),
    },
    summary: { type: "string" },
  }),
  CODE: objectSchema(["summary", "operations"], {
    summary: { type: "string" },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        anyOf: [
          objectSchema(["tool", "args"], {
            tool: { const: "write_file" },
            args: objectSchema(["path", "content"], {
              path: { type: "string" },
              content: { type: "string" },
            }),
          }),
          objectSchema(["tool", "args"], {
            tool: { const: "edit_file" },
            args: objectSchema(["path", "search", "replacement", "expectedOccurrences"], {
              path: { type: "string" },
              search: { type: "string" },
              replacement: { type: "string" },
              expectedOccurrences: { type: "integer", minimum: 1 },
            }),
          }),
        ],
      },
    },
  }),
  REVIEW: objectSchema(["approved", "reason", "feedback", "evidence"], {
    approved: { type: "boolean" },
    reason: { type: "string" },
    feedback: { type: "string" },
    evidence: { type: "string" },
  }),
  TEST: objectSchema([], {}),
  COMMIT: objectSchema([], {}),
};

const cache = new Map<StageId, string>();

export async function loadPrompt(
  stage: StageId,
  variables: Readonly<Record<string, string>> = {},
): Promise<{ readonly content: string; readonly version: string }> {
  let template = cache.get(stage);
  if (template === undefined) {
    template = await readFile(new URL(PROMPT_FILES[stage], import.meta.url), "utf8");
    cache.set(stage, template);
  }
  return { content: interpolatePrompt(template, variables), version: PROMPT_VERSIONS[stage] };
}

export function structuredOutputFor(stage: StageId): {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
} {
  return { name: `forgemind_${stage.toLocaleLowerCase()}_v1`, jsonSchema: SCHEMAS[stage] };
}

export function interpolatePrompt(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const rendered = Object.entries(variables).reduce(
    (content, [name, value]) => content.replaceAll(`{{${name}}}`, value),
    template,
  );
  const unresolved = rendered.match(/{{[a-zA-Z0-9_]+}}/g);
  if (unresolved !== null)
    throw new Error(`Unresolved prompt placeholders: ${unresolved.join(", ")}`);
  return rendered;
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { type: "object", additionalProperties: false, required, properties };
}
