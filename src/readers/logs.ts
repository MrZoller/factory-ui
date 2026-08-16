import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";

import type {
  LogsData,
  LogSourceAges,
  LogTiming,
  ReaderResult,
  ReaderWarning,
} from "../contracts";
import { resolveFactoryPath } from "../paths";

// Re-export types for test convenience
export type { LogsData, LogTiming, LogSourceAges };

export const MAX_LOG_ENTRIES = 256;
export const MAX_NARRATION_BYTES = 64 * 1024;
export const MAX_NARRATION_LINES = 100;
export const MAX_NARRATION_LINE_BYTES = 2_000;
const MAX_WARNINGS = 16;

export const LOGS_WARNING_CODES = [
  "WARNINGS_TRUNCATED",
  "LOG_NARRATION_TRUNCATED",
  "LOG_LINE_TOO_LONG",
  "LOG_LINES_TRUNCATED",
  "LOG_INVALID_UTF8",
  "LOG_INVALID_DURATION",
  "LOG_CHANGED_DURING_READ",
  "LOGS_MISSING",
  "LOG_NAME_INVALID",
  "LOG_UNAVAILABLE",
  "DRIVER_LOG_MISSING",
  "LOGS_EMPTY",
  "LOGS_UNAVAILABLE",
] as const;

export type LogKind = "driver" | "cycle" | "shepherd";

export interface ParsedLogName {
  kind: LogKind;
  stamp: string;
  startedAt: Date;
  sequence: bigint;
}

export interface SelectedLog {
  name: string;
  parsed: ParsedLogName;
}

export interface TrustedDriverLog {
  path: string;
  device: bigint;
  inode: bigint;
  directoryPath: string;
  directoryDevice: bigint;
  directoryInode: bigint;
}

type OpenedDriverLog = Pick<TrustedDriverLog, "path" | "device" | "inode">;

export interface FactoryLogsRead {
  result: ReaderResult<LogsData>;
  driver: TrustedDriverLog | null;
}

export interface LogReaderDependencies {
  afterOpen?: (path: string) => void | Promise<void>;
}

const LOG_NAME =
  /^(driver|cycle|shepherd)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(0|[1-9]\d*))?\.log$/;

export function warning(code: string, message: string): ReaderWarning {
  return { code, message };
}

export function parseLogName(name: string): ParsedLogName | null {
  const match = LOG_NAME.exec(name);
  if (match === null) return null;
  const [, kind, year, month, day, hour, minute, second, sequence] = match;
  if (
    kind === undefined ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    (kind === "driver") !== (sequence !== undefined)
  ) {
    return null;
  }
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(
    Number,
  ) as [number, number, number, number, number, number];
  const startedAt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    startedAt.getUTCFullYear() !== y ||
    startedAt.getUTCMonth() !== mo - 1 ||
    startedAt.getUTCDate() !== d ||
    startedAt.getUTCHours() !== h ||
    startedAt.getUTCMinutes() !== mi ||
    startedAt.getUTCSeconds() !== s
  ) {
    return null;
  }
  return {
    kind: kind as LogKind,
    stamp: `${year}${month}${day}${hour}${minute}${second}`,
    startedAt,
    sequence: sequence === undefined ? 0n : BigInt(sequence),
  };
}

function isNewer(candidate: SelectedLog, current?: SelectedLog): boolean {
  if (current === undefined) return true;
  if (candidate.parsed.stamp !== current.parsed.stamp)
    return candidate.parsed.stamp > current.parsed.stamp;
  if (candidate.parsed.sequence !== current.parsed.sequence)
    return candidate.parsed.sequence > current.parsed.sequence;
  return candidate.name > current.name;
}

function addWarning(warnings: ReaderWarning[], next: ReaderWarning): void {
  if (warnings.length < MAX_WARNINGS - 1) {
    warnings.push(next);
  } else if (!warnings.some((item) => item.code === "WARNINGS_TRUNCATED")) {
    warnings.push(
      warning("WARNINGS_TRUNCATED", "additional log warnings were omitted"),
    );
  }
}

