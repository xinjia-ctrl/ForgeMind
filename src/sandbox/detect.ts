import { HardFailure } from "../core/errors.js";
import { runProcess } from "../tools/process.js";
import { ContainerProcessRunner } from "./docker.js";
import { LocalProcessRunner } from "./local.js";
import type { ProcessRunner, SandboxConfig } from "./types.js";

export interface CreateProcessRunnerOptions {
  readonly warn?: (message: string) => void;
}

export async function createProcessRunner(
  config: SandboxConfig,
  options: CreateProcessRunnerOptions = {},
): Promise<ProcessRunner> {
  if (config.mode === "local") {
    const warn =
      options.warn ??
      ((message: string): void => {
        process.stderr.write(`${message}\n`);
      });
    warn("ForgeMind security warning: sandbox.mode=local runs approved test commands on the host");
    return new LocalProcessRunner();
  }

  const runtime = await detectContainerRuntime(config.runtime ?? "auto");
  const image = config.image;
  if (image === undefined) {
    throw new HardFailure("sandbox.image is required and must be pinned by sha256 digest");
  }
  return new ContainerProcessRunner({
    runtime,
    image,
    cpu: config.cpu ?? 1,
    memoryMb: config.memoryMb ?? 512,
    pidsLimit: config.pidsLimit ?? 128,
    network: config.network ?? false,
  });
}

export async function detectContainerRuntime(
  requested: "docker" | "podman" | "auto",
  probe: typeof runProcess = runProcess,
): Promise<"docker" | "podman"> {
  const candidates = requested === "auto" ? (["docker", "podman"] as const) : [requested];
  for (const candidate of candidates) {
    try {
      const result = await probe(candidate, ["version"], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxBytes: 8_000,
      });
      if (result.exitCode === 0) return candidate;
    } catch {
      // Continue to the next explicitly supported runtime.
    }
  }
  throw new HardFailure(
    "No usable Docker or Podman runtime found; install one or explicitly configure sandbox.mode=local",
  );
}
