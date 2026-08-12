import { spawn } from "node:child_process";
import { truncateUtf8 } from "../core/text.js";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut?: boolean;
  readonly sandbox?: {
    readonly mode: "container" | "local";
    readonly runtime: "docker" | "podman" | "host";
    readonly containerId: string;
    readonly image?: string;
    readonly network: boolean;
    readonly cpu?: number;
    readonly memoryMb?: number;
    readonly pidsLimit?: number;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly cleanup?: "not-required" | "succeeded" | "failed";
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  },
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const room = Math.max(0, options.maxBytes - outputBytes);
      if (room === 0) {
        truncated = true;
        return;
      }
      const bounded = truncateUtf8(chunk.toString("utf8"), room);
      const value = bounded.text;
      if (target === "stdout") stdout += value;
      else stderr += value;
      outputBytes += bounded.bytes;
      if (bounded.truncated || chunk.byteLength > room) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timeout.unref();

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal !== null) {
        append("stderr", Buffer.from(`\nProcess terminated by ${signal}`));
      }
      resolve({ exitCode: code ?? 1, stdout, stderr, truncated, timedOut });
    });
  });
}
