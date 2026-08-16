import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  createFleetSnapshot,
  readRepositorySnapshot,
  MAX_PROJECT_LENGTH,
} from "./snapshot";

describe("snapshot", () => {
  describe("MAX_PROJECT_LENGTH", () => {
    test("is 200", () => {
      expect(MAX_PROJECT_LENGTH).toBe(200);
    });
  });

  describe("readRepositorySnapshot", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(process.cwd(), "tmp-test-repo");
      mkdirSync(tempDir, { recursive: true });
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("returns available status for valid state.json", async () => {
      const state = {
        project: "test-project",
        phase: "build",
        spec_approved: true,
        plan_approved: true,
        current_task: "T1",
        branch: "main",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "available",
        project: "test-project",
        phase: "build",
      });
    });

    test("returns unavailable status when state.json is missing", async () => {
      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json is missing",
      });
    });

    test("returns unavailable status when state.json is too large", async () => {
      // Create a file larger than MAX_STATE_BYTES (64KB)
      const largeContent = JSON.stringify({
        project: "test-project",
        phase: "build",
        largeField: "x".repeat(70 * 1024),
      });
      await Bun.write(`${tempDir}/.factory/state.json`, largeContent);

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json is too large",
      });
    });

    test("returns unavailable status for empty project string", async () => {
      const state = {
        project: "",
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns available status for whitespace-only project string", async () => {
      const state = {
        project: "   ",
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "available",
        project: "   ",
        phase: "build",
      });
    });

    test("returns unavailable status for project exceeding MAX_PROJECT_LENGTH", async () => {
      const state = {
        project: "x".repeat(MAX_PROJECT_LENGTH + 1),
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for invalid phase", async () => {
      const state = {
        project: "test-project",
        phase: "invalid-phase",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for missing project field", async () => {
      const state = {
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for missing phase field", async () => {
      const state = {
        project: "test-project",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status when state.json is not valid JSON", async () => {
      await Bun.write(`${tempDir}/.factory/state.json`, "not-an-object");

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });

    test("returns unavailable status for array state.json", async () => {
      await Bun.write(`${tempDir}/.factory/state.json`, "[]");

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status when state.json cannot be read", async () => {
      // Create a file that can be read but JSON.parse fails
      await Bun.write(`${tempDir}/.factory/state.json`, "{ invalid json }");

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });

    test("returns unavailable status for null state.json", async () => {
      await Bun.write(`${tempDir}/.factory/state.json`, "null");

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for number state.json", async () => {
      await Bun.write(`${tempDir}/.factory/state.json`, "123");

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns available status for project with exactly MAX_PROJECT_LENGTH", async () => {
      const state = {
        project: "x".repeat(MAX_PROJECT_LENGTH),
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "available",
        project: "x".repeat(MAX_PROJECT_LENGTH),
        phase: "build",
      });
    });

    test("returns unavailable status for valid project but empty phase", async () => {
      const state = {
        project: "test-project",
        phase: "",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for non-string project", async () => {
      const state = {
        project: 123,
        phase: "build",
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("returns unavailable status for non-string phase", async () => {
      const state = {
        project: "test-project",
        phase: 123,
      };
      await Bun.write(`${tempDir}/.factory/state.json`, JSON.stringify(state));

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json has invalid project or phase data",
      });
    });

    test("handles all valid phases", async () => {
      const phases = ["specify", "plan", "build", "idle"] as const;
      for (const phase of phases) {
        const state = {
          project: "test-project",
          phase,
        };
        await Bun.write(
          `${tempDir}/.factory/state.json`,
          JSON.stringify(state),
        );

        const result = await readRepositorySnapshot({
          name: "test-repo",
          path: tempDir,
        });

        expect(result).toEqual({
          name: "test-repo",
          status: "available",
          project: "test-project",
          phase,
        });
      }
    });

    test("handles missing .factory directory", async () => {
      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempDir,
      });

      expect(result).toEqual({
        name: "test-repo",
        status: "unavailable",
        warning: "state.json is missing",
      });
    });
  });

  describe("createFleetSnapshot", () => {
    let tempDir1: string;
    let tempDir2: string;

    beforeEach(() => {
      tempDir1 = join(process.cwd(), "tmp-test-repo1");
      tempDir2 = join(process.cwd(), "tmp-test-repo2");
      mkdirSync(tempDir1, { recursive: true });
      mkdirSync(tempDir2, { recursive: true });
      mkdirSync(`${tempDir1}/.factory`, { recursive: true });
      mkdirSync(`${tempDir2}/.factory`, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir1, { recursive: true, force: true });
        rmSync(tempDir2, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("creates fleet snapshot with all repositories", async () => {
      const state1 = {
        project: "project1",
        phase: "build",
      };
      const state2 = {
        project: "project2",
        phase: "plan",
      };
      await Bun.write(
        `${tempDir1}/.factory/state.json`,
        JSON.stringify(state1),
      );
      await Bun.write(
        `${tempDir2}/.factory/state.json`,
        JSON.stringify(state2),
      );

      const config = {
        machine: "test-machine",
        repositories: [
          { name: "repo1", path: tempDir1 },
          { name: "repo2", path: tempDir2 },
        ],
        peers: [{ name: "peer1", origin: "http://localhost:8080" }],
        port: 7777,
      };

      const result = await createFleetSnapshot(config);

      expect(result).toEqual({
        hostname: "test-machine",
        repositories: [
          {
            name: "repo1",
            status: "available",
            project: "project1",
            phase: "build",
          },
          {
            name: "repo2",
            status: "available",
            project: "project2",
            phase: "plan",
          },
        ],
        peers: [{ name: "peer1", origin: "http://localhost:8080" }],
      });
    });

    test("handles mixed available and unavailable repositories", async () => {
      const state1 = {
        project: "project1",
        phase: "build",
      };
      await Bun.write(
        `${tempDir1}/.factory/state.json`,
        JSON.stringify(state1),
      );
      // tempDir2 has no state.json

      const config = {
        machine: "test-machine",
        repositories: [
          { name: "repo1", path: tempDir1 },
          { name: "repo2", path: tempDir2 },
        ],
        peers: [],
        port: 7777,
      };

      const result = await createFleetSnapshot(config);

      expect(result.repositories).toHaveLength(2);
      expect(result.repositories[0]).toEqual({
        name: "repo1",
        status: "available",
        project: "project1",
        phase: "build",
      });
      expect(result.repositories[1]).toEqual({
        name: "repo2",
        status: "unavailable",
        warning: "state.json is missing",
      });
    });

    test("createFleetSnapshot uses default snapshot behavior", async () => {
      const config = {
        machine: "test-machine",
        repositories: [{ name: "repo1", path: "fake-path" }],
        peers: [],
        port: 7777,
      };

      const result = await createFleetSnapshot(config);

      expect(result.hostname).toBe("test-machine");
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]).toEqual({
        name: "repo1",
        status: "unavailable",
        warning: "state.json is missing",
      });
    });
  });
});
