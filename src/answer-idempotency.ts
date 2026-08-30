import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ANSWER_UUID } from "./answer-intake";

export const MAX_ANSWER_IDEMPOTENCY_RECORDS = 512;
const MAX_GIT_OUTPUT_BYTES = 4096;
const MAX_RECORD_BYTES = 1024;
const STORE_DIRECTORY = "factory-ui-answer-idempotency";
const FINGERPRINT = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type AnswerReservation =
  | { status: "acquired" }
  | { status: "complete"; id: string }
  | { status: "conflict" }
  | { status: "reserved" }
  | { status: "full" };

export interface AnswerIdempotencyStore {
  reserve(
    repositoryPath: string,
    key: string,
    fingerprint: string,
  ): Promise<AnswerReservation>;
  complete(
    repositoryPath: string,
    key: string,
    fingerprint: string,
    id: string,
  ): Promise<void>;
}

type StoredRecord =
  | {
      key: string;
      fingerprint: string;
      status: "reserved";
    }
  | {
      key: string;
      fingerprint: string;
      status: "complete";
      id: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): StoredRecord | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    typeof value.key !== "string" ||
    !ANSWER_UUID.test(value.key) ||
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT.test(value.fingerprint)
  ) {
    return null;
  }
  if (
    value.status === "reserved" &&
    keys.length === 3 &&
    keys.every((key) => ["key", "fingerprint", "status"].includes(key))
  ) {
    return {
      key: value.key,
      fingerprint: value.fingerprint,
      status: "reserved",
    };
  }
  if (
    value.status === "complete" &&
    typeof value.id === "string" &&
    ANSWER_UUID.test(value.id) &&
    keys.length === 4 &&
    keys.every((key) => ["key", "fingerprint", "status", "id"].includes(key))
  ) {
    return {
      key: value.key,
      fingerprint: value.fingerprint,
      status: "complete",
      id: value.id,
    };
  }
  return null;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_GIT_OUTPUT_BYTES) {
      await reader.cancel();
      throw new Error("git output is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function discoverGitCommonDirectory(
  repositoryPath: string,
): Promise<string> {
  const canonicalRepository = await realpath(repositoryPath);
  const child = Bun.spawn(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: canonicalRepository,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [stdout, exitCode] = await Promise.all([
    readBounded(child.stdout),
    child.exited,
  ]);
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (
    exitCode !== 0 ||
    !value ||
    !isAbsolute(value) ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    throw new Error("cannot discover git common directory");
  }
  const canonicalCommon = await realpath(value);
  const metadata = await lstat(canonicalCommon);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("git common directory is unsafe");
  }
  return canonicalCommon;
}

async function ensureDirectory(path: string, mode?: number): Promise<void> {
  await mkdir(path, { mode, recursive: false }).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("idempotency directory is unsafe");
  }
  if (mode !== undefined) {
    if ((metadata.mode & 0o777) !== mode) {
      throw new Error("idempotency directory is not private");
    }
  }
}

async function storeDirectory(repositoryPath: string): Promise<string> {
  const common = await discoverGitCommonDirectory(repositoryPath);
  const factory = join(common, "factory");
  await ensureDirectory(factory, 0o700);
  const store = join(factory, STORE_DIRECTORY);
  await ensureDirectory(store, 0o700);
  return store;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateRecord(
  path: string,
  record: StoredRecord,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateRecord(path: string): Promise<StoredRecord> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("idempotency record is unsafe");
    }
    const bytes = new Uint8Array(
      await Bun.file(handle.fd)
        .slice(0, MAX_RECORD_BYTES + 1)
        .arrayBuffer(),
    );
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new Error("idempotency record is too large");
    }
    const value = parseRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (value === null) throw new Error("idempotency record is invalid");
    return value;
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  });
}

async function recordCount(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !ANSWER_UUID.test(entry.name)) {
      throw new Error("idempotency store contains an unsafe entry");
    }
  }
  return entries.length;
}

function randomTemporaryPath(directory: string): string {
  return join(directory, randomUUID());
}

export class DurableAnswerIdempotencyStore implements AnswerIdempotencyStore {
  async reserve(
    repositoryPath: string,
    key: string,
    fingerprint: string,
  ): Promise<AnswerReservation> {
    if (!ANSWER_UUID.test(key) || !FINGERPRINT.test(fingerprint)) {
      throw new Error("invalid idempotency reservation");
    }
    const directory = await storeDirectory(repositoryPath);
    const target = join(directory, key);
    const temporary = randomTemporaryPath(directory);
    await writePrivateRecord(temporary, {
      key,
      fingerprint,
      status: "reserved",
    });
    try {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        const existing = await readPrivateRecord(target);
        if (existing.key !== key || existing.fingerprint !== fingerprint) {
          return { status: "conflict" };
        }
        return existing.status === "complete"
          ? { status: "complete", id: existing.id }
          : { status: "reserved" };
      }
      await syncDirectory(directory);
    } finally {
      await removeIfPresent(temporary);
      await syncDirectory(directory);
    }
    if ((await recordCount(directory)) > MAX_ANSWER_IDEMPOTENCY_RECORDS) {
      await removeIfPresent(target);
      await syncDirectory(directory);
      return { status: "full" };
    }
    return { status: "acquired" };
  }

  async complete(
    repositoryPath: string,
    key: string,
    fingerprint: string,
    id: string,
  ): Promise<void> {
    if (!ANSWER_UUID.test(key) || !ANSWER_UUID.test(id)) {
      throw new Error("invalid idempotency completion");
    }
    const directory = await storeDirectory(repositoryPath);
    const target = join(directory, key);
    const existing = await readPrivateRecord(target);
    if (
      existing.key !== key ||
      existing.fingerprint !== fingerprint ||
      existing.status !== "reserved"
    ) {
      throw new Error("idempotency reservation changed");
    }
    const temporary = randomTemporaryPath(directory);
    await writePrivateRecord(temporary, {
      key,
      fingerprint,
      status: "complete",
      id,
    });
    try {
      await rename(temporary, target);
      await syncDirectory(directory);
    } finally {
      await removeIfPresent(temporary);
    }
  }
}
