import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TOKEN_BUDGETS } from "../config/budgets.js";
import { authorize } from "../auth/rbac.js";
import type { Actor, RiskLevel } from "../auth/types.js";
import { loadPolicyConfig, type ForgeMindPolicyConfig } from "../config/policy.js";
import { DefaultAgentFactory } from "../core/agent-factory.js";
import { createTaskContext } from "../core/context.js";
import { assertValidRunId, assertValidTaskId, EventLog } from "../core/event-log.js";
import { Orchestrator } from "../core/orchestrator.js";
import { FileRunCheckpointStore, type RunCheckpointStore } from "../core/run-checkpoint.js";
import type { RunResult } from "../core/types.js";
import type { UpstreamHandoff } from "../core/types.js";
import type { AcceptanceCriterion } from "../core/types.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import { EpisodicMemory } from "../memory/episodic-memory.js";
import { LayeredMemory } from "../memory/layered-memory.js";
import type { MemoryProvider } from "../memory/memory-provider.js";
import { NoopMemoryProvider } from "../memory/noop-memory-provider.js";
import { ProjectMemory } from "../memory/project-memory.js";
import { SemanticMemory, type EmbeddingProvider } from "../memory/semantic-memory.js";
import { ChatNegotiationTurnProvider, NegotiationProtocol } from "../negotiation/protocol.js";
import { OneShotConflictResolver } from "../negotiation/resolver.js";
import { AutoApprovalGateway } from "../policy/auto-gateway.js";
import { DenyApprovalGateway, type ApprovalGateway } from "../policy/gateway.js";
import { InteractiveApprovalGateway } from "../policy/interactive-gateway.js";
import { RulePolicyResolver } from "../policy/resolver.js";
import { createProcessRunner } from "../sandbox/detect.js";
import type { ProcessRunner } from "../sandbox/types.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import { inspectGitWorkspace, prepareGitWorkspace, type GitWorkspace } from "./git-workspace.js";
import { resolveTestCommand } from "./test-command.js";
import { AcceptanceVerifierRegistry } from "../verification/acceptance-verifier.js";
import { selectRunProfile, type RunProfile, type RunProfileSignals } from "../core/run-profile.js";
import { FileRunArtifactStore } from "../core/run-artifact-store.js";
import { DEFAULT_RUN_BUDGET, RunBudgetTracker, type RunBudget } from "../core/run-budget.js";
import { initialAcceptanceHash, sha256, type RunManifest } from "../core/run-manifest.js";
import { PROMPT_VERSIONS } from "../prompts/index.js";
import { runProcess } from "../tools/process.js";
import { FileActionJournal, type ActionJournal } from "../core/action-journal.js";

export interface RunOptions {
  readonly repoPath: string;
  readonly requirement: string;
  readonly requirementTrust?: "trusted" | "untrusted";
  readonly provider: ChatProvider;
  readonly model: string;
  readonly runId?: string;
  readonly testCommand?: string;
  readonly maxRework?: number;
  readonly skipGitHooks?: boolean;
  readonly configPath?: string;
  readonly approveAll?: boolean;
  readonly noApprove?: boolean;
  readonly policyConfig?: ForgeMindPolicyConfig;
  readonly processRunner?: ProcessRunner;
  readonly approvalGateway?: ApprovalGateway;
  readonly memory?: boolean;
  readonly memoryProvider?: MemoryProvider;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly parentRunId?: string;
  readonly taskId?: string;
  readonly preparedWorkspace?: GitWorkspace;
  readonly actor?: Actor;
  readonly team?: string;
  readonly approvalRisk?: RiskLevel;
  readonly authorizationRepo?: string;
  readonly toolAllowlist?: readonly string[];
  readonly commandAllowlist?: readonly (readonly string[])[];
  readonly riskTransform?: (risk: RiskLevel) => RiskLevel;
  readonly acceptanceCriteria?: readonly AcceptanceCriterion[];
  readonly acceptanceVerifierRegistry?: AcceptanceVerifierRegistry;
  readonly upstreamHandoffs?: readonly UpstreamHandoff[];
  readonly signal?: AbortSignal;
  readonly resume?: boolean;
  readonly checkpointStore?: RunCheckpointStore;
  readonly profile?: RunProfile;
  readonly profileSignals?: Omit<RunProfileSignals, "repositoryCount">;
  readonly runBudget?: RunBudget;
  /** Internal composition hook used to share one budget across DAG child runs. */
  readonly runBudgetTracker?: RunBudgetTracker;
  readonly negotiationMode?: "one-shot" | "multi-round";
  /** Internal fault-injection and alternate-persistence hook. */
  readonly actionJournal?: ActionJournal;
}

