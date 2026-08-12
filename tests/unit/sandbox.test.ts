import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HardFailure } from "../../src/core/errors.js";
import { ContainerProcessRunner, containerArguments } from "../../src/sandbox/docker.js";
import { createProcessRunner, detectContainerRuntime } from "../../src/sandbox/detect.js";
import { RunCommandTool } from "../../src/tools/command-tools.js";
import { runProcess, type ProcessResult } from "../../src/tools/process.js";
import { ToolPolicy } from "../../src/tools/types.js";

const IMAGE = `node@sha256:${"a".repeat(64)}`;

describe("container sandbox", () => {
  it("builds a no-network, least-privilege, resource-bounded invocation", () => {
    const args = containerArguments(
      "forgemind-test",
      { command: "npm", args: ["test"] },
      { cwd: "/repo", timeoutMs: 10_000, maxBytes: 8_000 },
      {
        runtime: "docker",
        image: IMAGE,
        cpu: 1.5,
        memoryMb: 384,
        pidsLimit: 96,
        network: false,
      },
    );

    assert.ok(args.includes("--read-only"));
    assert.deepEqual(option(args, "--network"), "none");
    assert.deepEqual(option(args, "--cpus"), "1.5");
    assert.deepEqual(option(args, "--memory"), "384m");
    assert.deepEqual(option(args, "--pids-limit"), "96");
    assert.ok(args.includes("type=bind,src=/repo,dst=/source,readonly"));
    assert.ok(args.includes("/workspace:rw,nosuid,nodev,size=384m"));
    assert.ok(args.includes("no-new-privileges"));
    assert.equal(args.at(-2), "npm");
    assert.equal(args.at(-1), "test");
  });

  it("records isolation evidence and preserves a resource-limit failure", async () => {
    const invocations: Array<{ command: string; args: readonly string[] }> = [];
    const runner = new ContainerProcessRunner({
      runtime: "podman",
      image: IMAGE,
      cpu: 1,
      memoryMb: 512,
      pidsLimit: 128,
      network: false,
      hostRunner: (command, args): Promise<ProcessResult> => {
        invocations.push({ command, args });
        return Promise.resolve({
          exitCode: 137,
          stdout: "",
          stderr: "out of memory",
          truncated: true,
        });
      },
    });
    const result = await runner.run(
      { command: "node", args: ["--test"] },
      { cwd: "/repo", timeoutMs: 10_000, maxBytes: 8_000 },
    );
    assert.equal(invocations[0]?.command, "podman");
    assert.ok(result.sandbox);
    assert.equal(result.sandbox.runtime, "podman");
    assert.equal(result.sandbox.image, IMAGE);
    assert.match(result.sandbox.containerId, /^forgemind-/);
    assert.equal(result.sandbox.pidsLimit, 128);
    assert.equal(result.sandbox.timeoutMs, 10_000);
    assert.equal(result.sandbox.maxOutputBytes, 8_000);
    assert.equal(result.exitCode, 137);
    assert.equal(result.truncated, true);
  });

  it("enforces one shared byte limit across stdout and stderr", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('a'.repeat(40)); process.stderr.write('b'.repeat(40))"],
      { cwd: process.cwd(), timeoutMs: 10_000, maxBytes: 50 },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 50);
    assert.equal(result.truncated, true);
  });

  it("fails timed-out commands and force-removes their container", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = new ContainerProcessRunner({
      runtime: "docker",
      image: IMAGE,
      cpu: 1,
      memoryMb: 512,
      pidsLimit: 128,
      network: false,
      hostRunner: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(
          args[0] === "run"
            ? {
                exitCode: 0,
                stdout: "",
                stderr: "",
                truncated: false,
                timedOut: true,
              }
            : { exitCode: 0, stdout: "", stderr: "", truncated: false },
        );
      },
    });
    const tool = new RunCommandTool(runner);
    const result = await tool.execute(
      { command: "node", args: ["--test"] },
      new ToolPolicy({
        workspaceRoot: process.cwd(),
        stage: "TEST",
        allowedTools: ["run_command"],
        allowedCommands: [["node", "--test"]],
        writable: false,
        commandTimeoutMs: 25,
      }),
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out after 25ms/);
    assert.deepEqual(calls[1]?.args.slice(0, 2), ["rm", "--force"]);
    assert.match(JSON.stringify(result.data), /"cleanup":"succeeded"/);
  });

  it("rejects unpinned images and unavailable runtimes", async () => {
    assert.throws(
      () =>
        new ContainerProcessRunner({
          runtime: "docker",
          image: "node:22",
          cpu: 1,
          memoryMb: 512,
          pidsLimit: 128,
          network: false,
        }),
      HardFailure,
    );
    await assert.rejects(
      () =>
        detectContainerRuntime("auto", () =>
          Promise.resolve({ exitCode: 1, stdout: "", stderr: "missing", truncated: false }),
        ),
      HardFailure,
    );

    const warnings: string[] = [];
    const local = await createProcessRunner(
      { mode: "local" },
      { warn: (message) => warnings.push(message) },
    );
    assert.equal(local.isolation, "local-explicit");
    assert.match(warnings[0] ?? "", /runs approved test commands on the host/);
  });
});

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
