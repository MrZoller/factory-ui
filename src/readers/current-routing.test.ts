import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_OPENCODE_CONFIG_BYTES,
  parseCurrentRouting,
  readCurrentRouting,
} from "./current-routing";

const encoder = new TextEncoder();

function parse(text: string) {
  return parseCurrentRouting(encoder.encode(text));
}

describe("current opencode routing reader", () => {
  const roots: string[] = [];
  const root = () => {
    const created = mkdtempSync(join(tmpdir(), "factory-ui-current-routing-"));
    roots.push(created);
    return created;
  };

  afterEach(() => {
    for (const path of roots.splice(0))
      rmSync(path, { recursive: true, force: true });
  });

  test("parses JSONC comments and trailing commas without mistaking string contents for comments", () => {
    const result = parse(`{
      // the configured default
      "model": "openai/gpt-5.6",
      "small_model": "opencode/gpt-5-mini", /* an inline comment */
      "note": "https://example.test//not-a-comment and /* not a comment */",
      "agent": {
        "builder": { "model": "openai/gpt-5.6", "steps": 25, },
      },
    }`);

    expect(result).toEqual({
      status: "available",
      data: {
        model: "openai/gpt-5.6",
        smallModel: "opencode/gpt-5-mini",
        agents: {
          builder: { provider: "openai", model: "gpt-5.6", steps: 25 },
        },
      },
      warnings: [],
    });
  });

  test("accepts UTF-8 routing values and rejects malformed JSONC or invalid UTF-8", () => {
    expect(
      parse(
        '{"model":"openai/gpt-5.6","small_model":"opencode/gpt-5-mini","label":"café ☕","agent":{}}',
      ),
    ).toMatchObject({ status: "available" });
    for (const bytes of [
      encoder.encode('{"model":"openai/gpt'),
      new Uint8Array([0xff]),
    ]) {
      expect(parseCurrentRouting(bytes).warnings[0]?.code).toBe(
        "CURRENT_ROUTING_INVALID_JSONC",
      );
    }
  });

  test("rejects malformed defaults and agent maps, while isolating invalid agents", () => {
    for (const text of [
      '{"small_model":"openai/small"}',
      '{"model":"openai/default","small_model":"invalid"}',
      '{"model":"openai/default","small_model":"openai/small","agent":[]}',
    ]) {
      expect(parse(text).status).toBe("unavailable");
    }

    const result = parse(`{
      "model":"openai/default", "small_model":"openai/small",
      "agent": {
        "valid":{"model":"amazon-bedrock/claude","steps":0},
        "invalid":{"model":"openai/gpt","steps":-1},
        "no-override":{"steps":12}
      }
    }`);
    expect(result).toMatchObject({
      status: "partial",
      data: {
        agents: {
          valid: { provider: "amazon-bedrock", model: "claude", steps: 0 },
        },
      },
      warnings: [{ code: "CURRENT_ROUTING_INVALID_AGENT" }],
    });
  });

  test("enforces object and agent limits and preserves hostile own keys in a null-prototype map", () => {
    const tooManyAgents = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `agent-${index}`,
        { model: "openai/gpt" },
      ]),
    );
    expect(
      parse(
        JSON.stringify({
          model: "openai/default",
          small_model: "openai/small",
          agent: tooManyAgents,
        }),
      ).warnings[0]?.code,
    ).toBe("CURRENT_ROUTING_TOO_MANY_AGENTS");
    expect(
      parse(
        JSON.stringify({
          model: "openai/default",
          small_model: "openai/small",
          ...Object.fromEntries(
            Array.from({ length: 255 }, (_, index) => [`future${index}`, true]),
          ),
        }),
      ).warnings[0]?.code,
    ).toBe("CURRENT_ROUTING_INVALID_ROOT");

    const result = parse(
      '{"model":"openai/default","small_model":"openai/small","agent":{"__proto__":{"model":"openai/gpt"},"constructor":{"model":"opencode/mini"}}}',
    );
    expect(result.status).toBe("available");
    if (result.status !== "unavailable") {
      expect(Object.getPrototypeOf(result.data.agents)).toBeNull();
      expect(result.data.agents.__proto__).toEqual({
        provider: "openai",
        model: "gpt",
        steps: null,
      });
      expect(result.data.agents["constructor"]).toEqual({
        provider: "opencode",
        model: "mini",
        steps: null,
      });
    }
  });

  test("reports omission, missing, symlinked, nonregular, and oversized external targets without reading them", async () => {
    expect((await readCurrentRouting(undefined)).warnings[0]?.code).toBe(
      "CURRENT_ROUTING_NOT_CONFIGURED",
    );
    const directory = root();
    const path = join(directory, "opencode.jsonc");
    expect((await readCurrentRouting(path)).warnings[0]?.code).toBe(
      "CURRENT_ROUTING_MISSING",
    );

    const outside = root();
    const outsidePath = join(outside, "opencode.jsonc");
    await Bun.write(
      outsidePath,
      '{"model":"openai/default","small_model":"openai/small"}',
    );
    symlinkSync(outsidePath, path);
    expect((await readCurrentRouting(path)).warnings[0]?.code).toBe(
      "CURRENT_ROUTING_UNAVAILABLE",
    );
    rmSync(path);
    mkdirSync(path);
    expect((await readCurrentRouting(path)).warnings[0]?.code).toBe(
      "CURRENT_ROUTING_UNAVAILABLE",
    );
    rmSync(path, { recursive: true });
    await Bun.write(path, "x".repeat(MAX_OPENCODE_CONFIG_BYTES + 1));
    expect((await readCurrentRouting(path)).warnings[0]?.code).toBe(
      "CURRENT_ROUTING_TOO_LARGE",
    );

    const base =
      '{"model":"openai/default","small_model":"openai/small","padding":""}';
    await Bun.write(
      path,
      `${base.slice(0, -2)}${"x".repeat(MAX_OPENCODE_CONFIG_BYTES - encoder.encode(base).byteLength)}"}`,
    );
    expect((await readCurrentRouting(path)).status).toBe("available");
  });
});
