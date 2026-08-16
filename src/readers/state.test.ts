import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createFactoryFixture, type FactoryFixture } from "../test-support";
import {
  MAX_PROJECT_LENGTH,
  MAX_STATE_BYTES,
  MAX_STATE_STRING_LENGTH,
  parseFactoryState,
  readFactoryState,
} from "./state";

const validState = {
  project: "factory-ui",
  phase: "build",
  spec_approved: true,
  plan_approved: false,
  current_task: "T42",
  branch: "factory/t42-reader",
  pr: 123,
  hold: true,
  updated: "2026-08-16T05:47:57Z",
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("state reader", () => {
  const fixtures: FactoryFixture[] = [];
  const fixture = (): FactoryFixture => {
    const created = createFactoryFixture();
    fixtures.push(created);
    return created;
  };

  afterEach(() => {
    for (const item of fixtures.splice(0)) item.cleanup();
  });

  test("exports fixed parsing limits", () => {
    expect(MAX_STATE_BYTES).toBe(64 * 1024);
    expect(MAX_PROJECT_LENGTH).toBe(200);
    expect(MAX_STATE_STRING_LENGTH).toBe(1024);
  });

  test("parses every approved state field and ignores unknown fields", () => {
    const result = parseFactoryState(
      encode({ ...validState, future: "value" }),
    );
    expect(result).toEqual({
      status: "available",
      data: {
        project: "factory-ui",
        phase: "build",
        specApproved: true,
        planApproved: false,
        currentTask: "T42",
        branch: "factory/t42-reader",
        pr: 123,
        hold: true,
        updated: "2026-08-16T05:47:57Z",
      },
      warnings: [],
    });
  });

  test.each(["specify", "plan", "build", "idle"])(
    "accepts the %s phase",
    (phase) => {
      expect(parseFactoryState(encode({ ...validState, phase })).status).toBe(
        "available",
      );
    },
  );

  test("accepts nullable task, branch, and PR fields", () => {
    const result = parseFactoryState(
      encode({ ...validState, current_task: null, branch: null, pr: null }),
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.data.currentTask).toBeNull();
      expect(result.data.branch).toBeNull();
      expect(result.data.pr).toBeNull();
    }
  });

  test("accepts one-to-three digit UTC fractions", () => {
    for (const updated of [
      "2026-08-16T05:47:57.1Z",
      "2026-08-16T05:47:57.12Z",
      "2026-08-16T05:47:57.123Z",
    ]) {
      expect(parseFactoryState(encode({ ...validState, updated })).status).toBe(
        "available",
      );
    }
  });

  test("returns only defensible fields for a partially written object", () => {
    const result = parseFactoryState(
      encode({ project: "factory-ui", phase: "build", hold: "false" }),
    );
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.data).toEqual({ project: "factory-ui", phase: "build" });
      expect(
        result.warnings.every((item) => item.code === "STATE_INVALID_FIELD"),
      ).toBeTrue();
    }
  });

  test.each([
    ["project", ""],
    ["project", "x".repeat(MAX_PROJECT_LENGTH + 1)],
    ["phase", "shipping"],
    ["spec_approved", 1],
    ["plan_approved", "yes"],
    ["current_task", "../T1"],
    ["branch", ""],
    ["branch", "x".repeat(MAX_STATE_STRING_LENGTH + 1)],
    ["pr", 0],
    ["pr", 1.5],
    ["hold", null],
    ["updated", "2026-02-31T00:00:00Z"],
    ["updated", "2026-08-16T05:47:57+01:00"],
  ])("marks invalid %s data partial", (field, value) => {
    const result = parseFactoryState(encode({ ...validState, [field]: value }));
    expect(result.status).toBe("partial");
    if (result.status === "partial")
      expect(result.data).not.toHaveProperty(
        field === "current_task"
          ? "currentTask"
          : field === "spec_approved"
            ? "specApproved"
            : field === "plan_approved"
              ? "planApproved"
              : field,
      );
  });

  test.each(["", '{"project":', "null", "[]", "true"])(
    "returns unavailable for malformed or non-object JSON %p",
    (text) => {
      expect(parseFactoryState(new TextEncoder().encode(text)).status).toBe(
        "unavailable",
      );
    },
  );

  test("returns unavailable for invalid UTF-8", () => {
    const result = parseFactoryState(new Uint8Array([0xff, 0xfe]));
    expect(result.status).toBe("unavailable");
    expect(result.warnings[0]?.code).toBe("STATE_INVALID_UTF8");
  });

  test("reads a valid fixed state file", async () => {
    const item = fixture();
    await item.writeState(validState);
    expect(await readFactoryState(item.root)).toMatchObject({
      status: "available",
      data: { project: "factory-ui" },
    });
  });

  test("returns bounded generic warnings for missing and oversized files", async () => {
    const missing = fixture();
    const oversized = fixture();
    await oversized.writeState("x".repeat(MAX_STATE_BYTES + 1));
    expect(await readFactoryState(missing.root)).toEqual({
      status: "unavailable",
      warnings: [{ code: "STATE_MISSING", message: "state.json is missing" }],
    });
    expect(await readFactoryState(oversized.root)).toEqual({
      status: "unavailable",
      warnings: [
        { code: "STATE_TOO_LARGE", message: "state.json is too large" },
      ],
    });
  });

  test("rejects a symlink escape without exposing paths", async () => {
    const item = fixture();
    const outside = fixture();
    await outside.writeState(validState);
    symlinkSync(
      join(outside.factoryPath, "state.json"),
      join(item.factoryPath, "state.json"),
    );
    const result = await readFactoryState(item.root);
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(item.root);
    expect(JSON.stringify(result)).not.toContain(outside.root);
  });

  test("rejects a non-file state target", async () => {
    const item = fixture();
    mkdirSync(join(item.factoryPath, "state.json"));
    expect((await readFactoryState(item.root)).status).toBe("unavailable");
  });

  test("rejects a state.json FIFO without blocking", async () => {
    const item = fixture();
    const path = join(item.factoryPath, "state.json");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);

    const result = await readFactoryState(item.root);

    expect(result.status).toBe("unavailable");
    expect(result.warnings[0]?.code).toBe("STATE_UNAVAILABLE");
  });
});
