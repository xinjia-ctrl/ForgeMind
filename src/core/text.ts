export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

export function truncateUtf8(text: string, maxBytes: number): TruncatedText {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative integer");
  }
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, bytes: totalBytes };
  }

  const chunks: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    chunks.push(character);
    bytes += characterBytes;
  }
  return { text: chunks.join(""), truncated: true, bytes };
}
