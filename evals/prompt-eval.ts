import { pathToFileURL } from "node:url";
import { estimateTokens } from "../src/core/token-budget.js";
import { FakeChatProvider } from "../src/llm/fake-provider.js";
import { PROMPT_VERSIONS, loadPrompt, structuredOutputFor } from "../src/prompts/index.js";

interface EvalScenario {
  readonly name: string;
  readonly requirement: string;
  readonly responses: Readonly<Record<EvaluatedStage, Readonly<Record<string, unknown>>>>;
}

interface EvalVersionResult {
  readonly version: string;
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
  readonly reworkRounds: number;
  readonly unauthorizedToolCalls: number;
  readonly estimatedPromptTokens: number;
}

type EvaluatedStage = "PLAN" | "ARCH" | "CODE" | "REVIEW";

interface PromptCandidate {
  readonly version: string;
  readonly requireFiveSections: boolean;
  readonly requireStructuredOutput: boolean;
  load(stage: EvaluatedStage): Promise<string>;
}

const EVALUATED_STAGES: readonly EvaluatedStage[] = ["PLAN", "ARCH", "CODE", "REVIEW"];
const REQUIRED_HEADINGS = [
  "## 角色与职责",
  "## 输入契约摘要",
  "## 约束与边界",
  "## 输出 JSON Schema",
  "## 成功判据",
] as const;

const SCENARIOS: readonly EvalScenario[] = [
  scenario("health-route", "Add a health-check route with tests", "src/health.ts"),
  scenario("input-validation", "Validate empty API input and add regression tests", "src/api.ts"),
  scenario("bug-fix", "Fix integer overflow handling and cover the failure case", "src/math.ts"),
  scenario(
    "config-flag",
    "Add a disabled-by-default configuration flag with tests",
    "src/config.ts",
  ),
];

export async function runPromptEvaluation(): Promise<{
  readonly baseline: EvalVersionResult;
  readonly current: EvalVersionResult;
}> {
  const baselineCandidate: PromptCandidate = {
    version: "legacy-inline-v0.4",
    requireFiveSections: false,
    requireStructuredOutput: false,
    load: (stage) => Promise.resolve(LEGACY_PROMPTS[stage]),
  };
  const currentCandidate: PromptCandidate = {
    version: [...new Set(EVALUATED_STAGES.map((stage) => PROMPT_VERSIONS[stage]))].join(","),
    requireFiveSections: true,
    requireStructuredOutput: true,
    load: async (stage) =>
      (await loadPrompt(stage, stage === "CODE" ? { maxOperations: "30" } : {})).content,
  };
  const [baseline, current] = await Promise.all([
    evaluateCandidate(baselineCandidate),
    evaluateCandidate(currentCandidate),
  ]);
  return { baseline, current };
}

async function evaluateCandidate(candidate: PromptCandidate): Promise<EvalVersionResult> {
  const results = await Promise.all(
    SCENARIOS.map(async (scenario) => await evaluateScenario(scenario, candidate)),
  );
  const passed = results.filter((result) => result.passed).length;
  return {
    version: candidate.version,
    passed,
    total: results.length,
    passRate: passed / results.length,
    reworkRounds: results.reduce((sum, result) => sum + result.reworkRounds, 0),
    unauthorizedToolCalls: results.reduce((sum, result) => sum + result.unauthorizedToolCalls, 0),
    estimatedPromptTokens: results.reduce((sum, result) => sum + result.estimatedPromptTokens, 0),
  };
}

async function evaluateScenario(
  scenario: EvalScenario,
  candidate: PromptCandidate,
): Promise<{
  readonly passed: boolean;
  readonly reworkRounds: number;
  readonly unauthorizedToolCalls: number;
  readonly estimatedPromptTokens: number;
}> {
  const provider = new FakeChatProvider(
    EVALUATED_STAGES.map((stage) => JSON.stringify(scenario.responses[stage])),
  );
  let promptContractsValid = true;
  let responseContractsValid = true;
  let estimatedPromptTokens = 0;
  const parsed = new Map<EvaluatedStage, Readonly<Record<string, unknown>>>();

  for (const stage of EVALUATED_STAGES) {
    const prompt = await candidate.load(stage);
    promptContractsValid &&=
      (!candidate.requireFiveSections ||
        REQUIRED_HEADINGS.every((heading) => prompt.includes(heading))) &&
      structuredOutputFor(stage).jsonSchema["type"] === "object";
    const userInput = `Requirement: ${scenario.requirement}`;
    estimatedPromptTokens += estimateTokens(`${prompt}\n${userInput}`);
    const completion = await provider.complete(
      [
        { role: "system", content: prompt },
        { role: "user", content: userInput },
      ],
      {
        model: "fake-eval-model",
        temperature: 0,
        maxOutputTokens: 8_000,
        seed: 42,
        ...(candidate.requireStructuredOutput
          ? { structuredOutput: structuredOutputFor(stage) }
          : {}),
      },
    );
    const value: unknown = JSON.parse(completion.content);
    const record = asRecord(value);
    responseContractsValid &&= record !== null && validFixture(stage, record);
    if (record !== null) parsed.set(stage, record);
  }

  const code = parsed.get("CODE");
  const operations = Array.isArray(code?.["operations"]) ? code["operations"] : [];
  const unauthorizedToolCalls = operations.filter((operation) => {
    const record = asRecord(operation);
    return record === null || (record["tool"] !== "write_file" && record["tool"] !== "edit_file");
  }).length;
  const approved = parsed.get("REVIEW")?.["approved"] === true;
  const providerContractValid =
    provider.remainingResponses === 0 &&
    provider.calls.every(
      (call) => (call.options.structuredOutput !== undefined) === candidate.requireStructuredOutput,
    );
  return {
    passed:
      promptContractsValid &&
      responseContractsValid &&
      providerContractValid &&
      approved &&
      unauthorizedToolCalls === 0,
    reworkRounds: approved ? 0 : 1,
    unauthorizedToolCalls,
    estimatedPromptTokens,
  };
}

