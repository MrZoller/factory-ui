import { describe, expect, test, vi } from "bun:test";
import { Window } from "happy-dom";

import { loadFleet, renderFleet } from "./app.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function dashboardDocument(): Document {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.body.innerHTML = [
    '<h1 id="machine"></h1>',
    '<p id="generated"></p>',
    '<p id="error"></p>',
    '<div id="repositories"></div>',
  ].join("");
  return document;
}

function richRepository(overrides: Record<string, unknown> = {}) {
  const task = {
    id: "T8",
    status: "active",
    size: "major",
    title: "Safe dashboard",
    dependencies: ["T7"],
    runnable: false,
  };
  return {
    name: "factory-ui",
    status: "available",
    project: "factory-ui",
    phase: "build",
    prUrl: "https://github.com/example/factory-ui/pull/42",
    state: {
      status: "available",
      data: {
        project: "factory-ui",
        phase: "build",
        specApproved: true,
        planApproved: true,
        currentTask: "T8",
        branch: "factory/t8-safe-dashboard",
        pr: 42,
        hold: true,
        updated: "2026-08-16T11:55:00.000Z",
      },
      warnings: [],
    },
    plan: {
      status: "available",
      data: {
        tasks: [task],
        active: [task],
        review: [{ ...task, id: "T7", title: "API" }],
        nextRunnable: [{ ...task, id: "T9", title: "Peers" }],
        completed: [{ ...task, id: "T6", title: "Logs" }],
        blocked: [{ ...task, id: "T11", title: "Review minors" }],
        remaining: [task],
      },
      warnings: [],
    },
    questions: {
      status: "available",
      data: {
        open: [
          {
            id: "Q8",
            taskId: "T8",
            title: "Which layout?",
            text: "Context and options",
          },
        ],
      },
      warnings: [],
    },
    worklog: {
      status: "available",
      data: { entries: [{ date: "2026-08-16", text: "Built dashboard" }] },
      warnings: [],
    },
    logs: {
      status: "partial",
      data: {
        narration: "Rendering safely",
        driver: {
          startedAt: "2026-08-16T11:00:00.000Z",
          lastActivityAt: "2026-08-16T11:59:00.000Z",
          durationMs: 3_540_000,
        },
        cycle: {
          startedAt: "2026-08-16T11:30:00.000Z",
          lastActivityAt: "2026-08-16T11:58:00.000Z",
        },
        shepherd: {
          startedAt: "2026-08-16T11:40:00.000Z",
          lastActivityAt: "2026-08-16T11:50:00.000Z",
        },
        asOf: { overall: "2026-08-16T11:59:00.000Z" },
      },
      warnings: [{ code: "LOG_TRUNCATED", message: "old lines omitted" }],
    },
    liveness: { state: "RUNNING", checkedAt: "2026-08-16T11:59:30.000Z" },
    ...overrides,
  };
}