function timing(startedAt: Date, modifiedAt: Date): LogTiming {
  const value: LogTiming = {
    startedAt: startedAt.toISOString(),
    lastActivityAt: modifiedAt.toISOString(),
  };
  const duration = modifiedAt.getTime() - startedAt.getTime();
  if (Number.isSafeInteger(duration) && duration >= 0)
    value.durationMs = duration;
  return value;
}

function trimNarrationLines(
  bytes: Uint8Array,
  truncatedStart: boolean,
  warnings: ReaderWarning[],
): string {
  let start = 0;
  if (truncatedStart) {
    const newline = bytes.indexOf(10);
    if (newline === -1) {
      addWarning(
        warnings,
        warning(
          "LOG_NARRATION_TRUNCATED",
          "driver narration has no bounded complete line",
        ),
      );
      return "";
    }
    start = newline + 1;
    addWarning(
      warnings,
      warning(
        "LOG_NARRATION_TRUNCATED",
        "driver narration was truncated to its bounded tail",
      ),
    );
  }

  const lines: Uint8Array[] = [];
  let lineStart = start;
  for (let index = start; index <= bytes.byteLength; index += 1) {
    if (index !== bytes.byteLength && bytes[index] !== 10) continue;
    const lineEnd = index === bytes.byteLength ? index : index + 1;
    if (lineEnd === lineStart) continue;
    const line = bytes.subarray(lineStart, lineEnd);
    if (line.byteLength > MAX_NARRATION_LINE_BYTES) {
      addWarning(
        warnings,
        warning(
          "LOG_LINE_TOO_LONG",
          "driver narration contains an oversized line",
        ),
      );
    } else {
      lines.push(line);
    }
    lineStart = lineEnd;
  }
  if (lines.length > MAX_NARRATION_LINES) {
    lines.splice(0, lines.length - MAX_NARRATION_LINES);
    addWarning(
      warnings,
      warning("LOG_LINES_TRUNCATED", "driver narration exceeds the line limit"),
    );
  }
  const size = lines.reduce((total, line) => total + line.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const line of lines) {
    combined.set(line, offset);
    offset += line.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    addWarning(
      warnings,
      warning("LOG_INVALID_UTF8", "driver narration is not valid UTF-8"),
    );
    return "";
  }
}

