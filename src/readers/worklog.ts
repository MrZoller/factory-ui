import {
  type ReaderResult,
  type ReaderWarning,
  type WorklogData,
  type WorklogEntry,
} from "../contracts";
import { readFactoryFile } from "./file";
import { readerWarning } from "./warnings";

export const MAX_WORKLOG_BYTES = 256 * 1024;
export const MAX_WORKLOG_LINES = 4096;
export const MAX_WORKLOG_LINE_LENGTH = 8192;
export const MAX_WORKLOG_ENTRIES = 20;
export const MAX_WORKLOG_WARNINGS = 32;

export const WORKLOG_WARNING_CODES = [
  "WARNINGS_TRUNCATED",
  "WORKLOG_TOO_MANY_LINES",
  "WORKLOG_LINE_TOO_LONG",
  "WORKLOG_EMPTY",
  "WORKLOG_MALFORMED_ENTRY",
  "WORKLOG_INVALID_UTF8",
  "WORKLOG_MISSING",
  "WORKLOG_TOO_LARGE",
  "WORKLOG_UNAVAILABLE",
] as const;

const WORKLOG_ENTRY =
  /^- (\d{4}-\d{2}-\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))? UTC - (.+)$/;
const LEGACY_WORKLOG_HEADING = /^## (\d{4}-\d{2}-\d{2})(?: — | - )(.+)$/;

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
  sourceLine?: string,
): void {
  if (warnings.length < MAX_WORKLOG_WARNINGS - 1) {
    warnings.push(readerWarning(code, message, line, sourceLine));
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
  const overlongLine = lines.findIndex(
    (line) => line.value.length > MAX_WORKLOG_LINE_LENGTH,
  );
  if (overlongLine !== -1) {
    return {
      status: "unavailable",
      warnings: [
        readerWarning(
          "WORKLOG_LINE_TOO_LONG",
          "worklog.md contains an oversized line",
          overlongLine + 1,
          lines[overlongLine]?.value,
        ),
      ],
    };
  }

  const warnings: ReaderWarning[] = [];
  if (text.trim().length === 0) {
    addWarning(warnings, "WORKLOG_EMPTY", "worklog.md is empty");
  }
  const entries: WorklogEntry[] = [];
  let active:
    | {
        line: SourceLine;
        date: string;
        time?: string;
        kind: "stamp" | "heading";
      }
    | undefined;
  const closeActive = (end: number): void => {
    if (active === undefined) return;
    const entry: WorklogEntry = {
      date: active.date,
      text: text.slice(active.line.start, end),
    };
    if (active.time !== undefined) entry.time = active.time;
    entries.push(entry);
    active = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const stamped = WORKLOG_ENTRY.exec(line.value);
    const validStamp = stamped !== null && validDate(stamped[1]!);
    const heading = LEGACY_WORKLOG_HEADING.exec(line.value);
    const validHeading =
      heading !== null &&
      validDate(heading[1]!) &&
      heading[2]!.trim().length > 0;

    if (validStamp || validHeading) {
      closeActive(line.start);
      active = validStamp
        ? {
            line,
            date: stamped[1]!,
            ...(stamped[2] === undefined ? {} : { time: stamped[2] }),
            kind: "stamp",
          }
        : { line, date: heading![1]!, kind: "heading" };
      continue;
    }

    if (line.value.startsWith("- ") && active?.kind !== "heading") {
      closeActive(line.start);
      addWarning(
        warnings,
        "WORKLOG_MALFORMED_ENTRY",
        "a worklog entry is malformed",
        index + 1,
        line.value,
      );
    }
  }
  closeActive(text.length);

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
