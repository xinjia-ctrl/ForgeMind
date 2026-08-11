const SENSITIVE_KEY =
  /content|prompt|token|secret|password|api.?key|diff|stdout|stderr|search|replacement|output|^text$/i;

export function auditValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return typeof value === "string"
      ? `<redacted:${Buffer.byteLength(value)} bytes>`
      : "<redacted>";
  }
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}<truncated>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => auditValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, auditValue(child, childKey)]),
    );
  }
  return value;
}
