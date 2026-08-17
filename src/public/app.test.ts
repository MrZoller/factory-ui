import { describe, expect, test, vi } from "bun:test";
import { Window } from "happy-dom";

import {
  loadFleet,
  MAX_CONCURRENT_PEER_FETCHES,
  PEER_FETCH_TIMEOUT_MS,
  renderFleet,
  UNKNOWN_WARNING_EXPLANATION,
  WARNING_EXPLANATIONS,
} from "./app.js";
import { COSTS_WARNING_CODES } from "../readers/costs";
import { LOGS_WARNING_CODES } from "../readers/logs";
import { PLAN_WARNING_CODES } from "../readers/plan";
import { QUESTIONS_WARNING_CODES } from "../readers/questions";
import { ROUTING_WARNING_CODES } from "../readers/routing";
import { STATE_WARNING_CODES } from "../readers/state";
import { WORKLOG_WARNING_CODES } from "../readers/worklog";

const NOW = new Date("2026-08-16T12:00:00.000Z");

function dashboardDocument(): Document {
  const window = new Window({ url: "https://dashboard.test/" });
  const document = window.document as unknown as Document;
  document.body.innerHTML = [
    '<h1 id="machine"></h1>',
    '<p id="generated"></p>',
    '<p id="error"></p>',
    '<button id="refresh" type="button">Refresh</button>',
    '<table id="fleet-summary"><tbody></tbody></table>',
    '<div id="machine-tabs" role="tablist"></div>',
    '<div id="repositories"></div>',
  ].join("");
  return document;
}

type TimerCallback = () => void;
type BrowserFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function fakeTimers() {
  const timers = new Map<
    number,
    { callback: TimerCallback; milliseconds: number }
  >();
  let nextId = 1;
  const schedule = (callback: TimerCallback, milliseconds = 0) => {
    const id = nextId++;
    timers.set(id, { callback, milliseconds });
    return id;
  };
  return {
    setTimeout: schedule,
    setInterval: schedule,
    clearTimeout: (id: number) => timers.delete(id),
    clearInterval: (id: number) => timers.delete(id),
    callbacksAt(milliseconds: number) {
      return Array.from(timers.entries())
        .filter(([, timer]) => timer.milliseconds === milliseconds)
        .map(([id, timer]) => ({ id, callback: timer.callback }));
    },
  };
}

function strictGlobalTimers() {
  const timers = fakeTimers();
  const requireGlobalReceiver = (receiver: unknown) => {
    if (receiver !== undefined && receiver !== globalThis) {
      throw new TypeError("Illegal invocation: timer receiver must be global");
    }
  };
  return {
    ...timers,
    setTimeout(this: unknown, callback: TimerCallback, milliseconds = 0) {
      requireGlobalReceiver(this);
      return timers.setTimeout(callback, milliseconds);
    },
    setInterval(this: unknown, callback: TimerCallback, milliseconds = 0) {
      requireGlobalReceiver(this);
      return timers.setInterval(callback, milliseconds);
    },
    clearTimeout(this: unknown, id: number) {
      requireGlobalReceiver(this);
      return timers.clearTimeout(id);
    },
    clearInterval(this: unknown, id: number) {
      requireGlobalReceiver(this);
      return timers.clearInterval(id);
    },
  };
}

