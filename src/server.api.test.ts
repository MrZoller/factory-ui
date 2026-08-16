import { afterEach, describe, expect, test, vi } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AppConfigSource,
  RepositoryFactorySnapshot,
  RepositorySource,
} from "./contracts";
import { createRequestHandler } from "./server";
import { createFactoryFixture, type FactoryFixture } from "./test-support";

const generatedAt = new Date("2026-08-16T12:00:00.000Z");
const fixtures: FactoryFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function unavailable(name: string): RepositoryFactorySnapshot {
  const warning = { code: "UNAVAILABLE", message: "source unavailable" };
  return {
    name,
    status: "unavailable",
    warning: "repository state is unavailable",
    state: { status: "unavailable", warnings: [warning] },
    plan: { status: "unavailable", warnings: [warning] },
    questions: { status: "unavailable", warnings: [warning] },
    worklog: { status: "unavailable", warnings: [warning] },
    logs: { status: "unavailable", warnings: [warning] },
    liveness: {
      state: "CANNOT_VERIFY",
      checkedAt: "2026-08-16T11:59:00.000Z",
    },
  };
}

function config(
  repositories: AppConfigSource["repositories"],
): AppConfigSource {
  return {
    machine: "mini",
    repositories,
    peers: [{ name: "legion", origin: "http://100.100.0.2:7777" }],
    developmentOrigins: ["http://localhost:3000"],
    bind: "127.0.0.1",
    port: 7777,
  };
}