const LEGACY_PROMPTS: Readonly<Record<EvaluatedStage, string>> = {
  PLAN: [
    "You are ForgeMind's planning agent.",
    "Turn one software requirement into a small, executable plan.",
    "Return JSON only with objective, steps[{id,title,description}], acceptanceCriteria[], summary.",
    "Do not propose work outside the stated requirement.",
  ].join(" "),
  ARCH: [
    "You are ForgeMind's architecture agent.",
    "Design the smallest maintainable change that follows the repository's existing architecture.",
    "Return JSON only with decisions[], files[{path,purpose}], risks[], summary.",
    "Do not invent a parallel framework or duplicate existing abstractions.",
  ].join(" "),
  CODE: [
    "You are ForgeMind's coding agent.",
    "Produce a complete, minimal implementation and its tests in one bounded operation batch.",
    "Return JSON only with summary and operations[].",
    "Each operation is write_file or edit_file.",
    "At most 30 operations are allowed. Never edit .git or docs/.forgemind run artifacts.",
    "Preserve existing architecture and do not omit tests.",
  ].join(" "),
  REVIEW: [
    "You are ForgeMind's read-only code reviewer.",
    "Check correctness, security, maintainability, architectural consistency, and meaningful test coverage.",
    "Reject any material defect. Return JSON only with approved:boolean, reason, feedback, evidence.",
    "Feedback must be concrete and directly actionable.",
  ].join(" "),
};

function validFixture(stage: EvaluatedStage, response: Readonly<Record<string, unknown>>): boolean {
  if (stage === "PLAN") {
    return (
      typeof response["objective"] === "string" &&
      Array.isArray(response["steps"]) &&
      Array.isArray(response["acceptanceCriteria"]) &&
      typeof response["summary"] === "string"
    );
  }
  if (stage === "ARCH") {
    return (
      Array.isArray(response["decisions"]) &&
      Array.isArray(response["files"]) &&
      Array.isArray(response["risks"]) &&
      typeof response["summary"] === "string"
    );
  }
  if (stage === "CODE") {
    const operations = response["operations"];
    return (
      typeof response["summary"] === "string" &&
      Array.isArray(operations) &&
      operations.length > 0 &&
      operations.every((operation) => {
        const record = asRecord(operation);
        return (
          record !== null && typeof record["tool"] === "string" && asRecord(record["args"]) !== null
        );
      })
    );
  }
  return (
    typeof response["approved"] === "boolean" &&
    typeof response["reason"] === "string" &&
    typeof response["feedback"] === "string" &&
    typeof response["evidence"] === "string"
  );
}

function scenario(name: string, requirement: string, file: string): EvalScenario {
  return {
    name,
    requirement,
    responses: {
      PLAN: {
        objective: requirement,
        steps: [{ id: "1", title: "Implement", description: requirement }],
        acceptanceCriteria: ["Implementation and tests pass"],
        summary: requirement,
      },
      ARCH: {
        decisions: ["Reuse the existing module boundary"],
        files: [{ path: file, purpose: "Implement the scoped change" }],
        risks: ["Regression in existing behavior"],
        summary: `Update ${file} within the existing architecture`,
      },
      CODE: {
        summary: `Implement ${requirement}`,
        operations: [{ tool: "write_file", args: { path: file, content: "export {};\n" } }],
      },
      REVIEW: {
        approved: true,
        reason: "The bounded fixture satisfies the contract",
        feedback: "No rework required",
        evidence: "Implementation and tests are represented",
      },
    },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPromptEvaluation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.current.passRate < report.baseline.passRate ||
    report.current.unauthorizedToolCalls > report.baseline.unauthorizedToolCalls
  ) {
    process.exitCode = 1;
  }
}
