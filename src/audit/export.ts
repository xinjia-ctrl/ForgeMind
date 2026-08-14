import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { HardFailure } from "../core/errors.js";
import type { AuditQueryResult, AuditRecord } from "./query.js";

export type AuditExportFormat = "json" | "csv";

export async function exportAuditResult(
  result: AuditQueryResult,
  options: {
    readonly directory: string;
    readonly name: string;
    readonly format: AuditExportFormat;
  },
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.name)) {
    throw new HardFailure(`Invalid audit export name: ${options.name}`);
  }
  await mkdir(options.directory, { recursive: true });
  const filePath = path.join(options.directory, `${options.name}.${options.format}`);
  const content =
    options.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderCsv(result.records);
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return filePath;
}

const COLUMNS = [
  "runId",
  "seq",
  "ts",
  "type",
  "stage",
  "taskId",
  "actor",
  "role",
  "risk",
  "repo",
  "status",
  "operation",
  "outcome",
] as const;

export function renderCsv(records: readonly AuditRecord[]): string {
  return `${COLUMNS.join(",")}\n${records
    .map((record) => COLUMNS.map((column) => csv(record[column])).join(","))
    .join("\n")}${records.length === 0 ? "" : "\n"}`;
}

function csv(value: AuditRecord[(typeof COLUMNS)[number]]): string {
  const raw = value === undefined || value === null ? "" : String(value);
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
