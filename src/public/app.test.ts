import { describe, expect, test, vi } from "bun:test";
import { Window } from "happy-dom";

import {
  loadFleet,
  MAX_CONCURRENT_PEER_FETCHES,
  PEER_FETCH_TIMEOUT_MS,
  renderFleet,
} from "./app.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function dashboardDocument(): Document {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.body.innerHTML = [
    '<h1 id="machine"></h1>',
    '<p id="generated"></p>',
    '<p id="error"></p>',
    '<table id="fleet-summary"><tbody></tbody></table>',
    '<div id="machine-tabs" role="tablist"></div>',
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
    routing: {
      status: "available",
      data: {
        schemaVersion: 1,
        recordedAt: "2026-08-16T11:59:00.000Z",
        model: "openai/gpt-5.6",
        smallModel: "opencode/gpt-5-mini",
        agents: {
          builder: { provider: "openai", model: "gpt-5.6", steps: null },
        },
      },
      warnings: [],
    },
    liveness: { state: "RUNNING", checkedAt: "2026-08-16T11:59:30.000Z" },
    ...overrides,
  };
}

function fleet(
  hostname: string,
  peers: Array<{ name: string; origin: string }> = [],
  repositories: unknown[] = [],
) {
  return {
    schemaVersion: 1,
    hostname,
    generatedAt: "2026-08-16T12:00:00.000Z",
    repositories,
    peers,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function summaryMachineNames(document: Document): Array<string | null> {
  return Array.from(
    document.querySelectorAll("#fleet-summary tbody tr"),
    (row) => row.querySelector("th")?.textContent ?? null,
  );
}

function summaryRow(
  document: Document,
  name: string,
): HTMLTableRowElement | undefined {
  return Array.from(document.querySelectorAll("#fleet-summary tbody tr")).find(
    (row) => row.querySelector("th")?.textContent === name,
  ) as HTMLTableRowElement | undefined;
}

function summaryCells(document: Document, name: string): Array<string | null> {
  return Array.from(
    summaryRow(document, name)?.children ?? [],
    (cell) => cell.textContent,
  );
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

  test("renders worklog entry heading with time as YYYY-MM-DD HH:MM UTC", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-16",
              time: "14:30",
              text: "- 2026-08-16 14:30 UTC - Timed entry",
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [repository],
      },
      document,
      NOW,
    );

    const worklogPanel = document.querySelector(".worklog-panel")!;
    const heading = worklogPanel.querySelector("h5")!;
    expect(heading.textContent).toBe("2026-08-16 14:30 UTC");
  });

  test("renders worklog legacy entry heading as YYYY-MM-DD without time", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      worklog: {
        status: "available",
        data: {
          entries: [
            { date: "2026-08-16", text: "- 2026-08-16 UTC - Legacy entry" },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [repository],
      },
      document,
      NOW,
    );

    const worklogPanel = document.querySelector(".worklog-panel")!;
    const heading = worklogPanel.querySelector("h5")!;
    expect(heading.textContent).toBe("2026-08-16");
  });

  test("renders mixed legacy and timed worklog entries with correct headings", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-14",
              time: "09:00",
              text: "- 2026-08-14 09:00 UTC - First timed",
            },
            { date: "2026-08-15", text: "- 2026-08-15 UTC - Second legacy" },
            {
              date: "2026-08-16",
              time: "23:45",
              text: "- 2026-08-16 23:45 UTC - Third timed",
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [repository],
      },
      document,
      NOW,
    );

    const headings = Array.from(
      document.querySelectorAll(".worklog-panel h5"),
      (h) => h.textContent,
    );
    expect(headings).toEqual([
      "2026-08-14 09:00 UTC",
      "2026-08-15",
      "2026-08-16 23:45 UTC",
    ]);
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

