import {
  type ReaderResult,
  type ReaderWarning,
  type WorklogData,
  type WorklogEntry,
} from "../contracts";
import { readFactoryFile } from "./file";

export const MAX_WORKLOG_BYTES = 256 * 1024;
export const MAX_WORKLOG_LINES = 4096;
export const MAX_WORKLOG_LINE_LENGTH = 8192;
export const MAX_WORKLOG_ENTRIES = 20;
export const MAX_WORKLOG_WARNINGS = 32;

const WORKLOG_ENTRY =
  /^- (\d{4}-\d{2}-\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))? UTC - (.+)$/;

interface SourceLine {
  value: string;
  start: number;
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let end = 0; end <= text.length; end += 1) {
    if (end === text.length || text[end] === "\n") {
      const raw = text.slice(start, end);
      lines.push({ value: raw.replace(/\r$/, ""), start });
      start = end + 1;
    }
  }
  return lines;
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function addWarning(
  warnings: ReaderWarning[],
  code: string,
  message: string,
  line?: number,
): void {
  if (warnings.length < MAX_WORKLOG_WARNINGS - 1) {
    warnings.push(
      line === undefined ? { code, message } : { code, message, line },
    );
  } else if (
    !warnings.some((warning) => warning.code === "WARNINGS_TRUNCATED")
  ) {
    warnings.push({
      code: "WARNINGS_TRUNCATED",
      message: "additional worklog warnings were omitted",
    });
  }
}

export function parseFactoryWorklog(text: string): ReaderResult<WorklogData> {
  const lines = sourceLines(text);
  if (lines.length > MAX_WORKLOG_LINES) {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "WORKLOG_TOO_MANY_LINES",
          message: "worklog.md has too many lines",
        },
      ],
    };
  }
  if (lines.some((line) => line.value.length > MAX_WORKLOG_LINE_LENGTH)) {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "WORKLOG_LINE_TOO_LONG",
          message: "worklog.md contains an oversized line",
        },
      ],
    };
  }

  const warnings: ReaderWarning[] = [];
  if (text.trim().length === 0) {
    addWarning(warnings, "WORKLOG_EMPTY", "worklog.md is empty");
  }
  const boundaries = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.value.startsWith("- "));
  const entries: WorklogEntry[] = [];
  for (let boundary = 0; boundary < boundaries.length; boundary += 1) {
    const current = boundaries[boundary]!;
    const match = WORKLOG_ENTRY.exec(current.line.value);
    if (!match || !validDate(match[1]!)) {
      addWarning(
        warnings,
        "WORKLOG_MALFORMED_ENTRY",
        "a worklog entry is malformed",
        current.index + 1,
      );
      continue;
    }
    const nextStart = boundaries[boundary + 1]?.line.start ?? text.length;
    const entry: WorklogEntry = {
      date: match[1]!,
      text: text.slice(current.line.start, nextStart),
    };
    if (match[2] !== undefined) entry.time = match[2];
    entries.push(entry);
  }

  const data = { entries: entries.slice(-MAX_WORKLOG_ENTRIES) };
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readFactoryWorklog(
  repositoryPath: string,
): Promise<ReaderResult<WorklogData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "worklog",
    MAX_WORKLOG_BYTES,
  );
  if (result.status === "available") {
    try {
      return parseFactoryWorklog(
        new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
      );
    } catch {
      return {
        status: "unavailable",
        warnings: [
          {
            code: "WORKLOG_INVALID_UTF8",
            message: "worklog.md is not valid UTF-8",
          },
        ],
      };
    }
  }
  const code =
    result.status === "missing"
      ? "WORKLOG_MISSING"
      : result.status === "too-large"
        ? "WORKLOG_TOO_LARGE"
        : "WORKLOG_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "worklog.md is missing"
      : result.status === "too-large"
        ? "worklog.md is too large"
        : "worklog.md could not be read safely";
  return { status: "unavailable", warnings: [{ code, message }] };
}