describe("local dashboard rendering", () => {
  test("renders every repository work and activity group distinctly", () => {
    const document = dashboardDocument();
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T11:59:45.000Z",
        repositories: [richRepository()],
      },
      document,
      NOW,
    );

    expect(document.querySelector("#machine")?.textContent).toBe("mini");
    expect(document.querySelector("#generated")?.textContent).toContain(
      "15s ago",
    );
    const card = document.querySelector(".repository")!;
    expect(card.textContent).toContain("T8");
    expect(card.textContent).toContain("factory/t8-safe-dashboard");
    expect(card.textContent).toContain("HELD");
    expect(card.querySelector(".active-work")?.textContent).toContain(
      "Safe dashboard",
    );
    expect(card.querySelector(".review-work")?.textContent).toContain("API");
    expect(card.querySelector(".runnable-work")?.textContent).toContain(
      "Peers",
    );
    expect(card.querySelector(".completed-work")?.textContent).toContain(
      "Logs",
    );
    expect(card.querySelector(".blocked-work")?.textContent).toContain(
      "Review minors",
    );
    expect(card.querySelector(".questions-panel")?.textContent).toContain(
      "Which layout?",
    );
    expect(card.querySelector(".worklog-panel")?.textContent).toContain(
      "Built dashboard",
    );
    expect(card.querySelector(".logs-panel")?.textContent).toContain(
      "Rendering safely",
    );
    expect(card.querySelector(".liveness.running")?.textContent).toBe(
      "RUNNING",
    );
    expect(card.querySelector(".warnings-panel")?.textContent).toContain(
      "LOG_TRUNCATED",
    );

    const link = card.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/example/factory-ui/pull/42",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("keeps hostile repository-derived strings literal and inert", () => {
    const document = dashboardDocument();
    const hostile =
      '<script>globalThis.pwned=1</script></script><img src=x onerror="pwned=2"><a href="javascript:pwned=3">&lt;entity&gt;</a> data:text/html onclick=';
    const repository = richRepository({
      name: hostile,
      project: hostile,
      prUrl: "javascript:alert(1)",
      warning: hostile,
      state: {
        status: "available",
        data: {
          currentTask: hostile,
          branch: hostile,
          pr: 42,
          hold: false,
        },
        warnings: [{ code: hostile, message: hostile }],
      },
      questions: {
        status: "available",
        data: {
          open: [
            { id: hostile, taskId: hostile, title: hostile, text: hostile },
          ],
        },
        warnings: [],
      },
      worklog: {
        status: "available",
        data: { entries: [{ date: hostile, text: hostile }] },
        warnings: [],
      },
      logs: {
        status: "available",
        data: { narration: hostile, asOf: {} },
        warnings: [],
      },
    });

    renderFleet(
      {
        hostname: hostile,
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [repository],
      },
      document,
      NOW,
    );

    expect(document.body.textContent).toContain(hostile);
    expect(document.querySelectorAll("script, img, form, iframe")).toHaveLength(
      0,
    );
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector("[onerror], [onclick]")).toBeNull();
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("renders partial and unavailable sources without hiding usable data", () => {
    const document = dashboardDocument();
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "invalid",
        repositories: [
          richRepository({
            status: "unavailable",
            warning: "repository state is unavailable",
            plan: {
              status: "unavailable",
              warnings: [{ code: "PLAN_MISSING", message: "plan unavailable" }],
            },
            questions: {
              status: "unavailable",
              warnings: [
                { code: "QUESTIONS_MISSING", message: "questions unavailable" },
              ],
            },
            worklog: {
              status: "unavailable",
              warnings: [
                { code: "WORKLOG_MISSING", message: "worklog unavailable" },
              ],
            },
            logs: {
              status: "unavailable",
              warnings: [{ code: "LOGS_MISSING", message: "logs unavailable" }],
            },
          }),
        ],
      },
      document,
      NOW,
    );

    expect(document.querySelector(".status.unavailable")?.textContent).toBe(
      "UNAVAILABLE",
    );
    expect(document.querySelector(".active-work")?.textContent).toContain(
      "Unavailable",
    );
    expect(document.querySelector(".questions-panel")?.textContent).toContain(
      "Unavailable",
    );
    expect(document.querySelector(".worklog-panel")?.textContent).toContain(
      "Unavailable",
    );
    expect(document.querySelector(".logs-panel")?.textContent).toContain(
      "Unavailable",
    );
    expect(document.querySelector(".warnings-panel")?.textContent).toContain(
      "PLAN_MISSING",
    );
    expect(document.querySelector("#generated")?.textContent).toContain(
      "Unknown",
    );
  });

  test("renders omitted state fields as unknown rather than negative values", () => {
    const document = dashboardDocument();
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [
          richRepository({
            state: {
              status: "unavailable",
              warnings: [
                { code: "STATE_MISSING", message: "state unavailable" },
              ],
            },
          }),
        ],
      },
      document,
      NOW,
    );

    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "TaskUnknown",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "BranchUnknown",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "Pull requestUnknown",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "HoldUnknown",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "Gatesspec Unknown; plan Unknown",
    );
  });

  test("keeps valid partial state fields visible", () => {
    const document = dashboardDocument();
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [
          richRepository({
            status: "unavailable",
            project: undefined,
            phase: undefined,
            state: {
              status: "partial",
              data: { project: "factory-ui" },
              warnings: [
                { code: "STATE_INVALID", message: "phase unavailable" },
              ],
            },
          }),
        ],
      },
      document,
      NOW,
    );

    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "Projectfactory-ui",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "PhaseUnknown",
    );
  });

  test("reports fetch failures without rendering stale cards", async () => {
    const document = dashboardDocument();
    document
      .querySelector("#repositories")
      ?.append(document.createElement("i"));
    const fetcher = vi.fn(async () => new Response("failure", { status: 503 }));

    await loadFleet(document, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/fleet");
    expect(document.querySelector("#machine")?.textContent).toBe(
      "Local machine unavailable",
    );
    expect(document.querySelector("#error")?.textContent).toBe(
      "Request failed (503)",
    );
  });
});
