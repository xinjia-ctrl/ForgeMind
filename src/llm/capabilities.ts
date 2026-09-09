import type { ChatProvider } from "./chat-provider.js";

export function supportsStructuredOutput(provider: ChatProvider): boolean {
  return provider.supportsStructuredOutput === true;
}
