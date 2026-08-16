import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createFactoryFixture, type FactoryFixture } from "../test-support";
import {
  MAX_COST_MODELS_PER_TASK,
  MAX_COST_TASKS,
  MAX_COSTS_BYTES,
  parseFactoryCosts,
  readFactoryCosts,
} from "./costs";

const counters = {
  usd: 1.23,
  messages: 4,
  sessions: 2,
  tokens: { input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
};
const validCosts = {
  schemaVersion: 1 as const,
  recordedAt: "2026-08-16T05:47:57Z",
  currency: "USD",
  tasks: {
    T23: {
      ...counters,
      byModel: { "openai/gpt-5.6": counters },
      firstAt: "2026-08-16T05:00:00Z",
      lastAt: "2026-08-16T05:47:57Z",
    },
    unattributed: {
      ...counters,
      usd: 0,
      byModel: {},
      firstAt: "2026-08-16T05:00:00Z",
      lastAt: "2026-08-16T05:47:57Z",
    },
  },
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("costs reader", () => {
  const fixtures: FactoryFixture[] = [];
  const fixture = (): FactoryFixture => {
    const created = createFactoryFixture();
    fixtures.push(created);
    return created;
  };

  afterEach(() => {
    for (const item of fixtures.splice(0)) item.cleanup();
  });

  test("parses schema version 1 counters and ignores unknown keys", () => {
    expect(parseFactoryCosts(encode({ ...validCosts, future: true }))).toEqual({
      status: "available",
      data: validCosts,
      warnings: [],
    });
  });

  test("exports the documented byte, task, and model bounds", () => {
    expect(MAX_COSTS_BYTES).toBe(64 * 1024);
    expect(MAX_COST_TASKS).toBe(256);
    expect(MAX_COST_MODELS_PER_TASK).toBe(64);
  });

  test.each(["{", "null", "[]", "true"])(
    "rejects malformed JSON or a non-object root: %p",
    (source) => {
      expect(parseFactoryCosts(new TextEncoder().encode(source)).status).toBe(
        "unavailable",
      );
    },
  );

  test("rejects invalid UTF-8 with an explicit warning", () => {
    expect(parseFactoryCosts(new Uint8Array([0xc3, 0x28]))).toEqual({
      status: "unavailable",
      warnings: [
        {
          code: "COSTS_INVALID_UTF8",
          message: "costs.json is not valid UTF-8",
        },
      ],
    });
  });

  test.each([
    ["schemaVersion", 2],
    ["recordedAt", "2026-02-31T00:00:00Z"],
    ["currency", ""],
    ["tasks", []],
  ])("rejects malformed schema field %s", (field, value) => {
    expect(
      parseFactoryCosts(encode({ ...validCosts, [field]: value })).status,
    ).toBe("unavailable");
  });

  test("rejects non-USD costs instead of exposing them as dollars", () => {
    expect(
      parseFactoryCosts(encode({ ...validCosts, currency: "EUR" })),
    ).toEqual({
      status: "unavailable",
      warnings: [
        {
          code: "COSTS_UNSUPPORTED_CURRENCY",
          message: "costs.json currency must be USD",
        },
      ],
    });
  });

  test.each(["T0", "T01", "t23", "23", "../T23", "__proto__"])(
    "rejects invalid or hostile task key %s",
    (taskId) => {
      const task = validCosts.tasks.T23;
      expect(
        parseFactoryCosts(encode({ ...validCosts, tasks: { [taskId]: task } }))
          .warnings[0]?.code,
      ).toBe("COSTS_INVALID_TASK");
    },
  );

  test.each([NaN, Infinity, -Infinity, -0.01])(
    "rejects non-finite or negative counters: %p",
    (value) => {
      const task = { ...validCosts.tasks.T23, usd: value };
      expect(
        parseFactoryCosts(encode({ ...validCosts, tasks: { T23: task } }))
          .status,
      ).toBe("unavailable");
    },
  );

  test("rejects invalid model identifiers and counters", () => {
    const task = {
      ...validCosts.tasks.T23,
      byModel: { "missing-separator": { ...counters, messages: -1 } },
    };
    expect(
      parseFactoryCosts(encode({ ...validCosts, tasks: { T23: task } }))
        .warnings[0]?.code,
    ).toBe("COSTS_INVALID_MODEL");
  });

  test("accepts exactly 256 tasks and 64 models per task, rejecting one more", () => {
    const task = validCosts.tasks.T23;
    const tasks = Object.fromEntries(
      Array.from({ length: MAX_COST_TASKS }, (_, index) => [
        `T${index + 1}`,
        task,
      ]),
    );
    const models = Object.fromEntries(
      Array.from({ length: MAX_COST_MODELS_PER_TASK }, (_, index) => [
        `provider/model-${index}`,
        counters,
      ]),
    );
    expect(
      parseFactoryCosts(
        encode({ ...validCosts, tasks: { T1: { ...task, byModel: models } } }),
      ).status,
    ).toBe("available");
    expect(parseFactoryCosts(encode({ ...validCosts, tasks })).status).toBe(
      "available",
    );
    expect(
      parseFactoryCosts(
        encode({ ...validCosts, tasks: { ...tasks, T257: task } }),
      ).warnings[0]?.code,
    ).toBe("COSTS_TOO_MANY_TASKS");
    expect(
      parseFactoryCosts(
        encode({
          ...validCosts,
          tasks: {
            T1: {
              ...task,
              byModel: { ...models, "provider/model-64": counters },
            },
          },
        }),
      ).warnings[0]?.code,
    ).toBe("COSTS_TOO_MANY_MODELS");
  });

  test("reads the fixed bounded target and reports missing or oversized files", async () => {
    const present = fixture();
    const missing = fixture();
    const oversized = fixture();
    await present.writeCosts(validCosts);
    await oversized.writeCosts("x".repeat(MAX_COSTS_BYTES + 1));

    expect(await readFactoryCosts(present.root)).toMatchObject({
      status: "available",
      data: { tasks: { T23: { usd: 1.23 } } },
    });
    expect((await readFactoryCosts(missing.root)).warnings[0]?.code).toBe(
      "COSTS_MISSING",
    );
    expect((await readFactoryCosts(oversized.root)).warnings[0]?.code).toBe(
      "COSTS_TOO_LARGE",
    );
  });

  test("rejects symlink escapes and non-file costs targets without exposing paths", async () => {
    const item = fixture();
    const outside = fixture();
    await outside.writeCosts(validCosts);
    symlinkSync(
      join(outside.factoryPath, "logs", "costs.json"),
      join(item.factoryPath, "logs", "costs.json"),
    );
    const escaped = await readFactoryCosts(item.root);
    expect(escaped.status).toBe("unavailable");
    expect(JSON.stringify(escaped)).not.toContain(outside.root);

    const directory = fixture();
    mkdirSync(join(directory.factoryPath, "logs", "costs.json"));
    expect((await readFactoryCosts(directory.root)).status).toBe("unavailable");
  });
});
