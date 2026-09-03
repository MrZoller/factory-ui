import { describe, expect, test, vi } from "bun:test";
import { Window } from "happy-dom";

import {
  ANSWER_FETCH_TIMEOUT_MS,
  loadFleet,
  MAX_CONCURRENT_PEER_FETCHES,
  PEER_FETCH_TIMEOUT_MS,
  renderFleet,
  startDashboard,
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
    '<span id="question-queue-count">0</span>',
    '<table id="fleet-summary"><tbody></tbody></table>',
    '<section id="question-queue"><h2 id="question-queue-heading"></h2><div id="question-queue-list"></div></section>',
    '<section id="dependency-graph"><div id="dependency-graph-list"></div></section>',
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

function dashboardDependencies(
  timers: ReturnType<typeof fakeTimers>,
  extras: { now?: () => Date; randomUUID?: () => string } = {},
) {
  return {
    setTimeout: timers.setTimeout as unknown as typeof globalThis.setTimeout,
    clearTimeout:
      timers.clearTimeout as unknown as typeof globalThis.clearTimeout,
    setInterval: timers.setInterval as unknown as typeof globalThis.setInterval,
    clearInterval:
      timers.clearInterval as unknown as typeof globalThis.clearInterval,
    ...extras,
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
  answerIntake = { enabled: true, authRequired: true },
) {
  return {
    schemaVersion: 1,
    hostname,
    generatedAt: "2026-08-16T12:00:00.000Z",
    repositories,
    peers,
    answerIntake,
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
    expect(
      Array.from(
        panel.querySelectorAll(".timing-stamp"),
        (node) => node.textContent,
      ),
    ).toEqual([
      "8/16/2026, 11:00:00 AM",
      "8/16/2026, 11:59:00 AM (59m 0s)",
      "8/16/2026, 11:30:00 AM",
      "8/16/2026, 11:58:00 AM",
      "8/16/2026, 11:40:00 AM",
      "8/16/2026, 11:50:00 AM",
    ]);
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

describe("answer lifecycle queue", () => {
  function answerableRepository(overrides = {}, filedAt?: string) {
    return richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q9",
              taskId: "T8",
              title: "Choose <img src=x onerror=1>",
              text: "raw",
              ...(filedAt === undefined ? {} : { filedAt }),
              context: "Context",
              options: [
                { label: "A", text: "Proceed", recommended: true },
                { label: "B", text: "Stop" },
              ],
              qualifier: "Why?",
            },
          ],
        },
        warnings: [],
      },
      ...overrides,
    });
  }

  test("accepts optional fractional filed-at seconds and rejects invalid calendar dates", async () => {
    const fractional = answerableRepository({}, "2026-08-30T03:04:05.123456Z");
    const accepted = dashboardDocument();
    await expect(
      loadFleet(accepted, async () =>
        jsonResponse(fleet("mini", [], [fractional])),
      ),
    ).resolves.toBe(true);
    expect(accepted.querySelector("#question-queue-count")?.textContent).toBe(
      "1",
    );

    const invalid = answerableRepository({}, "2026-02-30T03:04:05.1Z");
    const rejected = dashboardDocument();
    await expect(
      loadFleet(rejected, async () =>
        jsonResponse(fleet("mini", [], [invalid])),
      ),
    ).resolves.toBe(false);
    expect(rejected.querySelector("#question-queue-count")?.textContent).toBe(
      "0",
    );
  });

  test("uses one stateful options block with a visible recommendation and no default choice", () => {
    const document = dashboardDocument();
    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);
    let entry = document.querySelector(".question-queue-entry")!;
    expect(entry.querySelectorAll(".question-options")).toHaveLength(1);
    expect(
      entry.querySelectorAll("fieldset.question-options-edit"),
    ).toHaveLength(1);
    expect(
      Array.from(
        entry.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        (input) => input.checked,
      ),
    ).toEqual([false, false]);
    expect(entry.querySelector(".question-recommended")?.textContent).toBe(
      "(recommended)",
    );
    expect(document.querySelectorAll("img")).toHaveLength(0);
    const text = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=text]",
    )!;
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new document.defaultView!.Event("change"));
    text.value = "because";
    text.dispatchEvent(new document.defaultView!.Event("input"));
    secret.value = "shared";
    secret.dispatchEvent(new document.defaultView!.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    entry = document.querySelector(".question-queue-entry")!;
    expect(entry.querySelectorAll(".question-options")).toHaveLength(1);
    expect(entry.querySelector("fieldset.question-options-edit")).toBeNull();
    expect(entry.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Review answer",
    );
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Option: A",
    );
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel")!
      .click();
    entry = document.querySelector(".question-queue-entry")!;
    expect(
      entry.querySelector("fieldset.question-options-edit"),
    ).not.toBeNull();
  });

  test("keeps one static options block when intake is unavailable or lifecycle replaces editing", () => {
    const unavailable = dashboardDocument();
    renderFleet(
      fleet("mini", [], [answerableRepository()], {
        enabled: false,
        authRequired: true,
      }),
      unavailable,
      NOW,
    );
    const unavailableEntry = unavailable.querySelector(
      ".question-queue-entry",
    )!;
    expect(unavailableEntry.querySelectorAll(".question-options")).toHaveLength(
      1,
    );
    expect(
      unavailableEntry.querySelector("fieldset.question-options-edit"),
    ).toBeNull();
    expect(
      unavailableEntry.querySelectorAll('input[type="radio"]'),
    ).toHaveLength(0);
    expect(
      unavailableEntry.querySelector(".question-recommended")?.textContent,
    ).toBe("(recommended)");
    expect(unavailableEntry.querySelector(".answer-form")).toBeNull();

    const lifecycle = dashboardDocument();
    lifecycle.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "accepted",
          actor: "Verified Actor",
        },
      ]),
    );
    renderFleet(fleet("mini", [], [answerableRepository()]), lifecycle, NOW);
    const lifecycleEntry = lifecycle.querySelector(".question-queue-entry")!;
    expect(lifecycleEntry.querySelectorAll(".question-options")).toHaveLength(
      1,
    );
    expect(
      lifecycleEntry.querySelector("fieldset.question-options-edit"),
    ).toBeNull();
    expect(lifecycleEntry.querySelectorAll('input[type="radio"]')).toHaveLength(
      0,
    );
    expect(lifecycleEntry.querySelector(".answer-status")?.textContent).toBe(
      "applied/consumed",
    );
  });

  test("renders hostile option text as inert text in the stateful options block", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.optionPwned=1">';
    renderFleet(
      fleet(
        "mini",
        [],
        [
          answerableRepository({
            questions: {
              status: "available",
              data: {
                open: [
                  {
                    id: "Q9",
                    taskId: "T8",
                    title: "Choose safely",
                    text: "raw",
                    context: "Context",
                    options: [{ label: "A", text: hostile, recommended: true }],
                  },
                ],
              },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const entry = document.querySelector(".question-queue-entry")!;
    expect(entry.querySelector(".question-options")?.textContent).toContain(
      hostile,
    );
    expect(entry.querySelectorAll("img, [onerror]")).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).optionPwned).toBeUndefined();
  });

  test("qualifies duplicate-repository question identities", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const local = answerableRepository({ name: "factory-ui" });
    const remote = answerableRepository({
      name: "factory-ui",
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q10",
              taskId: "T10",
              title: "Peer question",
              text: "raw",
              context: "Context",
              options: [{ label: "A", text: "Proceed" }],
            },
          ],
        },
        warnings: [],
      },
    });
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "macbook",
          repository: "factory-ui",
          question: "Q10",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "accepted",
          actor: "Verified Actor",
        },
        {
          version: 1,
          machine: "macbook",
          repository: "factory-ui",
          question: "Q11",
          id: "223e4567-e89b-42d3-a456-426614174000",
          status: "pending",
        },
        {
          version: 1,
          machine: "macbook",
          repository: "factory-ui",
          question: "Q12",
          id: "323e4567-e89b-42d3-a456-426614174000",
          status: "rejected",
          reason: "Question already answered",
        },
      ]),
    );
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [peer], [local]))
          : jsonResponse(fleet("macbook", [], [remote])),
      ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(
      Array.from(
        document.querySelectorAll(
          ".question-queue-entry h3 .question-title-text",
        ),
        (heading) => heading.textContent,
      ),
    ).toEqual([
      "mini/factory-ui/Q9 · Choose <img src=x onerror=1>",
      "macbook/factory-ui/Q10 · Peer question",
      "macbook/factory-ui/Q11 · Answer lifecycle",
      "macbook/factory-ui/Q12 · Answer lifecycle",
    ]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          ".question-queue-entry h3 .question-permalink",
        ),
        (link) => [link.textContent, link.getAttribute("href")],
      ),
    ).toEqual([
      ["Permalink", "#machine=mini&repo=factory-ui&question=Q9"],
      ["Permalink", "#machine=macbook&repo=factory-ui&question=Q10"],
      ["Permalink", "#machine=macbook&repo=factory-ui&question=Q11"],
      ["Permalink", "#machine=macbook&repo=factory-ui&question=Q12"],
    ]);
    expect(
      Array.from(
        document.querySelectorAll(".questions-panel article.question h5"),
        (heading) => heading.textContent,
      ),
    ).toEqual(["mini/factory-ui/Q9 · T8", "macbook/factory-ui/Q10 · T10"]);

    const option = document.querySelector<HTMLInputElement>(
      '.question-queue-entry input[type="radio"]',
    )!;
    option.checked = true;
    option.dispatchEvent(new document.defaultView!.Event("change"));
    const secret = document.querySelector<HTMLInputElement>(
      '.question-queue-entry input[type="password"]',
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new document.defaultView!.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();

    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "mini/factory-ui/Q9",
    );
    expect(
      document.querySelector(".answer-attribution")?.textContent,
    ).toContain("macbook/factory-ui/Q10");
    expect(
      Array.from(
        document.querySelectorAll(".answer-identity"),
        (identity) => identity.textContent,
      ),
    ).toEqual(["macbook/factory-ui/Q11", "macbook/factory-ui/Q12"]);
    expect(document.querySelectorAll(".question-queue-entry img")).toHaveLength(
      0,
    );
  });

  test("ignores lifecycle records for removed machines when qualifying visible repositories", () => {
    const document = dashboardDocument();
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "removed-machine",
          repository: "factory-ui",
          question: "Q10",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "pending",
        },
      ]),
    );

    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);

    expect(
      document.querySelector(".question-queue-entry h3 .question-title-text")
        ?.textContent,
    ).toBe("factory-ui/Q9 · Choose <img src=x onerror=1>");
    expect(
      document.querySelector(".questions-panel article.question h5")
        ?.textContent,
    ).toBe("factory-ui/Q9 · T8");
  });

  test("keeps the T50 open header count separate from lifecycle-only cards and renders hostile terminal text inert", () => {
    const document = dashboardDocument();
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q99",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "rejected",
          reason: "<img src=x onerror=1> terminal",
        },
      ]),
    );
    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);
    expect(document.querySelector("#question-queue-count")?.textContent).toBe(
      "1",
    );
    expect(
      document.querySelector("#question-queue-heading")?.textContent,
    ).toContain("1 open · 1 tracked");
    expect(document.querySelector(".answer-reason")?.textContent).toBe(
      "<img src=x onerror=1> terminal",
    );
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  test("separates page navigation from explicitly labelled section jumps", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();
    const document = new Window({ url: "https://dashboard.test/" })
      .document as unknown as Document;
    document.write(html);

    const pageNavigation = document.querySelector(
      'nav.header-actions[aria-label="Dashboard pages"]',
    );
    expect(
      Array.from(
        pageNavigation?.querySelectorAll<HTMLAnchorElement>("a") ?? [],
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["/how"]);
    expect(pageNavigation?.querySelector('a[href^="#"]')).toBeNull();
    expect(pageNavigation?.querySelector("#refresh")).toBeNull();

    const sectionNavigation = document.querySelector(
      'nav.section-navigation[aria-label="Dashboard sections"]',
    );
    expect(
      Array.from(
        sectionNavigation?.querySelectorAll<HTMLAnchorElement>("a") ?? [],
        (link) => link.getAttribute("href"),
      ),
    ).toEqual(["#dependency-graph", "#question-queue"]);
    expect(sectionNavigation?.textContent).toContain("On this page");

    const questions = sectionNavigation?.querySelector<HTMLAnchorElement>(
      'a[href="#question-queue"]',
    );
    expect(
      Array.from(questions?.children ?? [], (child) => child.textContent),
    ).toEqual(["Questions", "0"]);
    expect(questions?.querySelector("#question-queue-count")?.textContent).toBe(
      "0",
    );

    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.section-navigation a\s*\{[^}]*gap:\s*var\(--space-2\)/,
    );
    expect(css).toMatch(
      /\.section-navigation a::before\s*\{[^}]*content:\s*"↓"/,
    );
  });

  test("fans peer delivery directly to its configured origin rather than through the local server", async () => {
    const document = dashboardDocument();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/fleet")
        return jsonResponse(
          fleet(
            "mini",
            [{ name: "legion", origin: "https://legion.tailnet:7777" }],
            [answerableRepository()],
          ),
        );
      return jsonResponse(fleet("legion", [], [answerableRepository()]));
    });
    await loadFleet(document, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://legion.tailnet:7777/api/fleet",
      expect.any(Object),
    );
  });

  test("ignores edit-only disappeared-repository drafts but retains durable and uncertain machine qualifiers", () => {
    const document = dashboardDocument();
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "peer",
          repository: "factory-ui",
          question: "Q10",
          status: "pending",
        },
      ]),
    );
    renderFleet(
      fleet(
        "mini",
        [{ name: "peer", origin: "https://peer.example" }],
        [answerableRepository()],
      ),
      document,
      NOW,
    );
    expect(
      document.querySelector(".question-queue-entry h3 .question-title-text")
        ?.textContent,
    ).toBe("factory-ui/Q9 · Choose <img src=x onerror=1>");

    const qualifiedDocument = dashboardDocument();
    qualifiedDocument.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "peer",
          repository: "factory-ui",
          question: "Q10",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "pending",
        },
      ]),
    );
    renderFleet(
      fleet(
        "mini",
        [{ name: "peer", origin: "https://peer.example" }],
        [answerableRepository()],
      ),
      qualifiedDocument,
      NOW,
    );
    expect(
      qualifiedDocument.querySelector(
        ".question-queue-entry h3 .question-title-text",
      )?.textContent,
    ).toBe("mini/factory-ui/Q9 · Choose <img src=x onerror=1>");
    expect(
      qualifiedDocument
        .querySelector(".questions-panel .question-permalink")
        ?.getAttribute("aria-label"),
    ).toBe("Permalink to mini/factory-ui/Q9");

    const uncertainDocument = dashboardDocument();
    uncertainDocument.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "peer",
          repository: "factory-ui",
          question: "Q11",
          status: "uncertain",
          idempotencyKey: "223e4567-e89b-42d3-a456-426614174000",
          payload: { question: "Q11", option: "A" },
        },
      ]),
    );
    renderFleet(
      fleet(
        "mini",
        [{ name: "peer", origin: "https://peer.example" }],
        [answerableRepository()],
      ),
      uncertainDocument,
      NOW,
    );
    expect(
      uncertainDocument.querySelector(
        ".question-queue-entry h3 .question-title-text",
      )?.textContent,
    ).toBe("mini/factory-ui/Q9 · Choose <img src=x onerror=1>");
  });

  test("submits local answers once with the exact wire request and retains its idempotency key for retry", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    let attempts = 0;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/fleet")
          return jsonResponse(fleet("mini", [], [answerableRepository()]));
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: "temporary" }, 503)
          : jsonResponse({ status: "pending", id: answerId }, 202);
      },
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => answerId,
        now: () => NOW,
      }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new view.Event("change"));
    const text = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=text]",
    )!;
    text.value = "because";
    text.dispatchEvent(new view.Event("input"));
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Confirm submission",
    )!;
    confirm.click();
    confirm.click();
    await flushPromises();
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Check submission status",
    )!;
    retry.click();
    await flushPromises();
    const posts = fetcher.mock.calls.filter(([input]) =>
      String(input).includes("/answers"),
    );
    expect(posts).toHaveLength(2);
    expect(
      posts.map(([, init]) => [
        String(init?.method),
        init?.body,
        new Headers(init?.headers).get("authorization"),
        new Headers(init?.headers).get("content-type"),
        new Headers(init?.headers).get("idempotency-key"),
      ]),
    ).toEqual([
      [
        "POST",
        '{"question":"Q9","option":"A","text":"because"}',
        "Bearer shared",
        "application/json",
        answerId,
      ],
      [
        "POST",
        '{"question":"Q9","option":"A","text":"because"}',
        "Bearer shared",
        "application/json",
        answerId,
      ],
    ]);
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "pending application",
    );
    expect(
      document.defaultView!.localStorage.getItem(
        "factory-ui.answer-lifecycle.v1",
      ),
    ).not.toContain("shared");
    controller.cleanup();
  });

  test.each(["option", "free text"] as const)(
    "uses receiver-safe default fetch wiring for %s submissions",
    async (kind) => {
      const document = dashboardDocument();
      const timers = fakeTimers();
      const repository =
        kind === "option"
          ? answerableRepository()
          : richRepository({
              questions: {
                status: "available",
                data: {
                  open: [
                    {
                      id: "Q9",
                      taskId: "T8",
                      title: "Explain the decision",
                      text: "raw",
                      context: "Provide the reason.",
                      proseOptions: ["Describe another approach"],
                    },
                  ],
                },
                warnings: [],
              },
            });
      const requests: Array<[string, RequestInit | undefined]> = [];
      const fetcher = async function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        if (this !== globalThis) {
          throw new TypeError("fetch receiver must be globalThis");
        }
        requests.push([String(input), init]);
        return String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [], [repository]))
          : jsonResponse(
              {
                status: "pending",
                id: "123e4567-e89b-42d3-a456-426614174000",
              },
              202,
            );
      };
      const restore = await bootDashboard(document, fetcher, timers);
      try {
        const view = document.defaultView!;
        if (kind === "option") {
          const option = document.querySelector<HTMLInputElement>(
            ".answer-option input",
          )!;
          option.checked = true;
          option.dispatchEvent(new view.Event("change"));
        } else {
          const text = document.querySelector<HTMLInputElement>(
            '.answer-form input[type="text"]',
          )!;
          text.value = "The deployment owner approved it.";
          text.dispatchEvent(new view.Event("input"));
        }
        const secret = document.querySelector<HTMLInputElement>(
          '.answer-form input[type="password"]',
        )!;
        secret.value = "shared";
        secret.dispatchEvent(new view.Event("input"));
        Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent === "Review answer")!
          .click();
        Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent === "Confirm submission")!
          .click();
        await flushPromises();

        expect(requests.map(([input]) => input)).toEqual([
          "/api/fleet",
          "/api/repo/factory-ui/answers",
        ]);
        expect(requests[1]?.[1]?.method).toBe("POST");
        expect(document.querySelector(".answer-status")?.textContent).toBe(
          "pending application",
        );
      } finally {
        restore();
      }
    },
  );

  test("submits and polls local tailnet-open answers without secret UI or authorization", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/fleet") {
          return jsonResponse(
            fleet("mini", [], [answerableRepository()], {
              enabled: true,
              authRequired: false,
            }),
          );
        }
        if (init?.method === "POST") {
          return jsonResponse({ status: "pending", id: answerId }, 202);
        }
        return jsonResponse({
          schemaVersion: 1,
          id: answerId,
          status: "accepted",
          question: "Q9",
          option: "A",
          actor: "Verified",
          source: "factory-ui",
          submittedAt: "2026-08-30T12:00:00.000Z",
          settledAt: "2026-08-30T12:00:02.000Z",
        });
      },
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => answerId,
        now: () => NOW,
      }),
    );
    await flushPromises();
    expect(document.body.textContent).not.toContain("Shared secret");
    expect(
      document.querySelector('.answer-form input[type="password"]'),
    ).toBeNull();
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new document.defaultView!.Event("change"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Confirm submission")!
      .click();
    await flushPromises();
    timers.callbacksAt(5_000).forEach(({ callback }) => callback());
    await flushPromises();
    const answerCalls = fetcher.mock.calls.slice(1);
    expect(answerCalls).toHaveLength(2);
    expect(
      answerCalls.map(([, init]) =>
        new Headers(init?.headers).has("authorization"),
      ),
    ).toEqual([false, false]);
    expect(
      answerCalls.map(([, init]) =>
        new Headers(init?.headers).get("x-factory-ui-answer"),
      ),
    ).toEqual([null, "1"]);
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "applied/consumed",
    );
    controller.cleanup();
  });

  test("resumes a persisted local tailnet-open outcome without prompting for a secret", async () => {
    const document = dashboardDocument();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: answerId,
          status: "pending",
        },
      ]),
    );
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(
              fleet("mini", [], [answerableRepository()], {
                enabled: true,
                authRequired: false,
              }),
            )
          : jsonResponse({
              schemaVersion: 1,
              id: answerId,
              status: "accepted",
              question: "Q9",
              option: "A",
              actor: "Verified",
              source: "factory-ui",
              submittedAt: "2026-08-30T12:00:00.000Z",
              settledAt: "2026-08-30T12:00:02.000Z",
            }),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(fakeTimers(), { now: () => NOW }),
    );
    await flushPromises();
    expect(document.body.textContent).not.toContain("Shared secret");
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Resume tracking")!
      .click();
    await flushPromises();
    expect(
      new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("authorization"),
    ).toBe(false);
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "applied/consumed",
    );
    controller.cleanup();
  });

  test("treats a legacy fleet response with no answer descriptor as disabled", () => {
    const document = dashboardDocument();
    const { answerIntake: _answerIntake, ...legacy } = fleet(
      "mini",
      [],
      [answerableRepository()],
    );
    renderFleet(legacy, document, NOW);
    expect(document.querySelector(".answer-form")).toBeNull();
    expect(document.querySelector(".question-body")).not.toBeNull();
  });

  test("bounds a stalled answer submission and re-enables the form", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) === "/api/fleet") {
          return Promise.resolve(
            jsonResponse(fleet("mini", [], [answerableRepository()])),
          );
        }
        signal = init?.signal;
        return new Promise(() => undefined);
      },
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
        now: () => NOW,
      }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new view.Event("change"));
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Confirm submission")!
      .click();
    await flushPromises();

    expect(signal).toBeInstanceOf(AbortSignal);
    timers.callbacksAt(ANSWER_FETCH_TIMEOUT_MS).at(-1)?.callback();
    await flushPromises();

    expect(signal?.aborted).toBe(true);
    expect(document.querySelector(".answer-error")?.textContent).toBe(
      "Answer request timed out",
    );
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Check submission status",
      )?.disabled,
    ).toBe(false);
    controller.cleanup();
  });

  test("recovers from idempotency key generation failure and permits retry", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const randomUUID = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error("UUID unavailable");
      })
      .mockReturnValue(answerId);
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/fleet"
        ? jsonResponse(fleet("mini", [], [answerableRepository()]))
        : jsonResponse({ status: "pending", id: answerId }, 202),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, { randomUUID, now: () => NOW }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new view.Event("change"));
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    const confirm = () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Confirm submission",
      )!;
    confirm().click();
    await flushPromises();
    expect(document.querySelector(".answer-error")?.textContent).toBe(
      "UUID unavailable",
    );
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "pending application",
    );
    controller.cleanup();
  });

  test("bounds a stalled answer outcome poll and clears tracking", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: answerId,
          status: "pending",
        },
      ]),
    );
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) === "/api/fleet") {
          return Promise.resolve(
            jsonResponse(fleet("mini", [], [answerableRepository()])),
          );
        }
        signal = init?.signal;
        return new Promise(() => undefined);
      },
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, { now: () => NOW }),
    );
    await flushPromises();
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-resume input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new document.defaultView!.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Resume tracking")!
      .click();
    await flushPromises();
    timers.callbacksAt(ANSWER_FETCH_TIMEOUT_MS).at(-1)?.callback();
    await flushPromises();

    expect(signal?.aborted).toBe(true);
    expect(document.querySelector(".answer-error")?.textContent).toBe(
      "Answer request timed out",
    );
    expect(
      document.querySelector<HTMLInputElement>("input[type=password]")?.value,
    ).toBe("");
    controller.cleanup();
  });

  test("restores an ambiguous submission reservation in a fresh session without its secret", async () => {
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const firstDocument = dashboardDocument();
    const firstTimers = fakeTimers();
    const firstFetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [], [answerableRepository()]))
          : jsonResponse(
              {
                error:
                  "Submission status uncertain; operator verification required",
              },
              init?.method === "POST" ? 503 : 500,
            ),
    );
    const firstController = startDashboard(
      firstDocument,
      firstFetcher,
      dashboardDependencies(firstTimers, {
        randomUUID: () => answerId,
        now: () => NOW,
      }),
    );
    await flushPromises();
    const firstView = firstDocument.defaultView!;
    const option = firstDocument.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new firstView.Event("change"));
    const text = firstDocument.querySelector<HTMLInputElement>(
      ".answer-form input[type=text]",
    )!;
    text.value = "because";
    text.dispatchEvent(new firstView.Event("input"));
    const secret = firstDocument.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new firstView.Event("input"));
    Array.from(firstDocument.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    Array.from(firstDocument.querySelectorAll("button"))
      .find((button) => button.textContent === "Confirm submission")!
      .click();
    await flushPromises();

    const firstPosts = firstFetcher.mock.calls.filter(
      ([, init]) => String(init?.method).toUpperCase() === "POST",
    );
    expect(firstPosts).toHaveLength(1);
    const stored = firstView.localStorage.getItem(
      "factory-ui.answer-lifecycle.v1",
    );
    expect(stored).toContain(
      '"payload":{"question":"Q9","option":"A","text":"because"}',
    );
    expect(stored).toContain(`"idempotencyKey":"${answerId}"`);
    expect(stored).not.toContain("shared");
    firstController.cleanup();

    const secondDocument = dashboardDocument();
    secondDocument.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      stored!,
    );
    const secondTimers = fakeTimers();
    const secondFetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(
              fleet(
                "mini",
                [],
                [
                  answerableRepository({
                    questions: {
                      status: "available",
                      data: { open: [] },
                      warnings: [],
                    },
                  }),
                ],
              ),
            )
          : jsonResponse(
              { status: "pending", id: answerId },
              init?.method === "POST" ? 202 : 500,
            ),
    );
    const secondController = startDashboard(
      secondDocument,
      secondFetcher,
      dashboardDependencies(secondTimers, { now: () => NOW }),
    );
    await flushPromises();

    expect(secondDocument.querySelector(".answer-error")?.textContent).toBe(
      "Submission status uncertain; operator verification required",
    );
    expect(secondDocument.querySelector(".answer-form")?.textContent).toContain(
      "Option: A",
    );
    expect(secondDocument.querySelector(".answer-form")?.textContent).toContain(
      "Text: because",
    );
    expect(
      secondDocument.querySelector("#question-queue-heading")?.textContent,
    ).toContain("0 open · 1 tracked");
    const resumedSecret = secondDocument.querySelector<HTMLInputElement>(
      "input[type=password]",
    )!;
    expect(resumedSecret.value).toBe("");
    resumedSecret.value = "shared";
    resumedSecret.dispatchEvent(new secondDocument.defaultView!.Event("input"));
    Array.from(secondDocument.querySelectorAll("button"))
      .find((button) => button.textContent === "Check submission status")!
      .click();
    await flushPromises();

    const secondPosts = secondFetcher.mock.calls.filter(
      ([, init]) => String(init?.method).toUpperCase() === "POST",
    );
    expect(secondPosts).toHaveLength(1);
    expect(secondPosts[0]?.[1]?.body).toBe(
      '{"question":"Q9","option":"A","text":"because"}',
    );
    expect(
      new Headers(secondPosts[0]?.[1]?.headers).get("idempotency-key"),
    ).toBe(answerId);
    expect(new Headers(secondPosts[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer shared",
    );
    secondController.cleanup();
  });

  test("retains an actively submitted uncertain reservation when storage is at capacity", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          status: "uncertain",
          payload: { question: "Q9", option: "A" },
          idempotencyKey: answerId,
        },
        ...Array.from({ length: 127 }, (_, index) => ({
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: `Q${index + 10}`,
          id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
          status: "pending",
        })),
      ]),
    );
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [], [answerableRepository()]))
          : jsonResponse(
              { error: "temporary" },
              init?.method === "POST" ? 503 : 500,
            ),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => answerId,
        now: () => NOW,
      }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Check submission status")!
      .click();
    await flushPromises();

    const stored = document.defaultView!.localStorage.getItem(
      "factory-ui.answer-lifecycle.v1",
    )!;
    const records = JSON.parse(stored) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(128);
    expect(records).toContainEqual({
      version: 1,
      machine: "mini",
      repository: "factory-ui",
      question: "Q9",
      status: "uncertain",
      payload: { question: "Q9", option: "A" },
      idempotencyKey: answerId,
    });
    expect(stored).not.toContain("shared");
    controller.cleanup();
  });

  test("ignores malformed uncertain reservations without restoring secrets or posting", async () => {
    const valid = {
      version: 1,
      machine: "mini",
      repository: "factory-ui",
      question: "Q9",
      status: "uncertain",
      payload: { question: "Q9", option: "A", text: "because" },
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    };
    const cases = [
      { payload: { ...valid.payload, question: "Q8" } },
      { idempotencyKey: "not-a-uuid" },
      { payload: { ...valid.payload, option: "AA" } },
      { payload: { ...valid.payload, text: "bad\ntext" } },
      { payload: { ...valid.payload, text: "x".repeat(10_001) } },
      { id: "123e4567-e89b-42d3-a456-426614174001" },
      { actor: "operator" },
      { reason: "no" },
      { secret: "injected-secret" },
    ];

    for (const overrides of cases) {
      const document = dashboardDocument();
      document.defaultView!.localStorage.setItem(
        "factory-ui.answer-lifecycle.v1",
        JSON.stringify([{ ...valid, ...overrides }]),
      );
      const fetcher = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) =>
          String(input) === "/api/fleet"
            ? jsonResponse(fleet("mini", [], [answerableRepository()]))
            : jsonResponse({ status: "pending" }, 202),
      );
      const controller = startDashboard(
        document,
        fetcher,
        dashboardDependencies(fakeTimers(), { now: () => NOW }),
      );
      await flushPromises();

      expect(document.querySelector(".answer-review-value") === null).toBe(
        true,
      );
      expect(
        document.querySelector<HTMLInputElement>(
          ".answer-form input[type=password]",
        )?.value,
      ).toBe("");
      expect(
        fetcher.mock.calls.filter(
          ([, init]) => String(init?.method).toUpperCase() === "POST",
        ),
      ).toHaveLength(0);
      controller.cleanup();
    }
  });

  test("does not post an answer when durable storage rejects its pre-submit reservation", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [], [answerableRepository()]))
          : jsonResponse(
              { status: "pending" },
              init?.method === "POST" ? 202 : 500,
            ),
    );
    const storage = document.defaultView!.localStorage;
    Object.defineProperty(storage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("storage full");
      },
    });
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
        now: () => NOW,
      }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new view.Event("change"));
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Confirm submission")!
      .click();
    await flushPromises();

    expect(
      fetcher.mock.calls.filter(
        ([, init]) => String(init?.method).toUpperCase() === "POST",
      ),
    ).toHaveLength(0);
    controller.cleanup();
  });

  test("links peer lifecycle to the owner in a secret-free fragment without cross-origin answer fetches", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const peer = "https://legion.tailnet:7777";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "legion",
          repository: "factory-ui",
          question: "Q9",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "pending",
        },
      ]),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/fleet")
        return jsonResponse(
          fleet("mini", [{ name: "legion", origin: peer }], []),
        );
      if (url === `${peer}/api/fleet`)
        return jsonResponse(fleet("legion", [], [answerableRepository()]));
      throw new Error(`unexpected answer request: ${url}`);
    });
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        now: () => NOW,
      }),
    );
    await flushPromises();
    expect(document.querySelector(".answer-form")).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>(
      ".answer-owning-dashboard a",
    );
    expect(link?.textContent).toBe("Open legion");
    const target = new URL(link!.href);
    const fragment = new URLSearchParams(target.hash.slice(1));
    expect(target.origin + target.pathname).toBe(`${peer}/`);
    expect(target.search).toBe("");
    expect(fragment.get("machine")).toBe("legion");
    expect(fragment.get("repo")).toBe("factory-ui");
    expect(fragment.get("question")).toBe("Q9");
    expect(JSON.parse(fragment.get("answerLifecycle")!)).toEqual({
      version: 1,
      machine: "legion",
      repository: "factory-ui",
      question: "Q9",
      id: "123e4567-e89b-42d3-a456-426614174000",
      status: "pending",
    });
    expect(link?.href).not.toContain("secret");
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/fleet",
      `${peer}/api/fleet`,
    ]);
    controller.cleanup();
  });

  test("imports pending lifecycle, cleans the fragment, and waits for Resume", async () => {
    const document = dashboardDocument();
    const migration = {
      version: 1,
      machine: "mini",
      repository: "factory-ui",
      question: "Q9",
      id: "123e4567-e89b-42d3-a456-426614174000",
      status: "pending",
    };
    document.defaultView!.location.hash = new URLSearchParams({
      machine: "mini",
      repo: "factory-ui",
      question: "Q9",
      answerLifecycle: JSON.stringify(migration),
    }).toString();
    const fetcher = vi.fn(async () =>
      jsonResponse(
        fleet("mini", [], [answerableRepository()], {
          enabled: true,
          authRequired: false,
        }),
      ),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(fakeTimers(), { now: () => NOW }),
    );
    await flushPromises();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.defaultView!.location.hash).toBe(
      "#machine=mini&repo=factory-ui&question=Q9",
    );
    expect(
      JSON.parse(
        document.defaultView!.localStorage.getItem(
          "factory-ui.answer-lifecycle.v1",
        )!,
      ),
    ).toEqual([migration]);
    expect(document.querySelector(".answer-resume")?.textContent).toContain(
      "Resume tracking",
    );
    controller.cleanup();
  });

  test("ignores malformed, mismatched, and conflicting lifecycle migrations", () => {
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const cases = [
      "{not-json",
      JSON.stringify({
        version: 1,
        machine: "legion",
        repository: "factory-ui",
        question: "Q9",
        id: answerId,
        status: "pending",
      }),
      JSON.stringify({
        version: 1,
        machine: "mini",
        repository: "missing",
        question: "Q9",
        id: answerId,
        status: "pending",
      }),
    ];
    for (const envelope of cases) {
      const document = dashboardDocument();
      document.defaultView!.location.hash = new URLSearchParams({
        machine: "mini",
        repo: "factory-ui",
        question: "Q9",
        answerLifecycle: envelope,
      }).toString();
      renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);
      expect(
        document.defaultView!.localStorage.getItem(
          "factory-ui.answer-lifecycle.v1",
        ),
      ).toBeNull();
      expect(document.defaultView!.location.hash).toBe(
        "#machine=mini&repo=factory-ui&question=Q9",
      );
    }

    const conflict = dashboardDocument();
    const existing = {
      version: 1,
      machine: "mini",
      repository: "factory-ui",
      question: "Q9",
      id: answerId,
      status: "pending",
    };
    conflict.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([existing]),
    );
    conflict.defaultView!.location.hash = new URLSearchParams({
      machine: "mini",
      repo: "factory-ui",
      question: "Q9",
      answerLifecycle: JSON.stringify({
        ...existing,
        id: "223e4567-e89b-42d3-a456-426614174000",
      }),
    }).toString();
    renderFleet(fleet("mini", [], [answerableRepository()]), conflict, NOW);
    expect(
      JSON.parse(
        conflict.defaultView!.localStorage.getItem(
          "factory-ui.answer-lifecycle.v1",
        )!,
      ),
    ).toEqual([existing]);
  });

  test("imports uncertain payload and idempotency as an explicit retry", () => {
    const document = dashboardDocument();
    const migration = {
      version: 1,
      machine: "mini",
      repository: "factory-ui",
      question: "Q9",
      status: "uncertain",
      payload: { question: "Q9", option: "A", text: "because" },
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    };
    document.defaultView!.location.hash = new URLSearchParams({
      machine: "mini",
      repo: "factory-ui",
      question: "Q9",
      answerLifecycle: JSON.stringify(migration),
    }).toString();
    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);

    expect(
      JSON.parse(
        document.defaultView!.localStorage.getItem(
          "factory-ui.answer-lifecycle.v1",
        )!,
      ),
    ).toEqual([migration]);
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Option: A",
    );
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Text: because",
    );
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Check submission status",
    );
  });

  test("renders terminal rejection exactly and resumes persisted pending records without mislabeling unknown outcomes", async () => {
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const document = dashboardDocument();
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: answerId,
          status: "pending",
        },
      ]),
    );
    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);
    expect(document.querySelector(".answer-resume")?.textContent).toContain(
      "Resume tracking",
    );
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "pending application",
    );
    expect(document.querySelector(".answer-status")?.textContent).not.toBe(
      "rejected",
    );
    const rejected = dashboardDocument();
    rejected.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: answerId,
          status: "rejected",
          reason: "question is terminal",
        },
      ]),
    );
    renderFleet(fleet("mini", [], [answerableRepository()]), rejected, NOW);
    expect(rejected.querySelector(".answer-status")?.textContent).toBe(
      "rejected",
    );
    expect(rejected.querySelector(".answer-reason")?.textContent).toBe(
      "question is terminal",
    );
  });

  test("shows an inert notice for stale local question links", () => {
    const emptyQuestions = answerableRepository({
      questions: { status: "available", data: { open: [] }, warnings: [] },
    });
    const cases = [
      {
        question: "93",
        repository: answerableRepository(),
        hasUnrelated: true,
      },
      {
        question: "Q404",
        repository: answerableRepository(),
        hasUnrelated: true,
      },
      { question: "Q404", repository: emptyQuestions, hasUnrelated: false },
    ];

    for (const { question, repository, hasUnrelated } of cases) {
      const document = dashboardDocument();
      document.defaultView!.location.hash = new URLSearchParams({
        machine: "mini",
        repo: "factory-ui",
        question,
      }).toString();

      renderFleet(fleet("mini", [], [repository]), document, NOW);

      const notice = document.querySelector(".stale-question-notice");
      expect(notice).not.toBeNull();
      if (notice) {
        expect(notice.textContent).toContain("factory-ui");
        expect(notice.textContent).toContain(`question=${question}`);
        expect(notice.textContent).toContain("old");
        expect(notice.textContent).toContain("pull request");
      }
      expect(document.querySelectorAll(".question-queue-entry")).toHaveLength(
        hasUnrelated ? 1 : 0,
      );
      if (hasUnrelated) {
        expect(
          document.querySelector(".question-queue-entry .question-title-text")
            ?.textContent,
        ).toContain("factory-ui/Q9");
        expect(
          document.querySelectorAll(".question-queue-entry .question-options"),
        ).toHaveLength(1);
      }
      expect(document.querySelector(".answer-form") !== null).toBe(
        hasUnrelated,
      );
      expect(
        document.querySelector("fieldset.question-options-edit") !== null,
      ).toBe(hasUnrelated);
      expect(
        document.querySelectorAll('input[type="radio"], input[type="password"]')
          .length > 0,
      ).toBe(hasUnrelated);
      expect(
        Array.from(
          document.querySelectorAll("button"),
          (button) => button.textContent,
        ).includes("Review answer"),
      ).toBe(hasUnrelated);
    }
  });

  test("restores answer controls when a stale link changes to the canonical open question", () => {
    const document = dashboardDocument();
    document.defaultView!.location.hash =
      "#machine=mini&repo=factory-ui&question=9";

    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);

    expect(document.querySelector(".stale-question-notice")).not.toBeNull();
    expect(document.querySelector(".answer-form")).toBeNull();
    document.defaultView!.location.hash =
      "#machine=mini&repo=factory-ui&question=Q9";
    document.defaultView!.dispatchEvent(
      new document.defaultView!.Event("hashchange"),
    );

    expect(document.querySelector(".stale-question-notice")).toBeNull();
    expect(document.querySelector(".answer-form")).not.toBeNull();
    expect(
      document.querySelector("fieldset.question-options-edit"),
    ).not.toBeNull();
  });

  test("does not claim a stale question is missing when its reader is partial or unavailable", () => {
    for (const questions of [
      { status: "partial", data: { open: [] }, warnings: [] },
      { status: "unavailable", warnings: [] },
    ]) {
      const document = dashboardDocument();
      document.defaultView!.location.hash =
        "#machine=mini&repo=factory-ui&question=Q404";
      const repository = answerableRepository({ questions });

      renderFleet(fleet("mini", [], [repository]), document, NOW);

      expect(document.querySelector(".stale-question-notice")).toBeNull();
      expect(document.querySelector(".answer-form")).toBeNull();
    }
  });

  test("resolves a canonical peer link on its exact owning machine", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const local = answerableRepository({
      questions: { status: "available", data: { open: [] }, warnings: [] },
    });
    document.defaultView!.location.hash =
      "#machine=macbook&repo=factory-ui&question=Q9";
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [peer], [local]))
          : jsonResponse(fleet("macbook", [], [answerableRepository()])),
      ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    const entry = document.querySelector(".question-queue-entry-linked")!;
    expect(entry.querySelector(".question-title-text")?.textContent).toContain(
      "macbook/factory-ui/Q9",
    );
    expect(entry.querySelector(".stale-question-notice")).toBeNull();
    expect(entry.querySelector(".answer-form")).toBeNull();
    expect(
      entry.querySelector<HTMLAnchorElement>(".answer-owning-dashboard a")
        ?.href,
    ).toBe(
      "https://macbook.example/#machine=macbook&repo=factory-ui&question=Q9",
    );
  });

  test("keeps a stale canonical deep link inert when its uncertain retry no longer names an open question", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    document.defaultView!.location.hash =
      "#machine=mini&repo=factory-ui&question=Q404";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q404",
          status: "uncertain",
          payload: { question: "Q404", option: "A", text: "because" },
          idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        },
      ]),
    );
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        String(input) === "/api/fleet"
          ? jsonResponse(
              fleet(
                "mini",
                [],
                [
                  answerableRepository({
                    questions: {
                      status: "available",
                      data: { open: [] },
                      warnings: [],
                    },
                  }),
                ],
              ),
            )
          : jsonResponse({ error: "unexpected answer request" }, 500),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, { now: () => NOW }),
    );
    await flushPromises();

    expect(
      document.querySelector(".stale-question-notice")?.textContent,
    ).toContain("No open question factory-ui/Q404");
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "pending application",
    );
    expect(document.querySelector(".answer-error")?.textContent).toBe(
      "Submission status uncertain; operator verification required",
    );
    expect(document.querySelector(".answer-form")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(
      Array.from(
        document.querySelectorAll("button"),
        (button) => button.textContent,
      ),
    ).not.toContain("Check submission status");
    expect(
      fetcher.mock.calls.filter(
        ([, init]) => String(init?.method).toUpperCase() === "POST",
      ),
    ).toHaveLength(0);
    controller.cleanup();
  });

  test("keeps missing-question lifecycle records tracked ahead of stale notices", () => {
    const hostileReason =
      '<img src=x onerror="globalThis.rejectedPwned=1"> closed';
    const cases = [
      ["pending", "pending application"],
      ["accepted", "applied/consumed"],
      ["rejected", "rejected"],
    ] as const;

    for (const [status, label] of cases) {
      const document = dashboardDocument();
      document.defaultView!.location.hash =
        "#machine=mini&repo=factory-ui&question=Q404";
      document.defaultView!.localStorage.setItem(
        "factory-ui.answer-lifecycle.v1",
        JSON.stringify([
          {
            version: 1,
            machine: "mini",
            repository: "factory-ui",
            question: "Q404",
            id: "123e4567-e89b-42d3-a456-426614174000",
            status,
            ...(status === "accepted" ? { actor: "Verified Actor" } : {}),
            ...(status === "rejected" ? { reason: hostileReason } : {}),
          },
        ]),
      );

      const emptyQuestions = answerableRepository({
        questions: { status: "available", data: { open: [] }, warnings: [] },
      });
      renderFleet(fleet("mini", [], [emptyQuestions]), document, NOW);

      expect(document.querySelector("#question-queue-count")?.textContent).toBe(
        "0",
      );
      expect(
        document.querySelector("#question-queue-heading")?.textContent,
      ).toBe("Question queue · 0 open · 1 tracked");
      expect(document.querySelector(".answer-status")?.textContent).toBe(label);
      expect(document.querySelector(".stale-question-notice")).toBeNull();
      expect(document.querySelector(".answer-form")).toBeNull();
      if (status === "rejected") {
        expect(document.querySelector(".answer-reason")?.textContent).toBe(
          hostileReason,
        );
        expect(document.querySelectorAll("img, [onerror]")).toHaveLength(0);
        expect(
          (globalThis as Record<string, unknown>).rejectedPwned,
        ).toBeUndefined();
      }
    }
  });

  test("keeps an unknown polled outcome pending rather than calling it rejected", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q9",
          id: answerId,
          status: "pending",
        },
      ]),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/fleet"
        ? jsonResponse(fleet("mini", [], [answerableRepository()]))
        : jsonResponse({ status: "unknown-record" }, 404),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, { now: () => NOW }),
    );
    await flushPromises();
    const password = document.querySelector<HTMLInputElement>(
      ".answer-resume input[type=password]",
    )!;
    password.value = "shared";
    password.dispatchEvent(new document.defaultView!.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Resume tracking")!
      .click();
    await flushPromises();
    expect(document.querySelector(".answer-status")?.textContent).toBe(
      "pending application",
    );
    expect(document.querySelector(".answer-error")?.textContent).toBe(
      "Outcome record not found",
    );
    expect(document.querySelector(".answer-status")?.textContent).not.toBe(
      "rejected",
    );
    controller.cleanup();
  });

  test("preserves in-progress review state across refresh rerender and cleanup cancels answer polling", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const answerId = "123e4567-e89b-42d3-a456-426614174000";
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/fleet")
          return jsonResponse(fleet("mini", [], [answerableRepository()]));
        if (init?.method === "POST")
          return jsonResponse({ status: "pending", id: answerId }, 202);
        return jsonResponse({ status: "unknown-record" }, 404);
      },
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, {
        randomUUID: () => answerId,
        now: () => NOW,
      }),
    );
    await flushPromises();
    const view = document.defaultView!;
    const option = document.querySelector<HTMLInputElement>(
      ".answer-option input",
    )!;
    option.checked = true;
    option.dispatchEvent(new view.Event("change"));
    const secret = document.querySelector<HTMLInputElement>(
      ".answer-form input[type=password]",
    )!;
    secret.value = "shared";
    secret.dispatchEvent(new view.Event("input"));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Review answer")!
      .click();
    renderFleet(fleet("mini", [], [answerableRepository()]), document, NOW);
    expect(document.querySelector(".answer-form")?.textContent).toContain(
      "Review answer",
    );
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Confirm submission")!
      .click();
    await flushPromises();
    expect(timers.callbacksAt(5_000)).toHaveLength(1);
    controller.cleanup();
    expect(timers.callbacksAt(5_000)).toHaveLength(0);
  });
});

