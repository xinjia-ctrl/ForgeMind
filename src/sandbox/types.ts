import type { ProcessResult } from "../tools/process.js";

export type SandboxMode = "container" | "local";

export interface SandboxConfig {
  readonly mode: SandboxMode;
  readonly runtime?: "docker" | "podman" | "auto";
  readonly image?: string;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
  readonly network?: boolean;
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ProcessRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface ProcessRunner {
  readonly isolation: string;
  run(invocation: ProcessInvocation, options: ProcessRunOptions): Promise<ProcessResult>;
}
