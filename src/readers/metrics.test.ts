import { afterEach, describe, expect, test } from "bun:test";

import { createFactoryFixture, type FactoryFixture } from "../test-support";
import {
  MAX_METRICS_BYTES,
  MAX_METRICS_LINES,
  MAX_METRICS_LINE_BYTES,
  parseFactoryMetrics,
  readFactoryMetrics,
} from "./metrics";

const ship = {
  schemaVersion: 1,
  task: "T34",
  event: "ship",
  size: "standard",
  reclassifiedFrom: null,
  internal: {
    rounds: 2,
    findings: { blocking: 1, minor: 2, invalid: 3 },
    fixed: 3,
  },
};

const merge = {
  schemaVersion: 1,
  task: "T34",
  event: "merge",
  pr: 34,
  external: {
    codex: {
      rounds: 1,
      findings: { blocking: 0, minor: 2, refuted: 1 },
      fixPushes: 2,
    },
  },
  ci: { runs: 3, reruns: 2 },
};

const pr = {
  schemaVersion: 1,
  task: "T34",
  event: "pr",
  by: "factory-git",
  openedAt: "2026-08-16T10:00:00.000Z",
  mergedAt: "2026-08-16T12:00:00.000Z",
  commits: 4,
  commitsAfterOpen: 3,
  reviews: { codex: 1 },
  issueComments: { codex: 2 },
  reactions: { codex: { eyes: 1 } },
  threads: { codex: { total: 3, resolved: 2 } },
  checkRuns: { total: 8, failed: 0 },
};

function jsonl(...events: unknown[]): Uint8Array {
  return new TextEncoder().encode(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

describe("metrics reader", () => {
  const fixtures: FactoryFixture[] = [];
  const fixture = () => {
    const created = createFactoryFixture();
    fixtures.push(created);
    return created;
  };

  afterEach(() => {
    for (const item of fixtures.splice(0)) item.cleanup();
  });

  test("exports and enforces the documented byte, line, and line-byte bounds", async () => {
    expect(MAX_METRICS_BYTES).toBe(256 * 1024);
    expect(MAX_METRICS_LINES).toBe(4096);
    expect(MAX_METRICS_LINE_BYTES).toBe(8 * 1024);

    const item = fixture();
    await item.writeMetrics("x".repeat(MAX_METRICS_BYTES + 1));
    expect((await readFactoryMetrics(item.root)).warnings[0]?.code).toBe(
      "METRICS_TOO_LARGE",
    );

    const overlong = parseFactoryMetrics(
      new TextEncoder().encode(`${"x".repeat(MAX_METRICS_LINE_BYTES + 1)}\n`),
    );
    expect(overlong.status).toBe("partial");
    expect(overlong.warnings[0]?.line).toBe(1);

    const tooManyLines = parseFactoryMetrics(
      jsonl(...Array.from({ length: MAX_METRICS_LINES + 1 }, () => ship)),
    );
    expect(tooManyLines.status).toBe("partial");
    expect(
      tooManyLines.warnings.some(
        (warning) => warning.line === MAX_METRICS_LINES + 1,
      ),
    ).toBe(true);
  });

  test("drops malformed JSONL records, while folding valid latest ship, merge, and pr events per task", () => {
    const result = parseFactoryMetrics(
      jsonl(
        { ...ship, internal: null },
        "not json",
        { ...ship, internal: { ...ship.internal, rounds: 2 } },
        merge,
        {
          ...merge,
          external: { claude: { ...merge.external.codex, rounds: 4 } },
        },
        pr,
      ),
    );

    expect(result.status).toBe("partial");
    expect(result.warnings).toHaveLength(1);
    if (result.status === "unavailable") throw new Error("metrics unavailable");
    expect(result.data.tasks.T34).toMatchObject({
      ship: { internal: { rounds: 2, fixed: 3 } },
      merge: { external: { claude: { rounds: 4, fixPushes: 2 } } },
      pr: { mergedAt: "2026-08-16T12:00:00.000Z", reviews: { codex: 1 } },
    });
    expect(result.data.tasks.T34?.merge?.external.codex).toBeUndefined();
  });

  test("rejects invalid event shapes without inventing counters and reports a missing file as unavailable", async () => {
    const item = fixture();
    expect((await readFactoryMetrics(item.root)).status).toBe("unavailable");

    const result = parseFactoryMetrics(
      jsonl(
        { ...ship, task: "../T34" },
        {
          ...merge,
          external: { "<img onerror=alert(1)>": merge.external.codex },
        },
        { ...pr, by: "curl" },
        { ...ship, internal: { ...ship.internal, rounds: -1 } },
      ),
    );
    expect(result.status).toBe("partial");
    if (result.status === "unavailable") throw new Error("metrics unavailable");
    expect(result.data.tasks).toEqual({});
    expect(result.warnings).toHaveLength(4);
  });
});
