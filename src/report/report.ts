import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventLog } from "../core/event-log.js";
import { renderReportHtml } from "./render-html.js";
import { buildReportViewModel, type ReportViewModel } from "./view-model.js";

export interface GenerateReportOptions {
  readonly gitDirectory: string;
  readonly runId: string;
}

export interface GeneratedReport {
  readonly path: string;
  readonly viewModel: ReportViewModel;
}

export async function generateReport(options: GenerateReportOptions): Promise<GeneratedReport> {
  const forgeMindDirectory = path.join(options.gitDirectory, "forgemind");
  const events = await EventLog.open(path.join(forgeMindDirectory, "runs"), options.runId).load();
  const viewModel = buildReportViewModel(events);
  const html = renderReportHtml(viewModel);
  const reportDirectory = path.join(forgeMindDirectory, "reports");
  const reportPath = path.join(reportDirectory, `${options.runId}.html`);
  const temporaryPath = path.join(
    reportDirectory,
    `.${options.runId}.${randomUUID()}.temporary.html`,
  );

  await mkdir(reportDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, reportPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { path: reportPath, viewModel };
}
