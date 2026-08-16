import { afterEach, describe, expect, test, vi } from "bun:test";

import { createRequestHandler, startServer } from "./server";
import type { AppConfig, FleetSnapshot } from "./contracts";

describe("server", () => {
  describe("createRequestHandler", () => {
    test("returns 405 for POST request", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

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
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/api/fleet", {
        method: "PUT",
        body: "{}",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    test("returns 405 for DELETE request", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/api/fleet", {
        method: "DELETE",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    test("returns 404 for unknown path", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/unknown");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 404 for /api/unknown path", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/api/unknown");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 200 for / with valid index.html", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/");

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      const text = await response.text();
      expect(text).toContain("<!doctype html>");
      expect(text).toContain("Factory fleet");
    });

    test("returns 404 for static files that don't exist", async () => {
      const handler = createRequestHandler({
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 7777,
      });

      const request = new Request("http://localhost/unknown-static.js");

      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns API response for /api/fleet", async () => {
      const mockSnapshot = vi.fn(
        async (config: AppConfig): Promise<FleetSnapshot> => ({
          hostname: config.machine,
          repositories: [
            {
              name: "repo1",
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
        hostname: "test-machine",
        repositories: [
          {
            name: "repo1",
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
        async (config: AppConfig): Promise<FleetSnapshot> => ({
          hostname: config.machine,
          repositories: [
            {
              name: "repo1",
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
      expect(data.repositories).toEqual([
        {
          name: "repo1",
          status: "unavailable",
          warning: "state.json is missing",
        },
      ]);
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
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 0,
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
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 0,
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
        repositories: [{ name: "repo1", path: "/fake/path" }],
        peers: [],
        port: 0,
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
    expect(source).toContain("document.createElement");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
  });
});
