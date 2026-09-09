import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPolicyConfig } from "../src/config/policy.js";
import { EventLog } from "../src/core/event-log.js";
import type { ForgeMindEvent } from "../src/core/events.js";
import {
  FileActionJournal,
  type ActionJournal,
  type ActionJournalRecord,
} from "../src/core/action-journal.js";
import { CancellationFailure } from "../src/core/errors.js";
import { OpenAICompatibleChatProvider } from "../src/llm/openai-compatible-provider.js";
import {
  configuredProviderId,
  isProviderId,
  providerDefinition,
  resolveProviderApiKey,
} from "../src/llm/provider-catalog.js";
import { runForgeMind, type RunExecution, type RunOptions } from "../src/runtime/run.js";
import { LocalProcessRunner } from "../src/sandbox/local.js";
import type { ProcessInvocation, ProcessRunner, ProcessRunOptions } from "../src/sandbox/types.js";
import { runProcess, type ProcessResult } from "../src/tools/process.js";
import type { AcceptanceCriterion, VerificationEvidence } from "../src/core/types.js";
import {
  AcceptanceVerifierRegistry,
  type BehaviorProbe,
} from "../src/verification/acceptance-verifier.js";

interface RealEvalScenario {
  readonly name: string;
  readonly requirement: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly seed: Readonly<Record<string, string>>;
  readonly probes?: readonly BehaviorProbe[];
  readonly fault?: "post-code-regression" | "crash-after-file-action";
  readonly minimumReworkRounds?: number;
  readonly minimumNegotiations?: number;
  verify(repository: string): Promise<readonly string[]>;
}

interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly status: string;
  readonly semanticFailures: readonly string[];
  readonly acceptanceEvidenceComplete: boolean;
  readonly modelCalls: number;
  readonly reworkRounds: number;
  readonly negotiations: number;
  readonly crashRecoveries: number;
  readonly toolFailures: number;
  readonly unauthorizedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly finalAcceptanceEvidence: readonly VerificationEvidence[];
  readonly eventLogPath?: string;
  readonly error?: string;
}

export interface RealAgentEvalReport {
  readonly kind: "real-agent-evaluation";
  readonly model: string;
  readonly generatedAt: string;
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
  readonly scenarios: readonly ScenarioResult[];
}

const SCENARIOS: readonly RealEvalScenario[] = [
  {
    name: "single-file-defect-fix",
    requirement:
      "Fix only src/sum.js so signed integers add correctly. Keep the existing regression test passing.",
    acceptanceCriteria: acceptanceContract(),
    seed: {
      "src/sum.js": "export function sum(left, right) {\n  return left - right;\n}\n",
      "test/sum.test.js":
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { sum } from '../src/sum.js';\ntest('signed sums', () => assert.equal(sum(-2, 1), -1));\n",
    },
    probes: [signedSumProbe()],
    verify: verifySum,
  },
  {
    name: "cross-file-feature-change",
    requirement:
      "Implement the personalized greeting across both existing source files: update src/constants.js so GREETING is 'hello', and update src/greet.js so greet(name) returns 'hello, <name>!'. Keep the existing node:test regression passing.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "GREETING is hello and greet('Ada') returns hello, Ada!",
        requiredEvidence: ["test"],
        verifier: { kind: "behavior", probeId: "greeting-probe" },
      },
      {
        id: "AC-2",
        description: "node --test passes",
        requiredEvidence: ["test"],
        verifier: { kind: "test-suite", commandId: "primary" },
      },
    ],
    seed: {
      "src/constants.js": "export const GREETING = 'hi';\n",
      "src/greet.js":
        "import { GREETING } from './constants.js';\nexport function greet(name) {\n  return GREETING;\n}\n",
      "test/greet.test.js":
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { GREETING } from '../src/constants.js';\nimport { greet } from '../src/greet.js';\ntest('personalized greeting', () => { assert.equal(GREETING, 'hello'); assert.equal(greet('Ada'), 'hello, Ada!'); });\n",
    },
    probes: [greetingProbe()],
    verify: verifyGreeting,
  },
  {
    name: "test-failure-auto-rework",
    requirement:
      "Create src/sum.js exporting sum(left, right) and meaningful node:test coverage in test/sum.test.js. Recover from verification feedback and preserve earlier fixes.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "signed sum behavior is correct",
        requiredEvidence: ["test"],
        verifier: { kind: "behavior", probeId: "rework-probe" },
      },
      {
        id: "AC-2",
        description: "node --test passes",
        requiredEvidence: ["test"],
        verifier: { kind: "test-suite", commandId: "primary" },
      },
    ],
    seed: {},
    probes: [reworkProbe()],
    fault: "post-code-regression",
    minimumReworkRounds: 1,
    verify: verifySum,
  },
  {
    name: "crash-recovery",
    requirement:
      "Update src/version.js so exported version is 2 and keep the existing node:test regression passing.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "src/version.js exports version 2",
        requiredEvidence: ["test"],
        verifier: { kind: "file", path: "src/version.js", assertion: "contains", value: "2" },
      },
      {
        id: "AC-2",
        description: "node --test passes",
        requiredEvidence: ["test"],
        verifier: { kind: "test-suite", commandId: "primary" },
      },
    ],
    seed: {
      "src/version.js": "export const version = 1;\n",
      "test/version.test.js":
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { version } from '../src/version.js';\ntest('version', () => assert.equal(version, 2));\n",
    },
    fault: "crash-after-file-action",
    verify: verifyVersion,
  },
  {
    name: "conflict-resolution",
    requirement:
      "Add src/divide.js exporting safeDivide(left, right) with node:test coverage. During architecture, explicitly retain two distinct alternatives with tradeoffs—throwing on division by zero versus returning null—so the bounded conflict resolver selects one. Implement and test the selected decision.",
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "safeDivide(6, 3) returns 2 and zero handling is explicit",
        requiredEvidence: ["test"],
        verifier: { kind: "behavior", probeId: "divide-probe" },
      },
      {
        id: "AC-2",
        description: "node --test passes",
        requiredEvidence: ["test"],
        verifier: { kind: "test-suite", commandId: "primary" },
      },
    ],
    seed: {},
    probes: [divideProbe()],
    minimumNegotiations: 1,
    verify: verifyDivide,
  },
];

