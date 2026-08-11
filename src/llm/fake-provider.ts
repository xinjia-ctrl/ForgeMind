import { StageFailure } from "../core/errors.js";
import { estimateTokens } from "../core/token-budget.js";
import type { ChatCompletion, ChatMessage, ChatOptions, ChatProvider } from "./chat-provider.js";

export class FakeChatProvider implements ChatProvider {
  readonly #responses: string[];
  readonly calls: Array<{
    readonly messages: readonly ChatMessage[];
    readonly options: ChatOptions;
  }> = [];

  public constructor(responses: readonly string[]) {
    this.#responses = [...responses];
  }

  public complete(messages: readonly ChatMessage[], options: ChatOptions): Promise<ChatCompletion> {
    this.calls.push({ messages, options });
    const content = this.#responses.shift();
    if (content === undefined) {
      return Promise.reject(new StageFailure("FakeChatProvider response queue exhausted"));
    }
    return Promise.resolve({
      content,
      usage: {
        inputTokens: estimateTokens(messages.map((item) => item.content).join("\n")),
        outputTokens: estimateTokens(content),
      },
    });
  }

  public get remainingResponses(): number {
    return this.#responses.length;
  }
}
