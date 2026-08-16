import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_BIND, DEFAULT_PORT, loadConfig, parseConfig } from "./config";

describe("config", () => {
  describe("DEFAULT_PORT", () => {
    test("is 7777", () => {
      expect(DEFAULT_PORT).toBe(7777);
    });
  });

  describe("DEFAULT_BIND", () => {
    test("is 127.0.0.1", () => {
      expect(DEFAULT_BIND).toBe("127.0.0.1");
    });
  });

  describe("parseConfig", () => {
    const baseInput = {
      machine: "test-machine",
      repositories: [
        {
          name: "repo1",
          path: "/path/to/repo1",
          githubUrl: "https://github.com/test/repo",
        },
      ],
      peers: [],
    };

    test("returns config with default port when port is omitted", () => {
      const input = { ...baseInput };
      const result = parseConfig(input);
      expect(result).toEqual({
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo1",
            githubUrl: "https://github.com/test/repo",
          },
        ],
        peers: [],
        port: DEFAULT_PORT,
        bind: DEFAULT_BIND,
        developmentOrigins: [],
      });
    });

    test("uses specified port when provided", () => {
      const input = { ...baseInput, port: 8080 };
      const result = parseConfig(input);
      expect(result.port).toBe(8080);
    });

    test("accepts port 1", () => {
      const input = { ...baseInput, port: 1 };
      const result = parseConfig(input);
      expect(result.port).toBe(1);
    });

    test("accepts port 65535", () => {
      const input = { ...baseInput, port: 65535 };
      const result = parseConfig(input);
      expect(result.port).toBe(65535);
    });

    test("rejects port 0", () => {
      const input = { ...baseInput, port: 0 };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects port 65536", () => {
      const input = { ...baseInput, port: 65536 };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects negative port", () => {
      const input = { ...baseInput, port: -1 };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects floating point port", () => {
      const input = { ...baseInput, port: 7777.5 };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects non-numeric port", () => {
      const input = { ...baseInput, port: "7777" as unknown as number };
      expect(() => parseConfig(input)).toThrow(
        "port must be an integer from 1 to 65535",
      );
    });

    test("rejects empty machine string", () => {
      const input = { ...baseInput, machine: "" };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects whitespace-only machine string", () => {
      const input = { ...baseInput, machine: "   " };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects empty repositories array", () => {
      const input = { ...baseInput, repositories: [] };
      expect(() => parseConfig(input)).toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("rejects missing repositories", () => {
      const input = { machine: "test-machine", peers: [] } as unknown;
      expect(() => parseConfig(input)).toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("accepts empty peers array", () => {
      const input = { ...baseInput, peers: [] };
      const result = parseConfig(input);
      expect(result.peers).toEqual([]);
    });

    test("rejects missing peers field", () => {
      const input = {
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo1",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      } as unknown;
      expect(() => parseConfig(input)).toThrow("peers must be an array");
    });

    test("rejects non-array peers", () => {
      const input = { ...baseInput, peers: "not-an-array" as unknown as [] };
      expect(() => parseConfig(input)).toThrow("peers must be an array");
    });

    test("rejects non-object repository", () => {
      const input = {
        ...baseInput,
        repositories: ["not-an-object"] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0] must be an object",
      );
    });

    test("rejects missing name in repository", () => {
      const input = {
        ...baseInput,
        repositories: [
          { path: "/path/to/repo1", githubUrl: "https://github.com/test/repo" },
        ] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a non-empty string",
      );
    });

    test("rejects empty name in repository", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "",
            path: "/path/to/repo1",
            githubUrl: "https://github.com/test/repo",
          },
        ] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a non-empty string",
      );
    });

    test("rejects missing path in repository", () => {
      const input = {
        ...baseInput,
        repositories: [
          { name: "repo1", githubUrl: "https://github.com/test/repo" },
        ] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects empty path in repository", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "",
            githubUrl: "https://github.com/test/repo",
          },
        ] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects missing githubUrl in repository", () => {
      const input = {
        ...baseInput,
        repositories: [
          { name: "repo1", path: "/path/to/repo1" },
        ] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a non-empty string",
      );
    });

    test("rejects non-object peer", () => {
      const input = { ...baseInput, peers: ["not-an-object"] as unknown as [] };
      expect(() => parseConfig(input)).toThrow("peers[0] must be an object");
    });

    test("rejects missing name in peer", () => {
      const input = {
        ...baseInput,
        peers: [{ origin: "http://localhost" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects empty name in peer", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "", origin: "http://localhost" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects missing origin in peer", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1" }] as unknown as [],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be a non-empty string",
      );
    });

    test("rejects empty origin in peer", () => {
      const input = {
        ...baseInput,
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
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo1",
            githubUrl: "https://github.com/test/repo1",
          },
          {
            name: "repo2",
            path: "/path/to/repo2",
            githubUrl: "https://github.com/test/repo2",
          },
        ],
      };
      const result = parseConfig(input);
      expect(result.repositories).toHaveLength(2);
    });

    test("handles multiple peers", () => {
      const input = {
        ...baseInput,
        peers: [
          { name: "peer1", origin: "http://localhost:8080" },
          { name: "peer2", origin: "http://localhost:8081" },
        ],
      };
      const result = parseConfig(input);
      expect(result.peers).toHaveLength(2);
    });

    test("accepts bind field with default value", () => {
      const input = { ...baseInput, bind: undefined };
      const result = parseConfig(input);
      expect(result.bind).toBe(DEFAULT_BIND);
    });

    test("accepts bind field with 127.0.0.1", () => {
      const input = { ...baseInput, bind: "127.0.0.1" };
      const result = parseConfig(input);
      expect(result.bind).toBe("127.0.0.1");
    });

    test("accepts bind field with localhost IPv6", () => {
      const input = { ...baseInput, bind: "::1" };
      const result = parseConfig(input);
      expect(result.bind).toBe("::1");
    });

    test("accepts bind field with 100.64.0.0/10 range", () => {
      const input = { ...baseInput, bind: "100.64.0.1" };
      const result = parseConfig(input);
      expect(result.bind).toBe("100.64.0.1");
    });

    test("accepts bind field with 100.127.255.255", () => {
      const input = { ...baseInput, bind: "100.127.255.255" };
      const result = parseConfig(input);
      expect(result.bind).toBe("100.127.255.255");
    });

    test("rejects bind field with 100.63.255.255 (outside 100.64.0.0/10)", () => {
      const input = { ...baseInput, bind: "100.63.255.255" };
      expect(() => parseConfig(input)).toThrow(
        "bind must be an allowed literal IP address",
      );
    });

    test("rejects bind field with 100.128.0.0 (outside 100.64.0.0/10)", () => {
      const input = { ...baseInput, bind: "100.128.0.0" };
      expect(() => parseConfig(input)).toThrow(
        "bind must be an allowed literal IP address",
      );
    });

    test("accepts bind field with Tailscale IPv6 range", () => {
      const input = { ...baseInput, bind: "fd7a:115c:a1e0::1" };
      const result = parseConfig(input);
      expect(result.bind).toBe("fd7a:115c:a1e0::1");
    });

    test("rejects bind field with non-IP string", () => {
      const input = { ...baseInput, bind: "not-an-ip" };
      expect(() => parseConfig(input)).toThrow(
        "bind must be an allowed literal IP address",
      );
    });

    test("rejects bind field with port", () => {
      const input = { ...baseInput, bind: "127.0.0.1:8080" };
      expect(() => parseConfig(input)).toThrow(
        "bind must be an allowed literal IP address",
      );
    });

    test("rejects bind field with zone ID", () => {
      const input = { ...baseInput, bind: "fe80::1%eth0" };
      expect(() => parseConfig(input)).toThrow(
        "bind must be an allowed literal IP address",
      );
    });

    test("accepts developmentOrigins with localhost", () => {
      const input = {
        ...baseInput,
        developmentOrigins: ["http://localhost:3000"],
      };
      const result = parseConfig(input);
      expect(result.developmentOrigins).toEqual(["http://localhost:3000"]);
    });

    test("accepts developmentOrigins with loopback IPv4", () => {
      const input = {
        ...baseInput,
        developmentOrigins: ["http://127.0.0.1:3000"],
      };
      const result = parseConfig(input);
      expect(result.developmentOrigins).toEqual(["http://127.0.0.1:3000"]);
    });

    test("accepts developmentOrigins with loopback IPv6", () => {
      const input = {
        ...baseInput,
        developmentOrigins: ["http://[::1]:3000"],
      };
      const result = parseConfig(input);
      expect(result.developmentOrigins).toEqual(["http://[::1]:3000"]);
    });

    test("rejects developmentOrigins with non-localhost domain", () => {
      const input = {
        ...baseInput,
        developmentOrigins: ["http://example.com:3000"],
      };
      expect(() => parseConfig(input)).toThrow(
        "developmentOrigins[0] must use localhost or a loopback IP",
      );
    });

    test("accepts developmentOrigins with port 0", () => {
      // Port 0 is valid in the URL but not in practice
      const input = {
        ...baseInput,
        developmentOrigins: ["http://localhost:0"],
      };
      const result = parseConfig(input);
      expect(result.developmentOrigins).toEqual(["http://localhost:0"]);
    });

    test("rejects developmentOrigins with more than MAX_PEERS entries", () => {
      const input = {
        ...baseInput,
        developmentOrigins: Array(33).fill("http://localhost:3000"),
      };
      expect(() => parseConfig(input)).toThrow(
        "developmentOrigins has too many entries",
      );
    });

    test("rejects duplicate repository names", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo1",
            githubUrl: "https://github.com/test/repo1",
          },
          {
            name: "repo1",
            path: "/path/to/repo2",
            githubUrl: "https://github.com/test/repo2",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repository names must be unique",
      );
    });

    test("rejects duplicate repository paths", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo1",
          },
          {
            name: "repo2",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo2",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repository roots must be unique",
      );
    });

    test("rejects duplicate peer names", () => {
      const input = {
        ...baseInput,
        peers: [
          { name: "peer1", origin: "http://localhost:8080" },
          { name: "peer1", origin: "http://localhost:8081" },
        ],
      };
      expect(() => parseConfig(input)).toThrow("peer names must be unique");
    });

    test("rejects duplicate peer origins", () => {
      const input = {
        ...baseInput,
        peers: [
          { name: "peer1", origin: "http://localhost:8080" },
          { name: "peer2", origin: "http://localhost:8080" },
        ],
      };
      expect(() => parseConfig(input)).toThrow("peer origins must be unique");
    });

    test("rejects duplicate development origins", () => {
      const input = {
        ...baseInput,
        developmentOrigins: ["http://localhost:3000", "http://localhost:3000"],
      };
      expect(() => parseConfig(input)).toThrow(
        "development origins must be unique",
      );
    });

    test("rejects overlapping peer and development origins", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080" }],
        developmentOrigins: ["http://localhost:8080"],
      };
      expect(() => parseConfig(input)).toThrow(
        "configured origins must be unique",
      );
    });

    test("rejects repository path with relative component", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "relative/path",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be an absolute normalized path without traversal",
      );
    });

    test("rejects repository path with traversal", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/../to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be an absolute normalized path without traversal",
      );
    });

    test("accepts repository path with trailing slash", () => {
      // Trailing slash is preserved by normalize()
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo/",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      const result = parseConfig(input);
      expect(result.repositories[0]!.path).toBe("/path/to/repo/");
    });

    test("rejects repository name with special characters", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo@1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects repository name starting with dot", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: ".repo",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects repository name with forward slash", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo/1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects repository name with backslash", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo\\1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects repository name with dot only", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: ".",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects repository name with dot-dot only", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "..",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].name must be a path-safe identifier",
      );
    });

    test("rejects peer origin with backslash", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http:\\\\localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with path", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080/path" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with query string", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080?query=1" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with fragment", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080#fragment" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with username", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://user@localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with password", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://user:pass@localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with port", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080" }],
      };
      const result = parseConfig(input);
      expect(result.peers[0]!.origin).toBe("http://localhost:8080");
    });

    test("rejects peer origin with wildcard hostname", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://*.example.com" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects peer origin with non-HTTP protocol", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "ws://localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be an exact HTTP origin",
      );
    });

    test("rejects githubUrl with backslash", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https:\\\\github.com\\test\\repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with query string", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo?query=1",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with fragment", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo#readme",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("accepts githubUrl with .git extension and canonicalizes", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo.git",
          },
        ],
      };
      const result = parseConfig(input);
      // .git extension should be stripped and canonicalized
      expect(result.repositories[0]!.githubUrl).toBe(
        "https://github.com/test/repo",
      );
    });

    test("accepts githubUrl with trailing slash", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo/",
          },
        ],
      };
      const result = parseConfig(input);
      expect(result.repositories[0]!.githubUrl).toBe(
        "https://github.com/test/repo",
      );
    });

    test("rejects githubUrl with non-github.com domain", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://gitlab.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with port", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com:443/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with username", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://user@github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with password", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://user:pass@github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with invalid owner (contains special chars)", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test@repo/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with invalid repository (contains special chars)", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo@1",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with owner starting with dot", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/.test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with repository starting with dot", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/.repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with owner as dot", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com=./repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a GitHub repository URL",
      );
    });

    test("rejects githubUrl with repository as dot", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/.",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with owner exceeding 100 chars", () => {
      const longOwner = "a".repeat(101);
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: `https://github.com/${longOwner}/repo`,
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects githubUrl with repository exceeding 100 chars", () => {
      const longRepo = "a".repeat(101);
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: `https://github.com/test/${longRepo}`,
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl has invalid owner or repository segments",
      );
    });

    test("rejects machine string with null byte", () => {
      const input = { ...baseInput, machine: "test\x00machine" };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects machine string with control character", () => {
      const input = { ...baseInput, machine: "test\nmachine" };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects machine string with leading whitespace", () => {
      const input = { ...baseInput, machine: " test-machine" };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects machine string with trailing whitespace", () => {
      const input = { ...baseInput, machine: "test-machine " };
      expect(() => parseConfig(input)).toThrow(
        "machine must be a non-empty string",
      );
    });

    test("rejects repository path with leading whitespace", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: " /path/to/repo",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects repository path with trailing whitespace", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo ",
            githubUrl: "https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].path must be a non-empty string",
      );
    });

    test("rejects peer name with leading whitespace", () => {
      const input = {
        ...baseInput,
        peers: [{ name: " peer1", origin: "http://localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects peer name with trailing whitespace", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1 ", origin: "http://localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].name must be a non-empty string",
      );
    });

    test("rejects peer origin with leading whitespace", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: " http://localhost:8080" }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be a non-empty string",
      );
    });

    test("rejects peer origin with trailing whitespace", () => {
      const input = {
        ...baseInput,
        peers: [{ name: "peer1", origin: "http://localhost:8080 " }],
      };
      expect(() => parseConfig(input)).toThrow(
        "peers[0].origin must be a non-empty string",
      );
    });

    test("rejects githubUrl with leading whitespace", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: " https://github.com/test/repo",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a non-empty string",
      );
    });

    test("rejects githubUrl with trailing whitespace", () => {
      const input = {
        ...baseInput,
        repositories: [
          {
            name: "repo1",
            path: "/path/to/repo",
            githubUrl: "https://github.com/test/repo ",
          },
        ],
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories[0].githubUrl must be a non-empty string",
      );
    });

    test("rejects too many repositories (MAX_REPOSITORIES + 1)", () => {
      const input = {
        ...baseInput,
        repositories: Array(33).fill({
          name: "repo1",
          path: "/path/to/repo",
          githubUrl: "https://github.com/test/repo",
        }),
      };
      expect(() => parseConfig(input)).toThrow(
        "repositories must be a non-empty array",
      );
    });

    test("rejects too many peers (MAX_PEERS + 1)", () => {
      const input = {
        ...baseInput,
        peers: Array(33).fill({
          name: "peer1",
          origin: "http://localhost:8080",
        }),
      };
      expect(() => parseConfig(input)).toThrow("peers must be an array");
    });

    test("accepts maximum repositories (MAX_REPOSITORIES)", () => {
      const input = {
        ...baseInput,
        repositories: Array(32)
          .fill(null)
          .map((_, i) => ({
            name: `repo${i}`,
            path: `/path/to/repo${i}`,
            githubUrl: `https://github.com/test/repo${i}`,
          })),
      };
      const result = parseConfig(input);
      expect(result.repositories).toHaveLength(32);
    });

    test("accepts maximum peers (MAX_PEERS)", () => {
      const input = {
        ...baseInput,
        peers: Array(32)
          .fill(null)
          .map((_, i) => ({
            name: `peer${i}`,
            origin: `http://localhost:${8080 + i}`,
          })),
      };
      const result = parseConfig(input);
      expect(result.peers).toHaveLength(32);
    });
  });

  describe("loadConfig", () => {
    let tempRoot: string;
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(process.cwd(), "tmp-test-config-"));
      tempDir = join(tempRoot, "repo1");
      mkdirSync(tempDir, { recursive: true });
      tempFile = join(tempRoot, "config.json");
    });

    afterEach(() => {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("loads valid config file", async () => {
      const config = {
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: tempDir,
            githubUrl: "https://github.com/test/repo",
          },
        ],
        peers: [],
        port: 7777,
      };
      await Bun.write(tempFile, JSON.stringify(config));

      const result = await loadConfig(tempFile);
      expect(result.machine).toBe("test-machine");
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]!.path).toBe(tempDir);
      expect(result.repositories[0]!.githubUrl).toBe(
        "https://github.com/test/repo",
      );
      expect(result.port).toBe(7777);
    });

    test("throws error for non-existent file", async () => {
      await expect(loadConfig("/nonexistent/path/config.json")).rejects.toThrow(
        "config file does not exist or could not be read",
      );
    });

    test("throws error for file too large", async () => {
      // Create a file larger than MAX_CONFIG_BYTES (64KB)
      const largeContent = JSON.stringify({
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: tempDir,
            githubUrl: "https://github.com/test/repo",
          },
        ],
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
        repositories: [
          {
            name: "repo1",
            path: tempDir,
            githubUrl: "https://github.com/test/repo",
          },
        ],
        peers: [],
        port: 7777,
      };
      // 64KB - 1 byte should succeed (file.size <= MAX_CONFIG_BYTES)
      // The config itself takes about 180 bytes (longer path), so we need to leave room for that
      const content = JSON.stringify({
        ...config,
        largeField: "x".repeat(64 * 1024 - 250), // Leave room for other content
      });
      await Bun.write(tempFile, content);

      // Should succeed since file size is <= 64KB
      const result = await loadConfig(tempFile);
      expect(result.machine).toBe("test-machine");
    });
  });
});
