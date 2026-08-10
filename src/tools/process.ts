import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
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
    let truncated = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const current = target === "stdout" ? stdout : stderr;
      const room = Math.max(0, options.maxBytes - Buffer.byteLength(current));
      if (room === 0) {
        truncated = true;
        return;
      }
      const value = chunk.subarray(0, room).toString("utf8");
      if (target === "stdout") stdout += value;
      else stderr += value;
      if (chunk.byteLength > room) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timeout.unref();

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal !== null) {
        stderr += `\nProcess terminated by ${signal}`;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr, truncated });
    });
  });
}
