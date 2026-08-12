import type {
  ReportGate,
  ReportSecurityEvent,
  ReportStageStats,
  ReportTimelineEvent,
  ReportViewModel,
  TimelineGroup,
} from "./view-model.js";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

export function renderReportHtml(model: ReportViewModel): string {
  const statusClass = cssToken(model.status);
  const timeline = model.timeline.map(renderTimelineGroup).join("");
  const stages = model.stats.perStage.map(renderStageStats).join("");
  const gates =
    model.gates.length === 0
      ? emptyState("No gate decisions recorded")
      : model.gates.map(renderGate).join("");
  const artifacts =
    model.artifacts.length === 0
      ? emptyState("No artifacts recorded")
      : model.artifacts
          .map(
            (artifact) => `<li>
              <span class="badge stage">${escapeHtml(artifact.stage)}</span>
              <div><strong>${escapeHtml(artifact.path)}</strong><small>${escapeHtml(artifact.kind)} · ${escapeHtml(artifact.summary)}</small></div>
            </li>`,
          )
          .join("");
  const security =
    model.security.length === 0
      ? emptyState("No policy or approval events recorded")
      : model.security.map(renderSecurityEvent).join("");
  const failure =
    model.failure === undefined
      ? ""
      : `<section class="failure" aria-label="Failure details">
          <div class="failure-mark">!</div>
          <div>
            <p class="eyebrow">FAILURE LOCATED</p>
            <h2>${escapeHtml(model.failure.stage ?? "FRAMEWORK")} · ${escapeHtml(model.failure.kind)}</h2>
            <p>${escapeHtml(model.failure.message)}</p>
          </div>
        </section>`;
  const truncation = model.truncated
    ? `<div class="notice">Timeline limited to ${formatNumber(model.displayedEvents)} of ${formatNumber(model.totalEvents)} events. Failures and gate decisions are retained first.</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
  <title>ForgeMind Run ${escapeHtml(model.runId)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <p class="brand">FORGEMIND / RUN REPORT</p>
        <h1>${escapeHtml(model.runId)}</h1>
        <p class="requirement">${escapeHtml(model.requirement || "No requirement recorded")}</p>
      </div>
      <span class="status ${statusClass}">${escapeHtml(model.status)}</span>
    </header>

    ${failure}

    <section class="overview" aria-label="Run overview">
      ${metric("Input tokens", formatNumber(model.stats.total.inputTokens))}
      ${metric("Output tokens", formatNumber(model.stats.total.outputTokens))}
      ${metric("Tool calls", formatNumber(model.stats.total.toolCalls))}
      ${metric("Run duration", formatDuration(model.stats.total.durationMs))}
    </section>

    <section>
      <div class="section-heading"><div><p class="eyebrow">RESOURCE MAP</p><h2>Stage statistics</h2></div></div>
      <div class="stage-grid">${stages}</div>
    </section>

    <section>
      <div class="section-heading timeline-heading">
        <div><p class="eyebrow">EVENT PROJECTION</p><h2>Workflow timeline</h2></div>
        <div class="player" aria-label="Timeline playback controls">
          <button id="previous" type="button">Previous</button>
          <button id="play" class="primary" type="button">Play</button>
          <button id="next" type="button">Next</button>
        </div>
      </div>
      ${truncation}
      <div class="timeline">${timeline}</div>
    </section>

    <section class="split">
      <div>
        <div class="section-heading"><div><p class="eyebrow">QUALITY CONTROL</p><h2>Gate decisions</h2></div></div>
        <div class="gate-list">${gates}</div>
      </div>
      <div>
        <div class="section-heading"><div><p class="eyebrow">OUTPUT INDEX</p><h2>Artifacts</h2></div></div>
        <ul class="artifact-list">${artifacts}</ul>
      </div>
    </section>

    <section>
      <div class="section-heading"><div><p class="eyebrow">SECURITY AUDIT</p><h2>Policy and approval decisions</h2></div></div>
      <div class="security-list">${security}</div>
    </section>

    <footer>
      <span>Workflow signature</span>
      <code>${escapeHtml(model.workflowSignature)}</code>
      <span>${formatNumber(model.totalEvents)} source events · offline single-file report</span>
    </footer>
  </main>
  <script>${PLAYER_SCRIPT}</script>
</body>
</html>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderStageStats(stats: ReportStageStats): string {
  return `<article class="stage-card">
    <div class="stage-name"><span>${escapeHtml(stats.stage)}</span><i></i></div>
    <dl>
      <div><dt>LLM calls</dt><dd>${formatNumber(stats.llmCalls)}</dd></div>
      <div><dt>Tokens</dt><dd>${formatNumber(stats.inputTokens)} in / ${formatNumber(stats.outputTokens)} out</dd></div>
      <div><dt>Tools</dt><dd>${formatNumber(stats.toolCalls)}</dd></div>
      <div><dt>Duration</dt><dd>${formatDuration(stats.durationMs)}</dd></div>
    </dl>
  </article>`;
}

function renderTimelineGroup(group: TimelineGroup): string {
  const label = group.stage ?? "RUN";
  const attempt = group.attempt === null ? "" : ` · ${formatNumber(group.attempt)}`;
  const events =
    group.events.length === 0
      ? `<div class="stage-empty">No events</div>`
      : group.events.map(renderTimelineEvent).join("");
  return `<section class="timeline-group">
    <div class="rail-label"><span>${escapeHtml(label)}${attempt}</span><small>${formatNumber(group.events.length)} events</small></div>
    <div class="event-list">${events}</div>
  </section>`;
}

function renderTimelineEvent(event: ReportTimelineEvent): string {
  const badges = [
    event.attempt === null
      ? ""
      : `<span class="badge">attempt ${formatNumber(event.attempt)}</span>`,
    event.operation === null ? "" : `<span class="badge">${escapeHtml(event.operation)}</span>`,
    event.outcome === null
      ? ""
      : `<span class="badge outcome ${cssToken(event.outcome)}">${escapeHtml(event.outcome)}</span>`,
  ].join("");
  const details =
    event.details === undefined
      ? ""
      : `<details><summary>Audited details</summary><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre></details>`;
  return `<article class="timeline-item" data-event-index tabindex="-1">
    <div class="event-dot"></div>
    <div class="event-content">
      <div class="event-meta"><code>#${formatNumber(event.seq)} · ${escapeHtml(event.type)}</code><time>${escapeHtml(event.ts)}</time></div>
      <p>${escapeHtml(event.summary)}</p>
      <div class="badges">${badges}</div>
      ${details}
    </div>
  </article>`;
}

function renderGate(gate: ReportGate): string {
  const state = gate.passed ? "passed" : "rejected";
  const detail = gate.passed ? gate.evidence : `${gate.reason} — ${gate.feedback}`;
  return `<article class="gate ${state}">
    <div><span class="badge stage">${escapeHtml(gate.stage)}</span><span class="badge">attempt ${formatNumber(gate.attempt)}</span>${gate.rework ? '<span class="badge rework">↻ rework</span>' : ""}</div>
    <strong>${gate.passed ? "Gate passed" : "Gate rejected"}</strong>
    <p>${escapeHtml(detail)}</p>
  </article>`;
}

function renderSecurityEvent(event: ReportSecurityEvent): string {
  const meta = [event.policy, event.source, event.reason].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  const details =
    event.details === undefined
      ? ""
      : `<details><summary>Audited action</summary><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre></details>`;
  return `<article class="security-event ${cssToken(event.decision)}">
    <div class="security-decision">${escapeHtml(event.decision)}</div>
    <div>
      <div class="badges"><span class="badge stage">${escapeHtml(event.stage)}</span><span class="badge">${escapeHtml(event.mode)}</span><span class="badge">#${formatNumber(event.seq)}</span></div>
      <strong>${escapeHtml(event.action)}</strong>
      <p>${escapeHtml(meta.join(" · "))}</p>
      ${details}
    </div>
    <time>${escapeHtml(event.ts)}</time>
  </article>`;
}

function emptyState(message: string): string {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function cssToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${formatNumber(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

const PLAYER_SCRIPT = String.raw`
(() => {
  const items = Array.from(document.querySelectorAll(".timeline-item"));
  const previous = document.getElementById("previous");
  const play = document.getElementById("play");
  const next = document.getElementById("next");
  let current = -1;
  let timer = null;

  function select(index) {
    if (items.length === 0) return;
    current = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item, itemIndex) => item.classList.toggle("active", itemIndex === current));
    items[current].scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    play.textContent = "Play";
  }

  previous.addEventListener("click", () => { stop(); select(current <= 0 ? 0 : current - 1); });
  next.addEventListener("click", () => { stop(); select(current + 1); });
  play.addEventListener("click", () => {
    if (timer !== null) { stop(); return; }
    play.textContent = "Pause";
    if (current >= items.length - 1) current = -1;
    select(current + 1);
    timer = window.setInterval(() => {
      if (current >= items.length - 1) { stop(); return; }
      select(current + 1);
    }, 900);
  });
  if (items.length === 0) [previous, play, next].forEach((button) => { button.disabled = true; });
})();`;

const STYLES = String.raw`
:root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--panel2:#171c27;--line:#2a3140;--text:#f4f6fb;--muted:#929cad;--cyan:#65e4ff;--violet:#a78bfa;--green:#54e39e;--red:#ff6b7a;--amber:#ffc857;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% -10%,#1f2950 0,transparent 32rem),var(--bg);color:var(--text)}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(to bottom,#000,transparent 80%)}main{width:min(1180px,calc(100% - 40px));margin:auto;padding:56px 0 40px;position:relative}.hero{display:flex;justify-content:space-between;gap:32px;align-items:flex-start;padding-bottom:36px;border-bottom:1px solid var(--line)}.brand,.eyebrow{color:var(--cyan);font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;margin:0 0 12px}.hero h1{font-size:clamp(28px,5vw,58px);letter-spacing:-.045em;margin:0;overflow-wrap:anywhere}.requirement{max-width:780px;color:#c8cfdb;font-size:18px;line-height:1.6;margin:18px 0 0;white-space:pre-wrap}.status{padding:10px 14px;border:1px solid;border-radius:999px;font:800 12px ui-monospace,monospace;letter-spacing:.08em}.status.succeeded{color:var(--green);background:#54e39e12}.status.failed,.status.blocked{color:var(--red);background:#ff6b7a12}.status.running{color:var(--amber);background:#ffc85712}.failure{display:flex;gap:18px;margin-top:28px;padding:24px;border:1px solid #ff6b7a66;background:linear-gradient(110deg,#ff6b7a18,transparent);border-radius:14px}.failure-mark{display:grid;place-items:center;flex:0 0 42px;height:42px;border-radius:50%;background:var(--red);color:#190307;font-weight:900;font-size:24px}.failure h2{margin:0 0 8px}.failure p:last-child{margin:0;color:#ffd4d8;white-space:pre-wrap}.overview{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:28px 0 60px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}.metric{background:#0e1219;padding:22px}.metric span{display:block;color:var(--muted);font-size:12px;margin-bottom:8px}.metric strong{font:700 25px ui-monospace,monospace}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;margin:0 0 18px}.section-heading h2{font-size:26px;letter-spacing:-.025em;margin:0}.stage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:64px}.stage-card{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:12px;padding:18px}.stage-name{display:flex;align-items:center;justify-content:space-between;font:800 13px ui-monospace,monospace;letter-spacing:.08em}.stage-name i{width:7px;height:7px;border-radius:50%;background:var(--violet);box-shadow:0 0 16px var(--violet)}dl{margin:20px 0 0}dl div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-top:1px solid #ffffff0d}dt{color:var(--muted);font-size:12px}dd{margin:0;font:600 12px ui-monospace,monospace;text-align:right}.player{display:flex;gap:8px}button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:8px;padding:9px 13px;cursor:pointer}button:hover{border-color:#56627a}button.primary{background:var(--cyan);border-color:var(--cyan);color:#061014;font-weight:800}button:disabled{opacity:.35;cursor:not-allowed}.notice{border:1px solid #ffc85755;background:#ffc85712;color:#ffdf94;padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:13px}.timeline{border-top:1px solid var(--line);margin-bottom:64px}.timeline-group{display:grid;grid-template-columns:130px 1fr;border-bottom:1px solid var(--line);padding:22px 0}.rail-label{position:sticky;top:20px;align-self:start;display:flex;flex-direction:column;gap:5px;font:800 13px ui-monospace,monospace;color:var(--cyan)}.rail-label small{color:var(--muted);font-weight:400}.event-list{display:flex;flex-direction:column;gap:10px}.timeline-item{display:grid;grid-template-columns:14px 1fr;gap:12px;padding:12px 14px 12px 6px;border:1px solid transparent;border-radius:10px;transition:.2s}.timeline-item.active{background:#65e4ff0c;border-color:#65e4ff88;box-shadow:0 0 24px #65e4ff0d}.event-dot{width:8px;height:8px;background:#556176;border:2px solid var(--bg);outline:1px solid #556176;border-radius:50%;margin-top:6px}.active .event-dot{background:var(--cyan);outline-color:var(--cyan);box-shadow:0 0 14px var(--cyan)}.event-meta{display:flex;justify-content:space-between;gap:16px;color:var(--muted)}.event-meta code{color:#c6d0e2;font-size:12px}.event-meta time{font:11px ui-monospace,monospace}.event-content p{margin:7px 0 8px;line-height:1.5;white-space:pre-wrap}.badges{display:flex;flex-wrap:wrap;gap:6px}.badge{display:inline-block;border:1px solid #374054;border-radius:999px;color:#aeb8c9;padding:3px 7px;font:600 10px ui-monospace,monospace}.badge.stage{color:var(--cyan);border-color:#65e4ff44}.badge.outcome.passed,.badge.outcome.succeeded{color:var(--green);border-color:#54e39e44}.badge.outcome.failed,.badge.outcome.rejected{color:var(--red);border-color:#ff6b7a44}.badge.rework{color:var(--amber);border-color:#ffc85744}details{margin-top:11px}details summary{cursor:pointer;color:var(--muted);font-size:12px}pre{max-height:360px;overflow:auto;background:#080a0e;border:1px solid var(--line);border-radius:8px;padding:12px;color:#bfc9da;font:11px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.stage-empty,.empty{padding:20px;border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:13px}.split{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-bottom:56px}.gate-list{display:flex;flex-direction:column;gap:10px}.gate{border:1px solid var(--line);border-left:3px solid;padding:16px;border-radius:10px;background:var(--panel)}.gate.passed{border-left-color:var(--green)}.gate.rejected{border-left-color:var(--red)}.gate strong{display:block;margin:12px 0 5px}.gate p{color:var(--muted);font-size:13px;line-height:1.5;margin:0;white-space:pre-wrap}.artifact-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}.artifact-list li{display:flex;gap:10px;padding:13px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}.artifact-list strong{display:block;font:600 12px ui-monospace,monospace;overflow-wrap:anywhere}.artifact-list small{display:block;color:var(--muted);margin-top:5px}.security-list{display:flex;flex-direction:column;gap:8px;margin-bottom:56px}.security-event{display:grid;grid-template-columns:88px 1fr auto;gap:16px;align-items:start;padding:14px;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;background:var(--panel)}.security-event.approved,.security-event.allowed{border-left-color:var(--green)}.security-event.denied{border-left-color:var(--red)}.security-decision{font:800 11px ui-monospace,monospace;color:var(--amber)}.security-event.approved .security-decision,.security-event.allowed .security-decision{color:var(--green)}.security-event.denied .security-decision{color:var(--red)}.security-event strong{display:block;margin:8px 0 4px}.security-event p{color:var(--muted);font-size:12px;margin:0;overflow-wrap:anywhere}.security-event>time{color:var(--muted);font:10px ui-monospace,monospace}footer{display:grid;gap:8px;padding-top:24px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}footer code{color:#b9c4d7;overflow-wrap:anywhere}@media(max-width:760px){main{width:min(100% - 24px,1180px);padding-top:28px}.hero{display:block}.status{display:inline-block;margin-top:20px}.overview{grid-template-columns:1fr 1fr}.stage-grid{grid-template-columns:1fr}.timeline-heading{display:block}.player{margin-top:16px}.timeline-group{grid-template-columns:1fr;gap:16px}.rail-label{position:static}.event-meta{display:block}.event-meta time{display:block;margin-top:4px}.split{grid-template-columns:1fr}.requirement{font-size:15px}.security-event{grid-template-columns:1fr}.security-event>time{margin-top:4px}}
`;
