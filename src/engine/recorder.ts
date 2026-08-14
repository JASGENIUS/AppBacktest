/**
 * RunRecord persistence. All paths written into records are POSIX-style and
 * relative to the record's own directory, so fixtures committed from Windows
 * replay on Linux CI and vice versa.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RunRecord } from "../core/types";

export function toPosixRelative(absPath: string, baseDir: string): string {
  return relative(baseDir, absPath).split(sep).join("/");
}

export function writeRunRecord(record: RunRecord, runDirAbs: string): void {
  mkdirSync(runDirAbs, { recursive: true });
  writeFileSync(join(runDirAbs, "record.json"), JSON.stringify(record, null, 2));
}

export function readRunRecord(recordDirAbs: string): RunRecord {
  const file = join(recordDirAbs, "record.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read run record at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = parsed as RunRecord;
  if (record?.formatVersion !== 1 || !Array.isArray(record.steps)) {
    throw new Error(`${file} is not a v1 AppBacktest run record`);
  }
  return record;
}