describe("versioned read-only API", () => {
  test("serves every rich repository field with response and source timestamps", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await Promise.all([
      fixture.writeState({
        project: "factory-ui",
        phase: "build",
        spec_approved: true,
        plan_approved: true,
        current_task: "T7",
        branch: "factory/t7-api",
        pr: 17,
        hold: true,
        updated: "2026-08-16T11:45:00Z",
      }),
      fixture.writePlan(
        [
          "- [~] T7 (standard) — Finalize API",
          "  - deps: T6",
          "- [R] T6 (standard) — Logs",
          "  - deps: none",
          "- [ ] T8 (major) — Dashboard",
          "  - deps: T7",
          "- [x] T5 (standard) — Questions",
          "  - deps: none",
          "- [!] T9 (standard) — Peers",
          "  - deps: T8",
        ].join("\n"),
      ),
      fixture.writeQuestions(
        "## Q7 (task T7, open) — Which schema?\nContext: API contract\nOptions considered: A / B\n**A:**",
      ),
      fixture.writeWorklog("- 2026-08-16 UTC - T7 API work"),
    ]);
    fixture.writeDriverLog(
      "driver-20260816-110000-0.log",
      "bounded narration\n",
    );
    fixture.writeCycleLog("cycle-20260816-113000.log", "cycle\n");
    fixture.writeShepherdLog("shepherd-20260816-114000.log", "review\n");

    const handler = createRequestHandler(
      config([{ name: "factory-ui", path: fixture.root }]),
      { now: () => generatedAt },
    );
    const response = await handler(
      new Request("http://localhost/api/repo/factory%2Dui"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.schemaVersion).toBe(1);
    expect(body.generatedAt).toBe(generatedAt.toISOString());
    expect(body.hostname).toBe("mini");
    expect(body.name).toBe("factory-ui");
    expect(body.status).toBe("available");
    expect(body.state.data).toMatchObject({
      project: "factory-ui",
      phase: "build",
      currentTask: "T7",
      branch: "factory/t7-api",
      pr: 17,
      hold: true,
      updated: "2026-08-16T11:45:00Z",
    });
    expect(body.plan.data).toMatchObject({
      active: [{ id: "T7" }],
      review: [{ id: "T6" }],
      completed: [{ id: "T5" }],
      blocked: [{ id: "T9" }],
      remaining: expect.any(Array),
      nextRunnable: expect.any(Array),
    });
    expect(body.questions.data.open[0].id).toBe("Q7");
    expect(body.worklog.data.entries[0].text).toContain("T7 API work");
    expect(body.logs.data.narration).toBe("bounded narration\n");
    expect(body.logs.data).toMatchObject({
      driver: {
        startedAt: expect.any(String),
        lastActivityAt: expect.any(String),
      },
      cycle: {
        startedAt: expect.any(String),
        lastActivityAt: expect.any(String),
      },
      shepherd: {
        startedAt: expect.any(String),
        lastActivityAt: expect.any(String),
      },
      asOf: { overall: expect.any(String) },
    });
    expect(["RUNNING", "STOPPED", "CANNOT_VERIFY"]).toContain(
      body.liveness.state,
    );
    expect(body.liveness.checkedAt).toEqual(expect.any(String));
  });

  test("rejects selectors before repository I/O and decodes exactly once", async () => {
    const readRepository = vi.fn(async (_repository: RepositorySource) =>
      unavailable("repo-one"),
    );
    const handler = createRequestHandler(
      config([{ name: "repo-one", path: "/not-read" }]),
      { repositorySnapshot: readRepository },
    );

    for (const selector of [
      "unknown",
      "repo%",
      "repo%2Fone",
      "repo%5Cone",
      "repo-one/extra",
      "repo%252Done",
    ]) {
      const response = await handler(
        new Request(`http://localhost/api/repo/${selector}`),
      );
      expect(response.status).toBe(404);
    }
    expect(readRepository).not.toHaveBeenCalled();

    const response = await handler(
      new Request("http://localhost/api/repo/repo%2Done"),
    );
    expect(response.status).toBe(200);
    expect(readRepository).toHaveBeenCalledTimes(1);
    expect(readRepository.mock.calls[0]![0]).toEqual({
      name: "repo-one",
      path: "/not-read",
    });
  });

  test("isolates unexpected fleet failures with generic bounded warnings", async () => {
    const readRepository = vi.fn(async ({ name }: { name: string }) => {
      if (name === "broken") throw new Error("/secret/path: database password");
      return unavailable(name);
    });
    const handler = createRequestHandler(
      config([
        { name: "healthy", path: "/healthy" },
        { name: "broken", path: "/secret/path" },
      ]),
      { repositorySnapshot: readRepository, now: () => generatedAt },
    );
    const response = await handler(new Request("http://localhost/api/fleet"));
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories[1]).toMatchObject({
      name: "broken",
      status: "unavailable",
      warning: "repository data could not be read",
    });
    expect(body.repositories[1].state.warnings).toHaveLength(1);
    expect(text).not.toContain("/secret/path");
    expect(text).not.toContain("database password");
    expect(text.match(/generatedAt/g)).toHaveLength(1);
  });

  test("does not disclose paths, trusted log identity, environment, or unrelated files", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await fixture.writeState({ project: "safe", phase: "idle" });
    await fixture.writePlan("- [x] T1 (standard) — Done\n  - deps: none");
    await fixture.writeQuestions("");
    await fixture.writeWorklog("- 2026-08-16 UTC - done");
    fixture.writeDriverLog("driver-20260816-110000-0.log", "safe log\n");
    const unrelatedPath = join(fixture.root, "unrelated-secret.txt");
    writeFileSync(unrelatedPath, "UNRELATED_SECRET_417");
    const sourcePaths = [
      join(fixture.factoryPath, "state.json"),
      join(fixture.factoryPath, "plan.md"),
      join(fixture.factoryPath, "questions.md"),
      join(fixture.factoryPath, "worklog.md"),
      join(fixture.factoryPath, "logs", "driver-20260816-110000-0.log"),
      unrelatedPath,
    ];
    const before = sourcePaths.map((path) => ({
      bytes: readFileSync(path),
      stat: statSync(path),
    }));
    const marker = "ENV_SECRET_983";
    process.env.FACTORY_UI_TEST_SECRET = marker;
    try {
      const handler = createRequestHandler(
        config([{ name: "safe", path: fixture.root }]),
      );
      await handler(new Request("http://localhost/"));
      const response = await handler(new Request("http://localhost/api/fleet"));
      const text = await response.text();

      expect(text).not.toContain(fixture.root);
      expect(text).not.toContain("UNRELATED_SECRET_417");
      expect(text).not.toContain(marker);
      expect(text).not.toMatch(/"(?:path|device|inode)"\s*:/);
      sourcePaths.forEach((path, index) => {
        const after = statSync(path);
        expect(readFileSync(path)).toEqual(before[index]!.bytes);
        expect({
          size: after.size,
          mode: after.mode,
          mtimeMs: after.mtimeMs,
        }).toEqual({
          size: before[index]!.stat.size,
          mode: before[index]!.stat.mode,
          mtimeMs: before[index]!.stat.mtimeMs,
        });
      });
    } finally {
      delete process.env.FACTORY_UI_TEST_SECRET;
    }
  });

  test("applies CORS, cache, security, and safe 404/405/500 responses", async () => {
    const handler = createRequestHandler(config([]), {
      snapshot: async () => {
        throw new Error("sensitive exception");
      },
    });
    const allowed = await handler(
      new Request("http://localhost/api/fleet", {
        headers: { origin: "http://100.100.0.2:7777" },
      }),
    );
    expect(allowed.status).toBe(500);
    expect(await allowed.text()).toBe("Internal Server Error");
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://100.100.0.2:7777",
    );
    expect(allowed.headers.get("vary")).toBe("Origin");
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(allowed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(allowed.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(allowed.headers.get("content-security-policy")).toContain(
      "connect-src 'self' http://127.0.0.1:7777 http://100.100.0.2:7777 http://localhost:3000",
    );

    const denied = await handler(
      new Request("http://localhost/nope", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(await denied.text()).toBe("Not Found");

    const wrongMethod = await handler(
      new Request("http://localhost/api/fleet", { method: "POST" }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(await wrongMethod.text()).toBe("Method Not Allowed");

    const staticPage = await handler(new Request("http://localhost/"));
    expect(staticPage.status).toBe(200);
    expect(await staticPage.text()).toContain('<script src="/app.js" defer>');
  });
});