function summaryCells(document: Document, name: string): Array<string | null> {
  return Array.from(
    summaryRow(document, name)?.children ?? [],
    (cell) => cell.textContent,
  );
}

describe("local dashboard rendering", () => {
  test("derives panel and queue question age from valid filed-at at render time while keeping legacy hostile titles inert", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.questionPwned=1">';
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            { id: "Q1", taskId: "T1", title: "Legacy", text: "raw" },
            {
              id: "Q2",
              taskId: "T2",
              title: hostile,
              text: "raw",
              filedAt: "2026-08-15T00:00:00Z",
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panelQuestions = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".questions-panel article.question",
      ),
    );
    const queueQuestions = Array.from(
      document.querySelectorAll<HTMLElement>(".question-queue-entry"),
    );
    const panelLegacy = panelQuestions.find((item) =>
      item.textContent?.includes("Legacy"),
    );
    const panelTimestamped = panelQuestions.find((item) =>
      item.textContent?.includes(hostile),
    );
    const queueLegacy = queueQuestions.find((item) =>
      item.textContent?.includes("Legacy"),
    );
    const queueTimestamped = queueQuestions.find((item) =>
      item.textContent?.includes(hostile),
    );
    expect(panelTimestamped?.textContent).toContain("36h ago");
    expect(queueTimestamped?.textContent).toContain("36h ago");
    expect(panelLegacy?.textContent).not.toContain("ago");
    expect(queueLegacy?.textContent).not.toContain("ago");
    expect(
      document.querySelectorAll(".questions-panel img, #question-queue img"),
    ).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).questionPwned,
    ).toBeUndefined();

    renderFleet(
      fleet("mini", [], [repository]),
      document,
      new Date("2026-08-17T12:00:00.000Z"),
    );
    expect(document.querySelector(".questions-panel")?.textContent).toContain(
      "2d ago",
    );
    expect(
      document.querySelector("#question-queue-list")?.textContent,
    ).toContain("2d ago");
  });

  test("renders ordered structured questions, old-schema fallbacks, and hostile strings as text", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.queuePwned=1">';
    const alpha = richRepository({
      name: "alpha",
      planUrl: "https://github.com/example/alpha/blob/HEAD/.factory/plan.md",
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q10",
              taskId: "T10",
              title: "Later",
              text: "source",
              context: "Structured context",
              options: [{ label: "A", text: "Proceed", recommended: true }],
              qualifier: "For A, confirm approval.",
              branch: "factory/t10-later",
              branchUrl:
                "https://github.com/example/alpha/tree/factory/t10-later",
              blockedTask: {
                id: "T10",
                title: "Later task",
                pr: 10,
                issueNumbers: [101],
                prUrl: "https://github.com/example/alpha/pull/10",
                issueUrls: ["https://github.com/example/alpha/issues/101"],
              },
            },
            { id: "Q2", taskId: "T2", title: hostile, text: hostile },
          ],
        },
        warnings: [],
      },
    });
    const zeta = richRepository({
      name: "zeta",
      questions: {
        status: "available",
        data: {
          open: [{ id: "Q1", taskId: "T1", title: "Last", text: "raw" }],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [zeta, alpha]), document, NOW);

    expect(document.querySelector("#question-queue-heading")?.textContent).toBe(
      "Question queue · 3",
    );
    expect(document.querySelector("#question-queue-count")?.textContent).toBe(
      "3",
    );
    expect(
      Array.from(
        document.querySelectorAll(
          ".question-queue-entry h3 .question-title-text",
        ),
        (node) => node.textContent,
      ),
    ).toEqual([`alpha/Q2 · ${hostile}`, "alpha/Q10 · Later", "zeta/Q1 · Last"]);
    const structured = document.querySelectorAll<HTMLElement>(
      ".question-queue-entry",
    )[1]!;
    expect(structured.textContent).toContain("mini · alpha");
    expect(structured.textContent).toContain("Blocked task: T10 · Later task");
    expect(structured.textContent).toContain(
      "factory/t10-later · PR #10 · Issue #101",
    );
    expect(structured.textContent).toContain("Structured context");
    expect(structured.textContent).toContain("A · Proceed(recommended)");
    expect(structured.textContent).toContain("For A, confirm approval.");
    expect(structured.querySelector("pre")).toBeNull();
    expect(document.querySelectorAll(".question-queue-entry pre")).toHaveLength(
      0,
    );
    expect(document.querySelector("#question-queue-list .age")).toBeNull();
    expect(
      Array.from(
        structured.querySelectorAll<HTMLAnchorElement>("a"),
        (link) => link.href,
      ),
    ).toEqual([
      "https://dashboard.test/#machine=mini&repo=alpha&question=Q10",
      "https://github.com/example/alpha/blob/HEAD/.factory/plan.md",
      "https://github.com/example/alpha/tree/factory/t10-later",
      "https://github.com/example/alpha/pull/10",
      "https://github.com/example/alpha/issues/101",
    ]);
    expect(
      document.querySelectorAll(
        "#question-queue-list img, #question-queue-list [onerror]",
      ),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).queuePwned).toBeUndefined();
  });

  test("uses the same proportional fallback body in repository and queue cards without rendering source markup", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.questionPwned=1">';
    const source = `## Q88 (task T8, open) — Choose a safe path
Context: Keep ${hostile} visible as text while this hard-wrapped
paragraph remains readable.
Options considered: Continue with the bounded reader and
document the limit / Remove the limit and
accept unbounded input.
**A:**`;
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          // A mixed-version peer has only its verbatim source text, so the
          // shared renderer must use its readable fallback in both surfaces.
          open: [
            {
              id: "Q88",
              taskId: "T8",
              title: "Choose a safe path",
              text: source,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panelBody = document.querySelector<HTMLElement>(
      ".questions-panel .question-body",
    );
    const queueBody = document.querySelector<HTMLElement>(
      ".question-queue-entry .question-body",
    );
    expect(panelBody?.textContent).toBe(queueBody?.textContent);
    expect(panelBody?.textContent).toContain(
      `Keep ${hostile} visible as text while this hard-wrapped paragraph remains readable.`,
    );
    expect(panelBody?.textContent).toContain(
      "Continue with the bounded reader and document the limit / Remove the limit and accept unbounded input.",
    );
    expect(panelBody?.textContent).toContain("Context:");
    expect(panelBody?.textContent).toContain("Options considered:");
    expect(
      Array.from(
        panelBody?.querySelectorAll("h4.question-field-label") ?? [],
        (field) => field.textContent,
      ),
    ).toEqual(["Context:", "Options considered:"]);
    expect(panelBody?.textContent).not.toContain("## Q88");
    expect(panelBody?.textContent).not.toContain("**A:**");
    expect(
      document.querySelectorAll(".question-body pre, .question-body img"),
    ).toHaveLength(0);
    expect(document.querySelectorAll(".question-body [onerror]")).toHaveLength(
      0,
    );
    expect(
      (globalThis as Record<string, unknown>).questionPwned,
    ).toBeUndefined();
  });

  test("renders bounded inline code spans in question bodies and rejected answers without changing task or worklog text", () => {
    const document = dashboardDocument();
    const script = "<script>globalThis.inlineCodePwned = true</script>";
    document.defaultView!.localStorage.setItem(
      "factory-ui.answer-lifecycle.v1",
      JSON.stringify([
        {
          version: 1,
          machine: "mini",
          repository: "factory-ui",
          question: "Q90",
          id: "123e4567-e89b-42d3-a456-426614174000",
          status: "rejected",
          reason: "Rejected `reason one` and `reason two`.",
        },
      ]),
    );
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q90",
              taskId: "T90",
              title: "Structured inline code",
              text: "source",
              context: `Use \`context one\`, \`context two\`, and \`${script}\`.`,
              options: [
                {
                  label: "A",
                  text: "Choose `option one` then `option two`.",
                },
                {
                  label: "B",
                  text: "`policy (recommended) value`",
                  recommended: true,
                },
                {
                  label: "C",
                  text: "Use (recommended: run `--safe`)",
                  recommended: true,
                },
                {
                  label: "D",
                  text: "Use (recommended: call `foo()` now)",
                  recommended: true,
                },
              ],
              qualifier: "Only `the owner` may proceed.",
            },
            {
              id: "Q91",
              taskId: "T91",
              title: "Prose inline code",
              text: "source",
              context: "Read `prose context`.",
              proseOptions: ["Describe `prose option`."],
            },
            {
              id: "Q92",
              taskId: "T92",
              title: "Fallback inline code",
              text: `## Q92 (task T92, open) — Fallback inline code
Context: Keep \`fallback context\` visible.
Options considered: Select \`fallback option\`.
**A:**`,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const questionBody = (surface: "panel" | "queue", id: string) => {
      const entries = document.querySelectorAll<HTMLElement>(
        surface === "panel"
          ? ".questions-panel article.question"
          : ".question-queue-entry",
      );
      return Array.from(entries)
        .find((entry) => entry.textContent?.includes(`factory-ui/${id}`))
        ?.querySelector<HTMLElement>(".question-body");
    };
    const codeText = (body: HTMLElement | null | undefined) =>
      Array.from(
        body?.querySelectorAll("code") ?? [],
        (code) => code.textContent,
      );

    for (const surface of ["panel", "queue"] as const) {
      expect(codeText(questionBody(surface, "Q90"))).toEqual([
        "context one",
        "context two",
        script,
        "option one",
        "option two",
        "policy (recommended) value",
        "--safe",
        "foo()",
        "the owner",
      ]);
      expect(codeText(questionBody(surface, "Q91"))).toEqual([
        "prose context",
        "prose option",
      ]);
      expect(codeText(questionBody(surface, "Q92"))).toEqual([
        "fallback context",
        "fallback option",
      ]);
    }
    expect(
      codeText(
        document.querySelector<HTMLElement>(
          ".question-queue-entry .answer-reason",
        ),
      ),
    ).toEqual(["reason one", "reason two"]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).inlineCodePwned,
    ).toBeUndefined();
    expect(
      document.querySelector(".active-work .task-title")?.textContent,
    ).toContain("Safe dashboard");
    expect(document.querySelector(".worklog-panel")?.textContent).toContain(
      "Built dashboard",
    );
  });

  test.each([
    ["unbalanced", "Keep `an opening delimiter literal."],
    ["nested delimiters", "Keep `outer `inner` text` literal."],
    ["multi-backtick delimiters", "Keep ``two ticks`` literal."],
    [
      "more than 32 spans",
      Array.from({ length: 33 }, (_, index) => `\`span ${index + 1}\``).join(
        " ",
      ),
    ],
    ["a span longer than 1024 code points", `\`${"x".repeat(1025)}\``],
  ])("keeps %s wholly literal in both question surfaces", (_kind, context) => {
    const document = dashboardDocument();
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q93",
              taskId: "T93",
              title: "Invalid inline code",
              text: "source",
              context,
              options: [{ label: "A", text: "Proceed" }],
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    for (const selector of [
      ".questions-panel .question-context",
      ".question-queue-entry .question-context",
    ]) {
      const field = document.querySelector<HTMLElement>(selector);
      expect(field?.textContent).toBe(context);
      expect(field?.querySelector("code")).toBeNull();
    }
  });

  test("keeps every paragraph literal when a question field exceeds the code-span cap", () => {
    const document = dashboardDocument();
    const context = Array.from({ length: 2 }, (_, paragraph) =>
      Array.from(
        { length: 20 },
        (_, span) => `\`paragraph ${paragraph}-${span}\``,
      ).join(" "),
    ).join("\n\n");
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q94",
              taskId: "T94",
              title: "Capped paragraphs",
              text: "source",
              context,
              options: [{ label: "A", text: "Proceed" }],
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    for (const selector of [
      ".questions-panel .question-context",
      ".question-queue-entry .question-context",
    ]) {
      const fields = document.querySelectorAll<HTMLElement>(selector);
      expect(fields).toHaveLength(2);
      expect(
        Array.from(fields, (field) => field.textContent).join("\n\n"),
      ).toBe(context);
      expect(
        Array.from(fields).every((field) => !field.querySelector("code")),
      ).toBe(true);
    }
  });

  test("keeps the free-text-only fallback when structured options have no labels", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q89",
              taskId: "T9",
              title: "Choose a migration",
              text: "source",
              context: "Choose the least disruptive migration.",
              proseOptions: ["Keep the current format", "Migrate now"],
            },
          ],
        },
        warnings: [],
      },
    });

    expect(() =>
      renderFleet(fleet("mini", [], [repository]), document, NOW),
    ).not.toThrow();
    const queueEntry = document.querySelector(".question-queue-entry");
    expect(queueEntry?.textContent).toContain("Keep the current format");
    expect(queueEntry?.textContent).toContain("Migrate now");
    expect(queueEntry?.querySelectorAll(".question-options")).toHaveLength(1);
    expect(
      queueEntry?.querySelector("fieldset.question-options-edit"),
    ).toBeNull();
    expect(queueEntry?.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(queueEntry?.querySelector('input[type="text"]')).not.toBeNull();
  });

  test("caps the globally ordered question queue while retaining its total", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const questionsFor = (repository: string) =>
      Array.from({ length: 128 }, (_, index) => ({
        id: `Q${index + 1}`,
        taskId: `T${index + 1}`,
        title: `${repository} question ${index + 1}`,
        text: "open",
      }));
    const repositoryWithQuestions = (name: string) =>
      richRepository({
        name,
        questions: {
          status: "available",
          data: { open: questionsFor(name) },
          warnings: [],
        },
      });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      String(input) === "/api/fleet"
        ? Promise.resolve(
            jsonResponse(
              fleet(
                "mini",
                [peer],
                [
                  repositoryWithQuestions("zeta"),
                  repositoryWithQuestions("beta"),
                ],
              ),
            ),
          )
        : Promise.resolve(
            jsonResponse(
              fleet("macbook", [], [repositoryWithQuestions("alpha")]),
            ),
          ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(document.querySelector("#question-queue-count")?.textContent).toBe(
      "384",
    );
    expect(document.querySelector("#question-queue-heading")?.textContent).toBe(
      "Question queue · 384 · showing 256",
    );
    expect(document.querySelectorAll(".question-queue-entry")).toHaveLength(
      256,
    );
    expect(
      Array.from(
        document.querySelectorAll(
          ".question-queue-entry h3 .question-title-text",
        ),
        (node) => node.textContent,
      ),
    ).toEqual([
      ...Array.from(
        { length: 128 },
        (_, index) => `alpha/Q${index + 1} · alpha question ${index + 1}`,
      ),
      ...Array.from(
        { length: 128 },
        (_, index) => `beta/Q${index + 1} · beta question ${index + 1}`,
      ),
    ]);
  });

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
    expect(Array.from(card.children, (child) => child.classList[1])).toEqual([
      "routing-panel",
      "current-panel",
      "logs-panel",
      "questions-panel",
      "active-work",
      "review-work",
      "runnable-work",
      "blocked-work",
      "worklog-panel",
      "warnings-panel",
      "panel-span-12",
      "completed-work",
    ]);
    for (const selector of [
      ".current-panel",
      ".logs-panel",
      ".questions-panel",
    ]) {
      expect(card.querySelector(selector)?.classList).toContain("panel-span-4");
    }
    for (const selector of [
      ".active-work",
      ".review-work",
      ".runnable-work",
      ".blocked-work",
      ".completed-work",
      ".review-strip",
    ]) {
      expect(card.querySelector(selector)?.classList).toContain(
        "panel-span-12",
      );
    }
    expect(card.querySelector(".worklog-panel")?.classList).toContain(
      "panel-span-8",
    );
    expect(card.querySelector(".warnings-panel")?.classList).toContain(
      "panel-span-4",
    );
    expect(card.lastElementChild?.querySelector("h4")?.textContent).toBe(
      "Completed",
    );
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

  test("collapses empty task groups without table headers", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: {
          ...richRepository().plan.data,
          active: [],
          review: [],
          nextRunnable: [],
          blocked: [],
          completed: [],
        },
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const strip = document.querySelector(".empty-task-groups")!;
    expect(strip.classList).toContain("panel-span-12");
    expect(strip.querySelectorAll(".empty-task-group")).toHaveLength(4);
    expect(
      Array.from(strip.querySelectorAll(".empty-task-group"), (group) =>
        group.textContent?.trim(),
      ),
    ).toEqual([
      "Active · None",
      "In review · None",
      "Next runnable · None",
      "Blocked · None",
    ]);
    expect(strip.querySelector("table, thead")).toBeNull();
    const completed = document.querySelector(".completed-work")!;
    expect(completed.textContent).toBe("CompletedNone");
    expect(completed.querySelector("table, thead")).toBeNull();
  });

  test("restores a full task table when an empty group gains work on refresh", () => {
    const document = dashboardDocument();
    const base = richRepository();
    const empty = {
      ...base,
      plan: {
        ...base.plan,
        data: { ...base.plan.data, active: [] },
      },
    };

    renderFleet(fleet("mini", [], [empty]), document, NOW);
    expect(
      Array.from(
        document.querySelectorAll(".empty-task-group"),
        (group) => group.textContent,
      ),
    ).toContain("Active · None");
    expect(document.querySelector(".active-work")).toBeNull();

    renderFleet(fleet("mini", [], [base]), document, NOW);
    expect(document.querySelector(".active-work thead")).not.toBeNull();
    expect(document.querySelector(".active-work tbody .task")).not.toBeNull();
    expect(
      Array.from(
        document.querySelectorAll(".empty-task-group"),
        (group) => group.textContent,
      ),
    ).not.toContain("Active · None");
  });

  test("moves repository availability into Current and sizes worklog around warnings", () => {
    const document = dashboardDocument();
    const base = richRepository();
    const clean = richRepository({
      logs: { ...base.logs, status: "available", warnings: [] },
    });
    renderFleet(fleet("mini", [], [clean]), document, NOW);

    expect(document.querySelector(".repository > header")).toBeNull();
    expect(
      document.querySelector(".current-panel h4 .status.available")
        ?.textContent,
    ).toBe("AVAILABLE");
    expect(document.querySelector(".warnings-panel")).toBeNull();
    expect(document.querySelector(".worklog-panel")?.classList).toContain(
      "panel-span-12",
    );

    renderFleet(
      fleet("mini", [], [richRepository({ warning: "snapshot incomplete" })]),
      document,
      NOW,
    );
    expect(document.querySelector(".warnings-panel")).not.toBeNull();
    expect(document.querySelector(".worklog-panel")?.classList).toContain(
      "panel-span-8",
    );

    renderFleet(fleet("mini", [], [clean]), document, NOW);
    expect(document.querySelector(".warnings-panel")).toBeNull();
    expect(document.querySelector(".worklog-panel")?.classList).toContain(
      "panel-span-12",
    );
  });

  test("keeps task metadata in distinct table cells with size guidance, costs, dependencies, and safe references", () => {
    const document = dashboardDocument();
    const tasks = ["trivial", "standard", "major"].map((size, index) => ({
      ...richRepository().plan.data.tasks[0],
      id: `T${index + 1}`,
      size,
      title: `${size} task`,
      dependencies: index === 0 ? ["T99"] : [],
      pr: index === 0 ? 42 : undefined,
      issueNumbers: index === 0 ? [17] : [],
      prUrl:
        index === 0
          ? "https://github.com/example/factory-ui/pull/42"
          : undefined,
      issueUrls:
        index === 0 ? ["https://github.com/example/factory-ui/issues/17"] : [],
    }));
    const repository = richRepository({
      costs: costs({ T1: costCounters(1.23, 123) }),
      plan: {
        ...richRepository().plan,
        data: { ...richRepository().plan.data, tasks, active: tasks },
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const table = document.querySelector<HTMLTableElement>(
      ".active-work .task-table",
    )!;
    expect(table.querySelector("th:nth-child(3)")?.getAttribute("title")).toBe(
      "trivial: small, skips size gates · standard: one session, merges when clean · major: PR held for review",
    );
    const rows = Array.from(
      table.querySelectorAll<HTMLTableRowElement>("tbody tr.task"),
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.map((row) => Array.from(row.children, (cell) => cell.className)),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        "task-id",
        "task-title",
        "task-size task-numeric",
        "task-cost-cell task-numeric",
        "task-review",
        "task-references",
      ]),
    );
    expect(
      rows.map((row) => row.querySelector<HTMLElement>(".task-size")?.title),
    ).toEqual([
      "small, skips size gates",
      "one session, merges when clean",
      "PR held for review",
    ]);
    expect(rows[0]!.querySelector(".task-deps")?.textContent).toBe("deps: T99");
    expect(rows[0]!.querySelector(".task-cost")?.textContent).toBe("$1.23");
    expect(rows[0]!.querySelector<HTMLElement>(".task-cost-cell")?.title).toBe(
      "metered · 123 tokens",
    );
    expect(rows[0]!.querySelector(".task-cost")?.classList).toContain(
      "cost-metered",
    );
    expect(rows[0]!.querySelector(".task-cost-detail")?.textContent).toBe(
      "metered · 123 tokens",
    );
    expect(rows[0]!.querySelector(".task-size-chip")?.textContent).toBe(
      "trivial",
    );
    expect(rows[0]!.querySelector(".task-review")?.textContent).toBe("");
    expect(
      Array.from(
        rows[0]!.querySelectorAll<HTMLAnchorElement>(".task-references a"),
        (link) => [link.textContent, link.href],
      ),
    ).toEqual([
      ["PR #42", "https://github.com/example/factory-ui/pull/42"],
      ["Fixes #17", "https://github.com/example/factory-ui/issues/17"],
    ]);
  });

  test("renders a prototype-named task size with the fallback legend", () => {
    const document = dashboardDocument();
    const task = {
      ...richRepository().plan.data.tasks[0],
      size: "constructor",
    };
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: { ...richRepository().plan.data, tasks: [task], active: [task] },
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const size = document.querySelector<HTMLElement>(
      ".active-work .task-size",
    )!;
    expect(size.textContent).toBe("constructor");
    expect(size.title).toBe(
      "trivial: small, skips size gates · standard: one session, merges when clean · major: PR held for review",
    );
  });

  test("uses a compact empty questions strip but full panels for questions and unavailable data", () => {
    const emptyDocument = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            questions: {
              status: "available",
              data: { open: [] },
              warnings: [],
            },
          }),
        ],
      ),
      emptyDocument,
      NOW,
    );
    const compact = emptyDocument.querySelector("section.questions-compact")!;
    expect(compact.textContent).toBe("Open questions · 0 · None");
    expect(compact.classList.contains("panel")).toBe(false);
    expect(compact.classList).toContain("panel-span-4");
    expect(emptyDocument.querySelector(".questions-panel")).toBeNull();

    const unavailableDocument = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            questions: { status: "unavailable", warnings: [] },
          }),
        ],
      ),
      unavailableDocument,
      NOW,
    );
    expect(unavailableDocument.querySelector(".questions-compact")).toBeNull();
    expect(
      unavailableDocument.querySelector(".questions-panel")?.classList,
    ).toContain("panel-span-4");
    expect(
      unavailableDocument.querySelector(".questions-panel")?.textContent,
    ).toContain("Unavailable");
  });

  test("renders visible, classed metered and prepaid task costs while leaving missing entries blank", () => {
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
    expect(active.querySelector(".task-cost")?.textContent).toBe("$1.23");
    expect(active.querySelector(".task-cost")?.classList).toContain(
      "cost-metered",
    );
    expect(active.querySelector<HTMLElement>(".task-cost-cell")?.title).toBe(
      "metered · 123 tokens",
    );
    expect(active.querySelector(".task-cost-detail")?.textContent).toBe(
      "metered · 123 tokens",
    );
    const review = document.querySelector(".review-work .task")!;
    expect(review.querySelector(".task-cost")?.textContent).toBe("Prepaid");
    expect(review.querySelector(".task-cost")?.classList).toContain(
      "cost-prepaid",
    );
    expect(review.querySelector<HTMLElement>(".task-cost-cell")?.title).toBe(
      "subscription · 456 tokens",
    );
    expect(review.querySelector(".task-cost-detail")?.textContent).toBe(
      "subscription · 456 tokens",
    );
    const missing = document.querySelector<HTMLElement>(
      ".runnable-work .task-cost-cell",
    )!;
    expect(missing.textContent).toBe("");
    expect(missing.title).toBe("");

    const row = document.querySelector(".repository-summary tbody tr")!;
    expect(row.querySelector(".cost-total")?.textContent).toBe("$1.23 metered");
    const overhead = row.querySelector<HTMLElement>(".cost-unattributed")!;
    expect(overhead.textContent).toBe("Prepaidsubscription · 789 tokens");
    expect(overhead.classList).toContain("cost-prepaid");
    expect(row.querySelector<HTMLElement>(".cost-unattributed")?.title).toBe(
      "789 tokens",
    );
    expect(overhead.querySelector(".cost-detail")?.textContent).toBe(
      "subscription · 789 tokens",
    );
    expect(
      summaryRow(document, "mini")?.querySelector(".cost-total")?.textContent,
    ).toBe("$1.23 metered");
    const overheadHeader = document.querySelector<HTMLTableCellElement>(
      ".repository-summary thead th:last-child",
    )!;
    expect(overheadHeader.textContent).toBe("Factory overhead");
    expect(overheadHeader.title).toBe(
      "Factory session usage not assigned to a task",
    );
  });

  test("distinguishes absent and unavailable factory overhead from prepaid overhead", () => {
    const absentDocument = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [richRepository({ costs: costs({ T8: costCounters(1.23, 123) }) })],
      ),
      absentDocument,
      NOW,
    );
    const absent = absentDocument.querySelector<HTMLElement>(
      ".repository-summary .cost-unattributed",
    )!;
    expect(absent.textContent).toBe("None recorded");
    expect(absent.classList).toContain("cost-absent");
    expect(absent.classList).toContain("empty");
    expect(absent.classList).not.toContain("unavailable");

    const unavailableDocument = dashboardDocument();
    renderFleet(
      fleet("mini", [], [richRepository()]),
      unavailableDocument,
      NOW,
    );
    const unavailable = unavailableDocument.querySelector<HTMLElement>(
      ".repository-summary .cost-unattributed",
    )!;
    expect(unavailable.textContent).toBe("Unavailable");
    expect(unavailable.classList).toContain("unavailable");
    expect(unavailable.classList).not.toContain("cost-absent");
    expect(unavailable.classList).not.toContain("cost-prepaid");
  });

  test("labels absent tasks and unattributed usage as partial in a retained recent costs window", () => {
    const document = dashboardDocument();
    const complete = costs({ T8: costCounters(1.23, 123) });
    const repository = richRepository({
      costs: {
        ...complete,
        status: "partial",
        data: {
          ...complete.data,
          coverage: { kind: "recent-window", retainedTaskCount: 1 },
        },
        warnings: [
          {
            code: "COSTS_RECENT_WINDOW",
            message: "older task entries omitted",
          },
        ],
      },
    });
    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const absentTask = document.querySelector<HTMLElement>(
      ".review-work .task-cost-cell",
    )!;
    expect(absentTask.textContent).toBe("Partial");
    expect(absentTask.title).toBe(
      "This task was not present in the bounded recent costs window.",
    );
    const overhead = document.querySelector<HTMLElement>(
      ".repository-summary .cost-unattributed",
    )!;
    expect(overhead.textContent).toBe("Partial");
    expect(overhead.title).toBe(
      "Factory overhead was not present in the bounded recent costs window.",
    );
    expect(
      document.querySelector(".repository-summary .cost-total")?.textContent,
    ).toBe("$1.23 (partial) metered");
    const machine = summaryRow(document, "mini")!.querySelector<HTMLElement>(
      ".cost-total",
    )!;
    expect(machine.textContent).toBe("$1.23 (partial) metered");
    expect(machine.title).toContain("recent-window repositories: factory-ui");
  });

  test("styles prepaid, metered, and absent cost states distinctly while keeping token detail visible", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();

    expect(css).toMatch(
      /\.cost-prepaid\s*\{[^}]*color:\s*var\(--color-accent\);/s,
    );
    expect(css).toMatch(
      /\.cost-metered\s*\{[^}]*color:\s*var\(--color-good\);/s,
    );
    expect(css).toMatch(
      /\.cost-absent\s*\{[^}]*color:\s*var\(--color-muted\);[^}]*font-style:\s*italic;/s,
    );
    expect(css).toMatch(
      /\.task-cost-detail,\s*\.cost-detail\s*\{[^}]*display:\s*block;/s,
    );
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
    expect(task.querySelector(".task-cost")?.textContent).toBe("$7.50");
    const taskNotional = task.querySelector<HTMLElement>(".task-notional")!;
    expect(taskNotional.textContent).toBe("~$6.00");
    expect(task.querySelector<HTMLElement>(".task-cost-cell")?.title).toContain(
      "metered · 3,000,000 tokens · ~$6.00 at list (partial); notional (partial):",
    );
    expect(taskNotional.title).toContain("at models.dev list price");
    expect(taskNotional.title).toBe(
      "notional (partial): subscription lane priced at models.dev list price as of 2026-08-16; not billed",
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
    expect(document.querySelector(".task-cost")?.textContent).toBe("Prepaid");
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

    expect(document.querySelector(".task-cost")?.textContent).toBe("Prepaid");
    expect(document.querySelector(".task-notional")?.textContent).toBe(
      "~$3.00",
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

    expect(document.querySelector(".task-cost")?.textContent).toBe("$4.50");
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

  test("sums all available costs in the machine summary", () => {
    const document = dashboardDocument();
    const alpha = richRepository({
      name: "alpha",
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: { "openai/gpt-5.6": routingModel() },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(1, { input: 1_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, { input: 1_000_000 }),
          },
        },
      }),
    });
    const beta = richRepository({
      name: "beta",
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: { "openai/gpt-5.6": routingModel() },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(2, { input: 2_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, { input: 2_000_000 }),
          },
        },
      }),
    });

    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);

    const total = summaryRow(document, "mini")!.querySelector<HTMLElement>(
      ".cost-total",
    )!;
    expect(total.childNodes[0]?.textContent).toBe("$3.00 metered");
    expect(total.querySelector(".notional-total")?.textContent).toBe(
      "~$3.00 at list",
    );
  });

  test("labels partial machine metered and notional totals", () => {
    const document = dashboardDocument();
    const alpha = richRepository({
      name: "alpha",
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: { "openai/gpt-5.6": routingModel() },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(1, { input: 1_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, { input: 1_000_000 }),
          },
        },
      }),
    });
    const beta = richRepository({
      name: "beta",
      costs: {
        status: "unavailable",
        warnings: [{ code: "COSTS_MISSING", message: "costs unavailable" }],
      },
    });
    const gamma = richRepository({
      name: "gamma",
      routing: {
        ...richRepository().routing,
        data: {
          ...richRepository().routing.data,
          models: { "openai/gpt-5.6": routingModel() },
        },
      },
      costs: costs({
        T8: {
          ...tokenCounters(2, { input: 2_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, { input: 2_000_000 }),
          },
        },
      }),
    });
    renderFleet(fleet("mini", [], [alpha, beta, gamma]), document, NOW);

    const total = summaryRow(document, "mini")!.querySelector<HTMLElement>(
      ".cost-total",
    )!;
    expect(total.childNodes[0]?.textContent).toBe(
      "$3.00 (partial) (2 of 3 repos) metered",
    );
    expect(total.title).toContain("beta");
    const notional = total.querySelector<HTMLElement>(".notional-total")!;
    expect(notional.textContent).toBe("~$3.00 at list (2 of 3 repos)");
    expect(notional.title).toContain("beta");
  });

  test("renders machine totals as unavailable when no repository has costs", () => {
    const document = dashboardDocument();
    const alpha = richRepository({
      name: "alpha",
      costs: {
        status: "unavailable",
        warnings: [{ code: "COSTS_MISSING", message: "costs unavailable" }],
      },
    });
    const beta = richRepository({
      name: "beta",
      costs: {
        status: "unavailable",
        warnings: [{ code: "COSTS_MISSING", message: "costs unavailable" }],
      },
    });

    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);

    const total = summaryRow(document, "mini")!.querySelector(".cost-total")!;
    expect(total.textContent).toBe("Unavailable");
    expect(total.querySelector(".notional-total")).toBeNull();
  });

  test("guards non-finite machine metered and notional aggregates", () => {
    const document = dashboardDocument();
    const alpha = richRepository({
      name: "alpha",
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
          ...tokenCounters(Number.MAX_VALUE, { input: 1_000_000 }),
          byModel: {
            "openai/gpt-5.6": tokenCounters(0, { input: 1_000_000 }),
          },
        },
      }),
    });
    const beta = richRepository({
      ...alpha,
      name: "beta",
    });

    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);

    const total = summaryRow(document, "mini")!.querySelector(".cost-total")!;
    expect(total.textContent).toBe("Unavailable");
    expect(total.querySelector(".notional-total")).toBeNull();
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
      /^Stale · last good snapshot less than 1m ago/,
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

  test("uses the canonical visual primitives and token-only type scale", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();

    expect(css.match(/--text-(?:xs|sm|base|lg|xl):/g)).toHaveLength(5);
    expect(
      Array.from(
        css.matchAll(/font-size:\s*([^;]+);/g),
        (match) => match[1] ?? "",
      ),
    ).toSatisfy((values) =>
      values.every((value) =>
        /^var\(--text-(?:xs|sm|base|lg|xl)\)$/.test(value),
      ),
    );
    expect(css).toMatch(
      /\.chip,[\s\S]*\.status,[\s\S]*\.badge,[\s\S]*\.review-chip,[\s\S]*\.worklog-chip/s,
    );
    expect(css).toMatch(
      /\.button,[\s\S]*\.worklog-toggle,[\s\S]*\.completed-tasks-toggle/s,
    );
    expect(css).toMatch(/\.tab,[\s\S]*\.machine-tab,[\s\S]*\.repository-tab/s);
    expect(css).toMatch(
      /\.panel-title,[\s\S]*\.review-strip h4,[\s\S]*\.questions-compact h4,[\s\S]*\.panel h4/s,
    );
    expect(css).toMatch(/body\s*\{[^}]*line-height:\s*1\.5;/s);
    expect(css).toMatch(/h1\s*\{[^}]*font-size:\s*var\(--text-xl\);/s);
    expect(css).toMatch(/h2,[\s\S]*font-size:\s*var\(--text-lg\);/s);
    expect(css).toMatch(/h3\s*\{[^}]*font-size:\s*var\(--text-base\);/s);
    expect(css).toMatch(/h4,[\s\S]*font-size:\s*var\(--text-xs\);/s);
    expect(css).toMatch(
      /#error:empty,[\s\S]*#how-error:empty\s*\{[^}]*display:\s*none;/s,
    );
    expect(css).toMatch(
      /\.numeric-cell\s*\{[^}]*text-align:\s*right !important;[^}]*font-variant-numeric:\s*tabular-nums;/s,
    );
    expect(
      Array.from(
        css.matchAll(/--color-focus:\s*([^;]+);/g),
        (match) => match[1]?.trim() ?? "",
      ),
    ).toSatisfy((values) =>
      values.every((value) => !/^#fff(?:fff)?\b/i.test(value)),
    );
    expect(css).toMatch(/\.empty\s*\{[^}]*color:\s*var\(--color-muted\);/s);
    expect(css.match(/text-transform:\s*uppercase;/g)).toHaveLength(5);
    expect(css.match(/letter-spacing:/g)).toHaveLength(5);
    for (const selector of [
      ".repository-summary thead th",
      "#fleet-summary thead th",
      ".panel-title",
      ".review-strip thead th",
      ".task-table thead th",
    ]) {
      expect(css).toContain(selector);
    }
  });

  test("uses em dashes for applicable empty summary cells and numeric-cell alignment", () => {
    const document = dashboardDocument();
    const repository = richRepository({
      state: {
        status: "available",
        data: { currentTask: null, pr: null, hold: false },
        warnings: [],
      },
      questions: { status: "available", data: { open: [] }, warnings: [] },
      worklog: { status: "available", data: { entries: [] }, warnings: [] },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    for (const row of [
      summaryRow(document, "mini")!,
      document.querySelector<HTMLTableRowElement>(
        ".repository-summary tbody tr",
      )!,
    ]) {
      expect(
        Array.from(row.children, (cell) => cell.textContent),
      ).not.toContain("");
      expect(Array.from(row.children, (cell) => cell.textContent)).toContain(
        "—",
      );
      expect(row.querySelectorAll(".numeric-cell")).toHaveLength(
        row.closest(".repository-summary") ? 4 : 3,
      );
    }
    expect(summaryCells(document, "mini")).toEqual([
      "mini",
      "RUNNING",
      "—",
      "—",
      "—",
      "0",
      "—",
      "Unavailable",
    ]);
  });

  test("keeps task scrolling horizontally contained while allowing vertical page chaining", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(css).toMatch(/\.task-list-scroll\s*\{[^}]*max-height: 24rem;/s);
    expect(css).toMatch(/\.task-list-scroll\s*\{[^}]*overflow: auto;/s);
    expect(css).toMatch(/\.task-table-scroll\s*\{[^}]*overflow-x: auto;/s);
    for (const selector of [".task-table-scroll", ".task-list-scroll"]) {
      const escaped = selector.replace(".", "\\.");
      expect(css).toMatch(
        new RegExp(
          `${escaped}\\s*\\{[^}]*overscroll-behavior-x:\\s*contain;`,
          "s",
        ),
      );
      expect(css).toMatch(
        new RegExp(
          `${escaped}\\s*\\{[^}]*overscroll-behavior-y:\\s*auto;`,
          "s",
        ),
      );
      expect(css).not.toMatch(
        new RegExp(`${escaped}\\s*\\{[^}]*overscroll-behavior\\s*:`, "s"),
      );
    }
    expect(css).toMatch(/\.task-table thead th\s*\{[^}]*position: sticky;/s);
    expect(css).toMatch(/\.task-table\s*\{[^}]*table-layout: fixed;/s);
    expect(css).toMatch(
      /\.task-table\s*\{[^}]*min-width: max\(42rem, 100%\);/s,
    );
    expect(css).toMatch(/\.warnings-panel ul\s*\{[^}]*overflow-x: auto;/s);
    expect(css).toMatch(/\.warning-row\s*\{[^}]*min-width: max-content;/s);
    expect(css).toMatch(
      /\.current-facts\s*\{[^}]*grid-template-columns:[^}]*minmax\(0, 1fr\)[^}]*minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 74\.999rem\)[\s\S]*\.questions-panel\s*,\s*\.questions-compact\s*\{[^}]*grid-column: 1 \/ -1;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 49\.999rem\)[\s\S]*\.panel-span-4,\s*\.panel-span-6,\s*\.panel-span-8,\s*\.panel-span-12\s*\{[^}]*grid-column: 1 \/ -1;/,
    );
    expect(css).not.toMatch(/\.panel-empty\s*\{[^}]*align-self:/s);
    expect(css).not.toMatch(/\.questions-compact\s*\{[^}]*align-self:/s);
  });

  test("keeps repository cost columns in an internally scrollable summary and shows a mid-width scroll hint", async () => {
    const document = dashboardDocument();
    renderFleet(fleet("mini", [], [richRepository()]), document, NOW);

    const region = document.querySelector<HTMLElement>(
      ".repository-summary-region",
    )!;
    const scroll = region.querySelector<HTMLElement>(
      ".repository-summary-scroll.table-scroll",
    )!;
    expect(region.querySelector(".repository-summary-hint")?.textContent).toBe(
      "Scroll horizontally for cost columns →",
    );
    expect(scroll.querySelector(".repository-summary")?.textContent).toContain(
      "Total cost",
    );
    expect(scroll.querySelector(".repository-summary")?.textContent).toContain(
      "Factory overhead",
    );

    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.repository-summary-scroll\.table-scroll\s*\{|\.table-scroll\s*\{[^}]*overflow-x:\s*auto;/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 74\.999rem\)[\s\S]*?\.repository-summary-hint\s*\{[^}]*display:\s*block;/,
    );
  });

  test("uses four Current fact tracks on desktop and two term/value tracks below 1100px", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.current-facts\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\) max-content minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 68\.749rem\)[\s\S]*?\.current-facts\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);/,
    );
  });

  test("sizes summary and review tables instead of squeezing labels", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    for (const selector of [
      "#fleet-summary",
      ".repository-summary",
      ".review-strip table",
    ]) {
      const escaped = selector.replace(/[.#]/g, "\\$&");
      expect(css).toMatch(
        new RegExp(`${escaped}\\s*\\{[^}]*table-layout: fixed;`, "s"),
      );
    }
    expect(css).toMatch(/#fleet-summary th:nth-child\(1\)\s*,/s);
    expect(css).toMatch(/\.repository-summary th:nth-child\(1\)\s*\{/s);
    expect(css).toMatch(/\.review-strip th:nth-child\(1\)\s*\{/s);
    for (const selector of [
      "#fleet-summary",
      ".repository-summary",
      ".review-strip table",
      ".task-table",
    ]) {
      const escaped = selector.replace(/[.#]/g, "\\$&");
      expect(css).toMatch(
        new RegExp(`${escaped}\\s*\\{[^}]*width: max-content;`, "s"),
      );
    }
  });

  test("wraps only long text while keeping identifiers and pills intact", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.task-title\s*,[^{]*\{[^}]*overflow-wrap: anywhere;/s,
    );
    expect(css).toMatch(/\.facts dd\s*,[^{]*\{[^}]*overflow-wrap: anywhere;/s);
    expect(css).toMatch(/\.warning-code\s*\{[^}]*white-space: nowrap;/s);
    expect(css).toMatch(/\.warning-source\s*\{[^}]*white-space: nowrap;/s);
    expect(css).toMatch(/\.task-id\s*\{[^}]*white-space: nowrap;/s);
    expect(css).toMatch(/\.task-size\s*\{[^}]*white-space: nowrap;/s);
    expect(css).toMatch(
      /\.review-strip tbody th\s*\{[^}]*white-space: nowrap;/s,
    );
    expect(css).toMatch(
      /\.review-strip tbody td:nth-child\(2\)\s*\{[^}]*white-space: nowrap;/s,
    );
    expect(css).toMatch(
      /\.review-reviewer-average\s*\{[^}]*white-space: nowrap;/s,
    );
    expect(css).toMatch(/\.unknown:not\(\.chip-muted\)\s*,/s);
    expect(css).toMatch(/\.timing-stamp\s*\{[^}]*white-space: nowrap;/s);
    expect(css).not.toMatch(
      /(?:#fleet-summary|\.repository-summary|\.review-strip|\.task-table) th\s*,[^}]*overflow-wrap: anywhere;/s,
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
    links
      .filter((link) => !link.getAttribute("href")?.startsWith("#"))
      .forEach((link) => {
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

    expect(document.querySelectorAll('a:not([href^="#"])')).toHaveLength(0);
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
    Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a:not([href^="#"])'),
    ).forEach((link) => {
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
      plan: {
        ...richRepository().plan,
        data: {
          ...richRepository().plan.data,
          tasks: [{ ...richRepository().plan.data.tasks[0], title: hostile }],
          active: [{ ...richRepository().plan.data.active[0], title: hostile }],
        },
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
    expect(
      document.querySelector(".active-work .task-title")?.textContent,
    ).toContain(hostile);
    expect(document.querySelectorAll("script, img, form, iframe")).toHaveLength(
      0,
    );
    expect(document.querySelectorAll('a:not([href^="#"])')).toHaveLength(0);
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

  test("renders legacy heading worklog entries through the normal meta, headline, and body path", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.headingPwned=1">';
    const repository = richRepository({
      repositoryUrl: undefined,
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-16",
              text: `## 2026-08-16 — T27 opened PR #12. ${hostile}\n\nThe follow-up paragraph is still body text.`,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const panel = document.querySelector(".worklog-panel")!;
    const entry = panel.querySelector(".worklog-entry")!;
    expect(panel.querySelector(".worklog-date")?.textContent).toBe(
      "2026-08-16",
    );
    expect(entry.querySelector(".worklog-time")?.textContent).toBe(
      "Time unavailable",
    );
    expect(entry.querySelector(".worklog-meta")?.textContent).toBe(
      "Time unavailable · opened PR · T27",
    );
    expect(entry.querySelector(".worklog-task")?.textContent).toBe("T27");
    expect(entry.querySelector(".worklog-event")?.textContent).toBe(
      "opened PR",
    );
    expect(entry.querySelector(".worklog-summary")?.textContent).toBe(
      `T27 opened PR #12. ${hostile}`,
    );
    expect(entry.querySelector(".worklog-body")?.textContent).toBe(
      "The follow-up paragraph is still body text.",
    );
    expect(entry.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).headingPwned,
    ).toBeUndefined();
  });

  test("keeps worklog and warnings disclosure choices across a refreshed snapshot", () => {
    const document = dashboardDocument();
    const entries = Array.from({ length: 7 }, (_, index) => ({
      date: "2026-08-16",
      time: `0${index}:00`,
      text: `- 2026-08-16 0${index}:00 UTC - Entry ${index}.`,
    }));
    const first = richRepository({
      worklog: { status: "available", data: { entries }, warnings: [] },
      logs: {
        status: "available",
        data: richRepository().logs.data,
        warnings: [],
      },
      plan: {
        status: "partial",
        data: richRepository().plan.data,
        warnings: [{ code: "PLAN_MALFORMED_TASK", message: "bad", line: 1 }],
      },
    });
    renderFleet(fleet("mini", [], [first]), document, NOW);

    const worklog = document.querySelector(".worklog-panel")!;
    worklog.querySelector<HTMLButtonElement>(".worklog-toggle")!.click();
    worklog.querySelector<HTMLButtonElement>(".worklog-raw-toggle")!.click();
    const warnings = document.querySelector<HTMLDetailsElement>(
      ".warnings-panel details",
    )!;
    warnings.querySelector<HTMLElement>("summary")!.click();
    warnings.querySelector<HTMLElement>("summary")!.click();

    const second = richRepository({
      worklog: { status: "available", data: { entries }, warnings: [] },
      logs: {
        status: "partial",
        data: richRepository().logs.data,
        warnings: [{ code: "LOG_TRUNCATED", message: "old lines omitted" }],
      },
    });
    renderFleet(fleet("mini", [], [second]), document, NOW);

    const refreshedWorklog = document.querySelector(".worklog-panel")!;
    const toggle =
      refreshedWorklog.querySelector<HTMLButtonElement>(".worklog-toggle")!;
    expect(toggle.textContent).toBe("Show newest 6");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(refreshedWorklog.querySelectorAll(".worklog-entry")).toHaveLength(7);
    expect(
      refreshedWorklog.querySelector(".worklog-raw-toggle")?.textContent,
    ).toBe("Hide raw entries");
    expect(
      Array.from(
        refreshedWorklog.querySelectorAll<HTMLElement>(".worklog-raw"),
        (raw) => raw.hidden,
      ),
    ).toSatisfy((hidden) => hidden.every((value) => value === false));
    expect(
      document.querySelector<HTMLDetailsElement>(".warnings-panel details")
        ?.open,
    ).toBe(false);
  });

  test("keeps worklog disclosure state separate for each repository", () => {
    const document = dashboardDocument();
    const entries = Array.from({ length: 7 }, (_, index) => ({
      date: "2026-08-16",
      time: `0${index}:00`,
      text: `- 2026-08-16 0${index}:00 UTC - Entry ${index}.`,
    }));
    const alpha = richRepository({
      name: "alpha",
      worklog: { status: "available", data: { entries }, warnings: [] },
    });
    const beta = richRepository({
      name: "beta",
      worklog: { status: "available", data: { entries }, warnings: [] },
    });
    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);
    document
      .querySelector<HTMLButtonElement>(".repository .worklog-toggle")!
      .click();

    renderFleet(fleet("mini", [], [alpha, beta]), document, NOW);

    const toggles = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".worklog-toggle"),
    );
    expect(toggles.map((toggle) => toggle.textContent)).toEqual([
      "Show newest 6",
      "Show all 7",
    ]);
    expect(
      toggles.map((toggle) => toggle.getAttribute("aria-expanded")),
    ).toEqual(["true", "false"]);
  });

  test("orders completed tasks by valid merged time, then task id, without changing other plan groups", () => {
    const document = dashboardDocument();
    const task = (id: string) => ({
      ...richRepository().plan.data.tasks[0],
      id,
      title: `Task ${id}`,
    });
    const completed = [task("T12"), task("T2"), task("T20"), task("T9")];
    const active = [task("T8"), task("T7")];
    const repository = (metrics: unknown) =>
      richRepository({
        plan: {
          ...richRepository().plan,
          data: {
            ...richRepository().plan.data,
            tasks: [...active, ...completed],
            active,
            completed,
          },
        },
        metrics,
      });

    renderFleet(
      fleet(
        "mini",
        [],
        [
          repository({
            status: "available",
            data: {
              tasks: {
                T2: { pr: { mergedAt: "2026-08-14T10:00:00.000Z" } },
                T9: { pr: { mergedAt: "2026-08-15T10:00:00.000Z" } },
                T12: { pr: { mergedAt: "not a date" } },
              },
            },
            warnings: [],
          }),
        ],
      ),
      document,
      NOW,
    );

    expect(
      Array.from(
        document.querySelectorAll(".completed-work .task-id"),
        (id) => id.textContent,
      ),
    ).toEqual(["T9", "T2", "T20", "T12"]);
    expect(
      Array.from(
        document.querySelectorAll(".active-work .task-id"),
        (id) => id.textContent,
      ),
    ).toEqual(["T8", "T7"]);

    renderFleet(fleet("mini", [], [repository(undefined)]), document, NOW);

    expect(
      Array.from(
        document.querySelectorAll(".completed-work .task-id"),
        (id) => id.textContent,
      ),
    ).toEqual(["T20", "T12", "T9", "T2"]);
  });

  test("orders completed task IDs above the safe-integer limit by decimal value", () => {
    const document = dashboardDocument();
    const completed = [
      "T9007199254740993",
      "T10000000000000000",
      "T9007199254740992",
    ].map((id) => ({
      ...richRepository().plan.data.tasks[0],
      id,
      title: `Task ${id}`,
    }));
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: { ...richRepository().plan.data, tasks: completed, completed },
      },
      metrics: undefined,
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(
      Array.from(
        document.querySelectorAll(".completed-work .task-id"),
        (id) => id.textContent,
      ),
    ).toEqual(["T10000000000000000", "T9007199254740993", "T9007199254740992"]);
  });

  test("caps completed tasks at eight and keeps its expanded scroll disclosure across rerenders", () => {
    const document = dashboardDocument();
    const completed = Array.from({ length: 9 }, (_, index) => ({
      ...richRepository().plan.data.tasks[0],
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
    }));
    const repository = () =>
      richRepository({
        plan: {
          ...richRepository().plan,
          data: {
            ...richRepository().plan.data,
            tasks: completed,
            completed,
          },
        },
      });

    renderFleet(fleet("mini", [], [repository()]), document, NOW);

    const collapsedList = document.querySelector(
      ".completed-work .task-table",
    )!;
    const collapsedScroll = document.querySelector(
      ".completed-work .task-table-scroll",
    )!;
    const toggle = document.querySelector<HTMLButtonElement>(
      ".completed-tasks-toggle",
    )!;
    expect(collapsedList.querySelectorAll(".task")).toHaveLength(8);
    expect(collapsedScroll.classList.contains("task-list-scroll")).toBe(false);
    expect(collapsedScroll.hasAttribute("tabindex")).toBe(false);
    expect(toggle.textContent).toBe("Show all 9");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();
    const expandedList = document.querySelector(".completed-work .task-table")!;
    const expandedScroll = document.querySelector(
      ".completed-work .task-table-scroll",
    )!;
    expect(expandedList.querySelectorAll(".task")).toHaveLength(9);
    expect(expandedScroll.classList.contains("task-list-scroll")).toBe(true);
    expect(expandedScroll.getAttribute("tabindex")).toBe("0");
    expect(toggle.textContent).toBe("Show newest 8");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    renderFleet(fleet("mini", [], [repository()]), document, NOW);

    const refreshedList = document.querySelector(
      ".completed-work .task-table",
    )!;
    const refreshedScroll = document.querySelector(
      ".completed-work .task-table-scroll",
    )!;
    const refreshedToggle = document.querySelector<HTMLButtonElement>(
      ".completed-tasks-toggle",
    )!;
    expect(refreshedList.querySelectorAll(".task")).toHaveLength(9);
    expect(refreshedScroll.classList.contains("task-list-scroll")).toBe(true);
    expect(refreshedScroll.getAttribute("tabindex")).toBe("0");
    expect(refreshedToggle.textContent).toBe("Show newest 8");
  });

  test("does not cap non-completed task groups", () => {
    const document = dashboardDocument();
    const active = Array.from({ length: 9 }, (_, index) => ({
      ...richRepository().plan.data.tasks[0],
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
    }));
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: {
          ...richRepository().plan.data,
          tasks: active,
          active,
        },
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(document.querySelectorAll(".active-work .task")).toHaveLength(9);
    expect(
      document.querySelector(".active-work .completed-tasks-toggle"),
    ).toBeNull();
  });

  test("renders review chips with unknown distinct from zero and marks newer PR tasks missing metrics", () => {
    const document = dashboardDocument();
    const [active, review, completed, missing] = [
      "T34",
      "T35",
      "T36",
      "T37",
    ].map((id) => ({
      ...richRepository().plan.data.tasks[0],
      id,
      pr: Number(id.slice(1)),
    }));
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: {
          ...richRepository().plan.data,
          tasks: [active, review, completed, missing],
          active: [active, missing],
          review: [review],
          completed: [completed],
        },
      },
      metrics: {
        status: "available",
        data: {
          tasks: {
            T34: { ship: { internal: null } },
            T35: {
              ship: {
                internal: {
                  rounds: 0,
                  fixed: 0,
                  findings: { blocking: 0, minor: 0, invalid: 0 },
                },
              },
              merge: {
                external: {
                  codex: {
                    rounds: 1,
                    fixPushes: 0,
                    findings: { blocking: 0, minor: 2, refuted: 0 },
                  },
                },
              },
            },
            T36: {
              ship: {
                internal: {
                  rounds: 2,
                  fixed: 3,
                  findings: { blocking: 1, minor: 2, invalid: 0 },
                },
              },
            },
          },
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(
      document.querySelector(".active-work .task-review")?.textContent,
    ).toContain("unknown");
    expect(
      document.querySelector(".review-work .task-review")?.textContent,
    ).toContain("panel 0r");
    expect(
      document.querySelector(".review-work .task-review")?.textContent,
    ).toContain("codex 1r");
    expect(
      document.querySelector(".completed-work .task-review")?.textContent,
    ).toContain("panel 2r");
    const reviewCell = document.querySelector(".review-work .task-review")!;
    expect(reviewCell.querySelectorAll(".review-detail")).toHaveLength(1);
    expect(reviewCell.querySelector(".review-detail")?.textContent).toBe(
      "codex: 2 minor",
    );
    expect(
      reviewCell.querySelector<HTMLElement>(".review-external")?.title,
    ).toBe("0 blocking · 2 minor · 0 refuted · 0 fix pushes");
    expect(
      document.querySelectorAll(".active-work .task-review")[1]?.textContent,
    ).toContain("metrics missing");
  });

  test("aggregates review metrics by size and highlights, without correcting, mechanical round mismatches", () => {
    const document = dashboardDocument();
    const task = (id: string, size: string) => ({
      ...richRepository().plan.data.tasks[0],
      id,
      size,
      pr: Number(id.slice(1)),
    });
    const standard = task("T34", "standard");
    const major = task("T35", "major");
    const metrics = {
      status: "available",
      data: {
        tasks: {
          T34: {
            ship: {
              task: "T34",
              size: "standard",
              internal: {
                rounds: 2,
                fixed: 3,
                findings: { blocking: 1, minor: 2, invalid: 1 },
              },
            },
            merge: {
              task: "T34",
              external: {
                codex: {
                  rounds: 3,
                  fixPushes: 2,
                  findings: { blocking: 1, minor: 2, refuted: 1 },
                },
              },
              ci: { runs: 3, reruns: 2 },
            },
            pr: {
              reviews: { codex: 1, mechanicalonly: 1 },
              issueComments: { codex: 1 },
              reactions: { codex: { eyes: 1 } },
            },
          },
          T35: {
            ship: {
              task: "T35",
              size: "major",
              internal: {
                rounds: 4,
                fixed: 1,
                findings: { blocking: 0, minor: 1, invalid: 0 },
              },
            },
            merge: {
              task: "T35",
              external: {
                claude: {
                  rounds: 2,
                  fixPushes: 1,
                  findings: { blocking: 0, minor: 1, refuted: 0 },
                },
              },
              ci: { runs: 1, reruns: 0 },
            },
            pr: { reviews: { claude: 2 }, issueComments: {}, reactions: {} },
          },
        },
      },
      warnings: [],
    };
    const repository = richRepository({
      plan: {
        ...richRepository().plan,
        data: {
          ...richRepository().plan.data,
          tasks: [standard, major],
          active: [standard],
          completed: [major],
        },
      },
      metrics,
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const strip = document.querySelector(".review-strip")!;
    const disclosure = strip.querySelector<HTMLDetailsElement>(
      ".review-strip-details",
    )!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector(":scope > summary")?.textContent).toBe(
      "Review · 2 measured · 2 mismatches",
    );
    expect(strip.textContent).toContain("standard");
    expect(strip.textContent).toContain("major");
    expect(strip.textContent).toContain("No measured tasks");
    expect(
      Array.from(strip.querySelectorAll("tbody tr"), (row) => row.textContent),
    ).toEqual(expect.arrayContaining(["trivialNo measured tasks"]));
    expect(
      strip.querySelector("tbody tr:nth-child(2) td")?.getAttribute("colspan"),
    ).toBe("6");
    expect(strip.textContent).toContain("2 measured");
    expect(strip.textContent).toContain("codex");
    expect(strip.textContent).toContain("claude");
    expect(strip.textContent).toContain("50%");
    const crossChecks = strip.querySelector(".review-cross-checks")!;
    expect(crossChecks.querySelector("summary")?.textContent).toBe(
      "2 mismatches",
    );
    expect(crossChecks.querySelectorAll(".review-mismatch")).toHaveLength(3);
    expect(
      Array.from(
        crossChecks.querySelectorAll(".review-cross-check.review-mismatch"),
        (line) => line.textContent,
      ),
    ).toEqual([
      "T34 codex: 3r vs 2 mechanical",
      "T34 mechanicalonly: 0r vs 1 mechanical",
    ]);
    expect(strip.textContent).toContain(
      "T34 mechanicalonly: 0r vs 1 mechanical",
    );
    expect(strip.querySelectorAll("tbody .review-cross-checks")).toHaveLength(
      1,
    );

    disclosure.open = true;
    disclosure.dispatchEvent(new document.defaultView!.Event("toggle"));
    renderFleet(fleet("mini", [], [repository]), document, NOW);
    expect(
      document.querySelector<HTMLDetailsElement>(
        ".review-strip .review-strip-details",
      )?.open,
    ).toBe(true);

    metrics.data.tasks.T34.pr.reviews.codex = 2;
    metrics.data.tasks.T34.pr.reviews.mechanicalonly = 0;
    const matchingDocument = dashboardDocument();
    renderFleet(fleet("mini", [], [repository]), matchingDocument, NOW);
    const matchingStrip = matchingDocument.querySelector(".review-strip")!;
    expect(
      matchingStrip.querySelector(".review-strip-details > summary")
        ?.textContent,
    ).toBe("Review · 2 measured · 0 mismatches");
    const allMatch = matchingStrip.querySelector(
      ".review-cross-checks > summary",
    )!;
    expect(allMatch.textContent).toBe("all match");
    expect(allMatch.classList).toContain("muted");

    type T35Metrics = typeof metrics.data.tasks.T35;
    const t35Metrics: Omit<T35Metrics, "pr"> & {
      pr?: T35Metrics["pr"];
    } = metrics.data.tasks.T35;
    delete t35Metrics.pr;
    const unverifiedDocument = dashboardDocument();
    renderFleet(fleet("mini", [], [repository]), unverifiedDocument, NOW);
    const unverified = unverifiedDocument.querySelector(
      ".review-cross-checks > summary",
    )!;
    expect(unverified.textContent).toBe("1 unverified");
    expect(
      unverifiedDocument.querySelector(".review-cross-checks")?.textContent,
    ).toContain("T35 claude: 2r vs unknown mechanical");
  });

  test("keeps hostile reviewer identifiers and metric strings literal and inert", () => {
    const document = dashboardDocument();
    const hostile =
      '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script>';
    const repository = richRepository({
      metrics: {
        status: "available",
        data: {
          tasks: {
            T8: {
              ship: { internal: null },
              merge: {
                external: {
                  [hostile]: {
                    rounds: 1,
                    fixPushes: 0,
                    findings: { blocking: 0, minor: 1, refuted: 0 },
                  },
                },
              },
            },
          },
        },
        warnings: [],
      },
    });
    renderFleet(fleet("mini", [], [repository]), document, NOW);
    expect(document.body.textContent).toContain(hostile);
    expect(
      document.querySelectorAll("img, script, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("keeps same-named repository disclosure state separate per machine", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const entries = Array.from({ length: 7 }, (_, index) => ({
      date: "2026-08-16",
      time: `0${index}:00`,
      text: `- 2026-08-16 0${index}:00 UTC - Entry ${index}.`,
    }));
    const local = fleet(
      "mini",
      [peer],
      [
        richRepository({
          name: "shared",
          worklog: { status: "available", data: { entries }, warnings: [] },
        }),
      ],
    );
    const remote = fleet(
      "macbook",
      [],
      [
        richRepository({
          name: "shared",
          worklog: { status: "available", data: { entries }, warnings: [] },
        }),
      ],
    );
    const fetcher = async (input: RequestInfo | URL) =>
      jsonResponse(String(input) === "/api/fleet" ? local : remote);

    await loadFleet(document, fetcher, { now: () => NOW });
    const machinePanels = document.querySelectorAll<HTMLElement>(
      '#repositories > [role="tabpanel"]',
    );
    machinePanels[0]!
      .querySelector<HTMLButtonElement>(".worklog-toggle")!
      .click();

    await loadFleet(document, fetcher, { now: () => NOW });

    const refreshedPanels = document.querySelectorAll<HTMLElement>(
      '#repositories > [role="tabpanel"]',
    );
    expect(
      refreshedPanels[0]!.querySelector(".worklog-toggle")?.textContent,
    ).toBe("Show newest 6");
    expect(
      refreshedPanels[1]!.querySelector(".worklog-toggle")?.textContent,
    ).toBe("Show all 7");
  });

  test("keeps one raw-entry toggle across changing worklog windows", () => {
    const document = dashboardDocument();
    const oldEntry = {
      date: "2026-08-15",
      time: "09:00",
      text: "- 2026-08-15 09:00 UTC - Old entry.",
    };
    const currentEntries = [
      oldEntry,
      ...Array.from({ length: 6 }, (_, index) => ({
        date: "2026-08-16",
        time: `0${index}:00`,
        text: `- 2026-08-16 0${index}:00 UTC - Entry ${index}.`,
      })),
    ];
    const repository = (entries: typeof currentEntries) =>
      richRepository({
        worklog: { status: "available", data: { entries }, warnings: [] },
      });
    renderFleet(fleet("mini", [], [repository(currentEntries)]), document, NOW);
    document.querySelector<HTMLButtonElement>(".worklog-toggle")!.click();
    document.querySelector<HTMLButtonElement>(".worklog-raw-toggle")!.click();

    renderFleet(
      fleet("mini", [], [repository(currentEntries.slice(1))]),
      document,
      NOW,
    );
    renderFleet(fleet("mini", [], [repository(currentEntries)]), document, NOW);

    expect(document.querySelectorAll(".worklog-raw-toggle")).toHaveLength(1);
    expect(document.querySelector(".worklog-raw-toggle")?.textContent).toBe(
      "Hide raw entries",
    );
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".worklog-raw"),
        (raw) => raw.hidden,
      ),
    ).toEqual(Array(7).fill(false));
  });

  test("renders worklog metadata, panel raw entries, and safe inline highlights", () => {
    const document = dashboardDocument();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const events = [
      ["T27 implemented and opened as PR #12.", "opened PR"],
      ["T2 implemented and opened as held major PR #2.", "opened PR"],
      ["Merged the release.", "merged"],
      ["Waiting for review.", "review wait"],
      ["The exact-head verdict is still pending.", "review wait"],
      ["Codex review is still in flight.", "review wait"],
      ["Parked review minors.", "parked minors"],
      ["Reclassified T27 as major.", "reclassified"],
      ["Escalated the decision.", "escalated"],
      ["Filed question Q1.", "question filed"],
      ["Documented the dashboard.", "other"],
    ];
    const entries = events.map(([sentence], index) => ({
      date: "2026-08-16",
      time: `${String(index).padStart(2, "0")}:00`,
      text: `- 2026-08-16 ${String(index).padStart(2, "0")}:00 UTC - ${sentence} Follow-up has T27, PR #12, issue #34, ${sha}, \`literal code\`, and https://github.com/example/factory-ui/issues/47.`,
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
        .map((entry) => entry.querySelector(".worklog-event")?.textContent),
    ).toEqual(
      events
        .map(([, event]) => (event === "other" ? undefined : event))
        .reverse(),
    );
    const opened = rendered[events.length]!;
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
    expect(panel.querySelectorAll(".worklog-raw-toggle")).toHaveLength(1);
    expect(opened.querySelector("details")).toBeNull();
    expect(opened.querySelector<HTMLElement>(".worklog-raw")?.hidden).toBe(
      true,
    );
    panel.querySelector<HTMLButtonElement>(".worklog-raw-toggle")!.click();
    expect(opened.querySelector(".worklog-raw")?.textContent).toContain(sha);
    expect(opened.querySelector(".worklog-raw")?.textContent).toContain(
      "UTC -",
    );
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
        "https://github.com/example/factory-ui/issues/47",
      ]),
    );
    opened.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });
    const malformed = rendered[0]!;
    expect(malformed.querySelector(".worklog-event")).toBeNull();
    expect(malformed.querySelector(".worklog-summary")?.textContent).toBe(
      "not a worklog stamp <em>at all</em>",
    );
    expect(malformed.querySelector(".worklog-body")).toBeNull();
  });

  test("renders policy-valid GitHub worklog URLs concisely in headlines and bodies while leaving unsafe URLs literal", () => {
    const document = dashboardDocument();
    const discussion =
      "https://github.com/example/factory-ui/pull/42#discussion_r123";
    const branch = "https://github.com/example/factory-ui/tree/factory/T61";
    const githubRepository = "https://github.com/example/factory-ui";
    const unsafe = [
      "https://example.invalid/factory-ui/pull/42",
      "https://user:secret@github.com/example/factory-ui/pull/42",
      "https://github.com/example/factory-ui/pull/42?redirect=evil",
      "https://github.com/example/factory-ui/pull/42#discussion_r0",
      "https://github.com/example/factory-ui/pull/42#discussion_r123/extra",
    ];
    const repository = richRepository({
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-16",
              time: "12:00",
              text: `- 2026-08-16 12:00 UTC - Reviewed (${discussion}). Follow-up ${discussion}; see ${branch}. Repository ${githubRepository}. ${unsafe.join(" ")}.`,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const entry = document.querySelector(".worklog-entry")!;
    expect(entry.querySelector(".worklog-summary")?.textContent).toBe(
      "Reviewed (PR #42 discussion).",
    );
    expect(entry.querySelector(".worklog-body")?.textContent).toContain(
      "Follow-up PR #42 discussion;",
    );
    expect(entry.querySelector(".worklog-body")?.textContent).toContain(
      "see branch factory/T61. Repository example/factory-ui.",
    );
    const links = Array.from(entry.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.map((link) => [link.textContent, link.href])).toEqual([
      ["PR #42 discussion", discussion],
      ["PR #42 discussion", discussion],
      ["branch factory/T61", branch],
      ["example/factory-ui", githubRepository],
    ]);
    links.forEach((link) => {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    });
    unsafe.forEach((url) => expect(entry.textContent).toContain(url));
    expect(entry.querySelectorAll("script, img, [onerror]")).toHaveLength(0);
  });

  test("links GitHub worklog URLs with repeated trailing punctuation while preserving that punctuation as text", () => {
    const document = dashboardDocument();
    const url = "https://github.com/example/factory-ui/pull/42";
    const punctuation = ").,;:!?".repeat(32);
    const repository = richRepository({
      worklog: {
        status: "available",
        data: {
          entries: [
            {
              date: "2026-08-16",
              time: "12:00",
              text: `- 2026-08-16 12:00 UTC - Reviewed ${url}${punctuation}`,
            },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    const entry = document.querySelector(".worklog-entry")!;
    const link = entry.querySelector<HTMLAnchorElement>(".worklog-url");
    expect(link?.href).toBe(url);
    expect(entry.querySelector(".worklog-summary")?.textContent).toBe(
      `Reviewed PR #42${punctuation}`,
    );
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
      panel.querySelectorAll<HTMLElement>(
        ".worklog-summary .worklog-reference, .worklog-body .worklog-reference",
      ),
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

    expect(
      document.querySelector(".current-panel h4 .status.unavailable")
        ?.textContent,
    ).toBe("UNAVAILABLE");
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

  test("collapses only fourth-and-later same-source warning codes into one rendered row", () => {
    const renderWarnings = (warnings: Array<Record<string, unknown>>) => {
      const document = dashboardDocument();
      renderFleet(
        fleet(
          "mini",
          [],
          [
            richRepository({
              worklog: {
                status: "partial",
                data: { entries: [] },
                warnings,
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
      return document.querySelector(".warnings-panel")!;
    };
    const malformed = (line: number, excerpt = `- malformed ${line}`) => ({
      code: "WORKLOG_MALFORMED_ENTRY",
      message: "bad worklog entry",
      line,
      excerpt,
    });

    const three = renderWarnings([malformed(2), malformed(5), malformed(8)]);
    expect(three.querySelector("summary")?.textContent).toBe(
      "Warnings · 3 · from this snapshot",
    );
    expect(three.querySelectorAll(".warning-row")).toHaveLength(3);
    expect(
      Array.from(
        three.querySelectorAll(".warning-line"),
        (line) => line.textContent,
      ),
    ).toEqual(["line 2", "line 5", "line 8"]);

    const four = renderWarnings([
      malformed(2, '<img src=x onerror="globalThis.warningPwned=1">'),
      malformed(5),
      malformed(8),
      malformed(13),
      { code: "WARNINGS_TRUNCATED", message: "omitted" },
    ]);
    expect(four.querySelector("summary")?.textContent).toBe(
      "Warnings · 2 · from this snapshot",
    );
    const rows = Array.from(four.querySelectorAll<HTMLElement>(".warning-row"));
    expect(rows).toHaveLength(2);
    const collapsed = rows.find(
      (row) =>
        row.querySelector(".warning-code")?.textContent ===
        "WORKLOG_MALFORMED_ENTRY",
    )!;
    expect(collapsed.querySelector(".warning-count")?.textContent).toBe("×4");
    expect(collapsed.querySelector(".warning-line")?.textContent).toBe(
      "lines 2, 5, 8 +1 more",
    );
    expect(collapsed.querySelector(".warning-excerpt")?.textContent).toBe(
      '<img src=x onerror="globalThis.warningPwned=1">',
    );
    expect(
      rows
        .find(
          (row) =>
            row.querySelector(".warning-code")?.textContent ===
            "WARNINGS_TRUNCATED",
        )
        ?.querySelector(".warning-count"),
    ).toBeNull();
    expect(four.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).warningPwned,
    ).toBeUndefined();
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

  test("recomputes automatic warning defaults until the user toggles the panel", () => {
    const document = dashboardDocument();
    const repository = (plan: unknown) =>
      richRepository({
        plan,
        logs: {
          status: "available",
          data: richRepository().logs.data,
          warnings: [],
        },
      });
    const unavailable = {
      status: "unavailable",
      warnings: [{ code: "PLAN_MISSING", message: "missing" }],
    };
    const hygiene = {
      status: "partial",
      data: richRepository().plan.data,
      warnings: [{ code: "PLAN_MALFORMED_TASK", message: "bad", line: 1 }],
    };

    renderFleet(fleet("mini", [], [repository(unavailable)]), document, NOW);
    expect(
      document.querySelector<HTMLDetailsElement>(".warnings-panel details")
        ?.open,
    ).toBe(true);

    renderFleet(fleet("mini", [], [repository(hygiene)]), document, NOW);
    const details = document.querySelector<HTMLDetailsElement>(
      ".warnings-panel details",
    )!;
    expect(details.open).toBe(false);
    details.querySelector<HTMLElement>("summary")!.click();

    renderFleet(fleet("mini", [], [repository(hygiene)]), document, NOW);
    expect(
      document.querySelector<HTMLDetailsElement>(".warnings-panel details")
        ?.open,
    ).toBe(true);
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

  test("does not use inherited warning explanations", () => {
    const document = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            plan: {
              status: "partial",
              data: richRepository().plan.data,
              warnings: [{ code: "constructor", message: "hostile code" }],
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

    const details = document.querySelector<HTMLDetailsElement>(
      ".warnings-panel details",
    )!;
    expect(details.querySelector(".warning-explanation")?.textContent).toBe(
      UNKNOWN_WARNING_EXPLANATION,
    );
    expect(details.open).toBe(true);
  });
});

describe("fleet summary and machine tabs", () => {
  function routingRows(strip: Element): HTMLElement[] {
    const definitionRows = Array.from(
      strip.querySelectorAll<HTMLElement>("dl > div"),
    );
    if (definitionRows.length > 0) return definitionRows;
    return Array.from(
      strip.querySelectorAll<HTMLElement>('[role="row"]'),
    ).filter((row) => row.querySelector('[role="cell"]') !== null);
  }

  function routingRowCells(row: HTMLElement): HTMLElement[] {
    const definitionCells = Array.from(row.children).filter((child) =>
      child.matches("dt, dd"),
    ) as HTMLElement[];
    if (definitionCells.length > 0) return definitionCells;
    return Array.from(row.querySelectorAll<HTMLElement>('[role="cell"]'));
  }

  test("groups routing overrides by first-seen model with ordered bold agents and optional caps", () => {
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
            verify: { provider: "openai", model: "gpt", steps: null },
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

    const strip = document.querySelectorAll(".routing-strip")[2]!;
    expect(document.querySelectorAll(".routing-strip")).toHaveLength(4);
    expect(strip.classList).toContain("panel");
    expect(strip.classList).toContain("routing-panel");
    expect(strip.querySelector(".panel-title")?.textContent).toBe(
      "Last-run routing",
    );
    expect(strip.querySelector(".routing-defaults")?.textContent).toBe(
      "default openai/default · small opencode/small",
    );
    expect(strip.textContent).not.toContain("ignored");
    const rows = routingRows(strip);
    expect(rows.map((row) => row.textContent)).toEqual([
      "openai/gptbuild ≤ 20 · verify",
      "opencode/miniplan",
      "amazon-bedrock/claudereview ≤ 5",
      "local/modelcustom",
    ]);
    expect(
      rows.map((row) => routingRowCells(row).map((cell) => cell.textContent)),
    ).toEqual([
      ["openai/gpt", "build ≤ 20 · verify"],
      ["opencode/mini", "plan"],
      ["amazon-bedrock/claude", "review ≤ 5"],
      ["local/model", "custom"],
    ]);
    expect(
      rows.map((row) =>
        Array.from(
          row.querySelectorAll("strong"),
          (agent) => agent.textContent,
        ),
      ),
    ).toEqual([["build", "verify"], ["plan"], ["review"], ["custom"]]);
    expect(rows[0]?.querySelector(".routing-steps")?.textContent).toBe("≤ 20");
    expect(rows[0]?.querySelector(".routing-steps")?.classList).toContain(
      "muted",
    );
    expect(rows[1]?.querySelector(".routing-steps")).toBeNull();
    expect(strip.querySelector(".provider-openai")?.textContent).toBe("openai");
    expect(strip.querySelector(".provider-opencode")?.textContent).toBe(
      "opencode",
    );
    expect(strip.querySelector(".provider-amazon-bedrock")?.textContent).toBe(
      "amazon-bedrock",
    );
    expect(strip.querySelector(".provider-other")?.textContent).toBe("local");
    expect(strip.textContent).not.toContain("steps ≤");
  });

  test("keeps slash-colliding provider and model pairs in distinct routing lanes", () => {
    const document = dashboardDocument();
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
                model: "openai/default",
                smallModel: "opencode/small",
                agents: {
                  first: { provider: "a/b", model: "c", steps: null },
                  second: { provider: "a", model: "b/c", steps: null },
                  third: { provider: "a/b", model: "c", steps: null },
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

    const rows = routingRows(document.querySelectorAll(".routing-strip")[1]!);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => routingRowCells(row).map((cell) => cell.textContent)),
    ).toEqual([
      ["a/b/c", "first · third"],
      ["a/b/c", "second"],
    ]);
  });

  test("renders a single routing lane and leaves the empty override case unchanged", () => {
    const document = dashboardDocument();
    const routing = (agents: Record<string, unknown>) => ({
      status: "available",
      data: {
        schemaVersion: 1,
        recordedAt: "2026-08-16T11:59:00Z",
        model: "openai/default",
        smallModel: "opencode/small",
        agents,
      },
      warnings: [],
    });

    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({
            routing: routing({
              builder: { provider: "openai", model: "gpt", steps: null },
            }),
          }),
        ],
      ),
      document,
      NOW,
    );
    expect(
      routingRows(document.querySelectorAll(".routing-strip")[1]!),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(".routing-strip")[1]?.querySelector("strong")
        ?.textContent,
    ).toBe("builder");

    renderFleet(
      fleet("mini", [], [richRepository({ routing: routing({}) })]),
      document,
      NOW,
    );
    expect(
      document.querySelectorAll(".routing-strip")[1]?.querySelector(".empty")
        ?.textContent,
    ).toBe("No agent overrides");
    expect(
      routingRows(document.querySelectorAll(".routing-strip")[1]!),
    ).toHaveLength(0);
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
    expect(document.querySelectorAll(".routing-strip")[1]?.textContent).toBe(
      "Last-run routingUnavailable",
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

    expect(
      document.querySelectorAll(".routing-strip")[1]?.textContent,
    ).toContain(hostile);
    expect(
      document.querySelectorAll(
        ".repository > .routing-strip script, .repository > .routing-strip img, [onerror]",
      ),
    ).toHaveLength(0);
    expect(
      document
        .querySelectorAll(".routing-strip")[1]
        ?.querySelector(".routing-provider")?.classList,
    ).toContain("provider-other");
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("separates machine current routing from every repository last-run routing and shows snapshot freshness", () => {
    const document = dashboardDocument();
    const first = richRepository({
      name: "first",
      routing: {
        status: "available",
        data: {
          schemaVersion: 1,
          recordedAt: "2026-08-16T10:00:00.000Z",
          model: "legacy/first",
          smallModel: "legacy/small",
          agents: {},
        },
        warnings: [],
      },
    });
    const second = richRepository({
      name: "second",
      routing: {
        status: "partial",
        data: {
          schemaVersion: 1,
          recordedAt: "2026-08-16T11:00:00.000Z",
          model: "legacy/second",
          smallModel: "legacy/small",
          agents: {},
        },
        warnings: [{ code: "ROUTING_INVALID_AGENT", message: "omitted" }],
      },
    });
    renderFleet(
      {
        ...fleet("mini", [], [first, second]),
        currentRouting: {
          status: "partial",
          data: {
            model: "openai/current",
            smallModel: "openai/current-small",
            agents: {},
          },
          warnings: [
            { code: "CURRENT_ROUTING_INVALID_AGENT", message: "omitted" },
          ],
        },
      },
      document,
      NOW,
    );

    const machineRouting = document.querySelector(
      ".local-machine > .routing-strip",
    )!;
    expect(machineRouting.textContent).toContain("Current / next-run routing");
    expect(machineRouting.textContent).toContain("openai/current");
    expect(machineRouting.textContent).toContain(
      "Current configuration · used for the next factory run",
    );
    expect(machineRouting.textContent).toContain("Partial");
    const repositoryRouting = Array.from(
      document.querySelectorAll(".repository > .routing-strip"),
    );
    expect(repositoryRouting.map((strip) => strip.textContent)).toEqual([
      expect.stringContaining("Last-run routingRecorded 2h ago"),
      expect.stringContaining("Last-run routingRecorded 1h ago"),
    ]);
    expect(repositoryRouting[0]?.textContent).toContain("legacy/first");
    expect(repositoryRouting[1]?.textContent).toContain("legacy/second");
    expect(repositoryRouting[1]?.textContent).toContain("Partial");
  });

  test("renders omitted current routing as not configured and retains legacy peer compatibility", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "legacy", origin: "http://100.64.0.6:7777" },
      { name: "partial", origin: "http://100.64.0.7:7777" },
      { name: "unavailable", origin: "http://100.64.0.8:7777" },
    ];
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet") {
        return Promise.resolve(
          jsonResponse({
            ...fleet("mini", peers, [richRepository()]),
            currentRouting: {
              status: "unavailable",
              warnings: [
                {
                  code: "CURRENT_ROUTING_NOT_CONFIGURED",
                  message: "not configured",
                },
              ],
            },
          }),
        );
      }
      if (String(input).includes("100.64.0.7")) {
        return Promise.resolve(
          jsonResponse({
            ...fleet("partial", [], [richRepository()]),
            currentRouting: {
              status: "partial",
              data: {
                model: "openai/current",
                smallModel: "openai/small",
                agents: {},
              },
              warnings: [
                { code: "CURRENT_ROUTING_INVALID_AGENT", message: "omitted" },
              ],
            },
          }),
        );
      }
      if (String(input).includes("100.64.0.8")) {
        return Promise.resolve(
          jsonResponse({
            ...fleet("unavailable", [], [richRepository()]),
            currentRouting: { status: "unavailable", warnings: [] },
          }),
        );
      }
      // Older peers have no currentRouting field and keep their per-repo last-run data.
      return Promise.resolve(
        jsonResponse(fleet("legacy", [], [richRepository()])),
      );
    });

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(
      document.querySelector(".local-machine > .routing-strip")?.textContent,
    ).toContain("Not configured");
    const peerPanel = document.querySelector(".peer-machine")!;
    expect(peerPanel.textContent).toContain(
      "Current / next-run routingUnavailable",
    );
    expect(
      peerPanel.querySelector(".repository > .routing-strip")?.textContent,
    ).toContain("Last-run routing");
    expect(
      document.querySelectorAll(".peer-machine .unreachable"),
    ).toHaveLength(0);
    expect(
      Array.from(document.querySelectorAll(".peer-machine"), (panel) =>
        panel.textContent?.includes("Partial"),
      ),
    ).toContain(true);
  });

  test("keeps hostile current-routing agent names literal and inert", () => {
    const document = dashboardDocument();
    const hostile = '<img src=x onerror="globalThis.pwned=1">';
    renderFleet(
      {
        ...fleet("mini", [], [richRepository()]),
        currentRouting: {
          status: "available",
          data: {
            model: "openai/default",
            smallModel: "openai/small",
            agents: {
              [hostile]: { provider: "openai", model: "safe", steps: null },
            },
          },
          warnings: [],
        },
      },
      document,
      NOW,
    );
    const strip = document.querySelector(".local-machine > .routing-strip")!;
    expect(strip.textContent).toContain(hostile);
    expect(strip.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
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
    ).toEqual(["miniHELD1 question", "macbook?", "legion?"]);
    expect(
      document.querySelectorAll("#machine-tabs .question-badge"),
    ).toHaveLength(3);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "#machine-tabs .question-badge-unavailable",
        ),
        (badge) => badge.title,
      ),
    ).toEqual(["Questions unavailable", "Questions unavailable"]);
    expect(
      document.querySelector("#machine-tabs .held-badge")?.classList,
    ).toContain("chip-danger");
    expect(
      summaryRow(document, "mini")?.querySelector(".held-badge")?.classList,
    ).toContain("chip-danger");
    expect(summaryCells(document, "mini")).toEqual([
      "mini",
      "RUNNING",
      "T8",
      "PR #42",
      "HELD",
      "1",
      "—",
      "Unavailable",
    ]);
    expect(document.querySelectorAll(".questions-compact")).toHaveLength(1);
    expect(document.querySelector(".questions-compact")?.textContent).toBe(
      "Open questions · 0 · None",
    );
    expect(document.querySelector(".panel-empty .unavailable")).toBeNull();
    expect(summaryCells(document, "macbook")).toEqual([
      "macbook",
      "Unavailable",
      "Unavailable",
      "Unavailable",
      "Unavailable",
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

  test("distinguishes unknown from unavailable question badges", () => {
    const document = dashboardDocument();
    const unknownQuestions = richRepository({
      questions: { status: "available", warnings: [] },
    });

    renderFleet(fleet("mini", [], [unknownQuestions]), document, NOW);

    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".question-badge-unavailable"),
        (badge) => badge.title,
      ),
    ).toEqual(["Questions unknown", "Questions unknown"]);
  });

  test("uses em dashes for empty values and Unavailable for failed readers", () => {
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
      "—",
      "—",
      "—",
      "0",
      "—",
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
      "Unavailable",
      "Unavailable",
      "Unavailable",
      "1",
    ]);

    renderFleet(
      fleet(
        "mini",
        [],
        [
          richRepository({ name: "available" }),
          richRepository({
            name: "unavailable",
            state: { status: "unavailable", warnings: [] },
          }),
        ],
      ),
      document,
      NOW,
    );
    expect(summaryCells(document, "mini").slice(2, 6)).toEqual([
      "Unknown",
      "Unknown",
      "Unknown",
      "2",
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
    ).toEqual([`${hostile}HELD1 question`, `${hostile}?`]);
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
    expect(rows[1]?.textContent).toContain("—");
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
      "alphaHELD1 question",
      "beta",
    ]);
    expect(tabs[1]?.querySelector(".question-badge")).toBeNull();
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
    ).toBe("miniHELD1 question");
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

  test("uses an em dash for fresh machine data ages and highlights stale ages", async () => {
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

    expect(summaryCells(document, "mini")[6]).toBe("—");
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
    expect(local.querySelectorAll(".routing-strip")).toHaveLength(2);
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
  test("renders inert question titles with accessible permalinks that select and highlight their destination", async () => {
    const document = dashboardDocument();
    const peer = { name: "macbook", origin: "https://macbook.example" };
    const local = richRepository({
      name: "zeta",
      questions: {
        status: "available",
        data: {
          open: [{ id: "Q9", taskId: "T9", title: "Local", text: "raw" }],
        },
        warnings: [],
      },
    });
    const remote = richRepository({
      name: "alpha",
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q2",
              taskId: "T2",
              title: '<img src=x onerror="globalThis.questionPwned=1"> Peer',
              text: "raw",
            },
          ],
        },
        warnings: [],
      },
    });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [peer], [local]))
          : jsonResponse(fleet("remote", [], [remote])),
      ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(document.querySelector("#question-queue-heading")?.textContent).toBe(
      "Question queue · 2",
    );
    const hostileTitle =
      '<img src=x onerror="globalThis.questionPwned=1"> Peer';
    const queueTitle = document.querySelector(".question-queue-entry h3")!;
    const detailTitle = document.querySelector(
      ".peer-machine .questions-panel .entry-title",
    )!;
    const expectedHash = "#machine=macbook&repo=alpha&question=Q2";
    const scrollIntoView = vi.fn();
    document.defaultView!.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    expect(
      [queueTitle, detailTitle].map(
        (title) => title.querySelector(".question-title-text")?.textContent,
      ),
    ).toEqual([`alpha/Q2 · ${hostileTitle}`, hostileTitle]);
    expect(
      [queueTitle, detailTitle].map(
        (title) => title.querySelectorAll(".question-title-text a").length,
      ),
    ).toEqual([0, 0]);
    const peerPermalinks = [queueTitle, detailTitle].map((title) =>
      title.querySelector<HTMLAnchorElement>("a.question-permalink")!,
    );
    expect(
      peerPermalinks.map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["Permalink", expectedHash, "Permalink to alpha/Q2"],
      ["Permalink", expectedHash, "Permalink to alpha/Q2"],
    ]);
    expect(document.querySelectorAll("img, [onerror]")).toHaveLength(0);
    expect(
      (globalThis as Record<string, unknown>).questionPwned,
    ).toBeUndefined();
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.question-permalink\s*\{[^}]*font-size:\s*var\(--text-xs\)/,
    );
    expect(css).toMatch(
      /\.question-queue-entry-linked,\s*\.question-detail-linked\s*\{[^}]*outline:\s*2px solid/,
    );

    peerPermalinks[0]!.click();
    expect(document.defaultView!.location.hash).toBe(expectedHash);
    document.defaultView!.dispatchEvent(
      new document.defaultView!.Event("hashchange"),
    );

    expect(
      document.querySelector('#machine-tabs [role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("macbook");
    expect(
      document.querySelector('.peer-machine [role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("alpha");
    expect(
      document.querySelector(".question-queue-entry-linked"),
    ).not.toBeNull();
    expect(document.querySelector(".question-detail-linked")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("omits ambiguous duplicate question deep links and highlights no duplicate card", () => {
    const document = dashboardDocument();
    document.defaultView!.location.hash =
      "#machine=mini&repo=factory-ui&question=Q7";
    const repository = richRepository({
      questions: {
        status: "available",
        data: {
          open: [
            { id: "Q7", taskId: "T7", title: "First", text: "first" },
            { id: "Q7", taskId: "T8", title: "Second", text: "second" },
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);

    expect(
      document.querySelectorAll(".question-queue-entry h3 a"),
    ).toHaveLength(0);
    expect(
      document.querySelectorAll(".questions-panel .entry-title a"),
    ).toHaveLength(0);
    expect(
      document.querySelectorAll(".question-queue-entry-linked"),
    ).toHaveLength(0);
    expect(document.querySelectorAll(".question-detail-linked")).toHaveLength(
      0,
    );
    expect(
      Array.from(
        document.querySelectorAll(
          ".question-queue-entry h3 .question-title-text",
        ),
        (heading) => heading.textContent,
      ),
    ).toEqual(["factory-ui/Q7 · First", "factory-ui/Q7 · Second"]);
  });

  test("isolates an unsafe peer question without losing local or valid-peer queue entries", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "bad", origin: "https://bad.example" },
      { name: "good", origin: "https://good.example" },
    ];
    const local = richRepository({
      name: "local-project",
      questions: {
        status: "available",
        data: {
          open: [{ id: "Q1", taskId: "T1", title: "Local", text: "open" }],
        },
        warnings: [],
      },
    });
    const unsafePeerRepository = richRepository({
      name: "bad-project",
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q2",
              taskId: "T2",
              title: "Unsafe peer question",
              text: "open",
              branch: "factory/t2-unsafe",
              branchUrl: "javascript:alert(1)",
            },
          ],
        },
        warnings: [],
      },
    });
    const validPeerRepository = richRepository({
      name: "good-project",
      questions: {
        status: "available",
        data: {
          open: [{ id: "Q3", taskId: "T3", title: "Valid peer", text: "open" }],
        },
        warnings: [],
      },
    });
    const pending = new Map<string, (response: Response) => void>();
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/fleet")
        return Promise.resolve(jsonResponse(fleet("mini", peers, [local])));
      return new Promise((resolve) => pending.set(url, resolve));
    });

    const loading = loadFleet(document, fetcher, { now: () => NOW });
    await flushPromises();
    const resolveGood = pending.get("https://good.example/api/fleet");
    expect(resolveGood).toBeDefined();
    resolveGood?.(jsonResponse(fleet("good-host", [], [validPeerRepository])));
    await flushPromises();
    const resolveBad = pending.get("https://bad.example/api/fleet");
    expect(resolveBad).toBeDefined();
    resolveBad?.(jsonResponse(fleet("bad-host", [], [unsafePeerRepository])));
    await loading;

    const peerPanels = document.querySelectorAll(".peer-machine");
    expect(peerPanels.item(0).querySelector(".unreachable")?.textContent).toBe(
      "UNREACHABLE",
    );
    expect(peerPanels.item(1).querySelector(".unreachable")).toBeNull();
    expect(peerPanels.item(1).textContent).toContain("good-project");
    expect(document.querySelector("#question-queue-count")?.textContent).toBe(
      "2",
    );
    expect(document.querySelector("#question-queue-heading")?.textContent).toBe(
      "Question queue · 2",
    );
    expect(
      Array.from(
        document.querySelectorAll(
          ".question-queue-entry h3 .question-title-text",
        ),
        (node) => node.textContent,
      ),
    ).toEqual(["good-project/Q3 · Valid peer", "local-project/Q1 · Local"]);
    expect(document.body.textContent).not.toContain("Unsafe peer question");
  });

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
      "—",
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

  test("accepts server-valid bounded provider and model routing forms from peers", async () => {
    const document = dashboardDocument();
    const peer = { name: "routing-peer", origin: "http://100.64.0.8:7777" };
    const unusualModel = "provider with spaces/model?and=punctuation";
    const unusualAgent = "agent provider/agent:model+variant";
    const repository = richRepository({
      routing: {
        status: "available",
        data: {
          schemaVersion: 1,
          recordedAt: "2026-08-16T11:59:00.000Z",
          model: unusualModel,
          smallModel: unusualModel,
          agents: {
            architect: {
              provider: "agent provider",
              model: "agent:model+variant",
              steps: 1,
            },
          },
        },
        warnings: [],
      },
    });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        String(input) === "/api/fleet"
          ? jsonResponse(fleet("mini", [peer]))
          : jsonResponse(fleet("routing-peer", [], [repository])),
      ),
    );

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(document.querySelector(".peer-machine .unreachable")).toBeNull();
    expect(document.querySelector(".peer-machine")?.textContent).toContain(
      unusualModel,
    );
    expect(document.querySelector(".peer-machine")?.textContent).toContain(
      unusualAgent,
    );
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
      "—",
      "$1.23 metered",
    ]);
  });

  test("accepts only a structurally valid partial recent-costs peer contract", async () => {
    const document = dashboardDocument();
    const peers = [
      { name: "valid-window", origin: "http://100.64.0.11:7777" },
      { name: "missing-coverage", origin: "http://100.64.0.12:7777" },
      { name: "wrong-count", origin: "http://100.64.0.13:7777" },
    ];
    let request = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/api/fleet")
        return Promise.resolve(jsonResponse(fleet("mini", peers)));
      request += 1;
      const complete = costs({ T8: validCostTask() });
      const coverage = {
        kind: "recent-window",
        retainedTaskCount: request === 3 ? 2 : 1,
      };
      return Promise.resolve(
        jsonResponse(
          fleet(
            peers[request - 1]!.name,
            [],
            [
              richRepository({
                costs: {
                  ...complete,
                  status: "partial",
                  data:
                    request === 2
                      ? complete.data
                      : { ...complete.data, coverage },
                  warnings: [],
                },
              }),
            ],
          ),
        ),
      );
    });

    await loadFleet(document, fetcher, { now: () => NOW });

    expect(
      summaryRow(document, "valid-window")?.querySelector(".unreachable"),
    ).toBeNull();
    expect(
      document.querySelectorAll(".peer-machine .unreachable"),
    ).toHaveLength(2);
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

  test("shows a timed-out peer on a fresh Updated snapshot", async () => {
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
    expect(document.querySelector("#generated")?.textContent).toMatch(
      /^Updated /,
    );
    expect(document.querySelector("#generated")?.classList).not.toContain(
      "stale",
    );
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
      Array.from(
        document.querySelectorAll(".repository-summary"),
        (summary) => summary.textContent ?? "",
      ).some((text) => text.includes("recovered")),
    ).toBe(true);
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

  test("pauses fresh snapshots before the age limit", async () => {
    const document = dashboardDocument();
    const window = document.defaultView!;
    window.history.replaceState(null, "", "?refresh=5");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const timers = fakeTimers();
    let now = NOW;
    const fetcher = vi.fn(async () =>
      jsonResponse({ ...fleet("mini"), generatedAt: NOW.toISOString() }),
    );
    const controller = startDashboard(
      document,
      fetcher,
      dashboardDependencies(timers, { now: () => now }),
    );
    try {
      await flushPromises();
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
        "Updated ",
      );
      expect(document.querySelector("#generated")?.textContent).toContain(
        "— paused",
      );
      expect(document.querySelector("#generated")?.classList).not.toContain(
        "stale",
      );

      now = new Date(NOW.valueOf() + 5_000);
      timers.callbacksAt(1_000).forEach(({ callback }) => callback());
      expect(document.querySelector("#generated")?.textContent).toMatch(
        /^Updated .*— paused$/,
      );
      expect(document.querySelector("#generated")?.classList).not.toContain(
        "stale",
      );

      now = new Date(NOW.valueOf() + 5_001);
      timers.callbacksAt(1_000).forEach(({ callback }) => callback());
      expect(document.querySelector("#generated")?.textContent).toContain(
        "Stale · last good snapshot less than 1m ago",
      );
      expect(document.querySelector("#generated")?.textContent).toContain(
        "— paused",
      );
      expect(document.querySelector("#generated")?.classList).toContain(
        "stale",
      );
    } finally {
      controller.cleanup();
    }
  });

  test("avoids status mutation on unchanged one-second ticks", async () => {
    const document = dashboardDocument();
    const timers = fakeTimers();
    const controller = startDashboard(
      document,
      async () =>
        jsonResponse({ ...fleet("mini"), generatedAt: NOW.toISOString() }),
      dashboardDependencies(timers, { now: () => NOW }),
    );
    try {
      await flushPromises();
      const generated = document.querySelector("#generated")!;
      const observer = new document.defaultView!.MutationObserver(
        () => undefined,
      );
      observer.observe(generated, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });

      timers.callbacksAt(1_000).forEach(({ callback }) => callback());

      expect(observer.takeRecords()).toHaveLength(0);
      observer.disconnect();
    } finally {
      controller.cleanup();
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

  test("marks an otherwise successful old snapshot stale with a coarse age", async () => {
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
        /Stale · last good snapshot less than 1m ago/,
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

  test("keeps fresh failures Updated with retry backoff", async () => {
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
        /last good.*less than 1m ago/i,
      );
      expect(document.querySelector("#generated")?.textContent).toContain(
        "— refresh failed",
      );
      expect(document.querySelector("#generated")?.textContent).toMatch(
        /^Updated /,
      );
      expect(document.querySelector("#generated")?.classList).not.toContain(
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

describe("fleet dependency graph", () => {
  function graphTask(
    id: string,
    status: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id,
      status,
      size: "standard",
      title: `${id} task`,
      localDependencies: [],
      crossRepoDependencies: [],
      runnable: status === "todo",
      ...overrides,
    };
  }

  function graphRepository(overrides: Record<string, unknown> = {}) {
    const runnable = graphTask("T1", "todo", {
      title: "Ready <img src=x onerror=globalThis.graphPwned=1>",
      crossRepoDependencies: ["acme/media#17"],
    });
    const building = graphTask("T2", "active", {
      localDependencies: ["T1"],
    });
    const review = graphTask("T3", "review", { pr: 42 });
    const blocked = graphTask("T4", "blocked", { runnable: false });
    const done = graphTask("T5", "completed", { runnable: false });
    return richRepository({
      name: "dashboard",
      repositoryUrl: "https://github.com/example/dashboard",
      planUrl:
        "https://github.com/example/dashboard/blob/HEAD/.factory/plan.md",
      state: {
        status: "available",
        data: { hold: true, currentTask: "T3", pr: 42 },
        warnings: [],
      },
      plan: {
        status: "available",
        data: {
          tasks: [runnable, building, review, blocked, done],
          active: [building],
          review: [review],
          nextRunnable: [runnable],
          completed: [done],
          blocked: [blocked],
          remaining: [],
        },
        warnings: [],
      },
      questions: {
        status: "available",
        data: {
          open: [
            {
              id: "Q4",
              taskId: "T4",
              title: "Choose safe rollout",
              text: "Question text",
            },
          ],
        },
        warnings: [],
      },
      ...overrides,
    });
  }

  test("renders live dependency work by default with safe destinations", () => {
    const document = dashboardDocument();
    renderFleet(fleet("mini", [], [graphRepository()]), document, NOW);

    const graph = document.querySelector("#dependency-graph");
    expect(graph?.querySelector(".dependency-machine")?.textContent).toBe(
      "mini",
    );
    expect(graph?.querySelector(".dependency-repository h3")?.textContent).toBe(
      "dashboard",
    );
    expect(graph?.textContent).toContain("T1 · Ready <img");
    expect(
      graph?.querySelectorAll(".dependency-state-runnable"),
    ).not.toHaveLength(0);
    expect(
      graph?.querySelectorAll(".dependency-state-building"),
    ).not.toHaveLength(0);
    expect(
      graph?.querySelectorAll(".dependency-state-question-blocked"),
    ).not.toHaveLength(0);
    expect(graph?.querySelectorAll(".dependency-state-held")).not.toHaveLength(
      0,
    );
    expect(graph?.querySelectorAll(".dependency-state-done")).toHaveLength(0);
    expect(graph?.textContent).not.toContain("T5 · T5 task");
    const reviewDocument = dashboardDocument();
    renderFleet(
      fleet(
        "mini",
        [],
        [
          graphRepository({
            state: { status: "available", data: { hold: false }, warnings: [] },
          }),
        ],
      ),
      reviewDocument,
      NOW,
    );
    expect(
      reviewDocument.querySelectorAll(".dependency-state-review"),
    ).not.toHaveLength(0);
    expect(graph?.querySelectorAll(".dependency-edge-local")).toHaveLength(1);
    expect(graph?.querySelectorAll(".dependency-edge-cross")).toHaveLength(1);
    expect(graph?.textContent).toContain("acme/media#17");

    const questionLink = graph?.querySelector<HTMLAnchorElement>(
      '.dependency-state-question-blocked a[href="#machine=mini&repo=dashboard&question=Q4"]',
    );
    expect(questionLink?.textContent).toContain("T4");
    const prLink = graph?.querySelector<HTMLAnchorElement>(
      '.dependency-state-held a[href="https://github.com/example/dashboard/pull/42"]',
    );
    expect(prLink?.target).toBe("_blank");
    expect(prLink?.rel).toBe("noopener noreferrer");
    expect(document.querySelectorAll("#dependency-graph img")).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).graphPwned).toBeUndefined();
  });

  test("excludes dependency-free todos and renders completed local prerequisites as satisfied", () => {
    const document = dashboardDocument();
    const done = graphTask("T1", "completed", { runnable: false });
    const waiting = graphTask("T2", "todo", {
      runnable: false,
      localDependencies: ["T1", "T3", "T99"],
      crossRepoDependencies: ["acme/media#17"],
    });
    const incomplete = graphTask("T3", "active");
    const dependencyFree = graphTask("T4", "todo");
    const repository = graphRepository({
      plan: {
        status: "available",
        data: { tasks: [done, waiting, incomplete, dependencyFree] },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [repository]), document, NOW);
    const graph = document.querySelector("#dependency-graph")!;
    expect(graph.textContent).not.toContain("T4 · T4 task");
    expect(graph.querySelector(".dependency-edge-satisfied")?.textContent).toBe(
      "✓ T1",
    );
    expect(graph.textContent).toContain("← T3");
    expect(
      graph.querySelector<HTMLAnchorElement>(
        '.dependency-edge-cross a[href="https://github.com/acme/media/issues/17"]',
      ),
    ).not.toBeNull();
  });

  test("collapses completed history, summarizes all-done repositories, and closes it on rerender", () => {
    const document = dashboardDocument();
    const repository = graphRepository({
      plan: {
        status: "available",
        data: {
          tasks: [
            graphTask("T1", "completed", { runnable: false }),
            graphTask("T2", "completed", { runnable: false }),
          ],
        },
        warnings: [],
      },
    });
    const snapshot = fleet("mini", [], [repository]);

    renderFleet(snapshot, document, NOW);
    expect(document.querySelector(".dependency-all-done")?.textContent).toBe(
      "all 2 tasks done",
    );
    const details = document.querySelector<HTMLDetailsElement>(
      ".dependency-completed",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "show completed (2)",
    );
    expect(details.querySelectorAll(".dependency-task")).toHaveLength(0);

    details.open = true;
    details.dispatchEvent(new document.defaultView!.Event("toggle"));
    expect(
      document.querySelectorAll(".dependency-completed .dependency-task"),
    ).toHaveLength(2);

    renderFleet(snapshot, document, NOW);
    expect(
      document.querySelector<HTMLDetailsElement>(".dependency-completed")?.open,
    ).toBe(false);
    expect(
      document.querySelectorAll(".dependency-completed .dependency-task"),
    ).toHaveLength(0);
  });

  test("does not claim ambiguous or malformed dependency data is satisfied", () => {
    const document = dashboardDocument();
    const malformed = graphRepository({
      name: "malformed",
      plan: {
        status: "available",
        data: {
          tasks: [
            graphTask("T1", "completed", { runnable: false }),
            { ...graphTask("T2", "active"), runnable: undefined },
          ],
        },
        warnings: [],
      },
    });
    const duplicates = graphRepository({
      name: "duplicates",
      plan: {
        status: "available",
        data: {
          tasks: [
            graphTask("T3", "todo", { localDependencies: ["T4"] }),
            graphTask("T4", "active"),
            graphTask("T4", "completed", { runnable: false }),
          ],
        },
        warnings: [],
      },
    });

    renderFleet(fleet("mini", [], [malformed, duplicates]), document, NOW);
    const graph = document.querySelector("#dependency-graph")!;
    expect(graph.textContent).toContain(
      "Some malformed task data was isolated",
    );
    expect(graph.textContent).not.toContain("all 1 tasks done");
    expect(graph.textContent).toContain("← T4");
    expect(graph.textContent).not.toContain("✓ T4");
  });

  test("renders peer graph groups while isolating unavailable and malformed repository graph data", async () => {
    const document = dashboardDocument();
    const peer = { name: "legion", origin: "https://legion.tailnet:7777" };
    const malformed = graphRepository({
      name: "malformed",
      plan: {
        status: "available",
        data: { tasks: "not task data" },
        warnings: [],
      },
    });
    const unavailable = graphRepository({
      name: "offline",
      status: "unavailable",
      plan: { status: "unavailable", warnings: [] },
    });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(
        String(input) === "/api/fleet"
          ? jsonResponse(
              fleet(
                "mini",
                [peer],
                [graphRepository(), malformed, unavailable],
              ),
            )
          : jsonResponse(
              fleet(
                "legion",
                [],
                [
                  graphRepository({
                    name: "media",
                    plan: {
                      status: "available",
                      data: {
                        tasks: [
                          graphTask("T17", "completed", {
                            title: "Remote provider",
                            crossRepoDependencies: [],
                          }),
                        ],
                        active: [],
                        review: [],
                        nextRunnable: [],
                        completed: [],
                        blocked: [],
                        remaining: [],
                      },
                      warnings: [],
                    },
                  }),
                ],
              ),
            ),
      ),
    );

    await expect(
      loadFleet(document, fetcher, { now: () => NOW }),
    ).resolves.toBe(true);
    const graph = document.querySelector("#dependency-graph");
    expect(graph?.textContent).toContain("Dependency data unavailable");
    expect(graph?.textContent).toContain(
      "Some malformed task data was isolated",
    );
    expect(graph?.textContent).not.toContain("malformedT1 task");
    expect(graph?.querySelectorAll(".dependency-edge-cross")).toHaveLength(1);
  });

  test("keeps unavailable peers as machine graph groups and labels nonempty budget omissions", () => {
    const document = dashboardDocument();
    const tasks = Array.from({ length: 256 }, (_, index) =>
      graphTask(`T${index + 1}`, "todo", {
        crossRepoDependencies: ["acme/shared#1"],
      }),
    );
    renderFleet(
      fleet(
        "mini",
        [{ name: "offline", origin: "https://offline.example" }],
        [
          graphRepository({
            plan: {
              status: "available",
              data: {
                tasks,
                active: [],
                review: [],
                nextRunnable: tasks,
                completed: [],
                blocked: [],
                remaining: [],
              },
              warnings: [],
            },
          }),
          graphRepository({
            name: "omitted",
            plan: {
              status: "available",
              data: {
                tasks: [
                  graphTask("T257", "todo", {
                    crossRepoDependencies: ["acme/shared#1"],
                  }),
                ],
                active: [],
                review: [],
                nextRunnable: [],
                completed: [],
                blocked: [],
                remaining: [],
              },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const graph = document.querySelector("#dependency-graph")!;
    expect(
      graph.querySelector(".dependency-machine-unavailable")?.textContent,
    ).toContain("offlineMachine unavailableDependency data unavailable");
    expect(graph.textContent).toContain("Tasks omitted by graph limit");
    expect(graph.textContent).toContain("Showing 256 of 257 tasks");
    expect(graph.textContent).not.toContain("omittedNo tasks");
  });

  test("shares the remaining history budget across stable disclosures in repository order", () => {
    const document = dashboardDocument();
    const liveTasks = Array.from({ length: 254 }, (_, index) =>
      graphTask(`T${index + 1}`, "todo", {
        crossRepoDependencies: ["acme/shared#1"],
      }),
    );
    renderFleet(
      fleet(
        "mini",
        [],
        [
          graphRepository({
            name: "live",
            plan: {
              status: "available",
              data: { tasks: liveTasks },
              warnings: [],
            },
          }),
          graphRepository({
            name: "first-history",
            plan: {
              status: "available",
              data: {
                tasks: [
                  graphTask("T300", "completed", { runnable: false }),
                  graphTask("T301", "completed", { runnable: false }),
                ],
              },
              warnings: [],
            },
          }),
          graphRepository({
            name: "second-history",
            plan: {
              status: "available",
              data: {
                tasks: [
                  graphTask("T400", "completed", { runnable: false }),
                  graphTask("T401", "completed", { runnable: false }),
                ],
              },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const graph = document.querySelector("#dependency-graph")!;
    expect(graph.querySelector(".dependency-limit")).toBeNull();
    const [first, second] = Array.from(
      graph.querySelectorAll<HTMLDetailsElement>(".dependency-completed"),
    );
    second!.open = true;
    second!.dispatchEvent(new document.defaultView!.Event("toggle"));
    expect(graph.querySelectorAll(".dependency-task")).toHaveLength(256);
    expect(second!.textContent).toContain("T400 · T400 task");

    first!.open = true;
    first!.dispatchEvent(new document.defaultView!.Event("toggle"));
    const disclosures = graph.querySelectorAll(".dependency-completed");
    expect(disclosures[0]).toBe(first!);
    expect(disclosures[1]).toBe(second!);
    expect(first!.textContent).toContain("T300 · T300 task");
    expect(first!.textContent).toContain("T301 · T301 task");
    expect(second!.textContent).not.toContain("T400 · T400 task");
    expect(second!.textContent).toContain(
      "Completed tasks omitted by graph limit",
    );
    expect(graph.textContent).toContain("Showing 256 of 258 tasks");
    expect(graph.textContent).toContain("T254 · T254 task");

    first!.open = false;
    first!.dispatchEvent(new document.defaultView!.Event("toggle"));
    expect(graph.querySelector(".dependency-limit")).toBeNull();
    expect(second!.textContent).toContain("T400 · T400 task");
    expect(second!.textContent).toContain("T401 · T401 task");
  });

  test("isolates an over-limit peer task array before graph traversal", () => {
    const document = dashboardDocument();
    const oversized = Array.from({ length: 257 }, (_, index) =>
      graphTask(`T${index + 1}`, "todo"),
    );
    renderFleet(
      fleet(
        "mini",
        [],
        [
          graphRepository({
            plan: {
              status: "available",
              data: { tasks: oversized },
              warnings: [],
            },
          }),
        ],
      ),
      document,
      NOW,
    );

    const group = document.querySelector(".dependency-repository");
    expect(group?.textContent).toContain(
      "Some malformed task data was isolated",
    );
    expect(group?.querySelectorAll(".dependency-task")).toHaveLength(0);
  });

  test("keeps graph navigation hash-addressable and provides responsive static hooks", async () => {
    const document = dashboardDocument();
    document.defaultView!.location.hash =
      "#machine=mini&repo=dashboard&question=Q4";
    renderFleet(fleet("mini", [], [graphRepository()]), document, NOW);

    const link = document.querySelector<HTMLAnchorElement>(
      ".dependency-state-question-blocked a",
    );
    expect(link?.getAttribute("href")).toBe(
      "#machine=mini&repo=dashboard&question=Q4",
    );
    document.defaultView!.location.hash = link!.getAttribute("href")!;
    document.defaultView!.dispatchEvent(
      new document.defaultView!.Event("hashchange"),
    );
    expect(document.defaultView!.location.hash).toBe(
      "#machine=mini&repo=dashboard&question=Q4",
    );
    expect(
      document.querySelector(".question-queue-entry-linked"),
    ).not.toBeNull();

    document.defaultView!.location.hash = "#dependency-graph";
    document.defaultView!.dispatchEvent(
      new document.defaultView!.Event("hashchange"),
    );
    expect(document.defaultView!.location.hash).toBe("#dependency-graph");

    document.defaultView!.location.hash = "#question-queue";
    document.defaultView!.dispatchEvent(
      new document.defaultView!.Event("hashchange"),
    );
    expect(document.defaultView!.location.hash).toBe("#question-queue");

    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css).toMatch(
      /\.dependency-graph-section\s*\{[^}]*scroll-margin-top/,
    );
    expect(css).toMatch(/#dependency-graph-list\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(
      /@media \(max-width: 49\.999rem\)[\s\S]*#dependency-graph-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
  });
});
