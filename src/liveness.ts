import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

import type { LivenessSnapshot } from "./contracts";
import { resolveFactoryPath } from "./paths";

export const LSOF_EXECUTABLE = "lsof";
export const LSOF_TIMEOUT_MS = 2_000;
export const MAX_LSOF_OUTPUT_BYTES = 64 * 1024;
export const MAX_LOG_ENTRIES = 256;

const DRIVER_LOG_PATTERN =
  /^driver-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d+)\.log$/;

export interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export type ProbeRunner = (
  executable: string,
  args: readonly string[],
  limits: Readonly<{ timeoutMs: number; maxOutputBytes: number }>,
) => Promise<ProbeResult>;

export interface LivenessDependencies {
  runner?: ProbeRunner;
  now?: () => Date;
}

interface BoundedRead {
  text: string;
  truncated: boolean;
}

interface DriverLogName {
  timestamp: string;
  sequence: bigint;
}

function parseDriverLogName(name: string): DriverLogName | null {
  const match = DRIVER_LOG_PATTERN.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, sequence] = match;
  if (sequence === undefined) return null;
  const parts = [year, month, day, hour, minute, second].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const [y, mo, d, h, mi, s] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  ) {
    return {
      timestamp: `${year}${month}${day}${hour}${minute}${second}`,
      sequence: BigInt(sequence),
    };
  }
  return null;
}

async function selectDriverLog(repositoryRoot: string): Promise<string | null> {
  const logsPath = await resolveFactoryPath(repositoryRoot, "logs");
  if (logsPath === null) return null;
  const directory = await opendir(logsPath);
  let entryCount = 0;
  let selected: { name: string; parsed: DriverLogName } | undefined;
  for await (const entry of directory) {
    entryCount += 1;
    if (entryCount > MAX_LOG_ENTRIES) {
      throw new Error("too many log entries");
    }
    const parsed = entry.isFile() ? parseDriverLogName(entry.name) : null;
    if (
      parsed !== null &&
      (selected === undefined ||
        parsed.timestamp > selected.parsed.timestamp ||
        (parsed.timestamp === selected.parsed.timestamp &&
          parsed.sequence > selected.parsed.sequence))
    ) {
      selected = { name: entry.name, parsed };
    }
  }
  if (selected === undefined) return null;

  const path = join(logsPath, selected.name);
  const target = await lstat(path);
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new Error("unsafe driver log");
  }
  return path;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<BoundedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      truncated: false,
    };
  } catch {
    return { text: "", truncated: true };
  }
}

export const runLsof: ProbeRunner = async (executable, args, limits) => {
  const process = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(9);
  }, limits.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(process.stdout, limits.maxOutputBytes),
      readBounded(process.stderr, limits.maxOutputBytes),
      process.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      outputTruncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
};

export function parseCommands(output: string): string[] | null {
  if (output.length === 0 || !output.endsWith("\n")) return null;
  const lines = output.slice(0, -1).split("\n");
  const commands: string[] = [];
  let awaitingCommand = false;
  for (const line of lines) {
    if (/^p[0-9]+$/.test(line)) {
      if (awaitingCommand) return null;
      awaitingCommand = true;
    } else if (line.startsWith("c") && line.length > 1) {
      if (!awaitingCommand) return null;
      commands.push(line.slice(1));
      awaitingCommand = false;
    } else {
      return null;
    }
  }
  return awaitingCommand || commands.length === 0 ? null : commands;
}

export async function checkRepositoryLiveness(
  repositoryRoot: string,
  dependencies: LivenessDependencies = {},
): Promise<LivenessSnapshot> {
  const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const cannotVerify = (): LivenessSnapshot => ({
    state: "CANNOT_VERIFY",
    checkedAt,
  });

  try {
    const driverLog = await selectDriverLog(repositoryRoot);
    if (driverLog === null) return cannotVerify();
    const result = await (dependencies.runner ?? runLsof)(
      LSOF_EXECUTABLE,
      ["-Fpc", "--", driverLog],
      {
        timeoutMs: LSOF_TIMEOUT_MS,
        maxOutputBytes: MAX_LSOF_OUTPUT_BYTES,
      },
    );
    if (result.timedOut || result.outputTruncated) return cannotVerify();
    if (result.exitCode === 1 && result.stdout === "" && result.stderr === "") {
      return { state: "STOPPED", checkedAt };
    }
    if (result.exitCode !== 0 || result.stderr !== "") return cannotVerify();
    const commands = parseCommands(result.stdout);
    if (commands === null) return cannotVerify();
    return {
      state: commands.includes("tee") ? "RUNNING" : "STOPPED",
      checkedAt,
    };
  } catch {
    return cannotVerify();
  }
}
