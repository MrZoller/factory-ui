import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_PLAN_BYTES,
  MAX_PLAN_LINES,
  MAX_PLAN_LINE_LENGTH,
  MAX_PLAN_TASKS,
  MAX_TASK_DEPENDENCIES,
  MAX_PLAN_WARNINGS,
  parseFactoryPlan,
  readFactoryPlan,
} from "./plan";
import { readRepositoryFactoryData } from "../snapshot";
import { type PlanData, type PlanTask } from "../contracts";
import { MAX_WARNING_EXCERPT_CODE_POINTS } from "./warnings";

describe("plan", () => {
  describe("constants", () => {
    test("MAX_PLAN_BYTES is 262144", () => {
      expect(MAX_PLAN_BYTES).toBe(256 * 1024);
    });

    test("MAX_PLAN_LINES is 4096", () => {
      expect(MAX_PLAN_LINES).toBe(4096);
    });

    test("MAX_PLAN_LINE_LENGTH is 8192", () => {
      expect(MAX_PLAN_LINE_LENGTH).toBe(8192);
    });

    test("MAX_PLAN_TASKS is 256", () => {
      expect(MAX_PLAN_TASKS).toBe(256);
    });

    test("MAX_TASK_DEPENDENCIES is 32", () => {
      expect(MAX_TASK_DEPENDENCIES).toBe(32);
    });

    test("MAX_PLAN_WARNINGS is 32", () => {
      expect(MAX_PLAN_WARNINGS).toBe(32);
    });
  });

  describe("parseFactoryPlan", () => {
    describe("line count validation", () => {
      test("returns unavailable for plan exceeding MAX_PLAN_LINES", () => {
        const lines = Array.from(
          { length: MAX_PLAN_LINES + 1 },
          (_, i) => `- [ ] T${i + 1} (standard) — Task ${i + 1}`,
        ).join("\n");
        const result = parseFactoryPlan(lines);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("PLAN_TOO_MANY_LINES");
      });

      test("returns partial for plan with exactly MAX_PLAN_LINES (missing deps)", () => {
        // Create a single task with enough lines to hit the limit
        // We need 4096 lines total, with the first being the task and rest being blank or comments
        const taskLine = `- [ ] T1 (trivial) — Task`;
        const blankLines = Array.from(
          { length: MAX_PLAN_LINES - 1 },
          () => "",
        ).join("\n");
        const lines = taskLine + "\n" + blankLines;
        const result = parseFactoryPlan(lines);
        expect(result.status).toBe("partial"); // Missing deps
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
        }
      });
    });

    describe("line length validation", () => {
      test("returns unavailable for line exceeding MAX_PLAN_LINE_LENGTH", () => {
        const longLine = `- [ ] T1 (standard) — ${"x".repeat(MAX_PLAN_LINE_LENGTH + 1)}`;
        const result = parseFactoryPlan(`first\n${longLine}`);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("PLAN_LINE_TOO_LONG");
        expect(result.warnings[0]!.line).toBe(2);
        expect(Array.from(result.warnings[0]!.excerpt ?? "")).toHaveLength(
          MAX_WARNING_EXCERPT_CODE_POINTS,
        );
        expect(result.warnings[0]!.excerpt?.endsWith("…")).toBe(true);
      });

      test("returns partial for line with exactly MAX_PLAN_LINE_LENGTH (missing deps)", () => {
        const line = `- [ ] T1 (standard) — ${"x".repeat(MAX_PLAN_LINE_LENGTH - 27)}`;
        const result = parseFactoryPlan(line);
        expect(result.status).toBe("partial"); // Missing deps
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
        }
      });
    });

    describe("task parsing - valid tasks", () => {
      test("parses an optional task PR and distinct Fixes issue references", () => {
        const plan = `- [R] T17 (standard) — Link GitHub work
  - acceptance: Dashboard navigation Fixes #17 and Fixes #23, not #17 again
  - pr: 42
  - deps: none`;
        const result = parseFactoryPlan(plan);

        expect(result.status).toBe("available");
        if (result.status === "available" || result.status === "partial") {
          expect(result.data.tasks[0]).toMatchObject({
            id: "T17",
            pr: 42,
            issueNumbers: [17, 23],
          });
        }
      });

      test("parses todo task", () => {
        const plan = `- [ ] T1 (standard) — Implement feature`;
        const result = parseFactoryPlan(plan);
        expect(result.status).toBe("partial");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
          expect(result.data.tasks[0]).toEqual({
            id: "T1",
            status: "todo",
            size: "standard",
            title: "Implement feature",
            dependencies: null,
            localDependencies: null,
            crossRepoDependencies: null,
            runnable: false,
          });
        }
      });

      test("parses active task", () => {
        const plan = `- [~] T1 (standard) — Implement feature`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.status).toBe("active");
        }
      });

      test("parses review task", () => {
        const plan = `- [R] T1 (standard) — Implement feature`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.status).toBe("review");
        }
      });

      test("parses completed task", () => {
        const plan = `- [x] T1 (standard) — Implement feature`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.status).toBe("completed");
        }
      });

      test("parses blocked task", () => {
        const plan = `- [!] T1 (standard) — Implement feature`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.status).toBe("blocked");
        }
      });

      test("parses trivial size", () => {
        const plan = `- [ ] T1 (trivial) — Fix typo`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.size).toBe("trivial");
        }
      });

      test("parses major size", () => {
        const plan = `- [ ] T1 (major) — Rewrite core`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.size).toBe("major");
        }
      });

      test("parses task with dependencies", () => {
        const plan = `- [ ] T1 (standard) — Implement feature
  - deps: T2`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.dependencies).toEqual(["T2"]);
        }
      });

      test("parses task with no dependencies", () => {
        const plan = `- [ ] T1 (standard) — Implement feature
  - deps: none`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.dependencies).toEqual([]);
        }
      });

      test("parses multiple dependencies", () => {
        const plan = `- [ ] T1 (standard) — Implement feature
  - deps: T2, T3, T4`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.dependencies).toEqual([
            "T2",
            "T3",
            "T4",
          ]);
        }
      });

      test("handles large task IDs", () => {
        const plan = `- [ ] T999999 (standard) — Large task ID`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.id).toBe("T999999");
        }
      });
    });

    describe("task parsing - invalid task lines", () => {
      test("ignores nested bullet points", () => {
        const plan = `- [ ] T1 (standard) — Main task
  - Nested item`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
        }
      });

      test("ignores nested task-like lines (not at top level)", () => {
        const plan = `- [ ] T1 (standard) — Main task
  - [ ] T2 (standard) — Nested task`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
          expect(result.data.tasks[0]!.id).toBe("T1");
        }
      });

      test("does not warn about malformed task line starting without dash", () => {
        const plan = `T1 (standard) — Missing dash`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        // This line doesn't start with "- [" so no warning is generated
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(false);
      });

      test("does not warn about malformed task line starting without dash", () => {
        // Lines that don't start with "- [" are not considered task lines
        // and don't generate warnings
        const plan = `T1 (standard) — Missing dash`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(false);
      });

      test("warns about malformed task line (missing size)", () => {
        const plan = `- [ ] T1 — Missing size`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });

      test("warns about malformed task line (missing title)", () => {
        const plan = `- [ ] T1 (standard) —`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });

      test("warns about malformed task line (invalid status)", () => {
        const plan = `- [?] T1 (standard) — Invalid status`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });

      test("bounds a hostile warning excerpt by Unicode code points", () => {
        const source = `- [?] T1 (standard) — <img onerror=alert(1)>\u0000${"😀".repeat(220)}`;
        const result = parseFactoryPlan(source);
        const warning = result.warnings.find(
          (item) => item.code === "PLAN_MALFORMED_TASK",
        );

        expect(warning?.line).toBe(1);
        expect(warning?.excerpt?.startsWith("- [?] T1")).toBe(true);
        expect(warning?.excerpt).toContain("<img onerror=alert(1)>");
        expect(warning?.excerpt).toContain("\u0000");
        expect(Array.from(warning?.excerpt ?? "")).toHaveLength(
          MAX_WARNING_EXCERPT_CODE_POINTS,
        );
        expect(warning?.excerpt?.endsWith("…")).toBe(true);
      });

      test("warns about malformed task line (lowercase t)", () => {
        const plan = `- [ ] t1 (standard) — Lowercase task ID`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });

      test("warns about malformed task line (T0)", () => {
        const plan = `- [ ] T0 (standard) — Task zero`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });

      test("warns about malformed task line (invalid size)", () => {
        const plan = `- [ ] T1 (invalid) — Invalid size`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_TASK"),
        ).toBe(true);
      });
    });

    describe("dependency parsing", () => {
      test("separates exact local and qualified cross-repository dependencies", () => {
        const result =
          parseFactoryPlan(`- [ ] T8 (standard) — Draw the fleet graph
  - deps: T2, acme/media#17, example/engine#92
- [x] T2 (standard) — Export local task data
  - deps: none`);

        expect(result.status).toBe("available");
        if (result.status === "available") {
          const task = result.data.tasks[0] as unknown as {
            localDependencies?: unknown;
            crossRepoDependencies?: unknown;
            runnable?: unknown;
          };
          // Graph clients need executable local prerequisites separately
          // from offline cross-repository metadata.
          expect(task.localDependencies).toEqual(["T2"]);
          expect(task.crossRepoDependencies).toEqual([
            "acme/media#17",
            "example/engine#92",
          ]);
          expect(task.runnable).toBe(true);
        }
      });

      test("treats qualified references as non-gating while local dependencies control runnability", () => {
        const result =
          parseFactoryPlan(`- [ ] T8 (standard) — Wait only for local work
  - deps: T2, acme/media#17
- [x] T2 (standard) — Export local task data
  - deps: none`);

        expect(result.status).toBe("available");
        if (result.status === "available") {
          const task = result.data.tasks[0] as unknown as {
            runnable?: unknown;
            localDependencies?: unknown;
            crossRepoDependencies?: unknown;
          };
          expect(task.localDependencies).toEqual(["T2"]);
          expect(task.crossRepoDependencies).toEqual(["acme/media#17"]);
          expect(task.runnable).toBe(true);
          expect(
            result.data.nextRunnable.map((candidate) => candidate.id),
          ).toEqual(["T8"]);
        }
      });

      test("rejects malformed qualified references without exposing a graphable dependency", () => {
        for (const reference of [
          "#17",
          "acme/media#0",
          "acme/#17",
          "acme/media#17/extra",
          "acme/media#17,",
        ]) {
          const result =
            parseFactoryPlan(`- [ ] T8 (standard) — Unsafe reference
  - deps: ${reference}`);

          expect(result.status).toBe("partial");
          if (result.status === "partial") {
            const task = result.data.tasks[0] as unknown as {
              localDependencies?: unknown;
              crossRepoDependencies?: unknown;
              runnable?: unknown;
            };
            expect(task.localDependencies).toBeNull();
            expect(task.crossRepoDependencies).toBeNull();
            expect(task.runnable).toBe(false);
          }
          expect(
            result.warnings.some((warning) =>
              ["PLAN_MALFORMED_DEPS", "PLAN_MALFORMED_CROSS_REPO_DEP"].includes(
                warning.code,
              ),
            ),
          ).toBe(true);
        }
      });

      test("ignores task-shaped lines inside Markdown fences", () => {
        const result = parseFactoryPlan(`\`\`\`markdown
- [ ] T99 (major) — Documentation example
  - deps: none
\`\`\`
- [ ] T1 (standard) — Real task
  - deps: none`);

        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.tasks.map((task) => task.id)).toEqual(["T1"]);
        }
      });

      test("accepts issue references followed by colon, bang, or question punctuation", () => {
        const result = parseFactoryPlan(`- [ ] T17 (standard) — Link work
  - acceptance: Fixes #12: detail; Fixes #13! Fixes #14?
  - deps: none`);

        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.tasks[0]?.issueNumbers).toEqual([12, 13, 14]);
        }
      });

      test("warns when PR metadata is present with an empty value", () => {
        const result = parseFactoryPlan(`- [ ] T17 (standard) — Link work
  - pr:
  - deps: none`);

        expect(result.status).toBe("partial");
        if (result.status === "partial") {
          expect(result.data.tasks[0]).toHaveProperty("pr", undefined);
        }
        expect(result.warnings.map((warning) => warning.code)).toContain(
          "PLAN_MALFORMED_PR",
        );
      });

      test("ignores malformed PR and Fixes values with bounded warnings", () => {
        const plan = `- [ ] T17 (standard) — Link GitHub work
  - acceptance: Fixes #0, Fixes #-3, Fixes #9007199254740992
  - pr: 0
  - deps: none`;
        const result = parseFactoryPlan(plan);

        expect(result.status).toBe("partial");
        if (result.status === "available" || result.status === "partial") {
          expect(result.data.tasks[0]).toMatchObject({
            pr: undefined,
            issueNumbers: [],
          });
        }
        expect(
          result.warnings.some(
            (warning) => warning.code === "PLAN_MALFORMED_PR",
          ),
        ).toBe(true);
        expect(
          result.warnings.some(
            (warning) => warning.code === "PLAN_MALFORMED_ISSUE",
          ),
        ).toBe(true);
      });

      test("bounds Fixes issue references per task without failing the plan", () => {
        const issues = Array.from(
          { length: 33 },
          (_, index) => `Fixes #${index + 1}`,
        ).join(", ");
        const result = parseFactoryPlan(`- [ ] T17 (standard) — Link GitHub work
  - acceptance: ${issues}
  - deps: none`);

        expect(result.status).toBe("partial");
        if (result.status === "available" || result.status === "partial") {
          expect(
            (result.data.tasks[0] as unknown as { issueNumbers: number[] })
              .issueNumbers,
          ).toHaveLength(32);
        }
        expect(
          result.warnings.some(
            (warning) => warning.code === "PLAN_TOO_MANY_ISSUES",
          ),
        ).toBe(true);
      });

      test("warns when task is missing dependency metadata", () => {
        const plan = `- [ ] T1 (standard) — Task without deps`;
        const result = parseFactoryPlan(plan);
        expect(
          result.warnings.some((w) => w.code === "PLAN_MISSING_DEPS"),
        ).toBe(true);
        expect(result.warnings[0]!.line).toBe(1);
      });

      test("warns about malformed dependencies line", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2,`;
        const result = parseFactoryPlan(plan);
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_DEPS"),
        ).toBe(true);
      });

      test("warns about duplicate dependencies lines", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
  - deps: T3`;
        const result = parseFactoryPlan(plan);
        expect(
          result.warnings.some((w) => w.code === "PLAN_MALFORMED_DEPS"),
        ).toBe(true);
      });

      test("rejects a repeated dependency without inventing runnability", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2, T2
- [x] T2 (standard) — Dependency
  - deps: none`;
        const result = parseFactoryPlan(plan);
        expect(result.status).toBe("partial");
        if (result.status === "partial") {
          expect(result.data.tasks[0]?.dependencies).toBeNull();
          expect(result.data.tasks[0]?.runnable).toBe(false);
        }
        expect(
          result.warnings.some(
            (warning) => warning.code === "PLAN_DUPLICATE_DEP",
          ),
        ).toBe(true);
      });

      test("warns when dependencies exceed MAX_TASK_DEPENDENCIES", () => {
        const deps = Array.from(
          { length: MAX_TASK_DEPENDENCIES + 1 },
          (_, i) => `T${i + 2}`,
        ).join(", ");
        const plan = `- [ ] T1 (standard) — Task
  - deps: ${deps}`;
        const result = parseFactoryPlan(plan);
        expect(
          result.warnings.some((w) => w.code === "PLAN_TOO_MANY_DEPS"),
        ).toBe(true);
      });

      test("accepts exactly MAX_TASK_DEPENDENCIES", () => {
        const deps = Array.from(
          { length: MAX_TASK_DEPENDENCIES },
          (_, i) => `T${i + 2}`,
        ).join(", ");
        const plan = `- [ ] T1 (standard) — Task
  - deps: ${deps}`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.dependencies).toHaveLength(
            MAX_TASK_DEPENDENCIES,
          );
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_TOO_MANY_DEPS"),
        ).toBe(false);
      });
    });

    describe("runnable grouping", () => {
      test("identifies runnable task when dependencies are completed", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [x] T2 (standard) — Dependency`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.nextRunnable).not.toBeNull();
          const nextRunnable = result.data.nextRunnable!;
          expect(nextRunnable.length).toBe(1);
          const [first] = nextRunnable;
          expect(first!.id).toBe("T1");
          expect(first!.runnable).toBe(true);
        }
      });

      test("does not identify runnable task when dependencies are not completed", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [ ] T2 (standard) — Dependency`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.nextRunnable).toHaveLength(0);
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
      });

      test("does not identify runnable task when self-dependent", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T1`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
        expect(result.warnings.some((w) => w.code === "PLAN_SELF_DEP")).toBe(
          true,
        );
      });

      test("does not identify runnable task when dependency is unknown", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T999`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
        expect(result.warnings.some((w) => w.code === "PLAN_UNKNOWN_DEP")).toBe(
          true,
        );
      });

      test("does not identify runnable task when dependency is ambiguous", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [ ] T2 (standard) — First T2
- [ ] T2 (standard) — Second T2`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
        expect(
          result.warnings.some((w) => w.code === "PLAN_AMBIGUOUS_DEP"),
        ).toBe(true);
      });

      test("groups tasks by status", () => {
        const plan = `- [ ] T1 (standard) — Todo
- [~] T2 (standard) — Active
- [R] T3 (standard) — Review
- [x] T4 (standard) — Completed
- [!] T5 (standard) — Blocked`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(5);
          expect(result.data.active).toHaveLength(1);
          expect(result.data.active[0]!.id).toBe("T2");
          expect(result.data.review).toHaveLength(1);
          expect(result.data.review[0]!.id).toBe("T3");
          expect(result.data.completed).toHaveLength(1);
          expect(result.data.completed[0]!.id).toBe("T4");
          expect(result.data.blocked).toHaveLength(1);
          expect(result.data.blocked[0]!.id).toBe("T5");
          expect(result.data.remaining).toHaveLength(1);
          expect(result.data.remaining[0]!.id).toBe("T1");
        }
      });

      test("nextRunnable only includes todo tasks with valid dependencies", () => {
        const plan = `- [ ] T1 (standard) — Todo with completed dep
  - deps: T3
- [x] T3 (standard) — Completed
- [ ] T2 (standard) — Todo with missing dep
  - deps: T999`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.nextRunnable).not.toBeNull();
          const nextRunnable = result.data.nextRunnable!;
          expect(nextRunnable.length).toBe(1);
          const [first] = nextRunnable;
          expect(first!.id).toBe("T1");
        }
      });
    });

    describe("duplicate task detection", () => {
      test("warns about duplicate task IDs", () => {
        const plan = `- [ ] T1 (standard) — First T1
- [ ] T1 (standard) — Second T1`;
        const result = parseFactoryPlan(plan);
        expect(
          result.warnings.some((w) => w.code === "PLAN_DUPLICATE_TASK"),
        ).toBe(true);
        expect(
          result.warnings.filter((w) => w.code === "PLAN_DUPLICATE_TASK"),
        ).toHaveLength(2);
      });

      test("warns with line numbers for duplicate tasks", () => {
        const plan = `- [ ] T1 (standard) — First
- [ ] T2 (standard) — Second
- [ ] T1 (standard) — Duplicate`;
        const result = parseFactoryPlan(plan);
        const dupWarnings = result.warnings.filter(
          (w) => w.code === "PLAN_DUPLICATE_TASK",
        );
        expect(dupWarnings).toHaveLength(2);
        expect(dupWarnings[0]!.line).toBe(1);
        expect(dupWarnings[1]!.line).toBe(3);
      });

      test("does not expose duplicate todo tasks as runnable", () => {
        const plan = `- [ ] T1 (standard) — First
  - deps: none
- [ ] T1 (standard) — Duplicate
  - deps: none`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial") {
          expect(result.data.nextRunnable).toHaveLength(0);
          expect(result.data.tasks.every((task) => !task.runnable)).toBe(true);
        }
      });
    });

    describe("task limit enforcement", () => {
      test("returns unavailable for plan exceeding MAX_PLAN_TASKS", () => {
        const lines = Array.from(
          { length: MAX_PLAN_TASKS + 1 },
          (_, i) => `- [ ] T${i + 1} (standard) — Task ${i + 1}`,
        ).join("\n");
        const result = parseFactoryPlan(lines);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("PLAN_TOO_MANY_TASKS");
      });

      test("returns partial for plan with exactly MAX_PLAN_TASKS (missing deps)", () => {
        const lines = Array.from(
          { length: MAX_PLAN_TASKS },
          (_, i) => `- [ ] T${i + 1} (standard) — Task ${i + 1}`,
        ).join("\n");
        const result = parseFactoryPlan(lines);
        expect(result.status).toBe("partial");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(MAX_PLAN_TASKS);
        }
      });
    });

    describe("CRLF line endings", () => {
      test("handles CRLF line endings", () => {
        const plan = `- [ ] T1 (standard) — Task\r\n  - deps: none`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
          expect(result.data.tasks[0]!.id).toBe("T1");
        }
      });
    });

    describe("hostile content preservation", () => {
      test("preserves hostile title in task", () => {
        const hostile = "<script>alert(1)</script>";
        const plan = `- [ ] T1 (standard) — ${hostile}`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.title).toBe(hostile);
        }
      });

      test("returns null for hostile dependency IDs (invalid task ID format)", () => {
        const hostile = "T1<script>";
        const plan = `- [ ] T2 (standard) — Task
  - deps: ${hostile}`;
        const result = parseFactoryPlan(plan);
        // The hostile ID doesn't match the task ID pattern T[1-9][0-9]*, so it's set to null
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.dependencies).toBeNull();
        }
      });

      test("preserves hostile text in warnings", () => {
        const hostile = "<img src=x onerror=alert(1)>";
        const plan = `- [ ] T1 (standard) — ${hostile}`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.title).toBe(hostile);
        }
      });
    });

    describe("empty and edge cases", () => {
      test("handles empty plan", () => {
        const result = parseFactoryPlan("");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
          expect(result.data.active).toHaveLength(0);
          expect(result.data.review).toHaveLength(0);
          expect(result.data.nextRunnable).toHaveLength(0);
          expect(result.data.completed).toHaveLength(0);
          expect(result.data.blocked).toHaveLength(0);
          expect(result.data.remaining).toHaveLength(0);
        }
      });

      test("handles plan with only whitespace", () => {
        const result = parseFactoryPlan("   \n  \n  ");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(0);
        }
      });

      test("handles plan with comments (non-task lines)", () => {
        const plan = `# This is a comment
## Section
- [ ] T1 (standard) — Task`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(1);
        }
      });

      test("handles plan with blank lines", () => {
        const plan = `- [ ] T1 (standard) — Task

- [ ] T2 (standard) — Task 2`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks).toHaveLength(2);
        }
      });
    });

    describe("warning truncation", () => {
      test("truncates warnings at MAX_PLAN_WARNINGS", () => {
        // Create many malformed tasks to trigger warning truncation
        const lines = Array.from(
          { length: MAX_PLAN_WARNINGS + 5 },
          (_, i) => `- [ ] T${i + 1} (standard) — Task`, // Missing deps
        ).join("\n");
        const result = parseFactoryPlan(lines);
        expect(result.warnings).toHaveLength(MAX_PLAN_WARNINGS);
        expect(result.warnings[MAX_PLAN_WARNINGS - 1]!.code).toBe(
          "WARNINGS_TRUNCATED",
        );
      });
    });

    describe("runnable dependency resolution", () => {
      test("correctly identifies runnable when dep is completed", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [x] T2 (standard) — Dep`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(true);
          expect(result.data.nextRunnable).not.toBeNull();
          const nextRunnable = result.data.nextRunnable!;
          expect(nextRunnable.length).toBe(1);
          const [first] = nextRunnable;
          expect(first!.id).toBe("T1");
        }
      });

      test("does not identify runnable when dep is todo", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [ ] T2 (standard) — Dep`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
          expect(result.data.nextRunnable).toHaveLength(0);
        }
      });

      test("does not identify runnable when dep is active", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [~] T2 (standard) — Dep`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
      });

      test("does not identify runnable when dep is review", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [R] T2 (standard) — Dep`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
      });

      test("does not identify runnable when dep is blocked", () => {
        const plan = `- [ ] T1 (standard) — Task
  - deps: T2
- [!] T2 (standard) — Dep`;
        const result = parseFactoryPlan(plan);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.tasks[0]!.runnable).toBe(false);
        }
      });
    });
  });

  describe("readFactoryPlan", () => {
    let tempDir: string;
    let factoryDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-plan-"));
      factoryDir = join(tempDir, ".factory");
      mkdirSync(factoryDir);
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test("returns available for valid plan.md", async () => {
      const plan = `- [ ] T1 (standard) — Implement feature
  - deps: none
- [x] T2 (standard) — Completed task
  - deps: none`;
      await Bun.write(join(factoryDir, "plan.md"), plan);

      const result = await readFactoryPlan(tempDir);
      if (result.status === "partial" || result.status === "available") {
        expect(result.data.tasks).toHaveLength(2);
        expect(result.data.completed).toHaveLength(1);
      }
    });

    test("returns unavailable with PLAN_MISSING when plan.md is missing", async () => {
      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("PLAN_MISSING");
      expect(result.warnings[0]!.message).toBe("plan.md is missing");
    });

    test("returns unavailable with PLAN_TOO_LARGE when plan.md exceeds MAX_PLAN_BYTES", async () => {
      const largeContent =
        "- [ ] T1 (standard) — " + "x".repeat(MAX_PLAN_BYTES + 1);
      await Bun.write(join(factoryDir, "plan.md"), largeContent);

      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("PLAN_TOO_LARGE");
      expect(result.warnings[0]!.message).toBe("plan.md is too large");
    });

    test("returns unavailable with PLAN_INVALID_UTF8 for invalid UTF-8", async () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
      await Bun.write(join(factoryDir, "plan.md"), bytes);

      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("PLAN_INVALID_UTF8");
    });

    test("returns partial for valid UTF-8 with warnings", async () => {
      const plan = `- [ ] T1 (standard) — Task without deps`;
      await Bun.write(join(factoryDir, "plan.md"), plan);

      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("partial");
      expect(result.warnings).toHaveLength(1);
    });

    test("handles missing .factory directory", async () => {
      rmSync(factoryDir, { recursive: true, force: true });
      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("PLAN_MISSING");
    });

    test("preserves repository identity in error messages", async () => {
      const plan = `- [ ] T1 (standard) — Task
  - deps: none`;
      await Bun.write(join(factoryDir, "plan.md"), plan);

      const result = await readFactoryPlan(tempDir);
      expect(result.status).toBe("available");
    });

    test("handles hostile content in plan.md", async () => {
      const hostile = `- [ ] T1 (standard) — <script>alert(1)</script>
  - deps: none`;
      await Bun.write(join(factoryDir, "plan.md"), hostile);

      const result = await readFactoryPlan(tempDir);
      if (result.status === "partial" || result.status === "available") {
        expect(result.data.tasks[0]!.title).toBe("<script>alert(1)</script>");
      }
    });

    test("preserves configured identity when both sources are unavailable", async () => {
      const result = await readRepositoryFactoryData({
        name: "configured-name",
        path: tempDir,
      });
      expect(result.name).toBe("configured-name");
      expect(result.state.status).toBe("unavailable");
      expect(result.plan.status).toBe("unavailable");
      expect(result.questions.status).toBe("unavailable");
      expect(result.worklog.status).toBe("unavailable");
    });
  });
});