async function readSelected(
  logsPath: string,
  selected: SelectedLog,
  includeNarration: boolean,
  warnings: ReaderWarning[],
  dependencies: LogReaderDependencies,
): Promise<{
  timing: LogTiming;
  trusted?: OpenedDriverLog;
  narration?: string;
}> {
  const path = join(logsPath, selected.name);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error("selected log changed");
    }
    const modifiedAt = new Date(Number(opened.mtimeMs));
    const value: {
      timing: LogTiming;
      trusted?: OpenedDriverLog;
      narration?: string;
    } = { timing: timing(selected.parsed.startedAt, modifiedAt) };
    if (value.timing.durationMs === undefined) {
      addWarning(
        warnings,
        warning(
          "LOG_INVALID_DURATION",
          "log activity predates its filename start",
        ),
      );
    }
    await dependencies.afterOpen?.(path);
    if (includeNarration) {
      const fileSize = Number(opened.size);
      const offset = Math.max(0, fileSize - MAX_NARRATION_BYTES);
      const length = Math.min(fileSize, MAX_NARRATION_BYTES);
      const bytes = new Uint8Array(length);
      const read = await handle.read(bytes, 0, length, offset);
      const [after, currentAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        !currentAfter.isFile() ||
        currentAfter.dev !== opened.dev ||
        currentAfter.ino !== opened.ino
      ) {
        addWarning(
          warnings,
          warning(
            "LOG_CHANGED_DURING_READ",
            "driver log changed while it was read",
          ),
        );
      }
      value.narration = trimNarrationLines(
        bytes.subarray(0, read.bytesRead),
        offset > 0,
        warnings,
      );
      if (
        currentAfter.isFile() &&
        currentAfter.dev === opened.dev &&
        currentAfter.ino === opened.ino
      ) {
        value.trusted = { path, device: opened.dev, inode: opened.ino };
      }
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function readFactoryLogsWithSelection(
  repositoryPath: string,
  dependencies: LogReaderDependencies = {},
): Promise<FactoryLogsRead> {
  const warnings: ReaderWarning[] = [];
  try {
    const logsPath = await resolveFactoryPath(repositoryPath, "logs");
    if (logsPath === null) {
      return {
        result: {
          status: "unavailable",
          warnings: [warning("LOGS_MISSING", "factory logs are missing")],
        },
        driver: null,
      };
    }
    const directoryHandle = await open(
      logsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    const openedDirectory = await directoryHandle.stat({ bigint: true });
    const verifyDirectory = async (): Promise<void> => {
      const currentDirectory = await lstat(logsPath, { bigint: true });
      if (
        !openedDirectory.isDirectory() ||
        !currentDirectory.isDirectory() ||
        openedDirectory.dev !== currentDirectory.dev ||
        openedDirectory.ino !== currentDirectory.ino
      ) {
        throw new Error("logs directory changed");
      }
    };
    await verifyDirectory();
    const selected: Partial<Record<LogKind, SelectedLog>> = {};
    let entries = 0;
    try {
      const directory = await opendir(logsPath);
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_LOG_ENTRIES) throw new Error("too many log entries");
        const parsed = entry.isFile() ? parseLogName(entry.name) : null;
        if (parsed === null) {
          if (/^(driver|cycle|shepherd)-/.test(entry.name)) {
            addWarning(
              warnings,
              warning(
                "LOG_NAME_INVALID",
                "factory logs contain an unrecognized log name",
              ),
            );
          }
          continue;
        }
        const candidate = { name: entry.name, parsed };
        if (isNewer(candidate, selected[parsed.kind]))
          selected[parsed.kind] = candidate;
      }
      await verifyDirectory();

      const data: LogsData = { narration: "", asOf: {} };
      let trusted: TrustedDriverLog | null = null;
      for (const kind of ["driver", "cycle", "shepherd"] as const) {
        const choice = selected[kind];
        if (choice === undefined) continue;
        try {
          await verifyDirectory();
          const value = await readSelected(
            logsPath,
            choice,
            kind === "driver",
            warnings,
            dependencies,
          );
          await verifyDirectory();
          data[kind] = value.timing;
          data.asOf[kind] = value.timing.lastActivityAt;
          if (kind === "driver") {
            data.narration = value.narration ?? "";
            trusted = value.trusted
              ? {
                  ...value.trusted,
                  directoryPath: logsPath,
                  directoryDevice: openedDirectory.dev,
                  directoryInode: openedDirectory.ino,
                }
              : null;
          }
        } catch {
          addWarning(
            warnings,
            warning("LOG_UNAVAILABLE", `${kind} log could not be read safely`),
          );
        }
      }
      await verifyDirectory();
      const ages = Object.values(data.asOf).filter(
        (value): value is string => typeof value === "string",
      );
      if (ages.length > 0) data.asOf.overall = ages.sort().at(-1);
      if (data.driver === undefined) {
        addWarning(
          warnings,
          warning("DRIVER_LOG_MISSING", "no usable driver log was found"),
        );
      }
      if (
        data.driver === undefined &&
        data.cycle === undefined &&
        data.shepherd === undefined
      ) {
        return {
          result: {
            status: "unavailable",
            warnings:
              warnings.length > 0
                ? warnings
                : [
                    warning(
                      "LOGS_EMPTY",
                      "no recognized factory logs were found",
                    ),
                  ],
          },
          driver: null,
        };
      }
      return {
        result:
          warnings.length === 0
            ? { status: "available", data, warnings: [] }
            : { status: "partial", data, warnings },
        driver: trusted,
      };
    } finally {
      await directoryHandle.close();
    }
  } catch {
    return {
      result: {
        status: "unavailable",
        warnings: [
          warning("LOGS_UNAVAILABLE", "factory logs could not be read safely"),
        ],
      },
      driver: null,
    };
  }
}

export async function readFactoryLogs(
  repositoryPath: string,
): Promise<ReaderResult<LogsData>> {
  return (await readFactoryLogsWithSelection(repositoryPath)).result;
}
