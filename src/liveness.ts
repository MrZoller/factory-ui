import { lstat } from "node:fs/promises";

import type { LivenessSnapshot } from "./contracts";
import {
  MAX_LOG_ENTRIES,
  readFactoryLogsWithSelection,
  type TrustedDriverLog,
} from "./readers/logs";

export { MAX_LOG_ENTRIES };

export const LSOF_EXECUTABLE = "lsof";
export const LSOF_TIMEOUT_MS = 2_000;
export const MAX_LSOF_OUTPUT_BYTES = 64 * 1024;

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
  let acceptingFileFields = false;
  for (const line of lines) {
    if (/^p[0-9]+$/.test(line)) {
      if (awaitingCommand) return null;
      awaitingCommand = true;
      acceptingFileFields = false;
    } else if (line.startsWith("c") && line.length > 1) {
      if (!awaitingCommand) return null;
      commands.push(line.slice(1));
      awaitingCommand = false;
      acceptingFileFields = true;
    } else if (
      /^[aCdDFGfgikKlLmMnNoPrRsStTuUzZ].*$/.test(line) &&
      acceptingFileFields
    ) {
      continue;
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
    const driverLog = (await readFactoryLogsWithSelection(repositoryRoot))
      .driver;
    return await checkTrustedDriverLiveness(driverLog, dependencies, checkedAt);
  } catch {
    return cannotVerify();
  }
}

export async function checkTrustedDriverLiveness(
  driverLog: TrustedDriverLog | null,
  dependencies: LivenessDependencies = {},
  checkedAt = (dependencies.now ?? (() => new Date()))().toISOString(),
): Promise<LivenessSnapshot> {
  const cannotVerify = (): LivenessSnapshot => ({
    state: "CANNOT_VERIFY",
    checkedAt,
  });
  try {
    if (driverLog === null) return cannotVerify();
    const [current, currentDirectory] = await Promise.all([
      lstat(driverLog.path, { bigint: true }),
      lstat(driverLog.directoryPath, { bigint: true }),
    ]);
    if (
      !current.isFile() ||
      current.dev !== driverLog.device ||
      current.ino !== driverLog.inode ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== driverLog.directoryDevice ||
      currentDirectory.ino !== driverLog.directoryInode
    ) {
      return cannotVerify();
    }
    const result = await (dependencies.runner ?? runLsof)(
      LSOF_EXECUTABLE,
      ["-Fpc", "--", driverLog.path],
      {
        timeoutMs: LSOF_TIMEOUT_MS,
        maxOutputBytes: MAX_LSOF_OUTPUT_BYTES,
      },
    );
    const [after, directoryAfter] = await Promise.all([
      lstat(driverLog.path, { bigint: true }),
      lstat(driverLog.directoryPath, { bigint: true }),
    ]);
    if (
      !after.isFile() ||
      after.dev !== driverLog.device ||
      after.ino !== driverLog.inode ||
      !directoryAfter.isDirectory() ||
      directoryAfter.dev !== driverLog.directoryDevice ||
      directoryAfter.ino !== driverLog.directoryInode
    ) {
      return cannotVerify();
    }
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
