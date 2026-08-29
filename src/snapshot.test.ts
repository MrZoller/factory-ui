import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createFactoryFixture } from "./test-support";
import { MAX_LOG_ENTRIES, type TrustedDriverLog } from "./readers/logs";

import {
  createFleetSnapshot,
  readRepositoryFactoryData,
  readRepositoryFactorySnapshot,
  readRepositorySnapshot,
  MAX_PROJECT_LENGTH,
} from "./snapshot";

describe("snapshot", () => {
  test("exposes a GitHub document URL only for each safely readable factory file", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        Bun.write(join(fixture.factoryPath, "spec.md"), "# Spec"),
        fixture.writePlan("# Plan"),
        fixture.writeWorklog("- 2026-08-16 UTC - shipped"),
        fixture.writeQuestions("## Q1 (task T1, open) — Question\nContext"),
      ]);

      const snapshot = (await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
        githubUrl: "https://github.com/example/factory-ui",
      })) as unknown as Record<string, unknown>;

      const documentUrls = {
        specUrl:
          "https://github.com/example/factory-ui/blob/HEAD/.factory/spec.md",
        planUrl:
          "https://github.com/example/factory-ui/blob/HEAD/.factory/plan.md",
        worklogUrl:
          "https://github.com/example/factory-ui/blob/HEAD/.factory/worklog.md",
        questionsUrl:
          "https://github.com/example/factory-ui/blob/HEAD/.factory/questions.md",
      };
      expect(snapshot).toMatchObject(documentUrls);

      for (const [key, filename] of Object.entries({
        specUrl: "spec.md",
        planUrl: "plan.md",
        worklogUrl: "worklog.md",
        questionsUrl: "questions.md",
      })) {
        rmSync(join(fixture.factoryPath, filename));
        const withoutSource = (await readRepositoryFactorySnapshot({
          name: "factory-ui",
          path: fixture.root,
          githubUrl: "https://github.com/example/factory-ui",
        })) as unknown as Record<string, unknown>;
        expect(withoutSource[key]).toBeUndefined();
      }
    } finally {
      fixture.cleanup();
    }
  });

  describe("MAX_PROJECT_LENGTH", () => {
    test("is 200", () => {
      expect(MAX_PROJECT_LENGTH).toBe(200);
    });
  });

  test("aggregates factory readers without coupling source availability", async () => {
    const root = mkdtempSync(join(process.cwd(), "tmp-factory-data-"));
    const factoryPath = join(root, ".factory");
    mkdirSync(factoryPath);
    try {
      await Promise.all([
        Bun.write(
          join(factoryPath, "state.json"),
          JSON.stringify({
            project: "internal-name",
            phase: "build",
            spec_approved: true,
            plan_approved: true,
            current_task: null,
            branch: null,
            pr: null,
            hold: false,
            updated: "2026-08-16T00:00:00Z",
          }),
        ),
        Bun.write(
          join(factoryPath, "plan.md"),
          "- [ ] T1 (standard) — Task\n  - deps: none",
        ),
        Bun.write(join(factoryPath, "questions.md"), "## Q1 malformed"),
        Bun.write(
          join(factoryPath, "worklog.md"),
          "- 2026-08-16 UTC - completed verification",
        ),
        Bun.write(
          join(factoryPath, "logs", "costs.json"),
          JSON.stringify({
            schemaVersion: 1,
            recordedAt: "2026-08-16T00:00:00Z",
            currency: "USD",
            tasks: {},
          }),
        ),
      ]);

      const result = await readRepositoryFactoryData({
        name: "configured-name",
        path: root,
      });

      expect(result.name).toBe("configured-name");
      expect(result.state.status).toBe("available");
      expect(result.plan.status).toBe("available");
      expect(result.questions.status).toBe("partial");
      expect(result.worklog.status).toBe("available");
      expect(result.routing.status).toBe("unavailable");
      expect(result.costs).toEqual({
        status: "available",
        data: {
          schemaVersion: 1,
          recordedAt: "2026-08-16T00:00:00Z",
          currency: "USD",
          tasks: {},
        },
        warnings: [],
      });
      expect(result.state.status).toBe("available");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps newest driver data usable through the snapshot above 256 logs", async () => {
    const fixture = createFactoryFixture();
    try {
      for (let i = 0; i < 257; i++) {
        fixture.writeDriverLog(
          `driver-20240101-120000-${i}.log`,
          i === 256 ? "newest driver narration\n" : "older driver narration\n",
        );
      }
      let selectedDriver: TrustedDriverLog | null | undefined;

      const result = await readRepositoryFactoryData(
        { name: "factory-ui", path: fixture.root },
        async (driver) => {
          selectedDriver = driver;
          return {
            state: "RUNNING",
            checkedAt: "2026-08-16T12:00:00.000Z",
          };
        },
      );

      expect(result.logs).toMatchObject({
        status: "available",
        data: { narration: "newest driver narration\n" },
      });
      expect(selectedDriver?.path).toEndWith(
        join("logs", "driver-20240101-120000-256.log"),
      );
      expect(result.liveness).toEqual({
        state: "RUNNING",
        checkedAt: "2026-08-16T12:00:00.000Z",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("propagates an over-bound logs directory as unavailable without a trusted driver", async () => {
    const fixture = createFactoryFixture();
    try {
      for (let i = 0; i <= MAX_LOG_ENTRIES; i++) {
        fixture.writeDriverLog(
          `driver-20240101-120000-${i}.log`,
          "driver narration\n",
        );
      }
      let selectedDriver: TrustedDriverLog | null | undefined;

      const result = await readRepositoryFactoryData(
        { name: "factory-ui", path: fixture.root },
        async (driver) => {
          selectedDriver = driver;
          return {
            state: "CANNOT_VERIFY",
            checkedAt: "2026-08-16T12:00:00.000Z",
          };
        },
      );

      expect(result.logs).toEqual({
        status: "unavailable",
        warnings: [expect.objectContaining({ code: "LOGS_TOO_MANY_ENTRIES" })],
      });
      expect(selectedDriver).toBeNull();
      expect(result.liveness).toEqual({
        state: "CANNOT_VERIFY",
        checkedAt: "2026-08-16T12:00:00.000Z",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps a repository available when routing is absent", async () => {
    const root = mkdtempSync(join(process.cwd(), "tmp-factory-routing-"));
    mkdirSync(join(root, ".factory"));
    try {
      await Bun.write(
        join(root, ".factory", "state.json"),
        JSON.stringify({ project: "factory-ui", phase: "build" }),
      );
      const result = await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: root,
      });
      expect(result.status).toBe("available");
      expect(result.routing.status).toBe("unavailable");
      expect(result.routing.warnings[0]?.code).toBe("ROUTING_MISSING");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exposes folded per-task review metrics without making state availability depend on metrics", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        fixture.writeMetrics(
          [
            JSON.stringify({
              schemaVersion: 1,
              task: "T34",
              event: "ship",
              size: "standard",
              reclassifiedFrom: null,
              internal: null,
            }),
            JSON.stringify({
              schemaVersion: 1,
              task: "T34",
              event: "merge",
              pr: 34,
              external: {},
              ci: { runs: 1, reruns: 0 },
            }),
          ].join("\n"),
        ),
      ]);

      const snapshot = (await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
      })) as unknown as { status: string; metrics?: Record<string, unknown> };
      expect(snapshot.status).toBe("available");
      expect(snapshot.metrics).toMatchObject({
        status: "available",
        data: {
          tasks: { T34: { ship: { internal: null }, merge: { pr: 34 } } },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("enriches an open question with bounded structured details and links from its exact blocked task", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        fixture.writePlan(`- [!] T7 (standard) — Choose the rollout
  - acceptance: Fixes #17 and Fixes #23
  - pr: 42
  - deps: none
- [!] T70 (standard) — Different task
  - acceptance: Fixes #70
  - pr: 70
  - deps: none`),
        fixture.writeQuestions(`## Q7 (task T7, open) — Which rollout?
Context: First paragraph with <b>literal</b> text.

Second paragraph.
Parked branch: \`factory/t7-rollout\`
Options considered:
A — Enable gradually (recommended: limits blast radius)
B: Enable everywhere
C - Defer
For B or C, state whether the migration window is approved.
**A:**`),
      ]);

      const snapshot = await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
        githubUrl: "https://github.com/example/factory-ui",
      });
      const question =
        snapshot.questions.status === "unavailable"
          ? undefined
          : snapshot.questions.data.open[0];

      expect(question).toMatchObject({
        id: "Q7",
        context:
          "First paragraph with <b>literal</b> text.\n\nSecond paragraph.\nParked branch: `factory/t7-rollout`",
        branch: "factory/t7-rollout",
        branchUrl:
          "https://github.com/example/factory-ui/tree/factory/t7-rollout",
        options: [
          {
            label: "A",
            text: "Enable gradually (recommended: limits blast radius)",
            recommended: true,
          },
          { label: "B", text: "Enable everywhere" },
          { label: "C", text: "Defer" },
        ],
        qualifier:
          "For B or C, state whether the migration window is approved.",
        blockedTask: {
          id: "T7",
          title: "Choose the rollout",
          pr: 42,
          issueNumbers: [17, 23],
          prUrl: "https://github.com/example/factory-ui/pull/42",
          issueUrls: [
            "https://github.com/example/factory-ui/issues/17",
            "https://github.com/example/factory-ui/issues/23",
          ],
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps ambiguous option grammar as the raw question and never invents task or branch links", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        fixture.writePlan(
          "- [!] T70 (standard) — Different task\n  - deps: none",
        ),
        fixture.writeQuestions(`## Q7 (task T7, open) — Choose safely
Context: Context
Options considered: A or B, depending on C
**A:**`),
      ]);
      const snapshot = await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
        githubUrl: "https://github.com/example/factory-ui",
      });
      const question =
        snapshot.questions.status === "unavailable"
          ? undefined
          : snapshot.questions.data.open[0];

      expect(question).toMatchObject({ id: "Q7", context: "Context" });
      expect(question?.options).toBeUndefined();
      expect(question?.branch).toBeUndefined();
      expect(question?.branchUrl).toBeUndefined();
      expect(question?.blockedTask).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  test("preserves a single labelled option and its recommendation explanation", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        fixture.writePlan("- [!] T7 (standard) — Choose\n  - deps: none"),
        fixture.writeQuestions(`## Q7 (task T7, open) — Choose
Context: Context
Options considered: A — Continue (recommended because it preserves compatibility)
**A:**`),
      ]);
      const snapshot = await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
      });
      const question =
        snapshot.questions.status === "unavailable"
          ? undefined
          : snapshot.questions.data.open[0];

      expect(question?.options).toEqual([
        {
          label: "A",
          text: "Continue (recommended because it preserves compatibility)",
          recommended: true,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("carries partial bounded model metadata through the snapshot", async () => {
    const fixture = createFactoryFixture();
    try {
      await Promise.all([
        fixture.writeState({ project: "factory-ui", phase: "build" }),
        fixture.writeRouting({
          schemaVersion: 1,
          recordedAt: "2026-08-16T00:00:00Z",
          model: "openai/gpt-5.6",
          smallModel: "opencode/gpt-5-mini",
          agents: {},
          models: {
            "openai/gpt-5.6": {
              source: "models.dev",
              pricesAsOf: "2026-08-16",
              name: "GPT 5.6",
              family: "gpt",
              releaseDate: "2026-08-01",
              contextWindow: 1_050_000,
              maxOutputTokens: 128_000,
              pricePerMillion: {
                input: 1.25,
                output: 10,
                cacheRead: null,
                cacheWrite: null,
              },
            },
            malformed: { source: "models.dev" },
          },
        }),
      ]);

      const result = await readRepositoryFactorySnapshot({
        name: "factory-ui",
        path: fixture.root,
      });
      expect(result.status).toBe("available");
      expect(result.routing).toMatchObject({
        status: "partial",
        data: {
          models: {
            "openai/gpt-5.6": {
              pricePerMillion: { input: 1.25, cacheRead: null },
            },
          },
        },
        warnings: [{ code: "ROUTING_INVALID_MODEL" }],
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("carries a reader warning line excerpt through the repository snapshot", async () => {
    const root = mkdtempSync(
      join(process.cwd(), "tmp-factory-warning-excerpt-"),
    );
    const factoryPath = join(root, ".factory");
    mkdirSync(factoryPath);
    const sourceLine = `- [?] T1 (standard) — <img onerror=alert(1)>\u0001${"x".repeat(8_192)}`;
    try {
      await Promise.all([
        Bun.write(
          join(factoryPath, "state.json"),
          JSON.stringify({ project: "factory-ui", phase: "build" }),
        ),
        Bun.write(join(factoryPath, "plan.md"), sourceLine),
      ]);

      const result = await readRepositoryFactoryData({
        name: "factory-ui",
        path: root,
      });

      expect(result.plan.warnings).toContainEqual({
        code: "PLAN_LINE_TOO_LONG",
        message: "plan.md contains an oversized line",
        line: 1,
        excerpt: `${Array.from(sourceLine).slice(0, 199).join("")}…`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
          liveness: {
            state: "CANNOT_VERIFY",
            checkedAt: expect.any(String),
          },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
            liveness: {
              state: "CANNOT_VERIFY",
              checkedAt: expect.any(String),
            },
            status: "available",
            project: "project1",
            phase: "build",
          },
          {
            name: "repo2",
            liveness: {
              state: "CANNOT_VERIFY",
              checkedAt: expect.any(String),
            },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "available",
        project: "project1",
        phase: "build",
      });
      expect(result.repositories[1]).toEqual({
        name: "repo2",
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
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
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });
  });

  describe("symlink escape and isolation", () => {
    let tempRoot: string;
    let tempRepo: string;
    let tempOutside: string;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(process.cwd(), "tmp-snapshot-symlink-"));
      tempRepo = join(tempRoot, "repo");
      tempOutside = join(tempRoot, "outside");
      mkdirSync(tempRepo, { recursive: true });
      mkdirSync(`${tempRepo}/.factory`, { recursive: true });
      mkdirSync(tempOutside, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("rejects symlinked .factory escaping to outside directory", async () => {
      // Create state.json in outside directory
      const outsideState = join(tempOutside, "state.json");
      await Bun.write(outsideState, '{"project":"outside","phase":"build"}');

      // Remove the existing .factory directory and create a symlink to outside
      rmSync(`${tempRepo}/.factory`, { recursive: true, force: true });
      symlinkSync(tempOutside, `${tempRepo}/.factory`);

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempRepo,
      });

      expect(result).toEqual({
        name: "test-repo",
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });

    test("rejects symlinked state.json escaping .factory directory", async () => {
      // Create state.json in outside directory
      const outsideState = join(tempOutside, "state.json");
      await Bun.write(outsideState, '{"project":"outside","phase":"build"}');

      // Remove the existing state.json and create a symlink to outside
      rmSync(`${tempRepo}/.factory/state.json`, { force: true });
      symlinkSync(outsideState, `${tempRepo}/.factory/state.json`);

      const result = await readRepositorySnapshot({
        name: "test-repo",
        path: tempRepo,
      });

      expect(result).toEqual({
        name: "test-repo",
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });

    test("isolates repositories - one with symlink escape, one clean", async () => {
      // Create state in clean repo
      const cleanState = join(tempRepo, ".factory", "state.json");
      await Bun.write(cleanState, '{"project":"clean","phase":"build"}');

      // Create another repo with symlink escape
      const escapedRepo = join(tempRoot, "escaped-repo");
      mkdirSync(escapedRepo, { recursive: true });
      mkdirSync(`${escapedRepo}/.factory`, { recursive: true });

      const escapedState = join(tempOutside, "escaped-state.json");
      await Bun.write(escapedState, '{"project":"escaped","phase":"build"}');
      const stateSymlink = join(escapedRepo, ".factory", "state.json");
      symlinkSync(escapedState, stateSymlink);

      const config = {
        machine: "test-machine",
        repositories: [
          { name: "clean-repo", path: tempRepo },
          { name: "escaped-repo", path: escapedRepo },
        ],
        peers: [],
        port: 7777,
      };

      const result = await createFleetSnapshot(config);

      expect(result.repositories).toHaveLength(2);
      expect(result.repositories[0]).toEqual({
        name: "clean-repo",
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "available",
        project: "clean",
        phase: "build",
      });
      expect(result.repositories[1]).toEqual({
        name: "escaped-repo",
        liveness: {
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        },
        status: "unavailable",
        warning: "state.json could not be read",
      });
    });
  });

  describe("readRepositoryFactoryData", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(process.cwd(), "tmp-factory-data-logs");
      mkdirSync(tempDir, { recursive: true });
      mkdirSync(`${tempDir}/.factory`, { recursive: true });
      mkdirSync(`${tempDir}/.factory/logs`, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("integrates logs reader and liveness check", async () => {
      // Write state.json
      await Bun.write(
        `${tempDir}/.factory/state.json`,
        JSON.stringify({
          project: "test-project",
          phase: "build",
          spec_approved: true,
          plan_approved: true,
          current_task: null,
          branch: null,
          pr: null,
          hold: false,
          updated: "2026-08-16T00:00:00Z",
        }),
      );

      // Write a driver log
      await Bun.write(
        `${tempDir}/.factory/logs/driver-20240101-120000-0.log`,
        "test driver log",
      );

      let probedPath: string | undefined;
      const result = await readRepositoryFactoryData(
        { name: "test-repo", path: tempDir },
        async (driver) => {
          probedPath = driver?.path;
          return { state: "STOPPED", checkedAt: "2026-08-16T00:00:00Z" };
        },
      );

      // Verify logs are present
      expect(result.logs.status).toBe("available");
      if (result.logs.status === "available") {
        expect(result.logs.data.narration).toBe("test driver log");
        expect(result.logs.data.driver).toBeDefined();
      }

      // Verify liveness is integrated with driver log
      expect(probedPath).toEndWith("driver-20240101-120000-0.log");
      expect(result.liveness.state).toBe("STOPPED");
      expect(result.liveness.checkedAt).toBe("2026-08-16T00:00:00Z");
    });

    test("returns CANNOT_VERIFY liveness when no driver log exists", async () => {
      // Write state.json
      await Bun.write(
        `${tempDir}/.factory/state.json`,
        JSON.stringify({
          project: "test-project",
          phase: "build",
          spec_approved: true,
          plan_approved: true,
          current_task: null,
          branch: null,
          pr: null,
          hold: false,
          updated: "2026-08-16T00:00:00Z",
        }),
      );

      const result = await readRepositoryFactoryData({
        name: "test-repo",
        path: tempDir,
      });

      // Verify logs are unavailable
      expect(result.logs.status).toBe("unavailable");

      // Verify liveness is CANNOT_VERIFY
      expect(result.liveness.state).toBe("CANNOT_VERIFY");
    });
  });
});
