/**
 * Findings presentation: an HTML index and the terminal section.
 *
 * Organisation follows the spec — real problems first, recommendations last,
 * and each category counted separately so a quality-of-life note never sits
 * beside a critical authentication failure just because both are "findings".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { BacktestReport, Finding, FindingCategory } from "../core/types";
import { formatOffset } from "../findings/timeline";

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  critical_failure: "CRITICAL ISSUES",
  functional_bug: "FUNCTIONAL BUGS",
  visual_bug: "VISUAL / UI BUGS",
  performance: "PERFORMANCE ISSUES",
  usability: "USABILITY ISSUES",
  qol_recommendation: "QUALITY-OF-LIFE RECOMMENDATIONS",
};
const ORDER: FindingCategory[] = [
  "critical_failure",
  "functional_bug",
  "visual_bug",
  "performance",
  "usability",
  "qol_recommendation",
];

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function group(findings: Finding[]): Map<FindingCategory, Finding[]> {
  const map = new Map<FindingCategory, Finding[]>();
  for (const cat of ORDER) {
    const items = findings.filter((f) => f.category === cat);
    if (items.length > 0) map.set(cat, items);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  critical: (s) => pc.red(pc.bold(s)),
  high: (s) => pc.red(s),
  medium: (s) => pc.yellow(s),
  low: (s) => pc.dim(s),
  info: (s) => pc.dim(s),
};

export function printFindings(findings: Finding[], outDirAbs: string): void {
  if (findings.length === 0) return;
  const grouped = group(findings);

  for (const [category, items] of grouped) {
    const isRecommendation = category === "qol_recommendation" || category === "usability";
    console.log(
      `\n${isRecommendation ? pc.cyan(pc.bold(CATEGORY_LABEL[category])) : pc.bold(CATEGORY_LABEL[category])} ${pc.dim(`(${items.length})`)}`,
    );
    for (const f of items) {
      const sev = (SEVERITY_COLOR[f.severity] ?? ((s: string) => s))(f.severity.toUpperCase());
      console.log(`\n  ${sev} ${pc.bold(f.title)} ${pc.dim(`#${f.id}`)}`);
      console.log(
        pc.dim(`    confidence ${(f.confidence * 100).toFixed(0)}% · reproduced ${f.reproducedIn}`),
      );
      console.log(`    ${pc.dim("Observed:")} ${wrap(f.observed, 6)}`);
      if (f.expected) console.log(`    ${pc.dim("Expected:")} ${wrap(f.expected, 6)}`);
      if (f.userImpact) console.log(`    ${pc.dim("Impact:")} ${wrap(f.userImpact, 6)}`);
      if (f.suggestion) console.log(`    ${pc.dim("Suggestion:")} ${wrap(f.suggestion, 6)}`);
      if (f.reproduction.length > 0) {
        console.log(pc.dim(`    Reproduction: ${f.reproduction.join(" → ")}`));
      }
      for (const e of f.evidence.slice(0, 3)) console.log(pc.dim(`    Evidence: ${e.slice(0, 150)}`));
      for (const ref of f.codeRefs) {
        console.log(pc.dim(`    Possible code location: ${ref.path}${ref.line ? `:${ref.line}` : ""} — ${ref.why}`));
      }
      const occ = f.occurrences[0];
      if (occ) {
        const at = occ.atMs !== undefined ? ` (at ${formatOffset(occ.atMs)})` : "";
        console.log(pc.dim(`    Replay${at}: ${outDirAbs.replace(/\\/g, "/")}/${occ.runDir}/replay.html`));
      }
    }
  }
  console.log(pc.dim(`\n  Source code modified: no (AppBacktest never edits your code)`));
}

function wrap(text: string, indent: number): string {
  const width = 92;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join(`\n${" ".repeat(indent)}`);
}

// ---------------------------------------------------------------------------
// HTML index
// ---------------------------------------------------------------------------

export function renderFindingsHtml(report: BacktestReport, findings: Finding[]): string {
  const grouped = group(findings);
  const counts = ORDER.map((c) => ({ c, n: findings.filter((f) => f.category === c).length })).filter(
    (x) => x.n > 0,
  );
  const totalActions = report.runs.reduce((n, r) => n + r.steps, 0);

  const card = (f: Finding): string => {
    const occ = f.occurrences[0];
    // This page lives in reports/, run artifacts live in runs/ — hop up one.
    const replay = occ
      ? `../${occ.runDir}/replay.html${occ.atMs !== undefined ? `#t=${Math.round(occ.atMs)}` : ""}`
      : "";
    return `<article class="f sev-${esc(f.severity)}">
      <div class="fhead">
        <span class="sev">${esc(f.severity)}</span>
        <h3>${esc(f.title)}</h3>
        <span class="id">#${esc(f.id)}</span>
      </div>
      <div class="meta">confidence ${(f.confidence * 100).toFixed(0)}% · reproduced ${esc(f.reproducedIn)}${
        occ?.atMs !== undefined ? ` · failure at ${esc(formatOffset(occ.atMs))}` : ""
      }</div>
      <p><b>Observed:</b> ${esc(f.observed)}</p>
      ${f.expected ? `<p><b>Expected:</b> ${esc(f.expected)}</p>` : ""}
      ${f.userImpact ? `<p><b>User impact:</b> ${esc(f.userImpact)}</p>` : ""}
      ${f.suggestion ? `<p><b>Suggestion:</b> ${esc(f.suggestion)}</p>` : ""}
      ${
        f.reproduction.length > 0
          ? `<p><b>Reproduction:</b> <span class="repro">${f.reproduction.map(esc).join(" → ")}</span></p>`
          : ""
      }
      ${
        f.evidence.length > 0
          ? `<div class="ev"><b>Relevant events</b><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
          : ""
      }
      ${
        f.codeRefs.length > 0
          ? `<div class="ev"><b>Possible code location</b><ul>${f.codeRefs
              .map(
                (r) =>
                  `<li><code>${esc(r.path)}${r.line ? `:${r.line}` : ""}</code> — ${esc(r.why)}${
                    r.snippet ? `<div class="snip">${esc(r.snippet)}</div>` : ""
                  }</li>`,
              )
              .join("")}</ul></div>`
          : ""
      }
      <div class="acts">
        ${replay ? `<a class="btn" href="${esc(replay)}">Open Replay</a>` : ""}
        <span class="occ">${f.occurrences.length} occurrence${f.occurrences.length === 1 ? "" : "s"}</span>
        <span class="nomod">Source code modified: no</span>
      </div>
    </article>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AppBacktest report · ${esc(report.app.name)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0d1017;color:#e6e9ef;font:15px/1.6 "Segoe UI",system-ui,sans-serif}
  .page{max-width:1000px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:20px;margin:0 0 4px}
  h2{font-size:13px;letter-spacing:.10em;text-transform:uppercase;color:#8b95a7;margin:34px 0 10px;border-bottom:1px solid #222836;padding-bottom:6px}
  h3{font-size:15px;margin:0;font-weight:600}
  .muted{color:#8b95a7;font-size:13px}
  .summary{display:flex;gap:22px;flex-wrap:wrap;margin:18px 0 6px;padding:14px 16px;background:#131822;border:1px solid #222836;border-radius:6px}
  .stat b{display:block;font-size:20px}
  .f{background:#131822;border:1px solid #222836;border-left-width:3px;border-radius:6px;padding:14px 16px;margin:12px 0}
  .sev-critical{border-left-color:#f87171}.sev-high{border-left-color:#fb923c}
  .sev-medium{border-left-color:#facc15}.sev-low{border-left-color:#64748b}.sev-info{border-left-color:#475569}
  .fhead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
  .sev{font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:3px;background:#221a1a;color:#fca5a5}
  .id{color:#5c6678;font-size:12px;margin-left:auto}
  .meta{color:#8b95a7;font-size:12px;margin:4px 0 10px}
  p{margin:6px 0}
  .repro{color:#7dd3fc}
  .ev{margin:8px 0;padding:8px 12px;background:#0f1420;border:1px solid #1e2534;border-radius:4px;font-size:13px}
  .ev ul{margin:4px 0 0;padding-left:18px}
  .snip{font-family:ui-monospace,Consolas,monospace;color:#94a3b8;font-size:12px;margin-top:3px}
  code{font-family:ui-monospace,Consolas,monospace;color:#7dd3fc}
  .acts{display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap}
  .btn{background:#1d4ed8;color:#fff;text-decoration:none;padding:6px 14px;border-radius:4px;font-size:13px}
  .occ,.nomod{color:#8b95a7;font-size:12px}
  .nomod{margin-left:auto}
  .none{color:#8b95a7;padding:16px;border:1px dashed #222836;border-radius:6px}
</style></head><body><div class="page">
  <h1>AppBacktest · ${esc(report.app.name)}</h1>
  <div class="muted">seed ${esc(report.seed)} · config ${esc(report.configHash.slice(0, 12))} · ${esc(report.finishedAt)}</div>
  <div class="summary">
    <div class="stat"><b>${report.totals.total}</b><span class="muted">runs</span></div>
    <div class="stat"><b>${totalActions}</b><span class="muted">actions</span></div>
    <div class="stat"><b>${findings.length}</b><span class="muted">findings</span></div>
    ${counts
      .map((c) => `<div class="stat"><b>${c.n}</b><span class="muted">${esc(CATEGORY_LABEL[c.c].toLowerCase())}</span></div>`)
      .join("")}
  </div>
  ${
    findings.length === 0
      ? '<div class="none">No findings — every workflow completed and every check passed.</div>'
      : [...grouped]
          .map(([cat, items]) => `<h2>${esc(CATEGORY_LABEL[cat])} (${items.length})</h2>${items.map(card).join("")}`)
          .join("")
  }
</div></body></html>`;
}

export function writeFindingsHtml(
  report: BacktestReport,
  findings: Finding[],
  outDirAbs: string,
): string {
  const dir = join(outDirAbs, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "latest.html");
  writeFileSync(file, renderFindingsHtml(report, findings));
  return file;
}