export async function runRealAgentEvaluation(options: {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly keepRepositories?: boolean;
}): Promise<RealAgentEvalReport> {
  const provider = new OpenAICompatibleChatProvider({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const scenarios: ScenarioResult[] = [];
  for (const [index, scenario] of SCENARIOS.entries()) {
    const repository = await createRepository(scenario.seed);
    try {
      let execution: RunExecution;
      let crashRecoveries = 0;
      try {
        const result = await executeRealScenario(
          scenario,
          repository,
          provider,
          options.model,
          `real-eval-${index + 1}-${Date.now().toString(36)}`,
        );
        execution = result.execution;
        crashRecoveries = result.crashRecoveries;
      } catch (error) {
        scenarios.push({
          name: scenario.name,
          passed: false,
          status: "ERROR",
          semanticFailures: [],
          acceptanceEvidenceComplete: false,
          modelCalls: 0,
          reworkRounds: 0,
          negotiations: 0,
          crashRecoveries,
          toolFailures: 0,
          unauthorizedToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: null,
          finalAcceptanceEvidence: [],
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const events = await EventLog.open(
        path.dirname(execution.eventLogPath),
        execution.result.context.runId,
      ).load();
      const semanticFailures = await scenario.verify(repository);
      const metrics = metricsFrom(events);
      const finalCriteria =
        execution.result.context.plan?.acceptanceCriteria ?? scenario.acceptanceCriteria;
      const finalAcceptanceEvidence = finalEvidence(execution.result.context.gates);
      const acceptanceEvidenceComplete = finalCriteria.every((criterion) =>
        criterion.requiredEvidence.every((required) => {
          return finalAcceptanceEvidence.some(
            (evidence) =>
              evidence.criterionId === criterion.id &&
              evidence.verifierKind === criterion.verifier.kind &&
              evidence.source.startsWith(`${required}:`) &&
              evidence.passed &&
              evidence.details.trim().length > 0,
          );
        }),
      );
      const proofFailures = [
        ...((scenario.minimumReworkRounds ?? 0) <= metrics.reworkRounds
          ? []
          : [`expected at least ${scenario.minimumReworkRounds} rework round(s)`]),
        ...((scenario.minimumNegotiations ?? 0) <= metrics.negotiations
          ? []
          : [`expected at least ${scenario.minimumNegotiations} negotiation(s)`]),
        ...(scenario.fault !== "crash-after-file-action" || crashRecoveries > 0
          ? []
          : ["the crash recovery failpoint did not execute"]),
      ];
      scenarios.push({
        name: scenario.name,
        passed:
          execution.result.status === "SUCCEEDED" &&
          semanticFailures.length === 0 &&
          acceptanceEvidenceComplete &&
          proofFailures.length === 0,
        status: execution.result.status,
        semanticFailures: [...semanticFailures, ...proofFailures],
        acceptanceEvidenceComplete,
        ...metrics,
        crashRecoveries,
        finalAcceptanceEvidence,
        ...(options.keepRepositories === true ? { eventLogPath: execution.eventLogPath } : {}),
        ...(execution.result.status === "SUCCEEDED" ? {} : { error: execution.result.summary }),
      });
    } finally {
      if (options.keepRepositories !== true) {
        await rm(repository, { recursive: true, force: true });
      }
    }
  }
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  return {
    kind: "real-agent-evaluation",
    model: options.model,
    generatedAt: new Date().toISOString(),
    passed,
    total: scenarios.length,
    passRate: scenarios.length === 0 ? 0 : passed / scenarios.length,
    scenarios,
  };
}

async function executeRealScenario(
  scenario: RealEvalScenario,
  repository: string,
  provider: OpenAICompatibleChatProvider,
  model: string,
  runId: string,
): Promise<{ readonly execution: RunExecution; readonly crashRecoveries: number }> {
  const primaryCommand = ["node", "--test"] as const;
  const probes = scenario.probes ?? [];
  const verifierRegistry = new AcceptanceVerifierRegistry({
    workspaceRoot: repository,
    commands: { primary: primaryCommand },
    probes,
  });
  const policyConfig = await loadPolicyConfig({
    repositoryRoot: repository,
    testCommand: primaryCommand,
    verificationCommands: verifierRegistry.commandAllowlist,
    environment: {
      FORGEMIND_POLICY_JSON: JSON.stringify({ sandbox: { mode: "local" } }),
    },
  });
  const localRunner = new LocalProcessRunner();
  const processRunner: ProcessRunner =
    scenario.fault === "post-code-regression"
      ? new InjectRegressionOnceProcessRunner(localRunner, probes[0]?.command ?? [])
      : localRunner;
  const common: Omit<RunOptions, "resume" | "actionJournal"> = {
    repoPath: repository,
    requirement: scenario.requirement,
    acceptanceCriteria: scenario.acceptanceCriteria,
    acceptanceVerifierRegistry: verifierRegistry,
    provider,
    model,
    runId,
    testCommand: "node --test",
    approveAll: true,
    policyConfig,
    processRunner,
  };
  if (scenario.fault !== "crash-after-file-action") {
    return { execution: await runForgeMind(common), crashRecoveries: 0 };
  }
  const journalPath = path.join(
    repository,
    ".git",
    "forgemind",
    "fault-injection",
    runId,
    "actions.json",
  );
  const persistedJournal = new FileActionJournal(journalPath);
  const crashingJournal = new CrashAfterFileActionJournal(persistedJournal);
  try {
    await runForgeMind({ ...common, actionJournal: crashingJournal });
    throw new Error("Crash recovery scenario completed without reaching its failpoint");
  } catch (error) {
    if (!crashingJournal.crashed) throw error;
  }
  const execution = await runForgeMind({
    ...common,
    resume: true,
    actionJournal: persistedJournal,
  });
  return { execution, crashRecoveries: 1 };
}

function metricsFrom(
  events: readonly ForgeMindEvent[],
): Omit<
  ScenarioResult,
  | "name"
  | "passed"
  | "status"
  | "semanticFailures"
  | "acceptanceEvidenceComplete"
  | "finalAcceptanceEvidence"
  | "eventLogPath"
  | "error"
> {
  const calls = events.filter((event) => event.type === "llm.called");
  const inputTokens = calls.reduce((sum, event) => sum + event.data.inputTokens, 0);
  const outputTokens = calls.reduce((sum, event) => sum + event.data.outputTokens, 0);
  const inputPrice = optionalPrice("FORGEMIND_EVAL_INPUT_USD_PER_MILLION");
  const outputPrice = optionalPrice("FORGEMIND_EVAL_OUTPUT_USD_PER_MILLION");
  return {
    modelCalls: calls.length,
    reworkRounds: events.filter((event) => event.type === "gate.rejected").length,
    negotiations: events.filter((event) => event.type === "negotiation.resolved").length,
    crashRecoveries: 0,
    toolFailures: events.filter(
      (event) =>
        event.type === "tool.called" &&
        typeof event.data.result === "object" &&
        event.data.result !== null &&
        "ok" in event.data.result &&
        event.data.result.ok === false,
    ).length,
    unauthorizedToolCalls: events.filter(
      (event) =>
        event.type === "tool.called" &&
        typeof event.data.result === "object" &&
        event.data.result !== null &&
        "error" in event.data.result &&
        typeof event.data.result.error === "string" &&
        /not allowed|not allowlisted|policy denied/iu.test(event.data.result.error),
    ).length,
    inputTokens,
    outputTokens,
    estimatedCostUsd:
      inputPrice === null || outputPrice === null
        ? null
        : roundUsd((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000),
  };
}

function finalEvidence(
  gates: readonly RunExecution["result"]["context"]["gates"][number][],
): readonly VerificationEvidence[] {
  const latestTest = [...gates].reverse().find((gate) => gate.stage === "TEST");
  const latestReview = [...gates].reverse().find((gate) => gate.stage === "REVIEW");
  return [
    ...(latestTest?.verificationEvidence ?? []),
    ...(latestReview?.verificationEvidence ?? []),
  ];
}

async function createRepository(seed: Readonly<Record<string, string>>): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "forgemind-real-eval-"));
  await writeSeed(repository, {
    "package.json": '{"type":"module","scripts":{"test":"node --test"}}\n',
    ".gitignore": ".forgemind/\n",
    ...seed,
  });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "eval@forgemind.local"],
    ["config", "user.name", "ForgeMind Eval"],
    ["add", "."],
    ["commit", "-m", "eval fixture"],
  ]) {
    const result = await runProcess("git", args, {
      cwd: repository,
      timeoutMs: 30_000,
      maxBytes: 64_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  }
  return repository;
}

async function writeSeed(
  repository: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(repository, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function verifySum(repository: string): Promise<readonly string[]> {
  const source = path.join(repository, "src", "sum.js");
  if (!(await exists(source))) return ["src/sum.js was not created"];
  const behavior = await runProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('./src/sum.js').then(({sum})=>{if(sum(2,3)!==5||sum(-2,1)!==-1)process.exit(9)})",
    ],
    { cwd: repository, timeoutMs: 30_000, maxBytes: 64_000 },
  );
  const tests = await runProcess(process.execPath, ["--test"], {
    cwd: repository,
    timeoutMs: 30_000,
    maxBytes: 64_000,
  });
  return [
    ...(behavior.exitCode === 0 ? [] : ["hidden signed-integer behavior check failed"]),
    ...(tests.exitCode === 0 ? [] : ["node --test failed after the run"]),
  ];
}

async function verifyGreeting(repository: string): Promise<readonly string[]> {
  return await verifyModuleBehavior(
    repository,
    "Promise.all([import('./src/constants.js'),import('./src/greet.js')]).then(([{GREETING},{greet}])=>{if(GREETING!=='hello'||greet('Ada')!=='hello, Ada!')process.exit(9)})",
    "hidden cross-file greeting behavior check failed",
  );
}

async function verifyVersion(repository: string): Promise<readonly string[]> {
  return await verifyModuleBehavior(
    repository,
    "import('./src/version.js').then(({version})=>{if(version!==2)process.exit(9)})",
    "version did not recover to 2",
  );
}

async function verifyDivide(repository: string): Promise<readonly string[]> {
  return await verifyModuleBehavior(
    repository,
    "import('./src/divide.js').then(({safeDivide})=>{if(safeDivide(6,3)!==2)process.exit(9);try{const value=safeDivide(1,0);if(value!==null)process.exit(10)}catch{}})",
    "safeDivide behavior did not match either negotiated zero-handling alternative",
  );
}

async function verifyModuleBehavior(
  repository: string,
  script: string,
  failure: string,
): Promise<readonly string[]> {
  const behavior = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repository,
    timeoutMs: 30_000,
    maxBytes: 64_000,
  });
  const tests = await runProcess(process.execPath, ["--test"], {
    cwd: repository,
    timeoutMs: 30_000,
    maxBytes: 64_000,
  });
  return [
    ...(behavior.exitCode === 0 ? [] : [failure]),
    ...(tests.exitCode === 0 ? [] : ["node --test failed after the run"]),
  ];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function optionalPrice(name: string): number | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function acceptanceContract(): readonly AcceptanceCriterion[] {
  return [
    {
      id: "AC-1",
      description: "sum(2, 3) returns 5 and sum(-2, 1) returns -1",
      requiredEvidence: ["test"],
      verifier: { kind: "behavior", probeId: "signed-sum-probe" },
    },
    {
      id: "AC-2",
      description: "node --test passes",
      requiredEvidence: ["test"],
      verifier: { kind: "test-suite", commandId: "primary" },
    },
  ];
}

function signedSumProbe() {
  return {
    id: "signed-sum-probe",
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      "import('./src/sum.js').then(({sum})=>{if(sum(2,3)!==5||sum(-2,1)!==-1)process.exit(9)})",
    ],
  } as const;
}

