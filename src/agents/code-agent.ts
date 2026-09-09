import { createHash } from "node:crypto";
import { renderAcceptanceContract } from "../core/acceptance.js";
import { StageFailure } from "../core/errors.js";
import { RunStopFailure } from "../core/run-budget.js";
import { FatalFailure } from "../core/errors.js";
import type { ActionJournal, ActionJournalRecord } from "../core/action-journal.js";
import { truncateUtf8 } from "../core/text.js";
import type { ArtifactRef, StageInput, StageOutput, TaskContext } from "../core/types.js";
import { workspaceFingerprint } from "../core/workspace-fingerprint.js";
import { rankWorkspaceFiles, searchTerms, type GrepMatch } from "../context/assembler.js";
import type { ToolResult } from "../tools/types.js";
import type { BaseAgentOptions } from "./base-agent.js";
import { BaseAgent } from "./base-agent.js";
import { objectArray, requiredString, stringArray } from "./validation.js";

export const CODE_TOOLS = [
  "glob",
  "grep",
  "read_file",
  "write_file",
  "edit_file",
  "git_status",
  "git_diff",
  "run_command",
] as const;

export type CodeLoopStopReason = "NO_PROGRESS" | "MAX_STEPS" | "MAX_TOOL_FAILURES";

export interface CodeLoopState {
  readonly step: number;
  readonly todo: readonly string[];
  readonly completed: readonly string[];
  readonly changedPaths: readonly string[];
  readonly lastObservation: string;
  readonly workspaceFingerprint: string;
  readonly repeatedActionCount: number;
  readonly consecutiveFailures: number;
}

type CodeAction =
  | { readonly kind: "inspect"; readonly paths: readonly string[] }
  | { readonly kind: "search"; readonly queries: readonly string[] }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
    }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "fast-check"; readonly checkId: string }
  | { readonly kind: "finish"; readonly evidence: string };

interface CodeAgentOptions extends Omit<BaseAgentOptions, "id" | "tools"> {
  readonly fastChecks?: Readonly<Record<string, readonly string[]>>;
  readonly maxSteps?: number;
  readonly actionJournal?: ActionJournal;
}

const DEFAULT_MAX_STEPS = 10;
const MAX_ACTIONS_PER_STEP = 3;
const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_BYTES = 80_000;
const MAX_OBSERVATION_BYTES = 24_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export class CodeLoopFailure extends RunStopFailure {
  public constructor(stopReason: CodeLoopStopReason, message: string) {
    super(stopReason, message);
  }
}

export class CodeAgent extends BaseAgent {
  readonly #fastChecks: ReadonlyMap<string, readonly string[]>;
  readonly #maxSteps: number;
  readonly #actionJournal: ActionJournal | undefined;

