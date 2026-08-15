/**
 * Read-only source correlation.
 *
 * Runtime evidence answers "what went wrong". Source can help answer "why, and
 * where does it come from". This module takes the concrete strings a finding
 * already produced — a failing endpoint path, an exception message, a button
 * label — and looks for where they appear in the user's code.
 *
 * HARD BOUNDARY: this module only ever reads. It imports no write API at all
 * (readFileSync/readdirSync/statSync are the entire filesystem surface), so it
 * cannot modify, create, patch, or commit anything in the user's project. Any
 * scratch space AppBacktest needs lives in its own artifacts directory.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { CodeRef, Finding, SourceConfig } from "../core/types";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".rb", ".go", ".java", ".cs", ".php", ".rs",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  "vendor", "__pycache__", ".venv", "target", ".backtests",
]);
const MAX_FILE_BYTES = 400_000;
const MAX_REFS_PER_FINDING = 3;

/** Collect candidate source files (read-only directory walk). */
function collectFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory is simply skipped
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (CODE_EXTENSIONS.has(extname(entry))) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** Distinctive strings worth searching for, derived from the evidence. */
function searchTermsFor(finding: Finding): Array<{ term: string; why: string }> {
  const terms: Array<{ term: string; why: string }> = [];
  const seen = new Set<string>();
  const add = (term: string, why: string) => {
    const t = term.trim();
    if (t.length < 4 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    terms.push({ term: t, why });
  };

  for (const line of finding.evidence) {
    // API paths: "/api/loads/38419/pods" → "/api/loads"
    const pathMatch = /(\/[a-z0-9_\-./]{3,})/i.exec(line);
    if (pathMatch) {
      const raw = pathMatch[1]!;
      const generic = raw
        .split("/")
        .filter((seg) => seg && !/^\d+$/.test(seg))
        .slice(0, 2)
        .join("/");
      if (generic) add(`/${generic}`, `handles the endpoint seen failing at runtime (${raw})`);
    }
    // Exception text
    const exc = /pageerror:\s*(.{6,60})/i.exec(line);
    if (exc) add(exc[1]!.replace(/["'`]/g, "").slice(0, 40), "text of the uncaught exception");
  }

  // Quoted UI labels from the title/observed text ("Upload POD", "Add note")
  for (const source of [finding.title, finding.observed]) {
    for (const m of source.matchAll(/[“"]([^”"]{3,40})[”"]/g)) {
      add(m[1]!, "label of the control involved in the finding");
    }
  }
  return terms.slice(0, 4);
}

/**
 * Attach likely code locations to findings. Never throws — correlation is a
 * diagnostic nicety and must not fail a run.
 */
export function correlateSource(findings: Finding[], cfg: SourceConfig): Finding[] {
  if (!cfg.enabled || !cfg.root) return findings;

  let files: string[];
  try {
    files = collectFiles(cfg.root, cfg.maxFiles);
  } catch {
    return findings;
  }
  if (files.length === 0) return findings;

  // Read once, search many.
  const contents = new Map<string, string[]>();
  for (const file of files) {
    try {
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      contents.set(file, readFileSync(file, "utf8").split(/\r?\n/));
    } catch {
      // unreadable file: skip
    }
  }

  return findings.map((finding) => {
    const terms = searchTermsFor(finding);
    if (terms.length === 0) return finding;

    const refs: CodeRef[] = [];
    for (const { term, why } of terms) {
      const needle = term.toLowerCase();
      for (const [file, lines] of contents) {
        if (refs.length >= MAX_REFS_PER_FINDING) break;
        const idx = lines.findIndex((l) => l.toLowerCase().includes(needle));
        if (idx === -1) continue;
        const path = relative(cfg.root!, file).split(sep).join("/");
        if (refs.some((r) => r.path === path)) continue;
        refs.push({
          path,
          line: idx + 1,
          snippet: lines[idx]!.trim().slice(0, 160),
          why,
        });
      }
      if (refs.length >= MAX_REFS_PER_FINDING) break;
    }
    return refs.length > 0 ? { ...finding, codeRefs: refs } : finding;
  });
}
