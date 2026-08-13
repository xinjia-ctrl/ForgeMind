import type { ChatProvider } from "./chat-provider.js";

export function supportsStructuredOutput(
  provider: ChatProvider,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment["FORGEMIND_STRUCTURED_OUTPUT"] === "0") return false;
  return provider.supportsStructuredOutput === true;
}
