import {
  TASK_SIZES,
  type ExternalReviewMetric,
  type MergeMetric,
  type MetricsData,
  type PullRequestMetric,
  type ReaderResult,
  type ReaderWarning,
  type ShipMetric,
  type TaskMetrics,
  type TaskSize,
} from "../contracts";
import { readFactoryFile } from "./file";
import { readerWarning } from "./warnings";

export const MAX_METRICS_BYTES = 256 * 1024;
export const MAX_METRICS_LINES = 4096;
export const MAX_METRICS_LINE_BYTES = 8 * 1024;
export const MAX_METRICS_WARNINGS = 64;
export const MAX_METRICS_MAP_ENTRIES = 64;
export const MAX_METRICS_KEY_LENGTH = 128;

export const METRICS_WARNING_CODES = [
  "METRICS_INVALID_UTF8",
  "METRICS_INVALID_JSON",
  "METRICS_UNSUPPORTED_SCHEMA",
  "METRICS_INVALID_EVENT",
  "METRICS_LINE_TOO_LONG",
  "METRICS_TOO_MANY_LINES",
  "METRICS_WARNINGS_TRUNCATED",
  "METRICS_MISSING",
  "METRICS_TOO_LARGE",
  "METRICS_UNAVAILABLE",
] as const;

const TASK_ID = /^T[1-9][0-9]*$/;
const REVIEWER_ID = /^[a-z0-9-]+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCounter(value: unknown): value is number {
  return isCounter(value) && value > 0;
}

function isBoundedKey(value: string, pattern?: RegExp): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_METRICS_KEY_LENGTH &&
    (pattern === undefined || pattern.test(value))
  );
}

function isTaskSize(value: unknown): value is TaskSize {
  return TASK_SIZES.includes(value as TaskSize);
}

function isUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_METRICS_KEY_LENGTH ||
    !UTC_TIMESTAMP.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) =>
      fraction === undefined ? ".000Z" : `.${fraction.padEnd(3, "0")}Z`,
  );
  return parsed.toISOString() === normalized;
}

function parseFindings<T extends readonly string[]>(
  value: unknown,
  keys: T,
): { [K in T[number]]: number } | null {
  if (!isRecord(value)) return null;
  const findings: Record<string, number> = Object.create(null);
  for (const key of keys) {
    const count = value[key];
    if (!isCounter(count)) return null;
    findings[key] = count;
  }
  return findings as { [K in T[number]]: number };
}

function parseShip(value: Record<string, unknown>): ShipMetric | null {
  if (
    !isTaskSize(value.size) ||
    !(value.reclassifiedFrom === null || isTaskSize(value.reclassifiedFrom))
  ) {
    return null;
  }
  let internal: ShipMetric["internal"] = null;
  if (value.internal !== null) {
    if (!isRecord(value.internal)) return null;
    const findings = parseFindings(value.internal.findings, [
      "blocking",
      "minor",
      "invalid",
    ] as const);
    if (
      findings === null ||
      !isCounter(value.internal.rounds) ||
      !isCounter(value.internal.fixed)
    ) {
      return null;
    }
    internal = {
      rounds: value.internal.rounds,
      findings,
      fixed: value.internal.fixed,
    };
  }
  return {
    schemaVersion: 1,
    task: value.task as string,
    event: "ship",
    size: value.size,
    reclassifiedFrom: value.reclassifiedFrom,
    internal,
  };
}

function parseExternal(
  value: unknown,
): Record<string, ExternalReviewMetric> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_METRICS_MAP_ENTRIES) return null;
  const external: Record<string, ExternalReviewMetric> = Object.create(null);
  for (const [reviewer, review] of entries) {
    if (!isBoundedKey(reviewer, REVIEWER_ID) || !isRecord(review)) return null;
    const findings = parseFindings(review.findings, [
      "blocking",
      "minor",
      "refuted",
    ] as const);
    if (
      findings === null ||
      !isCounter(review.rounds) ||
      !isCounter(review.fixPushes)
    ) {
      return null;
    }
    external[reviewer] = {
      rounds: review.rounds,
      findings,
      fixPushes: review.fixPushes,
    };
  }
  return external;
}

function parseMerge(value: Record<string, unknown>): MergeMetric | null {
  const external = parseExternal(value.external);
  if (
    external === null ||
    !isPositiveCounter(value.pr) ||
    !isRecord(value.ci) ||
    !isCounter(value.ci.runs) ||
    !isCounter(value.ci.reruns)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    task: value.task as string,
    event: "merge",
    pr: value.pr,
    external,
    ci: { runs: value.ci.runs, reruns: value.ci.reruns },
  };
}

function parseCounterMap(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_METRICS_MAP_ENTRIES) return null;
  const result: Record<string, number> = Object.create(null);
  for (const [login, count] of entries) {
    if (!isBoundedKey(login) || !isCounter(count)) return null;
    result[login] = count;
  }
  return result;
}

function parseNestedCounterMap(
  value: unknown,
): Record<string, Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_METRICS_MAP_ENTRIES) return null;
  const result: Record<string, Record<string, number>> = Object.create(null);
  for (const [login, counters] of entries) {
    if (!isBoundedKey(login) || !isRecord(counters)) return null;
    const counterEntries = Object.entries(counters);
    if (counterEntries.length > MAX_METRICS_MAP_ENTRIES) return null;
    const nested: Record<string, number> = Object.create(null);
    for (const [key, count] of counterEntries) {
      if (!isBoundedKey(key) || !isCounter(count)) return null;
      nested[key] = count;
    }
    result[login] = nested;
  }
  return result;
}