async function bootDashboard(
  document: Document,
  fetcher: BrowserFetcher,
  timers: ReturnType<typeof fakeTimers>,
) {
  const globals = globalThis as Record<string, unknown>;
  const original = {
    window: globals.window,
    document: globals.document,
    fetch: globals.fetch,
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
  };
  globals.window = document.defaultView;
  globals.document = document;
  globals.fetch = fetcher;
  globals.setTimeout = timers.setTimeout;
  globals.clearTimeout = timers.clearTimeout;
  globals.setInterval = timers.setInterval;
  globals.clearInterval = timers.clearInterval;
  try {
    await import(`./app.js?auto-refresh-test=${crypto.randomUUID()}`);
    await flushPromises();
    return () => Object.assign(globals, original);
  } catch (error) {
    Object.assign(globals, original);
    throw error;
  }
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

function costs(tasks: Record<string, Record<string, unknown>>) {
  return {
    status: "available",
    data: {
      schemaVersion: 1,
      recordedAt: "2026-08-16T11:59:00.000Z",
      currency: "USD",
      tasks,
    },
    warnings: [],
  };
}

function costCounters(usd: unknown, tokenCount = 0) {
  return {
    usd,
    messages: 1,
    sessions: 1,
    tokens: {
      input: tokenCount,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

function tokenCounters(usd: number, tokens: Partial<Record<string, number>>) {
  return {
    ...costCounters(usd),
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      ...tokens,
    },
  };
}

function routingModel(overrides: Record<string, unknown> = {}) {
  return {
    source: "models.dev",
    pricesAsOf: "2026-08-16",
    name: "GPT 5.6",
    family: "gpt",
    releaseDate: "2026-08-01",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricePerMillion: {
      input: 1,
      output: 4,
      cacheRead: 0.5,
      cacheWrite: 2,
    },
    ...overrides,
  };
}

function validCostTask(usd = 1.23, tokenCount = 123) {
  return {
    ...costCounters(usd, tokenCount),
    byModel: { "openai/gpt-5.6": costCounters(usd, tokenCount) },
    firstAt: "2026-08-16T11:00:00.000Z",
    lastAt: "2026-08-16T11:59:00.000Z",
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

describe("driver liveness freshness", () => {
  function activityPanel(document: Document): HTMLElement {
    return Array.from(document.querySelectorAll<HTMLElement>(".panel")).find(
      (panel) => panel.querySelector("h4")?.textContent === "Driver activity",
    )!;
  }

  test("hides a fresh liveness check while retaining source age", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            liveness: {
              state: "RUNNING",
              checkedAt: "2026-08-16T12:00:01.000Z",
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const panel = activityPanel(document);
    expect(panel.textContent).not.toContain("Liveness checked");
    expect(panel.querySelector("p.age")).toBeNull();
    expect(panel.textContent).toContain("Source age1m ago");
  });

  test("shows an old liveness check in the stale style", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            liveness: {
              state: "RUNNING",
              checkedAt: "2026-08-16T11:59:29.000Z",
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const stale = activityPanel(document).querySelector(".age.stale");
    expect(stale?.textContent).toBe("Liveness checked 31s ago — may be stale");
  });

  test("warns when a shown liveness state has no check time", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [richRepository({ liveness: { state: "CANNOT_VERIFY" } })],
      ),
      document,
      NOW,
    );

    const stale = activityPanel(document).querySelector(".age.stale");
    expect(stale?.textContent).toBe("Liveness checked Unknown — may be stale");
  });
});

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
    expect(document.querySelector("#generated")?.textContent).toMatch(
      /^Updated /,
    );
    expect(document.querySelector("#generated")?.textContent).not.toContain(
      "ago",
    );
    const card = document.querySelector(".repository")!;
    const panelSpans = Object.fromEntries(
      Array.from(card.querySelectorAll(".panel"), (panel) => [
        panel.querySelector("h4")?.textContent,
        Array.from(panel.classList).find((name) =>
          name.startsWith("panel-span-"),
        ),
      ]),
    );
    expect(panelSpans).toEqual({
      Current: "panel-span-8",
      Active: "panel-span-4",
      "In review": "panel-span-4",
      "Next runnable": "panel-span-4",
      Blocked: "panel-span-4",
      Completed: "panel-span-6",
      "Open questions": "panel-span-6",
      "Recent worklog": "panel-span-4",
      "Driver activity": "panel-span-4",
      "Warnings · 1 · from this snapshot": "panel-span-4",
    });
    const task = card.querySelector(".task")!;
    expect(
      ["task-id", "task-title", "task-size"].every((name) =>
        task.querySelector(`.${name}`),
      ),
    ).toBe(true);
    expect(task.querySelector(".task-deps")?.textContent).toContain("deps:");
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

  test("renders metered and subscription task costs, while omitting tasks without an entry", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      costs: costs({
        T8: costCounters(1.23, 123),
        T7: costCounters(0, 456),
        unattributed: costCounters(0, 789),
      }),
    });
    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const active = document.querySelector(".active-work .task")!;
    expect(active.querySelector(".task-cost")?.textContent).toBe(
      "$1.23 metered",
    );
    expect(active.querySelector<HTMLElement>(".task-cost")?.title).toBe(
      "123 tokens",
    );
    expect(active.querySelector(".task-cost-detail")?.textContent).toBe(
      "123 tokens",
    );
    const review = document.querySelector(".review-work .task")!;
    expect(review.querySelector(".task-cost")?.textContent).toBe("sub");
    expect(review.querySelector<HTMLElement>(".task-cost")?.title).toBe(
      "456 tokens",
    );
    expect(document.querySelector(".runnable-work .task-cost")).toBeNull();

    const row = document.querySelector(".repository-summary tbody tr")!;
    expect(row.querySelector(".cost-total")?.textContent).toBe("$1.23");
    expect(row.querySelector(".cost-unattributed")?.textContent).toBe("sub");
    expect(row.querySelector<HTMLElement>(".cost-unattributed")?.title).toBe(
      "789 tokens",
    );
    expect(
      summaryRow(document, "mini")?.querySelector(".cost-total")?.textContent,
    ).toBe("$1.23");
  });

  test("prices only subscription by-model usage and keeps list notional separate from metered spend", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: {
            "openai/gpt-5.6": routingModel(),
            "openai/partial": routingModel({
              name: "Partial",
              pricePerMillion: {
                input: 2,
                output: null,
                cacheRead: null,
                cacheWrite: null,
              },
            }),
          },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(7.5, { input: 3_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, {
              input: 2_000_000,
              output: 500_000,
              cacheRead: 1_000_000,
              cacheWrite: 250_000,
            }),
            "openai/partial": tokenCounters(0, {
              input: 500_000,
              output: 1_000_000,
            }),
            "openai/metered": tokenCounters(99, { input: 9_000_000 }),
            "openai/empty": tokenCounters(0, {}),
          },
          firstAt: "2026-08-16T11:00:00.000Z",
          lastAt: "2026-08-16T11:59:00.000Z",
        },
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const task = document.querySelector(".active-work .task")!;
    expect(task.querySelector(".task-cost")?.textContent).toBe("$7.50 metered");
    const taskNotional = task.querySelector<HTMLElement>(".task-notional")!;
    expect(taskNotional.textContent).toBe("~$6.00 at list (partial)");
    expect(taskNotional.title).toBe(
      "notional: subscription lane priced at models.dev list price as of 2026-08-16; not billed",
    );
    const repositoryTotal = document.querySelector(
      ".repository-summary .cost-total",
    )!;
    expect(repositoryTotal.childNodes[0]?.textContent).toBe("$7.50 metered");
    expect(repositoryTotal.querySelector(".notional-total")?.textContent).toBe(
      "~$6.00 at list (partial)",
    );
    const machineTotal = summaryRow(document, "mini")!.querySelector(
      ".cost-total",
    )!;
    expect(machineTotal.childNodes[0]?.textContent).toBe("$7.50 metered");
    expect(machineTotal.querySelector(".notional-total")?.textContent).toBe(
      "~$6.00 at list (partial)",
    );
    expect(document.body.textContent).not.toContain("$106.50");
  });

  test("omits notional labels when eligible usage is absent or entirely unpriced", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: {
            "openai/unpriced": routingModel({
              source: null,
              pricePerMillion: {
                input: null,
                output: null,
                cacheRead: null,
                cacheWrite: null,
              },
            }),
          },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(0, { input: 10 }),
          byModel: {
            "openai/unpriced": tokenCounters(0, { input: 10 }),
            "openai/metered": tokenCounters(2, { input: 10 }),
          },
          firstAt: "2026-08-16T11:00:00.000Z",
          lastAt: "2026-08-16T11:59:00.000Z",
        },
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(document.querySelector(".task-notional")).toBeNull();
    expect(document.querySelector(".notional-total")).toBeNull();
    expect(document.querySelector(".task-cost")?.textContent).toBe("sub");
  });

  test("flags a list estimate partial when any price component is unavailable", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: {
            "openai/input-only": routingModel({
              pricePerMillion: {
                input: 2,
                output: null,
                cacheRead: null,
                cacheWrite: null,
              },
            }),
          },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(0, { input: 1_500_000 }),
          byModel: {
            "openai/input-only": tokenCounters(0, { input: 1_500_000 }),
          },
          firstAt: "2026-08-16T11:00:00.000Z",
          lastAt: "2026-08-16T11:59:00.000Z",
        },
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(document.querySelector(".task-cost")?.textContent).toBe("sub");
    expect(document.querySelector(".task-notional")?.textContent).toBe(
      "~$3.00 at list (partial)",
    );
    expect(document.querySelector(".notional-total")?.textContent).toBe(
      "~$3.00 at list (partial)",
    );
  });

  test("never reprices metered model usage at list", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: { "openai/gpt-5.6": routingModel() },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(4.5, { input: 3_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(4.5, { input: 3_000_000 }),
          },
          firstAt: "2026-08-16T11:00:00.000Z",
          lastAt: "2026-08-16T11:59:00.000Z",
        },
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(document.querySelector(".task-cost")?.textContent).toBe(
      "$4.50 metered",
    );
    expect(document.querySelector(".task-notional")).toBeNull();
    expect(document.querySelector(".notional-total")).toBeNull();
  });

  test("omits non-finite notional arithmetic instead of rendering Infinity", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: {
            "openai/gpt-5.6": routingModel({
              pricePerMillion: {
                input: Number.MAX_VALUE,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            }),
          },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(0, { input: Number.MAX_VALUE }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, {
              input: Number.MAX_VALUE,
            }),
          },
          firstAt: "2026-08-16T11:00:00.000Z",
          lastAt: "2026-08-16T11:59:00.000Z",
        },
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(document.querySelector(".task-notional")).toBeNull();
    expect(document.querySelector(".notional-total")).toBeNull();
    expect(document.body.textContent).not.toContain("Infinity");
  });

  test("renders unavailable costs in repository and fleet summaries", () => {
    const document = dashboardDocument();
    renderFleet(fleet("mini", [], [richRepository()]), document, NOW);

    expect(
      document.querySelector(".repository-summary .cost-total")?.textContent,
    ).toBe("Unavailable");
    expect(
      document.querySelector(".repository-summary .cost-unattributed")
        ?.textContent,
    ).toBe("Unavailable");
    expect(
      summaryRow(document, "mini")?.querySelector(".cost-total")?.textContent,
    ).toBe("Unavailable");
  });

  test("does not present a partial machine cost as a total", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({ costs: costs({ T8: costCounters(1.23, 123) }) }),
          richRepository({
            costs: {
              status: "unavailable",
              warnings: [
                { code: "COSTS_MISSING", message: "costs unavailable" },
              ],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(
      summaryRow(document, "mini")?.querySelector(".cost-total")?.textContent,
    ).toBe("Unavailable");
    expect(
      Array.from(
        document.querySelectorAll(".warnings-panel .warning-code"),
      ).some((code) => code.textContent === "COSTS_MISSING"),
    ).toBe(true);
  });

  test("does not render overflowing aggregate USD totals as Infinity", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      costs: costs({
        T1: validCostTask(Number.MAX_VALUE),
        T2: validCostTask(Number.MAX_VALUE),
      }),
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(
      document.querySelector(".repository-summary .cost-total")?.textContent,
    ).toBe("Unavailable");
    expect(
      summaryRow(document, "mini")?.querySelector(".cost-total")?.textContent,
    ).toBe("Unavailable");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  test("rejects non-USD fleet costs instead of formatting them as dollars", async () => {
    const document = dashboardDocument();
    const nonUsd = costs({ T8: validCostTask() });
    nonUsd.data.currency = "EUR";

    expect(
      await loadFleet(document, async () =>
        jsonResponse(fleet("mini", [], [richRepository({ costs: nonUsd })])),
      ),
    ).toBe(false);
    expect(document.querySelector("#error")?.textContent).toBe(
      "Invalid fleet response",
    );
    expect(document.body.textContent).not.toContain("$1.23");
  });

  test("validates optional routing model metadata in fleet responses", async () => {
    const validDocument = dashboardDocument();
    const validRepository = richRepository();
    (
      validRepository.routing.data as typeof validRepository.routing.data & {
        models: Record<string, unknown>;
      }
    ).models = {
      "openai/gpt-5.6": routingModel(),
    };
    expect(
      await loadFleet(validDocument, async () =>
        jsonResponse(fleet("mini", [], [validRepository])),
      ),
    ).toBe(true);

    const invalidDocument = dashboardDocument();
    const invalidRepository = richRepository();
    (
      invalidRepository.routing
        .data as typeof invalidRepository.routing.data & {
        models: Record<string, unknown>;
      }
    ).models = {
      "openai/gpt-5.6": routingModel({
        pricePerMillion: {
          input: -1,
          output: 2,
          cacheRead: null,
          cacheWrite: null,
        },
      }),
    };
    expect(
      await loadFleet(invalidDocument, async () =>
        jsonResponse(fleet("peer", [], [invalidRepository])),
      ),
    ).toBe(false);
    expect(invalidDocument.querySelector("#error")?.textContent).toBe(
      "Invalid fleet response",
    );
  });

  test("keeps hostile costs from a peer response inert", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.pwned=1">';
    const repository = richRepository({
      costs: costs({
        T8: costCounters(hostile, 1),
        [hostile]: costCounters(0, 1),
      }),
    });

    expect(() =>
      renderFleet(fleet("mini", [], [repository]), document, NOW),
    ).not.toThrow();
    expect(
      document.querySelectorAll("img, script, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("renders an already-old snapshot as stale immediately", () => {
    const document = dashboardDocument();

    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T11:59:29.000Z",
        repositories: [],
      },
      document,
      NOW,
    );

    expect(document.querySelector("#generated")?.textContent).toMatch(
      /^Stale · last good snapshot 31s ago/,
    );
    expect(document.querySelector("#generated")?.classList).toContain("stale");
    expect(document.querySelector("#generated")?.textContent).toContain(
      "— snapshot too old",
    );
  });

  test("allows long machine headings to wrap anywhere", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.machine-subtitle\s*\{[^}]*overflow-wrap: anywhere;/s,
    );
  });

  test("renders validated GitHub links", () => {
    const document = dashboardDocument();
    const task = {
      ...richRepository().plan.data.tasks[0],
      pr: 42,
      issueNumbers: [17, 23],
      prUrl: "https://github.com/example/factory-ui/pull/42",
      issueUrls: [
        "https://github.com/example/factory-ui/issues/17",
        "https://github.com/example/factory-ui/issues/23",
      ],
    };
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [
          richRepository({
            repositoryUrl: "https://github.com/example/factory-ui",
            branchUrl:
              "https://github.com/example/factory-ui/tree/factory/t8-safe-dashboard",
            plan: {
              ...richRepository().plan,
              data: {
                ...richRepository().plan.data,
                tasks: [task],
                active: [task],
              },
            },
          }),
        ],
      },
      document,
      NOW,
    );

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.map((link) => [link.textContent, link.href])).toEqual(
      expect.arrayContaining([
        ["factory-ui", "https://github.com/example/factory-ui"],
        [
          "factory/t8-safe-dashboard",
          "https://github.com/example/factory-ui/tree/factory/t8-safe-dashboard",
        ],
        ["PR #42", "https://github.com/example/factory-ui/pull/42"],
        ["Fixes #17", "https://github.com/example/factory-ui/issues/17"],
        ["Fixes #23", "https://github.com/example/factory-ui/issues/23"],
      ]),
    );
    links.forEach((link) => {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });
  });

  test("renders hostile links as plain text", () => {
    const document = dashboardDocument();
    const task = {
      ...richRepository().plan.data.tasks[0],
      pr: 42,
      issueNumbers: [17],
      prUrl: "https://github.com@example.invalid/factory-ui/pull/42",
      issueUrls: [
        "https://github.com/example/factory-ui/issues/17?redirect=evil",
      ],
    };
    renderFleet(
      {
        hostname: "mini",
        generatedAt: "2026-08-16T12:00:00.000Z",
        repositories: [
          richRepository({
            prUrl: undefined,
            repositoryUrl: "https://github.com/example/factory-ui#fragment",
            branchUrl:
              "https://github.com/example/factory-ui/tree/factory/t8-safe-dashboard?redirect=evil",
            plan: {
              ...richRepository().plan,
              data: {
                ...richRepository().plan.data,
                tasks: [task],
                active: [task],
              },
            },
          }),
        ],
      },
      document,
      NOW,
    );

    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "factory-ui",
    );
    expect(document.querySelector(".current-panel")?.textContent).toContain(
      "factory/t8-safe-dashboard",
    );
    expect(document.querySelector(".active-work")?.textContent).toContain(
      "PR #42",
    );
    expect(document.querySelector(".active-work")?.textContent).toContain(
      "Fixes #17",
    );
  });

  test("renders safe factory document links beneath the project and on every plan-backed heading", () => {
    const document = dashboardDocument();
    const base = "https://github.com/example/factory-ui/blob/HEAD/.factory";
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            repositoryUrl: undefined,
            branchUrl: undefined,
            prUrl: undefined,
            specUrl: `${base}/spec.md`,
            planUrl: `${base}/plan.md`,
            worklogUrl: `${base}/worklog.md`,
            questionsUrl: `${base}/questions.md`,
          }),
        ],
      ),
      document,
      NOW,
    );

    const current = document.querySelector(".current-panel")!;
    const documentLinks = current.querySelector(".factory-document-links")!;
    expect(documentLinks.textContent).toBe("spec · plan · worklog · questions");
    expect(
      Array.from(
        documentLinks.querySelectorAll<HTMLAnchorElement>("a"),
        (link) => [link.textContent, link.href],
      ),
    ).toEqual([
      ["spec", `${base}/spec.md`],
      ["plan", `${base}/plan.md`],
      ["worklog", `${base}/worklog.md`],
      ["questions", `${base}/questions.md`],
    ]);
    expect(documentLinks.classList).toContain("muted");

    const planHeadings = [
      "Active",
      "In review",
      "Next runnable",
      "Blocked",
      "Completed",
    ];
    for (const title of planHeadings) {
      const heading = Array.from(document.querySelectorAll(".panel h4")).find(
        (element) => element.textContent === title,
      )!;
      expect(heading.querySelector("a")?.href).toBe(`${base}/plan.md`);
    }
    expect(
      document.querySelector<HTMLAnchorElement>(".worklog-panel h4 a")?.href,
    ).toBe(`${base}/worklog.md`);
    expect(
      document.querySelector<HTMLAnchorElement>(".questions-panel h4 a")?.href,
    ).toBe(`${base}/questions.md`);
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });
  });

  test("does not anchor absent or hostile factory document URLs", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            repositoryUrl: undefined,
            branchUrl: undefined,
            prUrl: undefined,
            specUrl:
              "https://github.com/example/factory-ui/blob/HEAD/.factory/spec.md?redirect=evil",
            planUrl:
              "https://github.com@example.invalid/factory-ui/blob/HEAD/.factory/plan.md",
            worklogUrl: "javascript:alert(1)",
            questionsUrl: undefined,
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(document.querySelector(".factory-document-links a")).toBeNull();
    expect(document.querySelector(".factory-document-links")?.textContent).toBe(
      "spec · plan · worklog · questions",
    );
    expect(
      document.querySelectorAll(
        ".active-work h4 a, .review-work h4 a, .runnable-work h4 a, .blocked-work h4 a, .completed-work h4 a, .worklog-panel h4 a, .questions-panel h4 a",
      ),
    ).toHaveLength(0);
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

  test("renders the newest six worklog entries first, grouped by date, and expands the reader window", () => {
    const document = dashboardDocument();
    const entries = Array.from({ length: 7 }, (_, index) => ({
      date: index < 2 ? "2026-08-15" : "2026-08-16",
      time: `0${index}:00`,
      text: `- 2026-08-${index < 2 ? "15" : "16"} 0${index}:00 UTC - Entry ${index}. Remaining ${index}.`,
    }));
    const repository = richRepository({
      worklog: { status: "available", data: { entries }, warnings: [] },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panel = document.querySelector(".worklog-panel")!;
    expect(
      Array.from(
        panel.querySelectorAll(".worklog-entry"),
        (entry) => entry.querySelector(".worklog-summary")?.textContent,
      ),
    ).toEqual([
      "Entry 6.",
      "Entry 5.",
      "Entry 4.",
      "Entry 3.",
      "Entry 2.",
      "Entry 1.",
    ]);
    expect(
      Array.from(
        panel.querySelectorAll(".worklog-date"),
        (date) => date.textContent,
      ),
    ).toEqual(["2026-08-16", "2026-08-15"]);
    expect(
      Array.from(
        panel.querySelectorAll(".worklog-time"),
        (time) => time.textContent,
      ),
    ).toEqual(["06:00", "05:00", "04:00", "03:00", "02:00", "01:00"]);
    expect(
      Array.from(
        panel.querySelectorAll(".worklog-summary, .worklog-body"),
        (node) => node.textContent,
      ).join(" "),
    ).not.toContain("UTC - Entry");
    expect(panel.querySelector(".worklog-toggle")?.textContent).toBe(
      "Show all 7",
    );

    panel.querySelector<HTMLButtonElement>(".worklog-toggle")!.click();
    expect(panel.querySelectorAll(".worklog-entry")).toHaveLength(7);
    expect(panel.querySelector(".worklog-toggle")?.textContent).toBe(
      "Show newest 6",
    );
  });

  test("renders worklog event chips, sentence bodies, raw fallbacks, and safe inline highlights", () => {
    const document = dashboardDocument();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const events = [
      ["T27 implemented and opened as PR #12.", "opened PR"],
      ["T2 implemented and opened as held major PR #2.", "opened PR"],
      ["Merged the release.", "merged"],
      ["Waiting for review.", "review wait"],
      ["Parked review minors.", "parked minors"],
      ["Reclassified T27 as major.", "reclassified"],
      ["Escalated the decision.", "escalated"],
      ["Filed question Q1.", "question filed"],
      ["Documented the dashboard.", "other"],
    ];
    const entries = events.map(([sentence], index) => ({
      date: "2026-08-16",
      time: `0${index}:00`,
      text: `- 2026-08-16 0${index}:00 UTC - ${sentence} Follow-up has T27, PR #12, issue #34, ${sha}, and \`literal code\`.`,
    }));
    entries.push({
      date: "2026-08-15",
      time: "09:00",
      text: "not a worklog stamp <em>at all</em>",
    });
    const repository = richRepository({
      repositoryUrl: "https://github.com/example/factory-ui",
      worklog: { status: "available", data: { entries }, warnings: [] },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panel = document.querySelector(".worklog-panel")!;
    panel.querySelector<HTMLButtonElement>(".worklog-toggle")!.click();
    const rendered = Array.from(panel.querySelectorAll(".worklog-entry"));
    expect(
      rendered
        .slice(1)
        .map(
          (entry) => entry.querySelector(".worklog-event-chip")?.textContent,
        ),
    ).toEqual(events.map(([, event]) => event).reverse());
    const opened = rendered[9]!;
    expect(opened.querySelector(".worklog-summary")?.textContent).toBe(
      "T27 implemented and opened as PR #12.",
    );
    expect(opened.querySelector(".worklog-body")?.textContent).toContain(
      "Follow-up has T27, PR #12, issue #34",
    );
    expect(opened.querySelector(".worklog-body")?.textContent).toContain(
      "0123456",
    );
    expect(opened.querySelector(".worklog-body")?.textContent).not.toContain(
      sha,
    );
    expect(
      Array.from(
        opened.querySelectorAll(".worklog-body code"),
        (code) => code.textContent,
      ),
    ).toContain("literal code");
    expect(opened.querySelector("details summary")?.textContent).toBe(
      "Raw entry",
    );
    expect(opened.querySelector("details")?.open).toBe(false);
    expect(opened.querySelector("details pre")?.textContent).toContain(sha);
    expect(opened.querySelector("details pre")?.textContent).toContain("UTC -");
    expect(
      Array.from(
        opened.querySelectorAll<HTMLAnchorElement>("a"),
        (link) => link.href,
      ),
    ).toEqual(
      expect.arrayContaining([
        "https://github.com/example/factory-ui/blob/HEAD/.factory/plan.md",
        "https://github.com/example/factory-ui/pull/12",
        "https://github.com/example/factory-ui/issues/34",
        `https://github.com/example/factory-ui/commit/${sha}`,
      ]),
    );
    opened.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });
    const malformed = rendered[0]!;
    expect(malformed.querySelector(".worklog-event-chip")?.textContent).toBe(
      "other",
    );
    expect(malformed.querySelector(".worklog-summary")?.textContent).toBe(
      "not a worklog stamp <em>at all</em>",
    );
    expect(malformed.querySelector(".worklog-body")).toBeNull();
  });

  test("keeps hostile worklog text inert and never invents remote links", () => {
    const document = dashboardDocument();
    const hostile =
      '<script>globalThis.pwned=1</script> <a href="javascript:pwned=2">bad</a> https://example.invalid/x';
    const repository = richRepository({
      repositoryUrl: undefined,
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-16",
              time: "12:00",
              text: `- 2026-08-16 12:00 UTC - ${hostile}. T27 PR #12 #34 0123456789abcdef0123456789abcdef01234567 \`<img onerror=pwned=3>\`.`,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panel = document.querySelector(".worklog-panel")!;
    expect(panel.textContent).toContain(hostile);
    expect(
      panel.querySelectorAll(
        "a, script, img, [href^='javascript:'], [onerror]",
      ),
    ).toHaveLength(0);
    const references = Array.from(
      panel.querySelectorAll<HTMLElement>(".worklog-reference"),
    );
    expect(references.map((reference) => reference.tagName)).toEqual([
      "CODE",
      "CODE",
      "CODE",
      "CODE",
    ]);
    expect(references.map((reference) => reference.textContent)).toEqual([
      "T27",
      "PR #12",
      "#34",
      "0123456",
    ]);
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
      "Updated invalid",
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

describe("actionable warnings", () => {
  test("explains every warning code exported by the seven readers", () => {
    const readerWarningCodes = [
      PLAN_WARNING_CODES,
      WORKLOG_WARNING_CODES,
      QUESTIONS_WARNING_CODES,
      STATE_WARNING_CODES,
      LOGS_WARNING_CODES,
      ROUTING_WARNING_CODES,
      COSTS_WARNING_CODES,
    ].flat();

    expect(readerWarningCodes).not.toHaveLength(0);
    for (const code of readerWarningCodes) {
      expect(WARNING_EXPLANATIONS[code]).toMatch(/\.$/);
    }
  });

  test("groups identical source/code/line warnings, sorts rows, and shows their locations", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      plan: {
        status: "partial",
        data: richRepository().plan.data,
        warnings: [
          {
            code: "PLAN_MALFORMED_TASK",
            message: "bad task",
            line: 12,
            excerpt: "- [?] T12 — malformed",
          },
          {
            code: "PLAN_MALFORMED_TASK",
            message: "same warning again",
            line: 12,
            excerpt: "a different message does not make a new row",
          },
          {
            code: "PLAN_MISSING_DEPS",
            message: "missing deps",
            line: 3,
            excerpt: "- [ ] T3 (standard) — Needs dependencies",
          },
        ],
      },
      questions: {
        status: "partial",
        data: { open: [] },
        warnings: [
          {
            code: "QUESTIONS_MALFORMED_ENTRY",
            message: "bad question",
            line: 2,
            excerpt: "## Q1 malformed",
          },
        ],
      },
      worklog: {
        status: "partial",
        data: { entries: [] },
        warnings: [
          {
            code: "WORKLOG_MALFORMED_ENTRY",
            message: "bad worklog",
            line: 1,
            excerpt: "- malformed",
          },
        ],
      },
      logs: {
        status: "available",
        data: richRepository().logs.data,
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panel = document.querySelector(".warnings-panel")!;
    expect(panel.querySelector("summary")?.textContent).toBe(
      "Warnings · 4 · from this snapshot",
    );
    const rows = Array.from(
      panel.querySelectorAll<HTMLElement>(".warning-row"),
    );
    expect(
      rows.map((row) => row.querySelector(".warning-source")?.textContent),
    ).toEqual(["plan", "plan", "questions", "worklog"]);
    expect(
      rows.map((row) => row.querySelector(".warning-line")?.textContent),
    ).toEqual(["line 3", "line 12", "line 2", "line 1"]);
    expect(rows[1]?.querySelector(".warning-count")?.textContent).toBe("×2");
    expect(rows[1]?.querySelector(".warning-excerpt")?.textContent).toBe(
      "- [?] T12 — malformed",
    );
    expect(rows[0]?.querySelector(".warning-explanation")?.textContent).toBe(
      WARNING_EXPLANATIONS.PLAN_MISSING_DEPS,
    );
  });

  test("opens only for non-hygiene warnings, unavailable sources, truncation, or top-level warnings", () => {
    const renderDetails = (overrides: Record<string, unknown>) => {
      const document = dashboardDocument();
      renderFleet(
        fleet("mini", [], [richRepository(overrides)]),
        document,
        NOW,
      );
      return document.querySelector<HTMLDetailsElement>(
        ".warnings-panel details",
      )!;
    };

    expect(
      renderDetails({
        plan: {
          status: "partial",
          data: richRepository().plan.data,
          warnings: [{ code: "PLAN_MALFORMED_TASK", message: "bad", line: 1 }],
        },
        worklog: {
          status: "partial",
          data: { entries: [] },
          warnings: [
            { code: "WORKLOG_MALFORMED_ENTRY", message: "bad", line: 2 },
          ],
        },
        logs: {
          status: "available",
          data: richRepository().logs.data,
          warnings: [],
        },
      }).open,
    ).toBe(false);
    expect(
      renderDetails({
        plan: {
          status: "unavailable",
          warnings: [{ code: "PLAN_MISSING", message: "missing" }],
        },
        logs: {
          status: "available",
          data: richRepository().logs.data,
          warnings: [],
        },
      }).open,
    ).toBe(true);
    expect(
      renderDetails({
        plan: {
          status: "partial",
          data: richRepository().plan.data,
          warnings: [{ code: "WARNINGS_TRUNCATED", message: "omitted" }],
        },
        logs: {
          status: "available",
          data: richRepository().logs.data,
          warnings: [],
        },
      }).open,
    ).toBe(true);
    const topLevelDetails = renderDetails({
      warning: "repository is incomplete",
      plan: {
        status: "partial",
        data: richRepository().plan.data,
        warnings: [{ code: "PLAN_MALFORMED_TASK", message: "bad", line: 1 }],
      },
      logs: {
        status: "available",
        data: richRepository().logs.data,
        warnings: [],
      },
    });
    expect(topLevelDetails.open).toBe(true);
    expect(topLevelDetails.querySelector(".warning-excerpt")?.textContent).toBe(
      "repository is incomplete",
    );
  });

  test("uses the unknown fallback and keeps hostile excerpts inert text", () => {
    const document = dashboardDocument();
    const hostile = `<img src=x onerror="globalThis.warningPwned=1">\u0001${"x".repeat(151)}…`;
    expect(Array.from(hostile)).toHaveLength(200);
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            plan: {
              status: "partial",
              data: richRepository().plan.data,
              warnings: [
                {
                  code: "FUTURE_WARNING",
                  message: "unknown",
                  line: 9,
                  excerpt: hostile,
                },
              ],
            },
            logs: {
              status: "available",
              data: richRepository().logs.data,
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const panel = document.querySelector(".warnings-panel")!;
    expect(panel.querySelector(".warning-explanation")?.textContent).toBe(
      UNKNOWN_WARNING_EXPLANATION,
    );
    expect(panel.querySelector(".warning-excerpt")?.textContent).toBe(hostile);
    expect(
      panel.querySelectorAll("img, script, [onerror], [src]"),
    ).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).warningPwned,
    ).toBeUndefined();
    expect(panel.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
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
        document.querySelectorAll('#machine-tabs [role="tab"]'),
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
      "",
      "Unavailable",
    ]);
    expect(
      document.querySelectorAll(".panel-empty .empty").length,
    ).toBeGreaterThan(0);
    expect(document.querySelector(".panel-empty .unavailable")).toBeNull();
    expect(summaryCells(document, "macbook")).toEqual([
      "macbook",
      "Unavailable",
      "Unavailable",
      "Unavailable",
      "",
      "Unavailable",
      "Unavailable",
      "Unavailable",
    ]);
    expect(document.querySelectorAll("#fleet-summary tbody tr")).toHaveLength(
      3,
    );
    expect(
      document.querySelectorAll('#repositories > [role="tabpanel"]'),
    ).toHaveLength(3);
    expect(
      document
        .querySelector('#machine-tabs [role="tab"]')
        ?.getAttribute("aria-selected"),
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
      "",
      "Unavailable",
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
      document.querySelectorAll<HTMLButtonElement>(
        '#machine-tabs [role="tab"]',
      ),
    );
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#repositories > [role="tabpanel"]',
      ),
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
      document.querySelectorAll<HTMLButtonElement>(
        '#machine-tabs [role="tab"]',
      ),
    );
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#repositories > [role="tabpanel"]',
      ),
    );
    expect(
      document.querySelector('#machine-tabs[role="tablist"]'),
    ).not.toBeNull();
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
        document.querySelectorAll('#machine-tabs [role="tab"]'),
        (tab) => tab.textContent,
      ),
    ).toEqual([`${hostile}HELDQuestions 1`, `${hostile}Questions Unavailable`]);
    expect(
      document.querySelectorAll("script, img, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe("repository strips and sub-tabs", () => {
  function localMachinePanel(document: Document): HTMLElement {
    return document.querySelector<HTMLElement>(
      '#repositories > [role="tabpanel"]',
    )!;
  }

  function repositoryTablist(panel: HTMLElement): HTMLElement {
    return panel.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Repositories"]',
    )!;
  }

  test("renders repository summaries in order with matching aggregate labels", () => {
    const document = dashboardDocument();
    const alpha = richRepository({ name: "alpha" });
    const beta = richRepository({
      name: "beta",
      state: {
        status: "available",
        data: { currentTask: null, pr: null, hold: false },
        warnings: [],
      },
      questions: { status: "available", data: { open: [] }, warnings: [] },
      liveness: { state: "STOPPED", checkedAt: "2026-08-16T11:50:00.000Z" },
    });

    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);

    const panel = localMachinePanel(document);
    const rows = Array.from(
      panel.querySelectorAll("table.repository-summary tbody tr"),
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("alphaAVAILABLERUNNINGT8PR #42HELD1"),
      expect.stringContaining("betaAVAILABLE"),
    ]);
    expect(rows[1]?.textContent).toContain("STOPPED");
    expect(rows[1]?.textContent).toContain("None");
    expect(rows[1]?.textContent).toContain("0");
    expect(rows[0]?.querySelector(".age")?.textContent).toBe("12h ago");
    expect(rows[1]?.querySelector(".age")?.textContent).toBe("12h ago");

    const tabs = Array.from(
      repositoryTablist(panel).querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    );
    const subpanels = Array.from(
      panel.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "alphaHELDQuestions 1",
      "betaQuestions 0",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    tabs.forEach((tab, index) => {
      expect(tab.getAttribute("aria-controls")).toBe(subpanels[index]!.id);
      expect(subpanels[index]?.getAttribute("aria-labelledby")).toBe(tab.id);
    });
    expect(
      document.querySelector('#machine-tabs [role="tab"]')?.textContent,
    ).toBe("miniHELDQuestions 1");
    expect(summaryCells(document, "mini").slice(4, 6)).toEqual(["HELD", "1"]);
  });

  test("switches sub-tabs by click and keyboard with a two-key hash", () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    window.location.hash = "#machine=mini&repo=beta";
    renderFleet(
      fleet(
        "mini",
        [],
        [richRepository({ name: "alpha" }), richRepository({ name: "beta" })],
      ),
      document,
      NOW,
    );

    const panel = localMachinePanel(document);
    const tabs = Array.from(
      repositoryTablist(panel).querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    );
    const subpanels = Array.from(
      panel.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
    );
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(subpanels.map((subpanel) => subpanel.hidden)).toEqual([true, false]);

    tabs[0]?.click();
    expect(window.location.hash).toBe("#machine=mini&repo=alpha");
    tabs[0]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(tabs[1]!);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0]);
    expect(window.location.hash).toBe("#machine=mini&repo=beta");
    tabs[1]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(window.location.hash).toBe("#machine=mini&repo=beta");
    tabs[0]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  });

  test("preserves ArrowRight repository selection during peer fan-out", async () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    const peer = { name: "macbook", origin: "https://macbook.example" };
    let resolvePeer: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(
          jsonResponse(
            fleet(
              "mini",
              [peer],
              [
                richRepository({ name: "alpha" }),
                richRepository({ name: "beta" }),
              ],
            ),
          ),
        );
      }
      return new Promise((resolve) => {
        resolvePeer = resolve;
      });
    });

    const loading = loadFleet(document, fetcher, { now: () => NOW });
    await flushPromises();
    const initialTabs = Array.from(
      repositoryTablist(
        localMachinePanel(document),
      ).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    initialTabs[0]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(window.location.hash).toBe("#machine=mini&repo=beta");
    expect(initialTabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(
      ["false", "true"],
    );

    resolvePeer?.(jsonResponse(fleet("macbook", [], [richRepository()])));
    await loading;

    const refreshedTabs = Array.from(
      repositoryTablist(
        localMachinePanel(document),
      ).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(window.location.hash).toBe("#machine=mini&repo=beta");
    expect(
      refreshedTabs.map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "true"]);
  });

  test("falls back for missing, unknown, and hostile repository hashes", () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    const hostile = '<img src=x onerror="globalThis.pwned=1">';
    const snapshot = fleet(
      "mini",
      [],
      [richRepository({ name: "alpha" }), richRepository({ name: "beta" })],
    );
    window.location.hash = "#machine=mini";
    renderFleet(snapshot, document, NOW);
    expect(window.location.hash).toBe("#machine=mini&repo=alpha");

    window.location.hash = "#machine=mini&repo=unknown";
    window.dispatchEvent(new window.Event("hashchange"));
    expect(window.location.hash).toBe("#machine=mini&repo=alpha");

    window.location.hash = `#${new URLSearchParams({
      machine: hostile,
      repo: hostile,
    })}`;
    window.dispatchEvent(new window.Event("hashchange"));
    expect(window.location.hash).toBe("#machine=mini&repo=alpha");
    expect(
      document.querySelectorAll("img, script, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("renders one selected repository sub-tab for a single-repository machine", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet("mini", [], [richRepository({ name: "only-repository" })]),
      document,
      NOW,
    );

    const panel = localMachinePanel(document);
    const tabs = repositoryTablist(panel).querySelectorAll('[role="tab"]');
    const subpanels = panel.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(tabs).toHaveLength(1);
    expect(subpanels).toHaveLength(1);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(subpanels[0]?.hidden).toBe(false);
    expect(document.defaultView?.location.hash).toBe(
      "#machine=mini&repo=only-repository",
    );
  });

  test("leaves fresh machine data ages blank and highlights ages beyond the interval", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      String(input) === "/api/fleet"
        ? Promise.resolve(
            jsonResponse(fleet("mini", [peer], [richRepository()])),
          )
        : Promise.resolve(
            jsonResponse({
              ...fleet("macbook", [], [richRepository()]),
              generatedAt: "2026-08-16T11:59:29.000Z",
            }),
          ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(summaryCells(document, "mini")[6]).toBe("");
    expect(summaryCells(document, "macbook")[6]).toBe("31s ago");
    expect(
      summaryRow(document, "macbook")?.querySelector(".age")?.classList,
    ).toContain("stale");
  });

  test("keeps routing above summaries and omits unavailable sub-tabs", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [{ name: "macbook", origin: "https://macbook.example" }],
        [richRepository()],
      ),
      document,
      NOW,
    );

    const local = localMachinePanel(document);
    expect(local.querySelectorAll(".routing-strip")).toHaveLength(1);
    expect(
      local
        .querySelector(".routing-strip")
        ?.compareDocumentPosition(local.querySelector(".repository-summary")!),
    ).toBe(document.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING);
    const unavailableGrid = document.querySelector<HTMLElement>(
      "#repositories > .peer-machine .peer-repositories",
    )!;
    expect(
      unavailableGrid.querySelector(":scope > .unavailable")?.textContent,
    ).toBe("Unavailable");
    expect(unavailableGrid.querySelector('[role="tablist"]')).toBeNull();
    expect(unavailableGrid.querySelector(".repository-summary")).toBeNull();
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
    expect(
      document.querySelectorAll('#machine-tabs [role="tab"]'),
    ).toHaveLength(3);
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
      "",
      "Unavailable",
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

  test("accepts peers without routing and rejects invalid peer routing", async () => {
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
      const repository =
        request === 1
          ? (() => {
              const { routing: _routing, ...withoutRouting } = richRepository();
              return withoutRouting;
            })()
          : richRepository({
              routing: {
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
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(".peer-machine").item(0).textContent,
    ).toContain("factory-ui");
    expect(
      document.querySelectorAll(".peer-machine").item(0).textContent,
    ).toContain("Unavailable");
  });

  test("accepts a peer response with valid costs", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "http://100.64.0.8:7777" };
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(jsonResponse(fleet("mini", [peer])));
      }
      return Promise.resolve(
        jsonResponse(
          fleet(
            "macbook",
            [],
            [richRepository({ costs: costs({ T8: validCostTask() }) })],
          ),
        ),
      );
    });

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(document.querySelector(".peer-machine .unreachable")).toBeNull();
    expect(summaryCells(document, "macbook")).toEqual([
      "macbook",
      "RUNNING",
      "T8",
      "PR #42",
      "HELD",
      "1",
      "",
      "$1.23",
    ]);
  });

  test("marks peers with invalid costs unreachable", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "wrong-cost-schema", origin: "http://100.64.0.9:7777" },
      { name: "wrong-cost-task", origin: "http://100.64.0.10:7777" },
    ];
    let request = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(jsonResponse(fleet("mini", peers)));
      }
      request += 1;
      const valid = costs({ T8: validCostTask() });
      const repository =
        request === 1
          ? richRepository({
              costs: { ...valid, data: { ...valid.data, schemaVersion: 2 } },
            })
          : richRepository({ costs: costs({ T01: validCostTask() }) });
      return Promise.resolve(jsonResponse(fleet("peer", [], [repository])));
    });

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(
      document.querySelectorAll(".peer-machine .unreachable"),
    ).toHaveLength(2);
    expect(
      Array.from(
        document.querySelectorAll(".peer-machine .unreachable"),
        (node) => node.textContent,
      ),
    ).toEqual(["UNREACHABLE", "UNREACHABLE"]);
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
    expect(document.querySelector("#generated")?.textContent).toContain(
      "— peer timed out",
    );
    expect(document.querySelector("#generated")?.classList).toContain("stale");
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

  test("an older peer timeout cannot stale a newer successful load", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "http://100.64.0.40:7777" };
    const timeouts: Array<() => void> = [];
    let localRequests = 0;
    let peerRequests = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        localRequests += 1;
        return Promise.resolve(
          jsonResponse(fleet(`mini-${localRequests}`, [peer])),
        );
      }
      peerRequests += 1;
      return peerRequests === 1
        ? new Promise(() => undefined)
        : Promise.resolve(jsonResponse(fleet("macbook")));
    });
    const dependencies = {
      setTimeout: ((callback: () => void) => {
        timeouts.push(callback);
        return timeouts.length;
      }) as typeof setTimeout,
      clearTimeout: vi.fn() as unknown as typeof clearTimeout,
      now: () => NOW,
    };

    const older = loadFleet(document, fetcher, dependencies);
    await flushPromises();
    expect(await loadFleet(document, fetcher, dependencies)).toBe(true);
    timeouts[0]?.();
    expect(await older).toBe(false);

    expect(document.querySelector("#machine")?.textContent).toBe("mini-2");
    expect(document.querySelector("#generated")?.textContent).not.toContain(
      "peer timed out",
    );
    expect(document.querySelector("#generated")?.classList).not.toContain(
      "stale",
    );
  });
});

