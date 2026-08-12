import { randomUUID } from "node:crypto";
import { HardFailure } from "../core/errors.js";
import { runProcess } from "../tools/process.js";
import type { ProcessResult } from "../tools/process.js";
import type { ProcessInvocation, ProcessRunner, ProcessRunOptions } from "./types.js";

export interface ContainerProcessRunnerOptions {
  readonly runtime: "docker" | "podman";
  readonly image: string;
  readonly cpu: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  readonly network: boolean;
  readonly hostRunner?: typeof runProcess;
}

export class ContainerProcessRunner implements ProcessRunner {
  public readonly isolation: string;
  readonly #options: ContainerProcessRunnerOptions;
  readonly #hostRunner: typeof runProcess;

  public constructor(options: ContainerProcessRunnerOptions) {
    assertPinnedImage(options.image);
    assertPositive(options.cpu, "sandbox cpu");
    assertPositiveInteger(options.memoryMb, "sandbox memoryMb");
    assertPositiveInteger(options.pidsLimit, "sandbox pidsLimit");
    this.#options = options;
    this.#hostRunner = options.hostRunner ?? runProcess;
    this.isolation = `${options.runtime}:${options.image}`;
  }

  public async run(
    invocation: ProcessInvocation,
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    const containerName = `forgemind-${randomUUID()}`;
    const arguments_ = containerArguments(containerName, invocation, options, this.#options);
    const result = await this.#hostRunner(this.#options.runtime, arguments_, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });
    const cleanup =
      result.timedOut === true ? await this.cleanup(containerName, options.cwd) : null;
    return {
      ...result,
      sandbox: {
        mode: "container",
        runtime: this.#options.runtime,
        containerId: containerName,
        image: this.#options.image,
        network: this.#options.network,
        cpu: this.#options.cpu,
        memoryMb: this.#options.memoryMb,
        pidsLimit: this.#options.pidsLimit,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxBytes,
        cleanup: cleanup ?? "not-required",
      },
    };
  }

  private async cleanup(containerName: string, cwd: string): Promise<"succeeded" | "failed"> {
    try {
      const result = await this.#hostRunner(
        this.#options.runtime,
        ["rm", "--force", containerName],
        { cwd, timeoutMs: 10_000, maxBytes: 8_000 },
      );
      return result.exitCode === 0 ? "succeeded" : "failed";
    } catch {
      return "failed";
    }
  }
}

export function containerArguments(
  containerName: string,
  invocation: ProcessInvocation,
  options: ProcessRunOptions,
  sandbox: ContainerProcessRunnerOptions,
): readonly string[] {
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--cpus",
    String(sandbox.cpu),
    "--memory",
    `${sandbox.memoryMb}m`,
    "--pids-limit",
    String(sandbox.pidsLimit),
    "--network",
    sandbox.network ? "bridge" : "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${options.cwd},dst=/source,readonly`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--tmpfs",
    `/workspace:rw,nosuid,nodev,size=${sandbox.memoryMb}m`,
    "--env",
    "HOME=/tmp",
    "--env",
    "npm_config_cache=/tmp/npm",
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/bin/sh",
    sandbox.image,
    "-c",
    'cp -a /source/. /workspace/ && exec "$@"',
    "forgemind-entrypoint",
    invocation.command,
    ...invocation.args,
  ];
}

function assertPinnedImage(image: string): void {
  if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new HardFailure("Sandbox image must be pinned by sha256 digest");
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new HardFailure(`${name} must be positive`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HardFailure(`${name} must be a positive integer`);
  }
}
