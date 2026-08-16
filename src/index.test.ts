import { describe, expect, test, mock } from "bun:test";

import { parseConfig } from "./config";
import type { AppConfig } from "./contracts";
import { launch, parseCliArgs, serviceName } from "./index";

describe("factory-ui", () => {
  test("exports its service name", () => {
    expect(serviceName).toBe("factory-ui");
  });
});

describe("parseCliArgs", () => {
  test("accepts exactly serve --config <path>", () => {
    expect(parseCliArgs(["serve", "--config", "./config.json"])).toEqual({
      configPath: "./config.json",
    });
  });

  test("rejects malformed arguments", () => {
    for (const args of [
      [],
      ["serve"],
      ["serve", "--config"],
      ["start", "--config", "config.json"],
      ["serve", "config.json"],
      ["serve", "--config", "config.json", "extra"],
    ]) {
      expect(() => parseCliArgs(args)).toThrow(
        "Usage: bun run serve --config <path>",
      );
    }
  });
});

describe("launch", () => {
  const config: AppConfig = {
    machine: "test-machine",
    repositories: [
      {
        name: "test-repo",
        path: "/test/path",
        githubUrl: "https://github.com/test/repo",
      },
    ],
    peers: [],
    port: 7777,
    bind: "127.0.0.1",
    developmentOrigins: [],
  };

  test("loads and validates configuration before listening", async () => {
    const calls: string[] = [];
    const loadConfigMock = mock(async () => {
      calls.push("load");
      return config;
    });
    const server = { url: new URL("http://127.0.0.1:7777") };
    const startServerMock = mock((received: AppConfig) => {
      calls.push("listen");
      expect(received.port).toBe(7777);
      return server as ReturnType<typeof Bun.serve>;
    });

    await expect(
      launch(["serve", "--config", "config.json"], {
        loadConfig: loadConfigMock,
        startServer: startServerMock,
      }),
    ).resolves.toBe(server);
    expect(loadConfigMock).toHaveBeenCalledWith("config.json");
    expect(calls).toEqual(["load", "listen"]);
  });

  test("does not listen when configuration loading fails", async () => {
    const loadConfigMock = mock(async () => {
      throw new Error("invalid config");
    });
    const startServerMock = mock(() => {
      throw new Error("must not listen");
    });

    await expect(
      launch(["serve", "--config", "config.json"], {
        loadConfig: loadConfigMock,
        startServer: startServerMock,
      }),
    ).rejects.toThrow("invalid config");
    expect(startServerMock).not.toHaveBeenCalled();
  });
});

describe("distribution artifacts", () => {
  test("ships the documented serve command", async () => {
    const packageJson = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    expect(packageJson.scripts.serve).toBe("bun src/index.ts serve");
  });

  test("ships a valid credential-free three-machine example", async () => {
    const source = await Bun.file(
      new URL("../factory-ui.config.example.json", import.meta.url),
    ).json();
    const config = parseConfig(source);

    expect(config.machine).toBe("mini");
    expect(config.port).toBe(7777);
    expect(config.peers.map(({ name }) => name)).toEqual(["macbook", "legion"]);
    expect(JSON.stringify(source)).not.toContain("password");
    expect(JSON.stringify(source)).not.toContain("token");
  });
});