function reworkProbe(): BehaviorProbe {
  return { ...signedSumProbe(), id: "rework-probe" };
}

function greetingProbe(): BehaviorProbe {
  return {
    id: "greeting-probe",
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      "Promise.all([import('./src/constants.js'),import('./src/greet.js')]).then(([{GREETING},{greet}])=>{if(GREETING!=='hello'||greet('Ada')!=='hello, Ada!')process.exit(9)})",
    ],
  };
}

function divideProbe(): BehaviorProbe {
  return {
    id: "divide-probe",
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      "import('./src/divide.js').then(({safeDivide})=>{if(safeDivide(6,3)!==2)process.exit(9);try{const value=safeDivide(1,0);if(value!==null)process.exit(10)}catch{}})",
    ],
  };
}

class InjectRegressionOnceProcessRunner implements ProcessRunner {
  public readonly isolation: string;
  #failed = false;

  public constructor(
    private readonly delegate: ProcessRunner,
    private readonly targetCommand: readonly string[],
  ) {
    if (targetCommand.length === 0) throw new Error("Fault injection requires a target command");
    this.isolation = `${delegate.isolation}+post-code-regression`;
  }

  public async run(
    invocation: ProcessInvocation,
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    if (!this.#failed && commandMatches(invocation, this.targetCommand)) {
      this.#failed = true;
      await writeFile(
        path.join(options.cwd, "src", "sum.js"),
        "export function sum(left, right) {\n  return left - right;\n}\n",
        "utf8",
      );
    }
    return await this.delegate.run(invocation, options);
  }
}