  public constructor(options: CodeAgentOptions) {
    super({ ...options, id: "CODE", tools: CODE_TOOLS });
    this.#fastChecks = new Map(Object.entries(options.fastChecks ?? {}));
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#actionJournal = options.actionJournal;
    if (!Number.isInteger(this.#maxSteps) || this.#maxSteps < 1 || this.#maxSteps > 10) {
      throw new StageFailure("CODE maxSteps must be an integer between 1 and 10");
    }
  }

  protected async execute(input: StageInput, ctx: TaskContext): Promise<StageOutput> {
    if (ctx.plan === null) throw new StageFailure("CODE requires a completed task plan");
    const initialContext = await this.collectWorkspaceContext(ctx);
    let fingerprint = await this.readWorkspaceFingerprint();
    const changedPaths = new Set<string>();
    const completed = new Set<string>();
    let todo: readonly string[] = ctx.plan.steps.map((step) => step.title);
    let lastObservation = initialContext.content;
    let previousRoundSignature: string | undefined;
    let repeatedObservationActionRounds = 0;
    let consecutiveFailures = 0;
    let lastFailedActionObservation: string | undefined;
    let repeatedFailedActionCount = 0;

    for (let step = 1; step <= this.#maxSteps; step += 1) {
      const state: CodeLoopState = {
        step,
        todo,
        completed: [...completed],
        changedPaths: [...changedPaths].sort(),
        lastObservation,
        workspaceFingerprint: fingerprint,
        repeatedActionCount: Math.max(repeatedObservationActionRounds, repeatedFailedActionCount),
        consecutiveFailures,
      };
      const response = await this.completeJson(
        ctx,
        this.sections(ctx, input, state, initialContext.references),
        {
          maxSteps: String(this.#maxSteps),
          maxActions: String(MAX_ACTIONS_PER_STEP),
          fastCheckIds: [...this.#fastChecks.keys()].sort().join(", ") || "none",
        },
      );
      const basedOnEvidence = requiredString(response, "basedOnEvidence");
      const nextTodo = stringArray(response, "todo");
      const actions = await this.recoverInterruptedActions(
        input.attempt,
        step,
        parseActions(response),
      );
      const observations: string[] = [`Decision evidence: ${basedOnEvidence}`];
      let finishEvidence: string | undefined;
      let roundFailed = false;
      const executedJournalIds: string[] = [];

      for (const [index, action] of actions.entries()) {
        if (finishEvidence !== undefined) {
          throw new StageFailure("CODE finish must be the final action in a step");
        }
        const journalId = `CODE:${input.attempt}:${step}:${index + 1}`;
        const signature = actionSignature(action);
        let journalRecord = (await this.#actionJournal?.get(journalId)) ?? undefined;
        if (journalRecord !== undefined && journalRecord.signature !== signature) {
          throw new FatalFailure(`Action journal conflict for ${journalId}`);
        }
        let journalPlanned = journalRecord !== undefined;
        if (this.#actionJournal !== undefined && journalRecord === undefined) {
          const expectation = await this.prepareActionExpectation(action, fingerprint);
          if (expectation !== null) {
            journalRecord = await this.#actionJournal.planned(journalId, signature, expectation);
            journalPlanned = true;
          }
        }
        const reconciled = await this.reconcileAction(action, journalRecord, changedPaths);
        const outcome = reconciled ?? (await this.executeAction(action, changedPaths));
        observations.push(outcome.observation);
        if (outcome.ok) {
          lastFailedActionObservation = undefined;
          repeatedFailedActionCount = 0;
          if (reconciled === undefined && journalPlanned) {
            await this.#actionJournal?.executed(journalId);
          }
          if (journalPlanned) executedJournalIds.push(journalId);
          if (action.kind === "finish") finishEvidence = action.evidence;
          continue;
        }
        roundFailed = true;
        const failureSignature = observationActionSignature([action], [outcome.observation], []);
        repeatedFailedActionCount =
          failureSignature === lastFailedActionObservation ? repeatedFailedActionCount + 1 : 1;
        lastFailedActionObservation = failureSignature;
        if (repeatedFailedActionCount >= 2) {
          throw new CodeLoopFailure(
            "MAX_TOOL_FAILURES",
            `the same action failed twice: ${signature}`,
          );
        }
        if (index < actions.length - 1)
          observations.push("Remaining actions deferred after failure.");
        break;
      }

      const nextFingerprint = await this.readWorkspaceFingerprint();
      for (const journalId of executedJournalIds) {
        await this.#actionJournal?.verified(journalId, nextFingerprint);
      }
      const roundSignature = observationActionSignature(actions, observations.slice(1), nextTodo);
      if (nextFingerprint !== fingerprint) {
        repeatedObservationActionRounds = 0;
      } else if (roundSignature === previousRoundSignature) {
        repeatedObservationActionRounds += 1;
      } else {
        repeatedObservationActionRounds = 0;
      }
      previousRoundSignature = roundSignature;
      fingerprint = nextFingerprint;
      consecutiveFailures = roundFailed ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new CodeLoopFailure(
          "MAX_TOOL_FAILURES",
          `${consecutiveFailures} consecutive action steps failed`,
        );
      }
      for (const item of todo) if (!nextTodo.includes(item)) completed.add(item);
      todo = nextTodo;
      lastObservation = truncateUtf8(observations.join("\n"), MAX_OBSERVATION_BYTES).text;

      if (finishEvidence !== undefined) {
        if (roundFailed) throw new StageFailure("CODE cannot finish in a failed action step");
        if (todo.length > 0)
          throw new StageFailure("CODE cannot finish with unresolved todo items");
        if (changedPaths.size === 0) throw new StageFailure("CODE cannot finish without a change");
        const artifacts: ArtifactRef[] = [...changedPaths].sort().map((artifactPath) => ({
          path: artifactPath,
          kind: "source",
          stage: "CODE",
          summary: finishEvidence,
        }));
        return { kind: "code", summary: finishEvidence, artifacts };
      }
      if (repeatedObservationActionRounds >= 1) {
        throw new CodeLoopFailure(
          "NO_PROGRESS",
          "the same actions produced the same observations without changing the workspace",
        );
      }
    }
    throw new CodeLoopFailure("MAX_STEPS", `CODE did not finish within ${this.#maxSteps} steps`);
  }

  private sections(
    ctx: TaskContext,
    input: StageInput,
    state: CodeLoopState,
    initialReferences: readonly string[],
  ) {
    return [
      {
        name: "Requirement",
        content: ctx.requirement,
        source: "contract" as const,
        trust: ctx.requirementTrust ?? "trusted",
      },
      {
        name: "Plan",
        content: ctx.plan?.summary ?? "missing",
        source: "contract" as const,
        trust: "untrusted" as const,
      },
      {
        name: "Acceptance contract",
        content: renderAcceptanceContract(ctx.plan?.acceptanceCriteria ?? []),
        source: "contract" as const,
        trust: "untrusted" as const,
      },
      {
        name: "Architecture",
        content: ctx.architecture?.summary ?? "No separate architecture stage was selected.",
        source: "contract" as const,
        trust: "untrusted" as const,
      },
      {
        name: "Upstream handoff evidence",
        content: renderUpstreamHandoffs(ctx),
        source: "retrieval" as const,
        references: (ctx.upstreamHandoffs ?? []).flatMap((handoff) =>
          handoff.artifacts.map(
            (artifact) =>
              `${handoff.taskId}:${artifact.path}@${artifact.version ?? handoff.commit}`,
          ),
        ),
      },
      {
        name: "Cumulative rework evidence",
        content: input.feedback ?? "none",
        source: "rework" as const,
      },
      {
        name: "Code loop state and latest observation",
        content: JSON.stringify(state, null, 2),
        source: "retrieval" as const,
        references: initialReferences,
      },
    ];
  }

  private async recoverInterruptedActions(
    attempt: number,
    step: number,
    proposed: readonly CodeAction[],
  ): Promise<readonly CodeAction[]> {
    if (this.#actionJournal === undefined) return proposed;
    const recorded: CodeAction[] = [];
    for (let index = 1; index <= MAX_ACTIONS_PER_STEP; index += 1) {
      const record = await this.#actionJournal.get(`CODE:${attempt}:${step}:${index}`);
      if (record === null) break;
      recorded.push(parseRecordedAction(record));
    }
    if (recorded.length === 0) return proposed;
    if (
      recorded.every(
        (action, index) => actionSignature(action) === actionSignature(proposed[index]!),
      )
    ) {
      return proposed;
    }
    return recorded;
  }

  private async executeAction(
    action: CodeAction,
    changedPaths: Set<string>,
  ): Promise<{ readonly ok: boolean; readonly observation: string }> {
    switch (action.kind) {
      case "inspect": {
        const excerpts: string[] = [];
        for (const file of action.paths.slice(0, MAX_CONTEXT_FILES)) {
          const result = await this.toolExecutor.execute("read_file", {
            path: file,
            startLine: 1,
            endLine: 800,
          });
          if (!result.ok) return failedObservation(action, result);
          excerpts.push(`--- ${file} ---\n${extractReadContent(result)}`);
        }
        return {
          ok: true,
          observation: truncateUtf8(excerpts.join("\n"), MAX_OBSERVATION_BYTES).text,
        };
      }
      case "search": {
        const result = await this.toolExecutor.execute("grep", {
          queries: action.queries,
          pattern: "**/*",
          caseSensitive: false,
        });
        if (!result.ok) return failedObservation(action, result);
        return {
          ok: true,
          observation: truncateUtf8(JSON.stringify(result.data), MAX_OBSERVATION_BYTES).text,
        };
      }
      case "edit": {
        assertWritableCodePath(action.path);
        const result = await this.toolExecutor.execute("edit_file", {
          path: action.path,
          search: action.oldText,
          replacement: action.newText,
          expectedOccurrences: 1,
        });
        if (!result.ok) {
          const refreshed = await this.toolExecutor.execute("read_file", {
            path: action.path,
            startLine: 1,
            endLine: 2_000,
          });
          return {
            ok: false,
            observation: truncateUtf8(
              [
                `edit failed: ${result.error ?? "unknown error"}`,
                refreshed.ok
                  ? `Latest ${action.path}:\n${extractReadContent(refreshed)}`
                  : `Could not refresh ${action.path}: ${refreshed.error ?? "unknown error"}`,
              ].join("\n"),
              MAX_OBSERVATION_BYTES,
            ).text,
          };
        }
        changedPaths.add(action.path);
        return { ok: true, observation: `Edited ${action.path}` };
      }
      case "write": {
        assertWritableCodePath(action.path);
        const result = await this.toolExecutor.execute("write_file", {
          path: action.path,
          content: action.content,
        });
        if (!result.ok) return failedObservation(action, result);
        changedPaths.add(action.path);
        return { ok: true, observation: `Wrote ${action.path}` };
      }
      case "fast-check": {
        const command = this.#fastChecks.get(action.checkId);
        if (command === undefined) {
          return { ok: false, observation: `Unknown pre-registered fast check: ${action.checkId}` };
        }
        const [executable, ...args] = command;
        if (executable === undefined) {
          return { ok: false, observation: `Fast check ${action.checkId} has no command` };
        }
        const result = await this.toolExecutor.execute("run_command", {
          command: executable,
          args,
        });
        return {
          ok: result.ok,
          observation: truncateUtf8(
            `Fast check ${action.checkId}: ok=${result.ok}\n${processOutput(result)}`,
            MAX_OBSERVATION_BYTES,
          ).text,
        };
      }
      case "finish":
        return { ok: true, observation: `Finish requested: ${action.evidence}` };
    }
  }

  private async reconcileAction(
    action: CodeAction,
    record: ActionJournalRecord | undefined,
    changedPaths: Set<string>,
  ): Promise<{ readonly ok: true; readonly observation: string } | undefined> {
    if (record === undefined) return undefined;
    if (action.kind === "inspect" || action.kind === "search" || action.kind === "fast-check") {
      if (record.state === "PLANNED") return undefined;
      return { ok: true, observation: `Recovered side-effect-free action ${record.id}` };
    }
    if (action.kind === "finish") {
      if (record.state === "PLANNED") return undefined;
      return { ok: true, observation: `Recovered finish action ${record.id}` };
    }
    const current = await this.readFileSnapshot(action.path);
    if (current.hash === record.expectedAfterHash) {
      changedPaths.add(action.path);
      if (record.state === "PLANNED") await this.#actionJournal?.executed(record.id);
      return {
        ok: true,
        observation:
          record.state === "PLANNED"
            ? `Recovered action ${record.id}; its expected file state was already present`
            : `Reconciled ${record.state.toLowerCase()} action ${record.id} from file state`,
      };
    }
    if (record.state === "PLANNED" && current.hash === record.beforeHash) {
      return undefined;
    }
    throw new FatalFailure(
      `Action journal conflict for ${record.id}: current file state matches neither beforeHash nor expectedAfterHash; refusing to overwrite`,
    );
  }

  private async prepareActionExpectation(
    action: CodeAction,
    fingerprint: string,
  ): Promise<{ readonly beforeHash: string; readonly expectedAfterHash: string } | null> {
    if (action.kind !== "write" && action.kind !== "edit") {
      return { beforeHash: fingerprint, expectedAfterHash: fingerprint };
    }
    assertWritableCodePath(action.path);
    const before = await this.readFileSnapshot(action.path);
    let expectedContent: string;
    if (action.kind === "write") {
      expectedContent = action.content;
    } else {
      if (before.content === null || countOccurrences(before.content, action.oldText) !== 1) {
        return null;
      }
      expectedContent = before.content.replace(action.oldText, action.newText);
    }
    const expectedAfterHash = fileStateHash(expectedContent);
    if (expectedAfterHash === before.hash) {
      throw new StageFailure(`${action.kind} action for ${action.path} would not change the file`);
    }
    return { beforeHash: before.hash, expectedAfterHash };
  }

  private async readFileSnapshot(
    filePath: string,
  ): Promise<{ readonly content: string | null; readonly hash: string }> {
    const result = await this.toolExecutor.execute("read_file", { path: filePath });
    if (!result.ok) {
      if (isNotFoundResult(result)) return { content: null, hash: fileStateHash(null) };
      throw new FatalFailure(`Cannot inspect ${filePath} for action recovery: ${result.error}`);
    }
    if (result.truncated === true) {
      throw new FatalFailure(`Cannot journal a truncated file snapshot for ${filePath}`);
    }
    const content = extractReadContent(result);
    return { content, hash: fileStateHash(content) };
  }

  private async readWorkspaceFingerprint(): Promise<string> {
    const result = await this.requireTool("git_diff", {});
    return workspaceFingerprint(extractDiff(result));
  }

  private async collectWorkspaceContext(
    ctx: TaskContext,
  ): Promise<{ readonly content: string; readonly references: readonly string[] }> {
    const glob = await this.requireTool("glob", { pattern: "**/*" });
    const files = extractFiles(glob).filter(
      (file) => !file.startsWith("docs/.forgemind/") && isLikelyText(file),
    );
    const preferred = ctx.architecture?.files.map((file) => file.path) ?? [];
    const queries = searchTerms(`${ctx.requirement} ${ctx.architecture?.summary ?? ""}`);
    const grepMatches: GrepMatch[] = [];
    if (queries.length > 0) {
      const result = await this.requireTool("grep", {
        queries,
        pattern: "**/*",
        caseSensitive: false,
      });
      grepMatches.push(...extractGrepMatches(result));
    }
    const selected = rankWorkspaceFiles({
      files,
      expectedFiles: preferred,
      query: `${ctx.requirement} ${ctx.architecture?.summary ?? ""}`,
      grepMatches,
      limit: MAX_CONTEXT_FILES,
    });
    const excerpts: string[] = [
      `Workspace files (${files.length}):\n${files.slice(0, 300).join("\n")}`,
    ];
    for (const file of selected) {
      const result = await this.requireTool("read_file", {
        path: file,
        startLine: 1,
        endLine: 400,
      });
      excerpts.push(`--- ${file} ---\n${extractReadContent(result)}`);
    }
    const matchSummary = grepMatches
      .slice(0, 30)
      .map((match) => `${match.path}:${match.line}: ${match.text}`)
      .join("\n");
    if (matchSummary.length > 0) excerpts.splice(1, 0, `Relevant grep matches:\n${matchSummary}`);
    return {
      content: truncateUtf8(excerpts.join("\n"), MAX_CONTEXT_BYTES).text,
      references: [
        ...selected,
        ...new Set(grepMatches.slice(0, 30).map((match) => `${match.path}:${match.line}`)),
      ],
    };
  }
}

function parseActions(response: Readonly<Record<string, unknown>>): readonly CodeAction[] {
  const raw = objectArray(response, "actions");
  if (raw.length < 1 || raw.length > MAX_ACTIONS_PER_STEP) {
    throw new StageFailure(`CODE must return 1-${MAX_ACTIONS_PER_STEP} actions per step`);
  }
  return raw.map(parseAction);
}

function parseRecordedAction(record: ActionJournalRecord): CodeAction {
  let raw: unknown;
  try {
    raw = JSON.parse(record.signature);
  } catch (error) {
    throw new FatalFailure(`Action journal ${record.id} contains an invalid action signature`, {
      cause: error,
    });
  }
  if (!isRecord(raw)) {
    throw new FatalFailure(`Action journal ${record.id} contains a non-object action signature`);
  }
  try {
    return parseAction(raw);
  } catch (error) {
    throw new FatalFailure(`Action journal ${record.id} contains an unsupported action`, {
      cause: error,
    });
  }
}

function parseAction(item: Readonly<Record<string, unknown>>): CodeAction {
  const kind = requiredString(item, "kind");
  switch (kind) {
    case "inspect":
      return { kind, paths: nonEmptyStringArray(item, "paths") };
    case "search":
      return { kind, queries: nonEmptyStringArray(item, "queries") };
    case "edit":
      return {
        kind,
        path: requiredString(item, "path"),
        oldText: requiredString(item, "oldText"),
        newText: stringValue(item, "newText"),
      };
    case "write":
      return { kind, path: requiredString(item, "path"), content: stringValue(item, "content") };
    case "fast-check":
      return { kind, checkId: requiredString(item, "checkId") };
    case "finish":
      return { kind, evidence: requiredString(item, "evidence") };
    default:
      throw new StageFailure(`CODE returned unsupported action kind: ${kind}`);
  }
}

function nonEmptyStringArray(
  item: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const values = stringArray(item, key);
  if (
    values.length === 0 ||
    values.length > 8 ||
    values.some((value) => value.trim().length === 0)
  ) {
    throw new StageFailure(`${key} must contain 1-8 non-empty strings`);
  }
  return values;
}

function stringValue(item: Readonly<Record<string, unknown>>, key: string): string {
  const value = item[key];
  if (typeof value !== "string") throw new StageFailure(`${key} must be a string`);
  return value;
}

function assertWritableCodePath(pathValue: string): void {
  if (pathValue.startsWith("docs/.forgemind/")) {
    throw new StageFailure("CODE cannot modify orchestration artifacts");
  }
}

function actionSignature(action: CodeAction): string {
  return JSON.stringify(action);
}

function observationActionSignature(
  actions: readonly CodeAction[],
  observations: readonly string[],
  todo: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actions: actions.map(actionSignature),
        observations,
        todo,
      }),
    )
    .digest("hex");
}

function fileStateHash(content: string | null): string {
  return createHash("sha256")
    .update(content === null ? "absent\0" : `present\0${content}`)
    .digest("hex");
}

function isNotFoundResult(result: ToolResult): boolean {
  return (
    typeof result.data === "object" &&
    result.data !== null &&
    "code" in result.data &&
    result.data.code === "NOT_FOUND"
  );
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const index = content.indexOf(search, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + search.length;
  }
}

function failedObservation(
  action: CodeAction,
  result: ToolResult,
): { readonly ok: false; readonly observation: string } {
  return { ok: false, observation: `${action.kind} failed: ${result.error ?? "unknown error"}` };
}

function renderUpstreamHandoffs(ctx: TaskContext): string {
  const handoffs = ctx.upstreamHandoffs ?? [];
  if (handoffs.length === 0) return "No upstream task handoffs.";
  return handoffs
    .map((handoff) =>
      [
        `Task ${handoff.taskId} (${handoff.repo})`,
        `Branch: ${handoff.branch}`,
        `Commit: ${handoff.commit}`,
        `Summary: ${handoff.summary}`,
        `Acceptance criteria: ${renderAcceptanceContract(handoff.acceptanceCriteria)}`,
        `Incomplete items: ${handoff.incompleteItems.join("; ") || "none"}`,
        `Artifacts: ${handoff.artifacts.map((artifact) => `${artifact.path}@${artifact.version ?? handoff.commit}`).join(", ") || "none"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function extractFiles(result: ToolResult): string[] {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("files" in data)) return [];
  const files = data.files;
  return Array.isArray(files) && files.every((item) => typeof item === "string") ? files : [];
}

function extractReadContent(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("content" in data)) return "";
  return typeof data.content === "string" ? data.content : "";
}

function extractDiff(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null || !("diff" in data)) {
    throw new StageFailure("git_diff did not return diff content");
  }
  if (typeof data.diff !== "string") throw new StageFailure("git_diff returned invalid content");
  return data.diff;
}

function processOutput(result: ToolResult): string {
  const data = result.data;
  if (typeof data !== "object" || data === null) return result.error ?? "";
  const stdout = "stdout" in data && typeof data.stdout === "string" ? data.stdout : "";
  const stderr = "stderr" in data && typeof data.stderr === "string" ? data.stderr : "";
  return `${stdout}\n${stderr}`.trim() || result.error || "<no output>";
}

function extractGrepMatches(result: ToolResult): GrepMatch[] {
  const data = result.data;
  if (!isRecord(data)) return [];
  const matches: unknown = data["matches"];
  if (!Array.isArray(matches)) return [];
  return matches.filter((match: unknown): match is GrepMatch => {
    if (!isRecord(match)) return false;
    return (
      typeof match["path"] === "string" &&
      typeof match["line"] === "number" &&
      typeof match["text"] === "string"
    );
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLikelyText(file: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|lock)$/i.test(file);
}
