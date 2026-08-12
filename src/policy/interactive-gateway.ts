import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApprovalDecision, ApprovalGateway } from "./gateway.js";
import type { ActionRequest } from "./types.js";

export interface InteractiveApprovalGatewayOptions {
  readonly input: Readable;
  readonly output: Writable;
}

export class InteractiveApprovalGateway implements ApprovalGateway {
  public readonly source = "interactive";
  readonly #options: InteractiveApprovalGatewayOptions;

  public constructor(options: InteractiveApprovalGatewayOptions) {
    this.#options = options;
  }

  public async request(action: ActionRequest): Promise<ApprovalDecision> {
    const terminal = createInterface(this.#options);
    try {
      const command = action.command === undefined ? "" : ` (${action.command.join(" ")})`;
      const answer = await terminal.question(
        `Approve ${action.stage}/${action.tool}${command}? [y/N] `,
      );
      return answer.trim().toLocaleLowerCase() === "y" ? "APPROVED" : "DENIED";
    } finally {
      terminal.close();
    }
  }
}