describe("dashboard auto-refresh", () => {
  test("uses globally bound default timers for initial, scheduled, and peer loads", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const timers = strictGlobalTimers();
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      String(input) === "/api/fleet"
        ? Promise.resolve(jsonResponse(fleet("mini", [peer])))
        : Promise.resolve(
            jsonResponse(fleet("macbook", [], [richRepository()])),
          ),
    );
    const restore = await bootDashboard(document, fetcher, timers);
    try {
      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/fleet",
        "https://macbook.example/api/fleet",
      ]);
      expect(timers.callbacksAt(1_000)).toHaveLength(1);
      expect(timers.callbacksAt(30_000)).toHaveLength(1);
      expect(
        document.querySelector(".peer-machine .repository")?.textContent,
      ).toContain("factory-ui");

      timers.callbacksAt(30_000).forEach(({ callback }) => callback());
      await flushPromises();

      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/fleet",
        "https://macbook.example/api/fleet",
        "/api/fleet",
        "https://macbook.example/api/fleet",
      ]);
      expect(timers.callbacksAt(30_000)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("shows a fresh absolute Updated time, marks a hidden tab stale, and clears it after refresh", async () => {
    vi.useFakeTimers();
    const document = dashboardDocument();
    const window = document.defaultView!;
    window.history.replaceState(null, "", "?refresh=5");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const timers = fakeTimers();
    const generatedAt = new Date().toISOString();
    const fetcher = vi.fn(async () =>
      jsonResponse({ ...fleet("mini"), generatedAt }),
    );
    const restore = await bootDashboard(document, fetcher, timers);
    try {
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(timers.callbacksAt(5_000)).not.toHaveLength(0);
      expect(window.location.search).toBe("?refresh=5");
      expect(document.querySelector("#generated")?.textContent).toMatch(
        /^Updated /,
      );
      expect(document.querySelector("#generated")?.textContent).not.toContain(
        "ago",
      );

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
      await flushPromises();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(document.querySelector("#generated")?.textContent).toContain(
        "Stale · last good snapshot",
      );
      expect(document.querySelector("#generated")?.textContent).toContain(
        "— paused",
      );
      expect(document.querySelector("#generated")?.classList).toContain(
        "stale",
      );

      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
      await flushPromises();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(document.querySelector("#generated")?.textContent).toMatch(
        /^Updated /,
      );
      expect(document.querySelector("#generated")?.classList).not.toContain(
        "stale",
      );
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  test("defaults invalid refresh values to 30 seconds and refreshes from the button only once while pending", async () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    window.history.replaceState(null, "", "?refresh=3601");
    const timers = fakeTimers();
    let resolveRefresh: ((response: Response) => void) | undefined;
    let requests = 0;
    const fetcher = vi.fn((): Promise<Response> => {
      requests += 1;
      if (requests === 1) return Promise.resolve(jsonResponse(fleet("mini")));
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const restore = await bootDashboard(document, fetcher, timers);
    try {
      expect(timers.callbacksAt(30_000)).not.toHaveLength(0);
      const refresh = document.querySelector<HTMLButtonElement>("#refresh");
      expect(refresh).not.toBeNull();
      refresh?.click();
      refresh?.click();
      await flushPromises();
      expect(fetcher).toHaveBeenCalledTimes(2);
      resolveRefresh?.(jsonResponse(fleet("mini-refreshed")));
    } finally {
      restore();
    }
  });

  test("marks an otherwise successful snapshot stale when its age exceeds the refresh interval", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const restore = await bootDashboard(
      document,
      async () =>
        jsonResponse({
          ...fleet("mini"),
          generatedAt: new Date(Date.now() - 30_001).toISOString(),
        }),
      timers,
    );
    try {
      expect(document.querySelector("#generated")?.textContent).toMatch(
        /Stale · last good snapshot \d+s ago/,
      );
      expect(document.querySelector("#generated")?.classList).toContain(
        "stale",
      );
    } finally {
      restore();
    }
  });

  test("uses the active refresh interval for the fleet data-age cell", async () => {
    const document = dashboardDocument();
    document.defaultView!.history.replaceState(null, "", "?refresh=5");
    const timers = fakeTimers();
    const restore = await bootDashboard(
      document,
      async () =>
        jsonResponse({
          ...fleet("mini"),
          generatedAt: new Date(Date.now() - 6_001).toISOString(),
        }),
      timers,
    );
    try {
      expect(summaryCells(document, "mini")[6]).toMatch(/\d+s ago/);
      expect(
        summaryRow(document, "mini")?.querySelector(".age")?.classList,
      ).toContain("stale");
    } finally {
      restore();
    }
  });

  test("rejects a below-minimum refresh value and accepts the 3600-second maximum", async () => {
    for (const [refresh, expectedMilliseconds] of [
      ["4", 30_000],
      ["3600", 3_600_000],
    ] as const) {
      const document = dashboardDocument();
      document.defaultView!.history.replaceState(
        null,
        "",
        `?refresh=${refresh}`,
      );
      const timers = fakeTimers();
      const restore = await bootDashboard(
        document,
        async () => jsonResponse(fleet("mini")),
        timers,
      );
      try {
        expect(timers.callbacksAt(expectedMilliseconds)).not.toHaveLength(0);
      } finally {
        restore();
      }
    }
  });

  test("keeps the selected machine, repository, scroll position, and current content until a refresh succeeds", async () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    const peer = { name: "macbook", origin: "https://macbook.example" };
    let resolveRefresh: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) !== "/api/fleet") {
        return Promise.resolve(
          jsonResponse(fleet("macbook", [], [richRepository()])),
        );
      }
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(
          jsonResponse(
            fleet(
              "mini",
              [peer],
              [
                richRepository({ name: "alpha" }),
                richRepository({ name: "beta" }),
              ],
            ),
          ),
        );
      }
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    });

    await loadFleet(document, fetcher, { now: () => NOW });
    window.location.hash = "#machine=mini&repo=beta";
    window.dispatchEvent(new window.Event("hashchange"));
    const repositoryPanel =
      document.querySelector<HTMLElement>("#repositories")!;
    repositoryPanel.scrollTop = 73;

    const refreshing = loadFleet(document, fetcher, { now: () => NOW });
    expect(document.querySelector("#machine")?.textContent).toBe("mini");
    expect(document.body.textContent).toContain("alpha");
    expect(repositoryPanel.scrollTop).toBe(73);
    expect(window.location.hash).toBe("#machine=mini&repo=beta");

    resolveRefresh?.(
      jsonResponse(
        fleet(
          "mini-new",
          [peer],
          [richRepository({ name: "alpha" }), richRepository({ name: "beta" })],
        ),
      ),
    );
    await refreshing;
    expect(window.location.hash).toBe("#machine=mini-new&repo=beta");
    expect(repositoryPanel.scrollTop).toBe(73);
  });

  test("retains the last good snapshot on failure, reports its age, and backs off retries", async () => {
    vi.useFakeTimers();
    const document = dashboardDocument();
    const timers = fakeTimers();
    let requests = 0;
    const fetcher = vi.fn(async () => {
      requests += 1;
      return requests === 1
        ? jsonResponse({
            ...fleet("mini", [], [richRepository()]),
            generatedAt: new Date().toISOString(),
          })
        : new Response("unavailable", { status: 503 });
    });
    const restore = await bootDashboard(document, fetcher, timers);
    try {
      timers.callbacksAt(30_000).forEach(({ callback }) => callback());
      await flushPromises();
      expect(document.querySelector("#machine")?.textContent).toBe("mini");
      expect(document.body.textContent).toContain("factory-ui");
      expect(document.querySelector("#error")?.textContent).toMatch(
        /last good.*0s ago/i,
      );
      expect(document.querySelector("#generated")?.textContent).toContain(
        "— refresh failed",
      );
      expect(document.querySelector("#generated")?.classList).toContain(
        "stale",
      );
      expect(timers.callbacksAt(60_000)).not.toHaveLength(0);

      timers.callbacksAt(60_000).forEach(({ callback }) => callback());
      await flushPromises();
      expect(timers.callbacksAt(120_000)).not.toHaveLength(0);
      timers.callbacksAt(120_000).forEach(({ callback }) => callback());
      await flushPromises();
      expect(timers.callbacksAt(240_000)).not.toHaveLength(0);
      timers.callbacksAt(240_000).forEach(({ callback }) => callback());
      await flushPromises();
      expect(timers.callbacksAt(300_000)).not.toHaveLength(0);
      timers.callbacksAt(300_000).forEach(({ callback }) => callback());
      await flushPromises();
      expect(timers.callbacksAt(300_000)).not.toHaveLength(0);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  test("drops an older load response after a newer generation has rendered", async () => {
    const document = dashboardDocument();
    let resolveOlder: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((_: RequestInfo | URL): Promise<Response> => {
      if (resolveOlder === undefined) {
        return new Promise((resolve) => {
          resolveOlder = resolve;
        });
      }
      return Promise.resolve(jsonResponse(fleet("newer")));
    });

    const older = loadFleet(document, fetcher);
    await loadFleet(document, fetcher);
    resolveOlder?.(jsonResponse(fleet("older")));
    await older;

    expect(document.querySelector("#machine")?.textContent).toBe("newer");
  });
});
