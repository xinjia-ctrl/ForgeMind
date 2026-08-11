import type { StageId } from "../core/types.js";

export interface ToolResult<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly truncated?: boolean;
  readonly tokenCost?: number;
}

export interface ToolPolicyOptions {
  readonly workspaceRoot: string;
  readonly stage: StageId;
  readonly allowedTools: readonly string[];
  readonly writable: boolean;
  readonly writablePrefixes?: readonly string[];
  readonly forbiddenWritePrefixes?: readonly string[];
  readonly allowedCommands?: readonly (readonly string[])[];
  readonly maxResultBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly skipGitHooks?: boolean;
}

export class ToolPolicy {
  public readonly workspaceRoot: string;
  public readonly stage: StageId;
  public readonly allowedTools: ReadonlySet<string>;
  public readonly writable: boolean;
  public readonly writablePrefixes: readonly string[];
  public readonly forbiddenWritePrefixes: readonly string[];
  public readonly allowedCommands: readonly (readonly string[])[];
  public readonly maxResultBytes: number;
  public readonly commandTimeoutMs: number;
  public readonly skipGitHooks: boolean;

  public constructor(options: ToolPolicyOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.stage = options.stage;
    this.allowedTools = new Set(options.allowedTools);
    this.writable = options.writable;
    this.writablePrefixes = options.writablePrefixes ?? [];
    this.forbiddenWritePrefixes = options.forbiddenWritePrefixes ?? [];
    this.allowedCommands = options.allowedCommands ?? [];
    this.maxResultBytes = options.maxResultBytes ?? 128_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.skipGitHooks = options.skipGitHooks ?? false;
  }

  public allowsCommand(command: readonly string[]): boolean {
    return this.allowedCommands.some(
      (allowed) =>
        allowed.length === command.length &&
        allowed.every((part, index) => part === command[index]),
    );
  }

  public describe(): string {
    const access = this.writable ? "write" : "read-only";
    const hooks =
      this.stage === "COMMIT" ? `:hooks-${this.skipGitHooks ? "skipped" : "enabled"}` : "";
    return `${this.stage}:${access}${hooks}`;
  }
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(args: unknown, policy: ToolPolicy): Promise<ToolResult>;
}
