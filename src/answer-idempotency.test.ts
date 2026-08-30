import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  DurableAnswerIdempotencyStore,
  MAX_ANSWER_IDEMPOTENCY_RECORDS,
} from "./answer-idempotency";

const fingerprint = createHash("sha256")
  .update("bounded payload")
  .digest("hex");
const outcomeId = "123e4567-e89b-42d3-a456-426614174000";

describe("durable answer idempotency store", () => {
  let repository: string;
  let storePath: string;

  beforeEach(() => {
    repository = mkdtempSync(join(process.cwd(), "tmp-answer-idempotency-"));
    const initialized = Bun.spawnSync(["git", "init", "--quiet", repository]);
    expect(initialized.exitCode).toBe(0);
    storePath = join(
      repository,
      ".git",
      "factory",
      "factory-ui-answer-idempotency",
    );
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  test("persists a private completed mapping across store instances without payload data", async () => {
    const key = randomUUID();
    const store = new DurableAnswerIdempotencyStore();

    expect(await store.reserve(repository, key, fingerprint)).toEqual({
      status: "acquired",
    });
    expect(lstatSync(storePath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(storePath, key)).mode & 0o777).toBe(0o600);

    await store.complete(repository, key, fingerprint, outcomeId);
    expect(
      await new DurableAnswerIdempotencyStore().reserve(
        repository,
        key,
        fingerprint,
      ),
    ).toEqual({ status: "complete", id: outcomeId });
    const serialized = readFileSync(join(storePath, key), "utf8");
    expect(JSON.parse(serialized)).toEqual({
      key,
      fingerprint,
      status: "complete",
      id: outcomeId,
    });
    expect(serialized).not.toContain("bounded payload");
    expect(readdirSync(storePath)).toEqual([key]);
  });

  test("keeps reservations across restarts and detects conflicts", async () => {
    const key = randomUUID();
    const store = new DurableAnswerIdempotencyStore();
    expect(await store.reserve(repository, key, fingerprint)).toEqual({
      status: "acquired",
    });
    expect(
      await new DurableAnswerIdempotencyStore().reserve(
        repository,
        key,
        fingerprint,
      ),
    ).toEqual({ status: "reserved" });
    expect(await store.reserve(repository, key, "0".repeat(64))).toEqual({
      status: "conflict",
    });
  });

  test("fails closed at the per-repository record cap", async () => {
    mkdirSync(storePath, { recursive: true, mode: 0o700 });
    for (let index = 0; index < MAX_ANSWER_IDEMPOTENCY_RECORDS; index += 1) {
      const key = randomUUID();
      writeFileSync(
        join(storePath, key),
        `${JSON.stringify({ key, fingerprint, status: "reserved" })}\n`,
        { mode: 0o600 },
      );
    }
    const extra = randomUUID();

    expect(
      await new DurableAnswerIdempotencyStore().reserve(
        repository,
        extra,
        fingerprint,
      ),
    ).toEqual({ status: "full" });
    expect(readdirSync(storePath)).toHaveLength(MAX_ANSWER_IDEMPOTENCY_RECORDS);
    expect(readdirSync(storePath)).not.toContain(extra);
  });

  test("rejects a symlink planted at a UUID record path", async () => {
    const key = randomUUID();
    mkdirSync(storePath, { recursive: true, mode: 0o700 });
    const target = join(repository, "outside");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, join(storePath, key));

    await expect(
      new DurableAnswerIdempotencyStore().reserve(repository, key, fingerprint),
    ).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});