describe("fleet summary and machine tabs", () => {
  test("renders routing once per machine from the first repository where it is available", () => {
    const document = dashboardDocument();
    const unavailableRouting = {
      status: "unavailable",
      warnings: [
        { code: "ROUTING_MISSING", message: "routing.json is missing" },
      ],
    };
    const selected = richRepository({
      name: "second",
      routing: {
        status: "available",
        data: {
          schemaVersion: 1,
          recordedAt: "2026-08-16T11:59:00Z",
          model: "openai/default",
          smallModel: "opencode/small",
          agents: {
            build: { provider: "openai", model: "gpt", steps: 20 },
            plan: { provider: "opencode", model: "mini", steps: null },
            review: {
              provider: "amazon-bedrock",
              model: "claude",
              steps: 5,
            },
            custom: { provider: "local", model: "model", steps: null },
          },
        },
        warnings: [],
      },
    });
    const ignored = richRepository({
      name: "third",
      routing: {
        ...selected.routing,
        data: {
          ...selected.routing.data,
          model: "other/ignored",
          agents: {},
        },
      },
    });

    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({ name: "first", routing: unavailableRouting }),
          selected,
          ignored,
        ],
      ),
      document,
      NOW,
    );

    const strip = document.querySelector(".routing-strip")!;
    expect(document.querySelectorAll(".routing-strip")).toHaveLength(1);
    expect(strip.textContent).toContain("Default openai/default");
    expect(strip.textContent).not.toContain("ignored");
    expect(strip.querySelector(".provider-openai")?.textContent).toBe("openai");
    expect(strip.querySelector(".provider-opencode")?.textContent).toBe(
      "opencode",
    );
    expect(strip.querySelector(".provider-amazon-bedrock")?.textContent).toBe(
      "amazon-bedrock",
    );
    expect(strip.querySelector(".provider-other")?.textContent).toBe("local");
    expect(strip.textContent).toContain("steps ≤ 20");
  });

  test("renders routing unavailable when no repository has routing", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            routing: { status: "unavailable", warnings: [] },
          }),
        ],
      ),
      document,
      NOW,
    );
    expect(document.querySelector(".routing-strip")?.textContent).toBe(
      "RoutingUnavailable",
    );
  });

  test("keeps hostile routing names, providers, and models literal and inert", () => {
    const document = dashboardDocument();
    const hostile =
      '<img src=x onerror="globalThis.pwned=1"><script>pwned=2</script>';
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            routing: {
              status: "available",
              data: {
                schemaVersion: 1,
                recordedAt: "2026-08-16T11:59:00Z",
                model: `other/${hostile}`,
                smallModel: `other/${hostile}`,
                agents: {
                  [hostile]: { provider: hostile, model: hostile, steps: null },
                },
              },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(document.querySelector(".routing-strip")?.textContent).toContain(
      hostile,
    );
    expect(
      document.querySelectorAll(
        ".routing-strip script, .routing-strip img, [onerror]",
      ),
    ).toHaveLength(0);
    expect(document.querySelector(".routing-provider")?.classList).toContain(
      "provider-other",
    );
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("renders one local-first summary row and tab per configured machine with matching badges", () => {
    const document = dashboardDocument();
    const localEmpty = richRepository({
      name: "empty-local",
      state: {
        status: "available",
        data: { currentTask: null, pr: null, hold: false },
        warnings: [],
      },
      questions: { status: "available", data: { open: [] }, warnings: [] },
      liveness: { state: "STOPPED", checkedAt: "2026-08-16T11:59:00.000Z" },
    });

    renderFleet(
      fleet(
        "mini",
        [
          { name: "macbook", origin: "https://macbook.example" },
          { name: "legion", origin: "https://legion.example" },
        ],
        [richRepository(), localEmpty],
      ),
      document,
      NOW,
    );

    expect(summaryMachineNames(document)).toEqual([
      "mini",
      "macbook",
      "legion",
    ]);
    expect(
      Array.from(
        document.querySelectorAll('[role="tab"]'),
        (tab) => tab.textContent,
      ),
    ).toEqual([
      "miniHELDQuestions 1",
      "macbookQuestions Unavailable",
      "legionQuestions Unavailable",
    ]);
    expect(summaryCells(document, "mini")).toEqual([
      "mini",
      "RUNNING",
      "T8",
      "PR #42",
      "HELD",
      "1",
      "0s ago",
    ]);
    expect(summaryCells(document, "macbook")).toEqual([
      "macbook",
      "Unavailable",
      "Unavailable",
      "Unavailable",
      "",
      "Unavailable",
      "Unavailable",
    ]);
    expect(document.querySelectorAll("#fleet-summary tbody tr")).toHaveLength(
      3,
    );
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(3);
    expect(
      document.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      new URLSearchParams(document.defaultView?.location.hash.slice(1)).get(
        "machine",
      ),
    ).toBe("mini");
  });

  test("uses None only for explicit empty values and Unknown for unavailable state", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            state: {
              status: "available",
              data: { currentTask: null, pr: null, hold: false },
              warnings: [],
            },
            questions: {
              status: "available",
              data: { open: [] },
              warnings: [],
            },
            liveness: {
              state: "CANNOT_VERIFY",
              checkedAt: "2026-08-16T11:59:00.000Z",
            },
          }),
        ],
      ),
      document,
      NOW,
    );
    expect(summaryCells(document, "mini")).toEqual([
      "mini",
      "CANNOT_VERIFY",
      "None",
      "None",
      "",
      "0",
      "0s ago",
    ]);

    renderFleet(
      fleet(
        "mini",
        [],
        [richRepository({ state: { status: "unavailable", warnings: [] } })],
      ),
      document,
      NOW,
    );
    expect(summaryCells(document, "mini").slice(2, 6)).toEqual([
      "Unknown",
      "Unknown",
      "",
      "1",
    ]);
  });

  test("summarizes an all-stopped machine with stopped liveness styling", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            liveness: {
              state: "STOPPED",
              checkedAt: "2026-08-16T11:59:00.000Z",
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(summaryCells(document, "mini")[1]).toBe("STOPPED");
    expect(
      summaryRow(document, "mini")?.querySelector(".liveness.stopped"),
    ).not.toBeNull();
  });

  test("joins multiple repository tasks and pull requests in repository order", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            name: "api",
            state: {
              status: "available",
              data: { currentTask: "T7", pr: 17, hold: false },
              warnings: [],
            },
          }),
          richRepository({
            name: "web",
            state: {
              status: "available",
              data: { currentTask: "T9", pr: 23, hold: false },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(summaryCells(document, "mini").slice(2, 4)).toEqual([
      "api: T7, web: T9",
      "api: PR #17, web: PR #23",
    ]);
  });

  test("switches tabs through click and hash changes, defaulting and falling back to local", () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    window.location.hash = "#machine=legion";
    renderFleet(
      fleet("mini", [
        { name: "macbook", origin: "https://macbook.example" },
        { name: "legion", origin: "https://legion.example" },
      ]),
      document,
      NOW,
    );
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    );

    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(panels.map((panel) => panel.hidden)).toEqual([true, true, false]);
    tabs[1]?.click();
    expect(window.location.hash).toBe("#machine=macbook");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);

    window.location.hash = "#machine=unknown";
    window.dispatchEvent(new window.Event("hashchange"));
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(
      new URLSearchParams(window.location.hash.slice(1)).get("machine"),
    ).toBe("mini");
  });

  test("supports roving keyboard tab selection with ARIA relationships", () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    renderFleet(
      fleet("mini", [
        { name: "macbook", origin: "https://macbook.example" },
        { name: "legion", origin: "https://legion.example" },
      ]),
      document,
      NOW,
    );
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    );
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs).toHaveLength(3);
    expect(panels).toHaveLength(3);
    tabs.forEach((tab, index) => {
      expect(tab.getAttribute("aria-controls")).toBe(panels[index]!.id);
      expect(panels[index]!.getAttribute("aria-labelledby")).toBe(tab.id);
    });

    tabs[0]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(tabs[1]!);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    tabs[1]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    tabs[1]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    tabs[2]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(panels.map((panel) => panel.hidden)).toEqual([true, true, false]);
  });

  test("keeps hostile machine, repository, and hash strings literal and inert", () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    const hostile =
      '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script>';
    window.location.hash = `#${new URLSearchParams({ machine: hostile })}`;
    renderFleet(
      fleet(
        hostile,
        [{ name: hostile, origin: "https://peer.example" }],
        [richRepository({ name: hostile })],
      ),
      document,
      NOW,
    );

    expect(summaryMachineNames(document)).toEqual([hostile, hostile]);
    expect(
      Array.from(
        document.querySelectorAll('[role="tab"]'),
        (tab) => tab.textContent,
      ),
    ).toEqual([`${hostile}HELDQuestions 1`, `${hostile}Questions Unavailable`]);
    expect(
      document.querySelectorAll("script, img, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe("browser peer fan-out", () => {
  test("uses fixed timeout and concurrency bounds", () => {
    expect(PEER_FETCH_TIMEOUT_MS).toBe(5_000);
    expect(MAX_CONCURRENT_PEER_FETCHES).toBe(4);
  });

  test("renders peer slots immediately and isolates direct peer failures", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "macbook", origin: "http://100.64.0.2:7777" },
      { name: "legion", origin: "https://legion.example:7777" },
    ];
    const pending: Array<{
      resolve: (response: Response) => void;
      reject: (cause: Error) => void;
    }> = [];
    const peerRequests: Array<{ url: string; signal?: AbortSignal | null }> =
      [];
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "/api/fleet") {
          return Promise.resolve(jsonResponse(fleet("mini", peers)));
        }
        peerRequests.push({ url, signal: init?.signal });
        return new Promise((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
      },
    );

    const loading = loadFleet(document, fetcher, { now: () => NOW });
    await flushPromises();

    expect(document.querySelector("#machine")?.textContent).toBe("mini");
    expect(summaryMachineNames(document)).toEqual([
      "mini",
      "macbook",
      "legion",
    ]);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(
      document.querySelectorAll(".peer-repositories > .unavailable"),
    ).toHaveLength(2);
    expect(peerRequests.map(({ url }) => url)).toEqual([
      "http://100.64.0.2:7777/api/fleet",
      "https://legion.example:7777/api/fleet",
    ]);
    expect(
      peerRequests.every(({ signal }) => signal instanceof AbortSignal),
    ).toBe(true);

    pending[0]!.resolve(
      jsonResponse(
        fleet(
          "remote-macbook",
          [{ name: "ignored", origin: "https://ignored.example" }],
          [richRepository({ name: "peer-project" })],
        ),
      ),
    );
    pending[1]!.reject(new TypeError("CORS failure"));
    await loading;

    const slots = document.querySelectorAll(".peer-machine");
    expect(slots.item(0).textContent).toContain("peer-project");
    expect(slots.item(0).textContent).not.toContain("ignored");
    expect(slots.item(1).textContent).toContain("UNREACHABLE");
    expect(summaryRow(document, "macbook")?.textContent).toContain("RUNNING");
    expect(summaryCells(document, "macbook")).toEqual([
      "macbook",
      "RUNNING",
      "T8",
      "PR #42",
      "HELD",
      "1",
      "0s ago",
    ]);
    expect(summaryRow(document, "legion")?.textContent).toContain(
      "Unavailable",
    );
    expect(document.querySelector("#error")?.textContent).toBe("");
  });

  test("marks malformed and non-success peer responses unreachable", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "bad-json", origin: "http://100.64.0.3:7777" },
      { name: "bad-schema", origin: "http://100.64.0.4:7777" },
      { name: "http-error", origin: "http://100.64.0.5:7777" },
    ];
    let request = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(jsonResponse(fleet("mini", peers)));
      }
      request += 1;
      if (request === 1) return Promise.resolve(new Response("{"));
      if (request === 2) {
        return Promise.resolve(
          jsonResponse({ ...fleet("peer"), schemaVersion: 2 }),
        );
      }
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    });

    await loadFleet(document, fetcher);

    expect(
      document.querySelectorAll(".peer-machine .unreachable"),
    ).toHaveLength(3);
    expect(document.querySelectorAll("#fleet-summary tbody tr")).toHaveLength(
      4,
    );
  });

  test("rejects invalid peer routing", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "missing-routing-field", origin: "http://100.64.0.6:7777" },
      {
        name: "too-many-routing-agents",
        origin: "http://100.64.0.7:7777",
      },
    ];
    let request = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(jsonResponse(fleet("mini", peers)));
      }
      request += 1;
      const repository = richRepository({
        routing:
          request === 1
            ? {
                status: "available",
                data: { schemaVersion: 1, agents: {} },
                warnings: [],
              }
            : {
                status: "available",
                data: {
                  schemaVersion: 1,
                  recordedAt: "2026-08-16T11:59:00.000Z",
                  model: "openai/gpt-5.6",
                  smallModel: "opencode/gpt-5-mini",
                  agents: Object.fromEntries(
                    Array.from({ length: 65 }, (_, index) => [
                      `agent-${index}`,
                      { provider: "openai", model: "gpt", steps: null },
                    ]),
                  ),
                },
                warnings: [],
              },
      });
      return Promise.resolve(jsonResponse(fleet("peer", [], [repository])));
    });

    await loadFleet(document, fetcher);

    expect(
      document.querySelectorAll(".peer-machine .unreachable"),
    ).toHaveLength(2);
  });

  test("never starts more than four peer requests concurrently", async () => {
    const document = dashboardDocument();
    const peers = Array.from({ length: 6 }, (_, index) => ({
      name: `peer-${index}`,
      origin: `http://100.64.0.${index + 10}:7777`,
    }));
    let active = 0;
    let maximum = 0;
    const pending: Array<(response: Response) => void> = [];
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(jsonResponse(fleet("mini", peers)));
      }
      active += 1;
      maximum = Math.max(maximum, active);
      return new Promise((resolve) => {
        pending.push((response) => {
          active -= 1;
          resolve(response);
        });
      });
    });

    const loading = loadFleet(document, fetcher);
    await flushPromises();
    expect(pending).toHaveLength(4);
    pending
      .splice(0)
      .forEach((resolve) => resolve(jsonResponse(fleet("peer"))));
    await flushPromises();
    expect(pending).toHaveLength(2);
    pending
      .splice(0)
      .forEach((resolve) => resolve(jsonResponse(fleet("peer"))));
    await loading;

    expect(maximum).toBe(4);
    expect(document.querySelectorAll("#fleet-summary tbody tr")).toHaveLength(
      7,
    );
    expect(
      Array.from(document.querySelectorAll("#fleet-summary tbody tr"))
        .slice(1)
        .every((row) => row.textContent?.includes("CANNOT_VERIFY")),
    ).toBe(true);
  });

  test("aborts and replaces a timed-out peer in place", async () => {
    const document = dashboardDocument();
    const peer = { name: "slow", origin: "http://100.64.0.30:7777" };
    let timeoutCallback: (() => void) | undefined;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) === "/api/fleet") {
          return Promise.resolve(jsonResponse(fleet("mini", [peer])));
        }
        signal = init?.signal;
        return new Promise(() => undefined);
      },
    );
    const loading = loadFleet(document, fetcher, {
      setTimeout: ((callback: () => void, milliseconds: number) => {
        expect(milliseconds).toBe(PEER_FETCH_TIMEOUT_MS);
        timeoutCallback = callback;
        return 1;
      }) as typeof setTimeout,
      clearTimeout: vi.fn() as unknown as typeof clearTimeout,
      now: () => NOW,
    });
    await flushPromises();

    timeoutCallback?.();
    await loading;

    expect(signal?.aborted).toBe(true);
    expect(
      document.querySelector(".peer-machine .unreachable")?.textContent,
    ).toBe("UNREACHABLE");
  });

  test("refresh discards stale peer data and can recover", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "http://100.64.0.40:7777" };
    let localRequests = 0;
    let peerRequests = 0;
    let resolveOldPeer: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        localRequests += 1;
        return Promise.resolve(
          jsonResponse(fleet(`mini-${localRequests}`, [peer])),
        );
      }
      peerRequests += 1;
      if (peerRequests === 1) {
        return new Promise((resolve) => {
          resolveOldPeer = resolve;
        });
      }
      if (peerRequests === 2) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        jsonResponse(
          fleet("macbook", [], [richRepository({ name: "recovered" })]),
        ),
      );
    });

    const first = loadFleet(document, fetcher);
    await flushPromises();
    expect(
      document.querySelector(".peer-machine .unavailable")?.textContent,
    ).toBe("Unavailable");

    await loadFleet(document, fetcher);
    expect(
      document.querySelector(".peer-machine .unreachable")?.textContent,
    ).toBe("UNREACHABLE");
    resolveOldPeer?.(
      jsonResponse(fleet("old", [], [richRepository({ name: "stale" })])),
    );
    await first;
    expect(document.body.textContent).not.toContain("stale");

    await loadFleet(document, fetcher);
    expect(
      document.querySelector(".peer-machine .repository")?.textContent,
    ).toContain("recovered");
    expect(document.body.textContent).toContain("recovered");
    expect(document.body.textContent).not.toContain("UNREACHABLE");
  });
});
