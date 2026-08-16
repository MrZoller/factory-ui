import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_PORT, loadConfig, parseConfig } from "./config";

describe("config", () => {
  describe("DEFAULT_PORT", () => {
    test("is 7777", () => {
      expect(DEFAULT_PORT).toBe(7777);
    });
  });

  describe("parseConfig", () => {
    test("returns config with default port when port is omitted", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
      };
      const result = parseConfig(input);
      expect(result).toEqual({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: DEFAULT_PORT,
      });
    });

    test("uses specified port when provided", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 8080,
      };
      const result = parseConfig(input);
      expect(result.port).toBe(8080);
    });

    test("accepts port 1", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 1,
      };
      const result = parseConfig(input);
      expect(result.port).toBe(1);
    });

    test("accepts port 65535", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 65535,
      };
      const result = parseConfig(input);
      expect(result.port).toBe(65535);
    });

    test("rejects port 0", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 0,
      };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects port 65536", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 65536,
      };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects negative port", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: -1,
      };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects floating point port", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 7777.5,
      };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects non-numeric port", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: "7777" as unknown as number,
      };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects empty machine string", () => {
      const input = {
        machine: "",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects whitespace-only machine string", () => {
      const input = {
        machine: "   ",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects empty repositories array", () => {
      const input = {
        machine: "test-machine",
        repositories: [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("rejects missing repositories", () => {
      const input = {
        machine: "test-machine",
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("accepts empty peers array", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
      };
      const result = parseConfig(input);
      expect(result.peers).toEqual([]);
    });

    test("rejects missing peers field", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
      };
      expect(() => parseConfig(input)).toThrow("peers must be an array");
    });

    test("rejects non-array peers", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: "not-an-array" as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow("peers must be an array");
    });

    test("rejects non-object repository", () => {
      const input = {
        machine: "test-machine",
        repositories: ["not-an-object"] as unknown as [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0] must be an object",
      );
    });

    test("rejects missing name in repository", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ path: "/path/to/repo1" }] as unknown as [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a non-empty string",
      );
    });

    test("rejects empty name in repository", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "", path: "/path/to/repo1" }] as unknown as [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a non-empty string",
      );
    });

    test("rejects missing path in repository", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1" }] as unknown as [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects empty path in repository", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "" }] as unknown as [],
        peers: [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects non-object peer", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: ["not-an-object"] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow("peers[0] must be an object");
    });

    test("rejects missing name in peer", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [{ origin: "http://localhost" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects empty name in peer", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [{ name: "", origin: "http://localhost" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects missing origin in peer", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [{ name: "peer1" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be a non-empty string",
      );
    });

    test("rejects empty origin in peer", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [{ name: "peer1", origin: "" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be a non-empty string",
      );
    });

    test("rejects non-object config", () => {
      expect(() => parseConfig("not-an-object" as unknown)).toThrow(
        "config must be a JSON object",
      );
    });

    test("rejects array config", () => {
      expect(() => parseConfig([] as unknown)).toThrow(
        "config must be a JSON object",
      );
    });

    test("rejects null config", () => {
      expect(() => parseConfig(null as unknown)).toThrow(
        "config must be a JSON object",
      );
    });

    test("rejects undefined config", () => {
      expect(() => parseConfig(undefined as unknown)).toThrow(
        "config must be a JSON object",
      );
    });

    test("rejects number config", () => {
      expect(() => parseConfig(123 as unknown)).toThrow(
        "config must be a JSON object",
      );
    });

    test("handles multiple repositories", () => {
      const input = {
        machine: "test-machine",
        repositories: [
          { name: "repo1", path: "/path/to/repo1" },
          { name: "repo2", path: "/path/to/repo2" },
        ],
        peers: [],
      };
      const result = parseConfig(input);
      expect(result.repositories).toHaveLength(2);
    });

    test("handles multiple peers", () => {
      const input = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [
          { name: "peer1", origin: "http://localhost:8080" },
          { name: "peer2", origin: "http://localhost:8081" },
        ],
      };
      const result = parseConfig(input);
      expect(result.peers).toHaveLength(2);
    });
  });

  describe("loadConfig", () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      tempDir = join(process.cwd(), "tmp-test-config");
      tempFile = join(tempDir, "config.json");
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("loads valid config file", async () => {
      const config = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 7777,
      };
      await Bun.write(tempFile, JSON.stringify(config));

      const result = await loadConfig(tempFile);
      expect(result).toEqual(config);
    });

    test("throws error for non-existent file", async () => {
      await expect(loadConfig("/nonexistent/path/config.json")).rejects.toThrow(
        "config file does not exist",
      );
    });

    test("throws error for file too large", async () => {
      // Create a file larger than MAX_CONFIG_BYTES (64KB)
      const largeContent = JSON.stringify({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 7777,
        // Add padding to exceed 64KB
        largeField: "x".repeat(70 * 1024),
      });
      await Bun.write(tempFile, largeContent);

      await expect(loadConfig(tempFile)).rejects.toThrow(
        "config file is too large",
      );
    });

    test("throws error for invalid JSON", async () => {
      await Bun.write(tempFile, "{ invalid json }");

      await expect(loadConfig(tempFile)).rejects.toThrow(
        "config file is not valid JSON",
      );
    });

    test("throws error for valid JSON but invalid config structure", async () => {
      await Bun.write(tempFile, JSON.stringify({ not: "valid config" }));

      await expect(loadConfig(tempFile)).rejects.toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("reads config file under MAX_CONFIG_BYTES", async () => {
      const config = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/path/to/repo1" }],
        peers: [],
        port: 7777,
      };
      // 64KB - 1 byte should succeed (file.size <= MAX_CONFIG_BYTES)
      // The config itself takes about 100 bytes, so we need to leave room for that
      const content = JSON.stringify({
        ...config,
        largeField: "x".repeat(64 * 1024 - 200), // Leave room for other content
      });
      await Bun.write(tempFile, content);

      // Should succeed since file size is <= 64KB
      const result = await loadConfig(tempFile);
      expect(result.machine).toBe("test-machine");
    });
  });
});
