import { HardFailure, StageFailure } from "../core/errors.js";
import type { ChatProvider } from "../llm/chat-provider.js";
import { supportsStructuredOutput } from "../llm/capabilities.js";
import type { DagPlan, DagTask } from "./types.js";

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DAG_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tasks"],
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "deps", "repo", "requirement"],
        properties: {
          taskId: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          repo: { type: "string" },
          requirement: { type: "string" },
        },
      },
    },
  },
} as const;

export interface DagPlannerOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly maxTasks?: number;
}

export class DagPlanner {
  readonly #provider: ChatProvider;
  readonly #model: string;
  readonly #maxTasks: number;

  public constructor(options: DagPlannerOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#maxTasks = options.maxTasks ?? 20;
    if (!Number.isInteger(this.#maxTasks) || this.#maxTasks < 1 || this.#maxTasks > 50) {
      throw new HardFailure("maxTasks must be an integer between 1 and 50");
    }
  }

  public async plan(requirement: string, repositories: readonly string[]): Promise<DagPlan> {
    const normalizedRequirement = requirement.trim();
    const normalizedRepositories = uniqueNonEmpty(repositories);
    if (normalizedRequirement.length === 0) throw new HardFailure("Requirement cannot be empty");
    if (normalizedRepositories.length === 0) {
      throw new HardFailure("At least one repository is required for a DAG plan");
    }
    const messages = [
      {
        role: "system" as const,
        content: [
          "You are ForgeMind's DAG planning agent.",
          "Decompose the requirement into bounded tasks with explicit dependencies.",
          "Every task must target exactly one repository from the allowlist.",
          "Use stable task ids and return JSON only with summary and tasks.",
          `Return at most ${this.#maxTasks} tasks. Never create cyclic or unknown dependencies.`,
        ].join(" "),
      },
      {
        role: "user" as const,
        content: `Requirement:\n${normalizedRequirement}\n\nRepository allowlist:\n${normalizedRepositories.join("\n")}`,
      },
    ];
    const completion = await this.#provider.complete(messages, {
      model: this.#model,
      temperature: 0,
      maxOutputTokens: 4_000,
      seed: 42,
      ...(supportsStructuredOutput(this.#provider)
        ? {
            structuredOutput: {
              name: "forgemind_dag_plan_v1",
              jsonSchema: DAG_PLAN_SCHEMA,
            },
          }
        : {}),
    });
    return parseDagPlan(completion.content, normalizedRepositories, this.#maxTasks);
  }
}

export function parseDagPlan(
  content: string,
  repositories: readonly string[],
  maxTasks = 20,
): DagPlan {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 50) {
    throw new HardFailure("maxTasks must be an integer between 1 and 50");
  }
  const value = parseObject(content);
  assertOnlyKeys(value, ["summary", "tasks"], "DAG plan");
  const summary = requiredString(value, "summary");
  const rawTasks: unknown = value["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > maxTasks) {
    throw new StageFailure(`DAG plan must contain 1-${maxTasks} tasks`);
  }
  const allowedRepositories = new Set(uniqueNonEmpty(repositories));
  const tasks = rawTasks.map((raw): DagTask => parseTask(raw, allowedRepositories));
  validateDagTasks(tasks);
  return { summary, tasks };
}

export function validateDagTasks(tasks: readonly DagTask[]): readonly string[] {
  if (tasks.length === 0) throw new HardFailure("DAG must contain at least one task");
  const byId = new Map<string, DagTask>();
  for (const task of tasks) {
    if (!TASK_ID_PATTERN.test(task.taskId))
      throw new HardFailure(`Invalid task id: ${task.taskId}`);
    if (byId.has(task.taskId)) throw new HardFailure(`Duplicate task id: ${task.taskId}`);
    if (task.repo.trim().length === 0)
      throw new HardFailure(`Task ${task.taskId} has no repository`);
    if (task.requirement.trim().length === 0) {
      throw new HardFailure(`Task ${task.taskId} has an empty requirement`);
    }
    byId.set(task.taskId, task);
  }
  const indegree = new Map(tasks.map((task) => [task.taskId, 0]));
  const dependents = new Map(tasks.map((task) => [task.taskId, [] as string[]]));
  for (const task of tasks) {
    const uniqueDeps = new Set(task.deps);
    if (uniqueDeps.size !== task.deps.length) {
      throw new HardFailure(`Task ${task.taskId} contains duplicate dependencies`);
    }
    for (const dependency of task.deps) {
      if (dependency === task.taskId) {
        throw new HardFailure(`Task ${task.taskId} cannot depend on itself`);
      }
      if (!byId.has(dependency)) {
        throw new HardFailure(`Task ${task.taskId} depends on unknown task ${dependency}`);
      }
      indegree.set(task.taskId, (indegree.get(task.taskId) ?? 0) + 1);
      dependents.get(dependency)?.push(task.taskId);
    }
  }
  const ready = tasks.filter((task) => indegree.get(task.taskId) === 0).map((task) => task.taskId);
  const order: string[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const taskId = ready[cursor];
    if (taskId === undefined) break;
    order.push(taskId);
    for (const dependent of dependents.get(taskId) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (order.length !== tasks.length) throw new HardFailure("DAG contains a dependency cycle");
  return order;
}

function parseTask(value: unknown, repositories: ReadonlySet<string>): DagTask {
  if (!isRecord(value)) throw new StageFailure("DAG task must be an object");
  assertOnlyKeys(value, ["taskId", "deps", "repo", "requirement"], "DAG task");
  const taskId = requiredString(value, "taskId");
  const repo = requiredString(value, "repo");
  const requirement = requiredString(value, "requirement");
  const depsValue: unknown = value["deps"];
  if (!Array.isArray(depsValue) || !depsValue.every((item) => typeof item === "string")) {
    throw new StageFailure(`Task ${taskId} deps must be an array of strings`);
  }
  if (!repositories.has(repo))
    throw new HardFailure(`Task ${taskId} targets unknown repository ${repo}`);
  return { taskId, repo, requirement, deps: depsValue };
}

function parseObject(content: string): Readonly<Record<string, unknown>> {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new StageFailure("DAG planner response is not JSON");
  try {
    const value: unknown = JSON.parse(trimmed.slice(start, end + 1));
    if (!isRecord(value)) throw new Error("JSON root must be an object");
    return value;
  } catch (error) {
    throw new StageFailure("DAG planner returned invalid JSON", { cause: error });
  }
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new StageFailure(`${key} must be a non-empty string`);
  }
  return result.trim();
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new StageFailure(`${location} contains unknown field ${unknown}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
