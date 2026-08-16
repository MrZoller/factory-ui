import { afterEach, describe, expect, test, vi } from "bun:test";

import { createRequestHandler, startServer } from "./server";
import type { AppConfigSource, FleetSnapshot } from "./contracts";

describe("server", () => {
  describe("createRequestHandler", () => {
    const baseConfig: AppConfigSource = {
      machine: "test-machine",
      repositories: [{ name: "repo1", path: "/fake/path" }],
      peers: [],
      port: 7777,
    };

    describe("CORS - Access-Control-Allow-Origin", () => {
      test("returns ACAO header for dashboard origin (127.0.0.1)", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "http://127.0.0.1:7777" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "http://127.0.0.1:7777",
        );
      });

      test("returns ACAO header for configured peer origin", async () => {
        const config = {
          ...baseConfig,
          peers: [{ name: "peer1", origin: "http://100.64.0.1:8080" }],
        };
        const handler = createRequestHandler(config);

        const request = new Request("http://localhost/", {
          headers: { origin: "http://100.64.0.1:8080" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "http://100.64.0.1:8080",
        );
      });

      test("returns ACAO header for development origin", async () => {
        const config = {
          ...baseConfig,
          developmentOrigins: ["http://localhost:3000"],
        };
        const handler = createRequestHandler(config);

        const request = new Request("http://localhost/", {
          headers: { origin: "http://localhost:3000" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "http://localhost:3000",
        );
      });

      test("does not return ACAO header for unconfigured origin", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "http://evil.com" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("does not return ACAO header for malformed origin", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "not-a-valid-origin" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("does not return ACAO header for null origin", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "null" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("does not return ACAO header for empty origin", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("does not return ACAO header for wildcard origin", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: { origin: "*" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("returns no ACAO for 404 response", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/unknown", {
          headers: { origin: "http://localhost:3000" },
        });

        const response = await handler(request);
        expect(response.status).toBe(404);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });

      test("returns no ACAO for 405 response", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        });

        const response = await handler(request);
        expect(response.status).toBe(405);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      });
    });

    describe("Vary Origin header", () => {
      test("returns Vary: Origin for 200 response", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/");
        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(response.headers.get("vary")).toBe("Origin");
      });

      test("returns Vary: Origin for 404 response", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/unknown");
        const response = await handler(request);
        expect(response.status).toBe(404);
        expect(response.headers.get("vary")).toBe("Origin");
      });

      test("returns Vary: Origin for 405 response", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          method: "POST",
        });

        const response = await handler(request);
        expect(response.status).toBe(405);
        expect(response.headers.get("vary")).toBe("Origin");
      });
    });

    describe("Hostile path/query/header/body values", () => {
      test("handles hostile path with traversal", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/../../../etc/passwd");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles hostile query string", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/?../../../etc/passwd");
        const response = await handler(request);
        expect(response.status).toBe(200);
      });

      test("handles hostile header value", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          headers: {
            origin: "http://localhost:3000",
            "x-hostile": "../../../etc/passwd",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
      });

      test("handles hostile body value", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/", {
          method: "POST",
          body: "../../../etc/passwd",
        });

        const response = await handler(request);
        expect(response.status).toBe(405);
      });

      test("handles path with null bytes", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/\x00/etc/passwd");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with control characters", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/\x1b[31m/etc/passwd");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with unicode", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/../../../éñ");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with percent encoding", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request(
          "http://localhost/%2e%2e%2f%2e%2e%2fetc/passwd",
        );
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with double encoding", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request(
          "http://localhost/%252e%252e%252f%252e%252e%252fetc/passwd",
        );
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with backslash", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/..\\..\\etc\\passwd");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });

      test("handles path with mixed slashes", async () => {
        const handler = createRequestHandler(baseConfig);

        const request = new Request("http://localhost/../../../etc\\passwd");
        const response = await handler(request);
        expect(response.status).toBe(404);
      });
    });

    test("returns 405 for POST request", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/api/fleet", {
        method: "POST",
        body: "{}",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
      expect(response.headers.get("allow")).toBe("GET");
    });

    test("returns 405 for PUT request", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/api/fleet", {
        method: "PUT",
        body: "{}",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    test("returns 405 for DELETE request", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/api/fleet", {
        method: "DELETE",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    test("returns 404 for unknown path", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/unknown");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 404 for /api/unknown path", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/api/unknown");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 200 for / with valid index.html", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/");

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      const text = await response.text();
      expect(text).toContain("<!doctype html>");
      expect(text).toContain("Factory fleet");
      expect(text).toMatch(
        /<h1 class="wordmark">\s*<span>Factory<\/span>\s*<\/h1>/,
      );
      expect(text).toContain('<svg\n            class="factory-mark"');
      expect(text).toContain('aria-hidden="true"');
      expect(text).toContain('<script src="/app.js" type="module">');
      expect(text).toContain('<link rel="stylesheet" href="/styles.css" />');
      expect(text).not.toContain("innerHTML");
      expect(text).not.toContain("onload=");
      expect(text).not.toMatch(/\son[a-z]+\s*=/i);
      expect(text).not.toMatch(/(?:src|href)="https?:\/\//i);
    });

    test("returns 404 for static files that don't exist", async () => {
      const handler = createRequestHandler(baseConfig);

      const request = new Request("http://localhost/unknown-static.js");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns API response for /api/fleet", async () => {
      const mockSnapshot = vi.fn(
        async (config: AppConfigSource): Promise<FleetSnapshot> => ({
          hostname: config.machine,
          repositories: [
            {
              name: "repo1",
              liveness: {
                state: "CANNOT_VERIFY",
                checkedAt: "2026-08-16T00:00:00.000Z",
              },
              status: "available" as const,
              project: "test-project",
              phase: "build" as const,
            },
          ],
          peers: [{ name: "peer1", origin: "http://localhost:8080" }],
        }),
      );

      const handler = createRequestHandler(
        {
          machine: "test-machine",
          repositories: [{ name: "repo1", path: "/fake/path" }],
          peers: [{ name: "peer1", origin: "http://localhost:8080" }],
          port: 7777,
        },
        { snapshot: mockSnapshot },
      );

      const request = new Request("http://localhost/api/fleet");

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const data = await response.json();
      expect(data).toEqual({
        schemaVersion: 1,
        generatedAt: expect.any(String),
        hostname: "test-machine",
        repositories: [
          {
            name: "repo1",
            liveness: { state: "CANNOT_VERIFY", checkedAt: expect.any(String) },
            status: "available",
            project: "test-project",
            phase: "build",
          },
        ],
        peers: [{ name: "peer1", origin: "http://localhost:8080" }],
      });
      expect(mockSnapshot).toHaveBeenCalled();
    });

    test("returns API response with unavailable repository", async () => {
      const mockSnapshot = vi.fn(
        async (config: AppConfigSource): Promise<FleetSnapshot> => ({
          hostname: config.machine,
          repositories: [
            {
              name: "repo1",
              liveness: {
                state: "CANNOT_VERIFY",
                checkedAt: "2026-08-16T00:00:00.000Z",
              },
              status: "unavailable" as const,
              warning: "state.json is missing",
            },
          ],
          peers: [],
        }),
      );

      const handler = createRequestHandler(
        {
          machine: "test-machine",
          repositories: [{ name: "repo1", path: "/fake/path" }],
          peers: [],
          port: 7777,
        },
        { snapshot: mockSnapshot },
      );

      const request = new Request("http://localhost/api/fleet");

      const response = await handler(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.repositories).toEqual([
        {
          name: "repo1",
          liveness: { state: "CANNOT_VERIFY", checkedAt: expect.any(String) },
          status: "unavailable",
          warning: "state.json is missing",
        },
      ]);
    });

    test("injects custom snapshot function", async () => {
      const customSnapshot = vi.fn(async () => ({
        hostname: "custom-hostname",
        repositories: [],
        peers: [],
      }));

      const handler = createRequestHandler(
        {
          machine: "test-machine",
          repositories: [{ name: "repo1", path: "/fake/path" }],
          peers: [],
          port: 7777,
        },
        { snapshot: customSnapshot },
      );

      const request = new Request("http://localhost/api/fleet");
      await handler(request);

      expect(customSnapshot).toHaveBeenCalled();
    });

    test("uses default snapshot when no dependency provided", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      // This will fail because /fake/path doesn't exist, but it should
      // at least attempt to use the default snapshot function
      const request = new Request("http://localhost/api/fleet");
      const response = await handler(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      // Check that liveness state is CANNOT_VERIFY and checkedAt is a valid ISO date
      expect(data.repositories[0].liveness.state).toBe("CANNOT_VERIFY");
      expect(data.repositories[0].liveness.checkedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(data.repositories[0].status).toBe("unavailable");
      expect(data.repositories[0].warning).toBe(
        "repository state is unavailable",
      );
    });
  });

  describe("startServer", () => {
    let server: any;

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    test("starts server on loopback", async () => {
      server = startServer({
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: "/fake/path",
            githubUrl: "https://github.com/example/repo1",
          },
        ],
        peers: [],
        port: 0,
        bind: "127.0.0.1",
        developmentOrigins: [],
      });

      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);

      // Verify server is actually running
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
    });

    test("returns server with correct fetch handler", async () => {
      server = startServer({
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: "/fake/path",
            githubUrl: "https://github.com/example/repo1",
          },
        ],
        peers: [],
        port: 0,
        bind: "127.0.0.1",
        developmentOrigins: [],
      });

      // Test GET /api/fleet
      const fleetResponse = await fetch(new URL("/api/fleet", server.url));
      expect(fleetResponse.status).toBe(200);
      const fleetData = await fleetResponse.json();
      expect(fleetData.hostname).toBe("test-machine");

      // Test 405 for POST
      const postResponse = await fetch(new URL("/api/fleet", server.url), {
        method: "POST",
        body: "{}",
      });
      expect(postResponse.status).toBe(405);

      // Test 404 for unknown path
      const notFoundResponse = await fetch(new URL("/unknown", server.url));
      expect(notFoundResponse.status).toBe(404);
    });

    test("server stops cleanly", async () => {
      server = startServer({
        machine: "test-machine",
        repositories: [
          {
            name: "repo1",
            path: "/fake/path",
            githubUrl: "https://github.com/example/repo1",
          },
        ],
        peers: [],
        port: 0,
        bind: "127.0.0.1",
        developmentOrigins: [],
      });

      const stopResult = await server.stop();
      expect(stopResult).toBeUndefined();
    });
  });

  test("browser code renders dynamic values with text-only DOM APIs", async () => {
    const source = await Bun.file(
      new URL("./public/app.js", import.meta.url),
    ).text();

    expect(source).toContain("textContent");
    expect(source).toContain("documentRoot.createElement");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
  });
});