class CrashAfterFileActionJournal implements ActionJournal {
  public crashed = false;

  public constructor(private readonly delegate: FileActionJournal) {}

  public get(id: string): Promise<ActionJournalRecord | null> {
    return this.delegate.get(id);
  }

  public planned(
    id: string,
    signature: string,
    expectation: { readonly beforeHash: string; readonly expectedAfterHash: string },
  ): Promise<ActionJournalRecord> {
    return this.delegate.planned(id, signature, expectation);
  }

  public async executed(id: string): Promise<ActionJournalRecord> {
    const record = await this.delegate.get(id);
    if (!this.crashed && record !== null && isFileAction(record.signature)) {
      this.crashed = true;
      throw new CancellationFailure("Injected crash after file mutation and before EXECUTED");
    }
    return await this.delegate.executed(id);
  }

  public verified(id: string, workspaceFingerprint: string): Promise<ActionJournalRecord> {
    return this.delegate.verified(id, workspaceFingerprint);
  }
}

function commandMatches(invocation: ProcessInvocation, expected: readonly string[]): boolean {
  return (
    invocation.command === expected[0] &&
    invocation.args.length === expected.length - 1 &&
    invocation.args.every((part, index) => part === expected[index + 1])
  );
}

function isFileAction(signature: string): boolean {
  try {
    const value: unknown = JSON.parse(signature);
    return (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      (value.kind === "write" || value.kind === "edit")
    );
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requestedProvider =
    process.env["FORGEMIND_EVAL_PROVIDER"] ?? configuredProviderId(process.env);
  if (!isProviderId(requestedProvider)) {
    process.stderr.write(`Unknown FORGEMIND_EVAL_PROVIDER: ${requestedProvider}.\n`);
    process.exitCode = 2;
  } else {
    const definition = providerDefinition(requestedProvider);
    const apiKey = resolveProviderApiKey(requestedProvider, process.env);
    const model =
      process.env["FORGEMIND_EVAL_MODEL"] ??
      process.env["FORGEMIND_MODEL"] ??
      definition.defaultModel;
    const baseUrl =
      process.env["FORGEMIND_EVAL_BASE_URL"] ??
      (requestedProvider === "custom" ? process.env["OPENAI_BASE_URL"] : definition.baseUrl);
    if (apiKey === undefined || model.trim().length === 0 || baseUrl === undefined) {
      process.stderr.write(
        `Real evaluation requires a model, endpoint, and one of these credentials for ${requestedProvider}: ${definition.apiKeyEnvironments.join(", ")}.\n`,
      );
      process.exitCode = 2;
    } else {
      const report = await runRealAgentEvaluation({
        apiKey,
        model,
        baseUrl,
        keepRepositories: process.env["FORGEMIND_EVAL_KEEP_REPOS"] === "1",
      });
      const outputPath = path.resolve(
        process.env["FORGEMIND_EVAL_RESULTS_PATH"] ??
          path.join("evals", "results", "latest-real-agent.json"),
      );
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`Saved real-agent evidence to ${outputPath}.\n`);
      if (report.passRate < 1) process.exitCode = 1;
    }
  }
}
