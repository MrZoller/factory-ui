import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createFactoryFixture, type FactoryFixture } from "../test-support";
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_ROUTING_AGENTS,
  MAX_ROUTING_BYTES,
  MAX_ROUTING_STEPS,
  MAX_ROUTING_STRING_LENGTH,
  parseFactoryRouting,
  readFactoryRouting,
} from "./routing";

const validRouting = {
  schemaVersion: 1,
  recordedAt: "2026-08-16T05:47:57Z",
  model: "openai/gpt-5.6",
  smallModel: "opencode/gpt-5-mini",
  agents: {
    builder: { provider: "openai", model: "gpt-5.6", steps: 25 },
    reviewer: { provider: "amazon-bedrock", model: "claude", steps: null },
  },
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("routing reader", () => {
  const fixtures: FactoryFixture[] = [];
  const fixture = (): FactoryFixture => {
    const created = createFactoryFixture();
    fixtures.push(created);
    return created;
  };

  afterEach(() => {
    for (const item of fixtures.splice(0)) item.cleanup();
  });

  test("exports fixed bounds", () => {
    expect(MAX_ROUTING_BYTES).toBe(16 * 1024);
    expect(MAX_ROUTING_AGENTS).toBe(64);
    expect(MAX_AGENT_NAME_LENGTH).toBe(128);
    expect(MAX_ROUTING_STRING_LENGTH).toBe(1024);
    expect(MAX_ROUTING_STEPS).toBe(1_000_000);
  });

  test("parses schema version 1 and ignores unknown keys at every level", () => {
    const result = parseFactoryRouting(
      encode({
        ...validRouting,
        future: true,
        agents: {
          builder: {
            provider: "openai",
            model: "gpt-5.6",
            steps: 25,
            future: "ignored",
          },
        },
      }),
    );
    expect(result).toEqual({
      status: "available",
      data: {
        schemaVersion: 1,
        recordedAt: "2026-08-16T05:47:57Z",
        model: "openai/gpt-5.6",
        smallModel: "opencode/gpt-5-mini",
        agents: {
          builder: { provider: "openai", model: "gpt-5.6", steps: 25 },
        },
      },
      warnings: [],
    });
  });

  test("preserves hostile agent, provider, and model text as data", () => {
    const hostile = '<img src=x onerror="pwned=1">';
    const result = parseFactoryRouting(
      encode({
        ...validRouting,
        agents: {
          [hostile]: { provider: hostile, model: hostile, steps: null },
        },
      }),
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.data.agents[hostile]).toEqual({
        provider: hostile,
        model: hostile,
        steps: null,
      });
    }
  });

  test("preserves a __proto__ agent name without changing the agent map prototype", () => {
    const result = parseFactoryRouting(
      new TextEncoder().encode(
        '{"schemaVersion":1,"recordedAt":"2026-08-16T05:47:57Z","model":"openai/gpt-5.6","smallModel":"opencode/gpt-5-mini","agents":{"__proto__":{"provider":"openai","model":"gpt","steps":null}}}',
      ),
    );

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(Object.getPrototypeOf(result.data.agents)).toBeNull();
      expect(result.data.agents.__proto__).toEqual({
        provider: "openai",
        model: "gpt",
        steps: null,
      });
    }
  });

  test.each([0, 1, MAX_ROUTING_STEPS, null])(
    "accepts bounded steps %p",
    (steps) => {
      expect(
        parseFactoryRouting(
          encode({
            ...validRouting,
            agents: { builder: { provider: "openai", model: "gpt", steps } },
          }),
        ).status,
      ).toBe("available");
    },
  );

  test.each([
    ["schemaVersion", 2],
    ["schemaVersion", "1"],
    ["recordedAt", "2026-02-31T00:00:00Z"],
    ["recordedAt", "2026-08-16T05:47:57+01:00"],
    ["model", "missing-provider"],
    ["model", `/model`],
    ["smallModel", `provider/`],
    ["model", `p/${"x".repeat(MAX_ROUTING_STRING_LENGTH)}`],
    ["agents", []],
  ])("rejects invalid root field %s", (field, value) => {
    expect(
      parseFactoryRouting(encode({ ...validRouting, [field]: value })).status,
    ).toBe("unavailable");
  });

  test.each(["schemaVersion", "recordedAt", "model", "smallModel", "agents"])(
    "rejects a missing required root field %s",
    (field) => {
      const routing: Record<string, unknown> = { ...validRouting };
      delete routing[field];

      expect(parseFactoryRouting(encode(routing)).status).toBe("unavailable");
    },
  );

  test.each([
    ["", { provider: "openai", model: "gpt", steps: null }],
    [
      "x".repeat(MAX_AGENT_NAME_LENGTH + 1),
      { provider: "openai", model: "gpt", steps: null },
    ],
    ["builder", { provider: "", model: "gpt", steps: null }],
    ["builder", { provider: "openai", model: "x".repeat(1025), steps: null }],
    ["builder", { provider: "openai", model: "gpt", steps: -1 }],
    ["builder", { provider: "openai", model: "gpt", steps: 1.5 }],
    [
      "builder",
      { provider: "openai", model: "gpt", steps: MAX_ROUTING_STEPS + 1 },
    ],
  ])("rejects invalid agent %p", (name, agent) => {
    expect(
      parseFactoryRouting(
        encode({ ...validRouting, agents: { [name as string]: agent } }),
      ).status,
    ).toBe("unavailable");
  });

  test("rejects more than the bounded number of agents", () => {
    const agents = Object.fromEntries(
      Array.from({ length: MAX_ROUTING_AGENTS + 1 }, (_, index) => [
        `agent-${index}`,
        { provider: "openai", model: "gpt", steps: null },
      ]),
    );
    expect(
      parseFactoryRouting(encode({ ...validRouting, agents })).warnings[0]
        ?.code,
    ).toBe("ROUTING_TOO_MANY_AGENTS");
  });

  test.each(["", "{", "null", "[]", "true"])(
    "rejects malformed or non-object JSON %p",
    (text) => {
      expect(parseFactoryRouting(new TextEncoder().encode(text)).status).toBe(
        "unavailable",
      );
    },
  );

  test("rejects invalid UTF-8", () => {
    expect(parseFactoryRouting(new Uint8Array([0xff])).warnings[0]?.code).toBe(
      "ROUTING_INVALID_UTF8",
    );
  });

  test("reads the fixed nested target through the bounded file reader", async () => {
    const item = fixture();
    await item.writeRouting(validRouting);
    expect(await readFactoryRouting(item.root)).toMatchObject({
      status: "available",
      data: { model: "openai/gpt-5.6" },
    });
  });

  test("accepts a routing file at exactly the 16 KiB boundary", async () => {
    const item = fixture();
    const encoded = encode({ ...validRouting, padding: "" });
    const padding = "x".repeat(MAX_ROUTING_BYTES - encoded.byteLength);
    const exact = encode({ ...validRouting, padding });

    expect(exact.byteLength).toBe(MAX_ROUTING_BYTES);
    await item.writeRouting(exact);
    expect(await readFactoryRouting(item.root)).toMatchObject({
      status: "available",
      data: { agents: validRouting.agents },
    });
  });

  test("reports missing and oversized routing independently", async () => {
    const missing = fixture();
    const oversized = fixture();
    await oversized.writeRouting("x".repeat(MAX_ROUTING_BYTES + 1));
    expect((await readFactoryRouting(missing.root)).warnings[0]?.code).toBe(
      "ROUTING_MISSING",
    );
    expect((await readFactoryRouting(oversized.root)).warnings[0]?.code).toBe(
      "ROUTING_TOO_LARGE",
    );
  });

  test("rejects symlink escapes and non-file targets without exposing paths", async () => {
    const item = fixture();
    const outside = fixture();
    await outside.writeRouting(validRouting);
    symlinkSync(
      join(outside.factoryPath, "logs", "routing.json"),
      join(item.factoryPath, "logs", "routing.json"),
    );
    const escaped = await readFactoryRouting(item.root);
    expect(escaped.status).toBe("unavailable");
    expect(JSON.stringify(escaped)).not.toContain(outside.root);

    const directory = fixture();
    mkdirSync(join(directory.factoryPath, "logs", "routing.json"));
    expect((await readFactoryRouting(directory.root)).status).toBe(
      "unavailable",
    );
  });
});