export interface RunExecution {
  readonly result: RunResult;
  readonly eventLogPath: string;
}

export async function runForgeMind(options: RunOptions): Promise<RunExecution> {
  if (options.requirement.trim().length === 0) {
    throw new Error("Requirement cannot be empty");
  }
  if (options.requirement.length > 100_000) {
    throw new Error("Requirement exceeds the 100,000 character input limit");
  }
  if (
    options.maxRework !== undefined &&
    (!Number.isInteger(options.maxRework) || options.maxRework < 0)
  ) {
    throw new Error("maxRework must be a non-negative integer");
  }
  if (options.approveAll === true && options.noApprove === true) {
    throw new Error("approveAll and noApprove cannot both be enabled");
  }
  if (options.embeddingProvider !== undefined && options.memory !== true) {
    throw new Error("embeddingProvider requires memory to be enabled");
  }
  if (options.embeddingProvider !== undefined && options.memoryProvider !== undefined) {
    throw new Error("embeddingProvider and memoryProvider cannot both be provided");
  }
  if (options.resume === true && options.runId === undefined) {
    throw new Error("resume requires an explicit runId");
  }
  if (options.runBudget !== undefined && options.runBudgetTracker !== undefined) {
    throw new Error("runBudget and runBudgetTracker cannot both be provided");
  }
  if (options.resume === true && options.runBudgetTracker !== undefined) {
    throw new Error("resume cannot use an externally shared runBudgetTracker");
  }
  const runId = options.runId ?? createRunId();
  assertValidRunId(runId);
  if (options.parentRunId !== undefined) assertValidRunId(options.parentRunId);
  if (options.taskId !== undefined) assertValidTaskId(options.taskId);
  const inspected = await inspectGitWorkspace(options.repoPath);
  const authorizationRepo = options.authorizationRepo ?? inspected.root;
  if (
    options.actor !== undefined &&
    !authorize(
      options.actor,
      {
        repo: authorizationRepo,
        ...(options.team === undefined ? {} : { team: options.team }),
      },
      "run",
    )
  ) {
    throw new Error(`Actor ${options.actor.id} is not authorized to run in ${authorizationRepo}`);
  }
  if (options.preparedWorkspace !== undefined && options.resume !== true) {
    assertPreparedWorkspace(options.preparedWorkspace, inspected, runId);
  }
  const testCommand = await resolveTestCommand(inspected.root, options.testCommand);
  const profile = selectRunProfile({
    requirement: options.requirement,
    repositoryCount: 1,
    ...options.profileSignals,
    estimatedFileCount:
      options.profileSignals?.estimatedFileCount ??
      new Set(
        (options.acceptanceCriteria ?? []).flatMap((criterion) =>
          criterion.verifier.kind === "file" ? [criterion.verifier.path] : [],
        ),
      ).size,
    ...(options.profile === undefined ? {} : { explicit: options.profile }),
  });
  const acceptanceVerifiers =
    options.acceptanceVerifierRegistry ??
    new AcceptanceVerifierRegistry({
      workspaceRoot: inspected.root,
      commands: { primary: testCommand },
    });
  const policyConfig =
    options.policyConfig ??
    (await loadPolicyConfig({
      repositoryRoot: inspected.root,
      testCommand,
      verificationCommands: acceptanceVerifiers.commandAllowlist,
      ...(options.configPath === undefined ? {} : { explicitPath: options.configPath }),
    }));
  const processRunner = options.processRunner ?? (await createProcessRunner(policyConfig.sandbox));
  const initialHead = await readHead(inspected.root);
  const runBudgetConfig =
    options.runBudgetTracker?.budget ?? options.runBudget ?? DEFAULT_RUN_BUDGET;
  const manifest: RunManifest = {
    requirementHash: sha256(options.requirement.trim()),
    acceptanceContractHash: initialAcceptanceHash(options.acceptanceCriteria),
    initialHead,
    provider: options.provider.providerId ?? (options.provider.constructor.name || "ChatProvider"),
    model: options.model,
    promptVersions: PROMPT_VERSIONS,
    policyHash: sha256(policyConfig),
    testCommandHash: sha256({
      primary: testCommand,
      verifierRegistry: acceptanceVerifiers.fingerprint(),
    }),
    budgetHash: sha256(runBudgetConfig),
    upstreamCommitHashes: (options.upstreamHandoffs ?? []).map((handoff) => handoff.commit).sort(),
  };
  const approvalGateway = options.approvalGateway ?? approvalGatewayFor(options);
  const approvalContext =
    options.actor === undefined
      ? undefined
      : {
          actor: options.actor,
          scope: {
            repo: authorizationRepo,
            ...(options.team === undefined ? {} : { team: options.team }),
          },
          risk: options.approvalRisk ?? ("high" as const),
        };
  const policyResolver = new RulePolicyResolver(policyConfig.defaultMode, policyConfig.rules);
  if (options.memory === true) await excludeProjectMemory(inspected.commonGitDirectory);
  const workspace =
    options.preparedWorkspace ??
    (options.resume === true
      ? resumeGitWorkspace(inspected, runId)
      : await prepareGitWorkspace(options.repoPath, runId));
  const eventsDirectory = path.join(workspace.commonGitDirectory, "forgemind", "runs");
  const eventIndex = {
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  };
  const eventLog =
    options.resume === true
      ? EventLog.open(eventsDirectory, runId, eventIndex)
      : await EventLog.create(eventsDirectory, runId, eventIndex);
  const checkpointStore =
    options.checkpointStore ??
    new FileRunCheckpointStore(path.join(eventsDirectory, "checkpoints"));
  const artifactStore = new FileRunArtifactStore(path.join(eventsDirectory, runId, "artifacts"));
  const runBudget = options.runBudgetTracker ?? new RunBudgetTracker(runBudgetConfig);
  const actionJournal =
    options.actionJournal ??
    new FileActionJournal(path.join(eventsDirectory, runId, "artifacts", "code-actions.json"));
  const memory =
    options.memoryProvider ??
    (options.memory === true
      ? new LayeredMemory({
          layers: {
            episodic: new EpisodicMemory({ eventsDirectory, currentRunId: runId }),
            project: new ProjectMemory({
              repositoryRoot: workspace.root,
              writeEnabled: true,
              eventLog,
            }),
            semantic: new SemanticMemory({
              repositoryRoots: [workspace.root],
              ...(options.embeddingProvider === undefined
                ? {}
                : { embeddingProvider: options.embeddingProvider }),
            }),
          },
        })
      : new NoopMemoryProvider());
  const context = createTaskContext({
    runId,
    requirement: options.requirement.trim(),
    requirementTrust: options.requirementTrust ?? "trusted",
    ...(options.acceptanceCriteria === undefined
      ? {}
      : { requiredAcceptanceCriteria: options.acceptanceCriteria }),
    ...(options.upstreamHandoffs === undefined
      ? {}
      : { upstreamHandoffs: options.upstreamHandoffs }),
    repoPath: workspace.root,
    branch: workspace.branch,
    tokenBudget: DEFAULT_TOKEN_BUDGETS,
  });
  const factory = new DefaultAgentFactory({
    provider: options.provider,
    model: options.model,
    eventLog,
    registry: createDefaultToolRegistry(processRunner),
    runId,
    workspaceRoot: workspace.root,
    budgets: DEFAULT_TOKEN_BUDGETS,
    testCommand,
    acceptanceVerifiers,
    skipGitHooks: options.skipGitHooks ?? false,
    policyResolver,
    approvalGateway,
    ...(options.toolAllowlist === undefined ? {} : { toolAllowlist: options.toolAllowlist }),
    ...(options.commandAllowlist === undefined
      ? {}
      : { commandAllowlist: options.commandAllowlist }),
    ...(options.riskTransform === undefined ? {} : { riskTransform: options.riskTransform }),
    ...(approvalContext === undefined ? {} : { approvalContext }),
    memory,
    artifactStore,
    runBudget,
    actionJournal,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const negotiation =
    options.negotiationMode === "multi-round"
      ? new NegotiationProtocol({
          eventLog,
          proposal: new ChatNegotiationTurnProvider({
            provider: options.provider,
            model: options.model,
            eventLog,
            runBudget,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          counter: new ChatNegotiationTurnProvider({
            provider: options.provider,
            model: options.model,
            eventLog,
            runBudget,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
          approvalGateway,
          ...(approvalContext === undefined ? {} : { approvalContext }),
        })
      : new OneShotConflictResolver({
          provider: options.provider,
          model: options.model,
          eventLog,
          runBudget,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
  const orchestrator = new Orchestrator({
    eventLog,
    agentFactory: factory,
    memory,
    negotiation,
    checkpointStore,
    resume: options.resume ?? false,
    includeArchitecture: profile.includeArchitecture,
    runBudget,
    manifest,
    profile: profile.profile,
    profileReason: profile.reason,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxRework === undefined ? {} : { maxRework: options.maxRework }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  const result = await orchestrator.run(context);
  return { result, eventLogPath: eventLog.filePath };
}

function resumeGitWorkspace(inspected: Omit<GitWorkspace, "branch">, runId: string): GitWorkspace {
  const branch = `forgemind/${runId}`;
  if (inspected.originalBranch !== branch) {
    throw new Error(
      `Cannot resume ${runId}: workspace is on ${inspected.originalBranch}, expected ${branch}`,
    );
  }
  return { ...inspected, branch };
}

async function excludeProjectMemory(gitDirectory: string): Promise<void> {
  const infoDirectory = path.join(gitDirectory, "info");
  const excludePath = path.join(infoDirectory, "exclude");
  const rule = "/.forgemind/memory/";
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (content.split(/\r?\n/).includes(rule)) return;
  await mkdir(infoDirectory, { recursive: true });
  await appendFile(
    excludePath,
    `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${rule}\n`,
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function approvalGatewayFor(
  options: Pick<RunOptions, "approveAll" | "noApprove">,
): ApprovalGateway {
  if (options.approveAll === true) return new AutoApprovalGateway();
  if (options.noApprove === true || !process.stdin.isTTY || !process.stdout.isTTY) {
    return new DenyApprovalGateway();
  }
  return new InteractiveApprovalGateway({ input: process.stdin, output: process.stdout });
}

export function createRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function readHead(repositoryRoot: string): Promise<string> {
  const result = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    timeoutMs: 30_000,
    maxBytes: 8_000,
  });
  if (result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(result.stdout.trim())) {
    throw new Error("Cannot fingerprint the initial Git HEAD");
  }
  return result.stdout.trim();
}

function assertPreparedWorkspace(
  workspace: GitWorkspace,
  inspected: Omit<GitWorkspace, "branch">,
  runId: string,
): void {
  const expectedBranch = `forgemind/${runId}`;
  if (
    workspace.root !== inspected.root ||
    workspace.gitDirectory !== inspected.gitDirectory ||
    workspace.commonGitDirectory !== inspected.commonGitDirectory ||
    workspace.branch !== inspected.originalBranch ||
    workspace.branch !== expectedBranch
  ) {
    throw new Error(`Prepared workspace does not match run ${runId}`);
  }
}
