import { runProcess } from "../tools/process.js";
import type { ProcessInvocation, ProcessRunner, ProcessRunOptions } from "./types.js";

export class LocalProcessRunner implements ProcessRunner {
  public readonly isolation = "local-explicit";

  public async run(
    invocation: ProcessInvocation,
    options: ProcessRunOptions,
  ): Promise<Awaited<ReturnType<typeof runProcess>>> {
    const result = await runProcess(invocation.command, invocation.args, options);
    return {
      ...result,
      sandbox: {
        mode: "local",
        runtime: "host",
        containerId: "host-process",
        network: true,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxBytes,
        cleanup: "not-required",
      },
    };
  }
}
