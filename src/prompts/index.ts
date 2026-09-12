import { readFile } from "node:fs/promises";
import type { StageId } from "../core/types.js";

export const PROMPT_VERSIONS = {
  PLAN: "plan.v4",
  ARCH: "architecture.v4",
  CODE: "code.v5",
  REVIEW: "review.v5",
  TEST: "test.v1",
  COMMIT: "commit.v1",
} as const satisfies Readonly<Record<StageId, string>>;

const PROMPT_FILES = {
  PLAN: "plan.v4.md",
  ARCH: "architecture.v4.md",
  CODE: "code.v5.md",
  REVIEW: "review.v5.md",
  TEST: "test.v1.md",
  COMMIT: "commit.v1.md",
} as const satisfies Readonly<Record<StageId, string>>;

const SCHEMAS: Readonly<Record<StageId, Readonly<Record<string, unknown>>>> = {
  PLAN: objectSchema(["objective", "steps", "acceptanceCriteria", "summary"], {
    objective: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      items: objectSchema(["title", "description"], {
        title: { type: "string" },
        description: { type: "string" },
      }),
    },
    acceptanceCriteria: {
      type: "array",
      items: objectSchema(["description", "requiredEvidence", "verifier"], {
        description: { type: "string" },
        requiredEvidence: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: ["test", "review"] },
        },
        verifier: {
          anyOf: [
            objectSchema(["kind", "commandId"], {
              kind: { const: "test-suite" },
              commandId: { type: "string" },
            }),
            objectSchema(["kind", "commandId", "pattern"], {
              kind: { const: "test-case" },
              commandId: { type: "string" },
              pattern: { type: "string" },
            }),
            objectSchema(["kind", "path", "assertion"], {
              kind: { const: "file" },
              path: { type: "string" },
              assertion: { type: "string", enum: ["exists", "absent"] },
            }),
            objectSchema(["kind", "path", "assertion", "value"], {
              kind: { const: "file" },
              path: { type: "string" },
              assertion: { const: "contains" },
              value: { type: "string" },
            }),
            objectSchema(["kind", "rubric"], {
              kind: { const: "review" },
              rubric: { type: "string" },
            }),
          ],
        },
      }),
    },
    summary: { type: "string" },
  }),
  ARCH: objectSchema(["decisions", "files", "risks", "summary"], {
    decisions: { type: "array", items: { type: "string" } },
    files: {
      type: "array",
      items: objectSchema(["path", "purpose"], {
        path: { type: "string" },
        purpose: { type: "string" },
      }),
    },
    risks: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  }),
  CODE: objectSchema(["basedOnEvidence", "todo", "actions"], {
    basedOnEvidence: { type: "string" },
    todo: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        anyOf: [
          objectSchema(["kind", "paths"], {
            kind: { const: "inspect" },
            paths: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          }),
          objectSchema(["kind", "queries"], {
            kind: { const: "search" },
            queries: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          }),
          objectSchema(["kind", "path", "oldText", "newText"], {
            kind: { const: "edit" },
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          }),
          objectSchema(["kind", "path", "content"], {
            kind: { const: "write" },
            path: { type: "string" },
            content: { type: "string" },
          }),
          objectSchema(["kind", "checkId"], {
            kind: { const: "fast-check" },
            checkId: { type: "string" },
          }),
          objectSchema(["kind", "evidence"], {
            kind: { const: "finish" },
            evidence: { type: "string" },
          }),
        ],
      },
    },
  }),
  REVIEW: objectSchema(["approved", "reason", "feedback", "evidence", "acceptanceCriteria"], {
    approved: { type: "boolean" },
    reason: { type: "string", minLength: 1 },
    feedback: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 },
    acceptanceCriteria: {
      type: "array",
      items: objectSchema(["criterionId", "satisfied", "evidence"], {
        criterionId: { type: "string" },
        satisfied: { type: "boolean" },
        evidence: { type: "string", minLength: 1 },
      }),
    },
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
  const effectiveVariables =
    stage === "CODE"
      ? { maxSteps: "10", maxActions: "3", fastCheckIds: "none", ...variables }
      : variables;
  return {
    content: interpolatePrompt(template, effectiveVariables),
    version: PROMPT_VERSIONS[stage],
  };
}

export function structuredOutputFor(stage: StageId): {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
} {
  const version = PROMPT_VERSIONS[stage].split(".").at(-1);
  return {
    name: `forgemind_${stage.toLocaleLowerCase()}_${version}`,
    jsonSchema: SCHEMAS[stage],
  };
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
