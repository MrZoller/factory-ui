import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createFactoryFixture, type FactoryFixture } from "../test-support";
import {
  MAX_COST_MODELS_PER_TASK,
  MAX_COST_TASKS,
  MAX_COSTS_BYTES,
  MAX_COSTS_SOURCE_BYTES,
  MAX_COSTS_WINDOW_BYTES,
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

function costTask(usd: number, note?: string) {
  return {
    ...validCosts.tasks.T23,
    usd,
    ...(note === undefined ? {} : { note }),
  };
}

function oversizedCosts(suffix: Record<string, unknown>): string {
  // The leading member is deliberately larger than the retained suffix. Its
  // string exercises braces, commas, quotes, escapes, and split UTF-8 bytes.
  const padding = '"}, { [ ] \\ \\" 🦄,'.repeat(32_000);
  return JSON.stringify({
    ...validCosts,
    tasks: { T1: costTask(1, padding), ...suffix },
  });
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

  test("reads exactly 64KiB as a complete costs document", async () => {
    const present = fixture();
    const source = JSON.stringify(validCosts);
    const sourceLength = new TextEncoder().encode(source).byteLength;
    await present.writeCosts(
      `${source}${" ".repeat(MAX_COSTS_BYTES - sourceLength)}`,
    );

    expect(await readFactoryCosts(present.root)).toEqual({
      status: "available",
      data: validCosts,
      warnings: [],
    });
  });

  test("returns deterministic complete entries from one-byte-over and canonical oversized documents", async () => {
    const item = fixture();
    const oneByteOver = JSON.stringify(validCosts);
    const oneByteOverLength = new TextEncoder().encode(oneByteOver).byteLength;
    await item.writeCosts(
      `${oneByteOver}${" ".repeat(MAX_COSTS_BYTES + 1 - oneByteOverLength)}`,
    );
    expect(await readFactoryCosts(item.root)).toEqual({
      status: "partial",
      data: {
        ...validCosts,
        coverage: { kind: "recent-window", retainedTaskCount: 2 },
      },
      warnings: [
        {
          code: "COSTS_RECENT_WINDOW",
          message:
            "costs.json exceeded the complete-read limit; totals cover retained recent entries only",
        },
      ],
    });

    const source = oversizedCosts({
      T2: costTask(2, 'recent }, { [ ] \\" escaped 🦄'),
      T3: costTask(3, 'rightmost, } { \\\\ "quoted" 🦄'),
    });
    expect(encode(source).byteLength).toBeGreaterThan(MAX_COSTS_WINDOW_BYTES);
    await item.writeCosts(source);

    const first = await readFactoryCosts(item.root);
    const second = await readFactoryCosts(item.root);
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: "partial",
      data: {
        schemaVersion: 1,
        recordedAt: validCosts.recordedAt,
        currency: "USD",
        tasks: { T2: costTask(2), T3: costTask(3) },
        coverage: { kind: "recent-window", retainedTaskCount: 2 },
      },
      warnings: [
        {
          code: "COSTS_RECENT_WINDOW",
          message:
            "costs.json exceeded the complete-read limit; totals cover retained recent entries only",
        },
      ],
    });
  });

  test("ignores task-shaped unknown root properties after tasks in an oversized costs source", async () => {
    const item = fixture();
    await item.writeCosts(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: validCosts.recordedAt,
        currency: "USD",
        tasks: { T2: costTask(2) },
        futureTasks: { T99: { ...costTask(99), padding: "x".repeat(70_000) } },
      }),
    );

    const result = await readFactoryCosts(item.root);
    expect(result).toMatchObject({
      status: "partial",
      data: {
        tasks: { T2: costTask(2) },
        coverage: { kind: "recent-window", retainedTaskCount: 1 },
      },
      warnings: [{ code: "COSTS_RECENT_WINDOW" }],
    });
    if (result.status === "unavailable")
      throw new Error("costs must be readable");
    expect(Object.keys(result.data.tasks)).toEqual(["T2"]);
    expect(JSON.stringify(result.data)).not.toContain("futureTasks");
    expect(JSON.stringify(result.data)).not.toContain("T99");
  });

  test("rejects a costs source above the bounded source limit", async () => {
    const item = fixture();
    await item.writeCosts("x".repeat(MAX_COSTS_SOURCE_BYTES + 1));

    expect(await readFactoryCosts(item.root)).toEqual({
      status: "unavailable",
      warnings: [
        {
          code: "COSTS_TOO_LARGE",
          message: "costs.json exceeds the bounded source limit",
        },
      ],
    });
  });

  test("fails closed for malformed or unsafe oversized costs files", async () => {
    const malformed = fixture();
    const unsafe = fixture();
    await malformed.writeCosts(
      `${oversizedCosts({ T2: costTask(2) }).slice(0, -2)}]}`,
    );
    await unsafe.writeCosts(oversizedCosts({ T2: costTask(2) }));
    rmSync(join(malformed.factoryPath, "logs", "costs.json"));
    symlinkSync(
      join(unsafe.factoryPath, "logs", "costs.json"),
      join(malformed.factoryPath, "logs", "costs.json"),
    );

    // The malformed source is checked before replacing it with an unsafe link.
    const malformedSource = fixture();
    await malformedSource.writeCosts(
      `${oversizedCosts({ T2: costTask(2) }).slice(0, -2)}]}`,
    );
    expect((await readFactoryCosts(malformedSource.root)).status).toBe(
      "unavailable",
    );
    expect(await readFactoryCosts(malformed.root)).toEqual({
      status: "unavailable",
      warnings: [
        {
          code: "COSTS_UNAVAILABLE",
          message: "costs.json could not be read safely",
        },
      ],
    });
  });

  test("reports missing costs files", async () => {
    const missing = fixture();
    expect((await readFactoryCosts(missing.root)).warnings[0]?.code).toBe(
      "COSTS_MISSING",
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