function parseThreads(
  value: unknown,
): Record<string, { total: number; resolved: number }> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_METRICS_MAP_ENTRIES) return null;
  const result: Record<string, { total: number; resolved: number }> =
    Object.create(null);
  for (const [login, thread] of entries) {
    if (
      !isBoundedKey(login) ||
      !isRecord(thread) ||
      !isCounter(thread.total) ||
      !isCounter(thread.resolved)
    ) {
      return null;
    }
    result[login] = { total: thread.total, resolved: thread.resolved };
  }
  return result;
}

function parsePullRequest(
  value: Record<string, unknown>,
): PullRequestMetric | null {
  const reviews = parseCounterMap(value.reviews);
  const issueComments = parseCounterMap(value.issueComments);
  const reactions = parseNestedCounterMap(value.reactions);
  const threads = parseThreads(value.threads);
  if (
    value.by !== "factory-git" ||
    !isUtcTimestamp(value.openedAt) ||
    !isUtcTimestamp(value.mergedAt) ||
    !isCounter(value.commits) ||
    !isCounter(value.commitsAfterOpen) ||
    reviews === null ||
    issueComments === null ||
    reactions === null ||
    threads === null ||
    !isRecord(value.checkRuns) ||
    !isCounter(value.checkRuns.total) ||
    !isCounter(value.checkRuns.failed)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    task: value.task as string,
    event: "pr",
    by: "factory-git",
    openedAt: value.openedAt,
    mergedAt: value.mergedAt,
    commits: value.commits,
    commitsAfterOpen: value.commitsAfterOpen,
    reviews,
    issueComments,
    reactions,
    threads,
    checkRuns: { total: value.checkRuns.total, failed: value.checkRuns.failed },
  };
}

function parseEvent(
  value: unknown,
): ShipMetric | MergeMetric | PullRequestMetric | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.task !== "string" ||
    !TASK_ID.test(value.task)
  ) {
    return null;
  }
  if (value.event === "ship") return parseShip(value);
  if (value.event === "merge") return parseMerge(value);
  if (value.event === "pr") return parsePullRequest(value);
  return null;
}

function addWarning(
  warnings: ReaderWarning[],
  code: string,
  message: string,
  line: number,
  sourceLine?: string,
): void {
  if (warnings.length < MAX_METRICS_WARNINGS - 1) {
    warnings.push(readerWarning(code, message, line, sourceLine));
  } else if (
    !warnings.some((warning) => warning.code === "METRICS_WARNINGS_TRUNCATED")
  ) {
    warnings.push({
      code: "METRICS_WARNINGS_TRUNCATED",
      message: "additional metrics warnings were omitted",
    });
  }
}

function lineSlices(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.byteLength) lines.push(bytes.subarray(start));
  return lines;
}

export function parseFactoryMetrics(
  bytes: Uint8Array,
): ReaderResult<MetricsData> {
  const tasks: Record<string, TaskMetrics> = Object.create(null);
  const warnings: ReaderWarning[] = [];
  const lines = lineSlices(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index]!;
    if (lineNumber > MAX_METRICS_LINES) {
      addWarning(
        warnings,
        "METRICS_TOO_MANY_LINES",
        "metrics.jsonl contains too many lines; extra lines were dropped",
        lineNumber,
      );
      break;
    }
    const lineBytes =
      rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
    if (lineBytes.byteLength > MAX_METRICS_LINE_BYTES) {
      addWarning(
        warnings,
        "METRICS_LINE_TOO_LONG",
        "metrics.jsonl contains an oversized line",
        lineNumber,
        new TextDecoder().decode(lineBytes),
      );
      continue;
    }

    let sourceLine: string;
    try {
      sourceLine = decoder.decode(lineBytes);
    } catch {
      addWarning(
        warnings,
        "METRICS_INVALID_UTF8",
        "metrics.jsonl contains a line that is not valid UTF-8",
        lineNumber,
        new TextDecoder().decode(lineBytes),
      );
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(sourceLine);
    } catch {
      addWarning(
        warnings,
        "METRICS_INVALID_JSON",
        "metrics.jsonl contains malformed JSON",
        lineNumber,
        sourceLine,
      );
      continue;
    }
    const event = parseEvent(value);
    if (event === null) {
      const unsupportedSchema =
        isRecord(value) &&
        "schemaVersion" in value &&
        value.schemaVersion !== 1;
      addWarning(
        warnings,
        unsupportedSchema
          ? "METRICS_UNSUPPORTED_SCHEMA"
          : "METRICS_INVALID_EVENT",
        unsupportedSchema
          ? "metrics.jsonl contains an unsupported schemaVersion"
          : "metrics.jsonl contains an invalid metrics event",
        lineNumber,
        sourceLine,
      );
      continue;
    }

    const task = tasks[event.task] ?? (Object.create(null) as TaskMetrics);
    if (event.event === "ship") task.ship = event;
    else if (event.event === "merge") task.merge = event;
    else task.pr = event;
    tasks[event.task] = task;
  }

  const data = { tasks };
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readFactoryMetrics(
  repositoryPath: string,
): Promise<ReaderResult<MetricsData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "metrics",
    MAX_METRICS_BYTES,
  );
  if (result.status === "available") return parseFactoryMetrics(result.bytes);
  const code =
    result.status === "missing"
      ? "METRICS_MISSING"
      : result.status === "too-large"
        ? "METRICS_TOO_LARGE"
        : "METRICS_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "metrics.jsonl is missing"
      : result.status === "too-large"
        ? "metrics.jsonl is too large"
        : "metrics.jsonl could not be read safely";
  return { status: "unavailable", warnings: [{ code, message }] };
}
