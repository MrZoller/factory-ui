import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";

import { resolveFactoryPath } from "./paths";

describe("paths", () => {
  describe("resolveFactoryPath", () => {
    let tempRoot: string;
    let tempDir: string;

    beforeEach(() => {
      // Use a temp directory that will be cleaned up
      tempRoot = mkdtempSync(join(process.cwd(), "tmp-test-paths-"));
      tempDir = join(tempRoot, "repo");
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("resolves state.json path when exists", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const statePath = join(tempDir, ".factory", "state.json");
      await Bun.write(statePath, '{"project":"test","phase":"build"}');

      const result = await resolveFactoryPath(tempDir, "state");
      expect(result).toBe(statePath);
    });

    test("resolves plan.md path when exists", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const planPath = join(tempDir, ".factory", "plan.md");
      await Bun.write(planPath, "# Plan");

      const result = await resolveFactoryPath(tempDir, "plan");
      expect(result).toBe(planPath);
    });

    test("resolves questions.md path when exists", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const questionsPath = join(tempDir, ".factory", "questions.md");
      await Bun.write(questionsPath, "## Questions");

      const result = await resolveFactoryPath(tempDir, "questions");
      expect(result).toBe(questionsPath);
    });

    test("resolves worklog.md path when exists", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const worklogPath = join(tempDir, ".factory", "worklog.md");
      await Bun.write(worklogPath, "## Worklog");

      const result = await resolveFactoryPath(tempDir, "worklog");
      expect(result).toBe(worklogPath);
    });

    test("resolves logs directory when exists", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });

      const result = await resolveFactoryPath(tempDir, "logs");
      expect(result).toBe(logsDir);
    });

    test("resolves only the fixed logs/routing.json target", async () => {
      mkdirSync(`${tempDir}/.factory/logs`, { recursive: true });
      const routingPath = join(tempDir, ".factory", "logs", "routing.json");
      await Bun.write(routingPath, '{"schemaVersion":1}');

      expect(await resolveFactoryPath(tempDir, "routing")).toBe(routingPath);
    });

    test("returns null when .factory directory does not exist", async () => {
      const result = await resolveFactoryPath(tempDir, "state");
      expect(result).toBeNull();
    });

    test("returns null when state.json does not exist", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const result = await resolveFactoryPath(tempDir, "state");
      expect(result).toBeNull();
    });

    test("throws when .factory is a dangling symlink", async () => {
      const realFactory = join(tempRoot, "real-factory");
      mkdirSync(realFactory, { recursive: true });
      const factorySymlink = join(tempDir, ".factory");
      symlinkSync(realFactory, factorySymlink);

      // Now delete the real directory to make it a dangling symlink
      rmSync(realFactory, { recursive: true, force: true });

      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("throws when .factory escapes repository root", async () => {
      const outsideDir = join(tempRoot, "outside");
      mkdirSync(outsideDir, { recursive: true });
      const outsideFactory = join(outsideDir, ".factory");
      mkdirSync(outsideFactory, { recursive: true });

      // Create a symlink from tempDir to outsideDir
      const factorySymlink = join(tempDir, ".factory");
      symlinkSync(outsideDir, factorySymlink);

      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("throws when target escapes .factory directory", async () => {
      const outsideState = join(tempRoot, "outside-state.json");
      await Bun.write(outsideState, "{}");

      // Create a symlink from .factory to outside
      const factorySymlink = join(tempDir, ".factory");
      symlinkSync(tempRoot, factorySymlink);

      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("handles repository root that is a symlink", async () => {
      const realRepo = join(tempRoot, "real-repo");
      mkdirSync(realRepo, { recursive: true });
      mkdirSync(`${realRepo}/.factory`, { recursive: true });

      const repoSymlink = join(tempRoot, "repo-link");
      symlinkSync(realRepo, repoSymlink);

      mkdirSync(`${realRepo}/.factory`, { recursive: true });
      const statePath = join(realRepo, ".factory", "state.json");
      await Bun.write(statePath, '{"project":"test","phase":"build"}');

      const result = await resolveFactoryPath(repoSymlink, "state");
      expect(result).toBe(statePath);
    });

    test("canonicalizes paths correctly", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const statePath = join(tempDir, ".factory", "state.json");
      await Bun.write(statePath, '{"project":"test","phase":"build"}');

      // Use a path with redundant components
      const canonical = await resolveFactoryPath(join(tempDir, "."), "state");
      expect(canonical).toBe(statePath);
    });

    test("throws when repository root is not a directory", async () => {
      const fileRoot = join(tempRoot, "file-root");
      await Bun.write(fileRoot, "not a directory");

      let threw = false;
      try {
        await resolveFactoryPath(fileRoot, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("throws when target is a directory but file expected", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const dirTarget = join(tempDir, ".factory", "state.json");
      mkdirSync(dirTarget, { recursive: true });

      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("throws when target is a file but directory expected", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const fileTarget = join(tempDir, ".factory", "logs");
      await Bun.write(fileTarget, "not a directory");

      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "logs");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("error message does not expose absolute root path", async () => {
      const outsideDir = join(tempRoot, "outside");
      mkdirSync(outsideDir, { recursive: true });
      const outsideFactory = join(outsideDir, ".factory");
      mkdirSync(outsideFactory, { recursive: true });

      const factorySymlink = join(tempDir, ".factory");
      symlinkSync(outsideDir, factorySymlink);

      let errorMessage: string | undefined;
      let threw = false;
      try {
        await resolveFactoryPath(tempDir, "state");
      } catch (e) {
        threw = true;
        errorMessage = (e as Error).message;
      }
      expect(threw).toBe(true);

      expect(errorMessage).toBeDefined();
      expect(errorMessage).not.toContain(tempRoot);
      expect(errorMessage).not.toContain(outsideDir);
      expect(errorMessage).toBe("factory path could not be resolved safely");
    });

    test("handles non-existent repository root", async () => {
      const nonExistent = join(tempRoot, "does-not-exist");
      let threw = false;
      try {
        await resolveFactoryPath(nonExistent, "state");
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe(
          "factory path could not be resolved safely",
        );
      }
      expect(threw).toBe(true);
    });

    test("all factory path keys are resolvable", async () => {
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      const keys: Array<
        "state" | "plan" | "questions" | "worklog" | "logs" | "routing"
      > = ["state", "plan", "questions", "worklog", "logs", "routing"];

      for (const key of keys) {
        const expected = {
          state: "state.json",
          plan: "plan.md",
          questions: "questions.md",
          worklog: "worklog.md",
          logs: "logs",
          routing: "logs/routing.json",
        }[key];

        if (key === "logs") {
          mkdirSync(join(tempDir, ".factory", expected), { recursive: true });
        } else {
          if (key === "routing")
            mkdirSync(join(tempDir, ".factory", "logs"), { recursive: true });
          await Bun.write(join(tempDir, ".factory", expected), "{}");
        }

        const result = await resolveFactoryPath(tempDir, key);
        expect(result).toContain(expected);
      }
    });
  });
});
