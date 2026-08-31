import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AppConfigSource,
  RepositoryFactorySnapshot,
  RepositorySource,
} from "./contracts";
import type {
  AnswerIdempotencyStore,
  AnswerReservation,
} from "./answer-idempotency";
import { createRequestHandler } from "./server";
import { readRepositoryFactoryData } from "./snapshot";
import { discoverRepositories } from "./discovery";
import { MAX_LOG_ENTRIES } from "./readers/logs";
import {
  CURRENT_SHEPHERD_LOG_NAME,
  createFactoryFixture,
  type FactoryFixture,
} from "./test-support";

const generatedAt = new Date("2026-08-16T12:00:00.000Z");
const fixtures: FactoryFixture[] = [];
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-ui-api-")));
  temporaryRoots.push(root);
  return root;
}

function writeFactoryState(repositoryPath: string, project: string): void {
  mkdirSync(join(repositoryPath, ".factory"), { recursive: true });
  writeFileSync(
    join(repositoryPath, ".factory", "state.json"),
    JSON.stringify({
      project,
      phase: "build",
      spec_approved: true,
      plan_approved: true,
      current_task: null,
      branch: null,
      pr: null,
      hold: false,
      updated: "2026-08-31T00:00:00Z",
    }),
  );
}

const unavailableRemote = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "",
});

class TestAnswerIdempotencyStore implements AnswerIdempotencyStore {
  failCompletion = false;
  readonly records = new Map<
    string,
    { fingerprint: string; status: "reserved" | "complete"; id?: string }
  >();

  async reserve(
    repositoryPath: string,
    key: string,
    fingerprint: string,
  ): Promise<AnswerReservation> {
    const record = this.records.get(`${repositoryPath}\0${key}`);
    if (record === undefined) {
      this.records.set(`${repositoryPath}\0${key}`, {
        fingerprint,
        status: "reserved",
      });
      return { status: "acquired" };
    }
    if (record.fingerprint !== fingerprint) return { status: "conflict" };
    return record.status === "complete" && record.id !== undefined
      ? { status: "complete", id: record.id }
      : { status: "reserved" };
  }

  async complete(
    repositoryPath: string,
    key: string,
    fingerprint: string,
    id: string,
  ): Promise<void> {
    if (this.failCompletion) throw new Error("completion failed");
    this.records.set(`${repositoryPath}\0${key}`, {
      fingerprint,
      status: "complete",
      id,
    });
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("answer delivery API", () => {
  const answerId = "123e4567-e89b-42d3-a456-426614174000";
  const secret = "shared-secret";
  const source = {
    machine: "mini",
    repositories: [{ name: "owned", path: "/trusted/owned" }],
    peers: [{ name: "legion", origin: "http://100.100.0.2:7777" }],
    developmentOrigins: ["http://localhost:3000"],
    bind: "127.0.0.1",
    port: 7777,
    answerIntake: { actor: "Verified Actor", secret },
  };
  function request(path = "/api/repo/owned/answers", init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, init);
  }
  const headers = {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "Idempotency-Key": answerId,
  };

  test("authenticates before reading an invalid body and does not disclose ownership or secret", async () => {
    const submit = vi.fn();
    const handler = createRequestHandler(source, {
      submitAnswer: submit,
      answerIdempotencyStore: new TestAnswerIdempotencyStore(),
    });
    const bad = await handler(
      request("/api/repo/not-owned/answers", {
        method: "POST",
        body: "{not-json",
      }),
    );
    const unauthenticated = await handler(
      request(undefined, {
        method: "POST",
        body: "{not-json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(bad.status).toBe(404);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).not.toContain(secret);
    expect(submit).not.toHaveBeenCalled();
  });

  test("enforces answer method, content type, body bound, exact fields, and configured actor", async () => {
    const submit = vi.fn(async () => ({
      status: "pending" as const,
      id: answerId,
    }));
    const handler = createRequestHandler(source, {
      submitAnswer: submit,
      answerIdempotencyStore: new TestAnswerIdempotencyStore(),
    });
    expect(
      (await handler(request(undefined, { method: "GET", headers }))).status,
    ).toBe(405);
    expect(
      (
        await handler(
          request(undefined, {
            method: "POST",
            headers: { ...headers, "Content-Type": "text/plain" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request(undefined, {
            method: "POST",
            headers: { ...headers, "Content-Length": "999999" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request(undefined, {
            method: "POST",
            headers,
            body: JSON.stringify({ question: "Q1", option: "A", extra: true }),
          }),
        )
      ).status,
    ).toBe(400);
    const response = await handler(
      request(undefined, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "Q1", option: "A" }),
      }),
    );
    expect(response.status).toBe(202);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryPath: "/trusted/owned",
        actor: "Verified Actor",
        secret,
        question: "Q1",
      }),
    );
  });

  test("serves outcomes, CORS preflight, no-store, and generic errors without secret or path disclosure", async () => {
    const handler = createRequestHandler(source, {
      answerOutcome: async () => ({
        schemaVersion: 1,
        id: answerId,
        status: "rejected",
        question: "Q1",
        option: "A",
        actor: "Verified Actor",
        source: "factory-ui",
        submittedAt: "2026-08-30T12:00:00.000Z",
        settledAt: "2026-08-30T12:00:01.000Z",
        reason: "question terminal",
      }),
    });
    const outcome = await handler(
      request(`/api/repo/owned/answers/${answerId}`, {
        headers: {
          Authorization: `Bearer ${secret}`,
          Origin: "http://100.100.0.2:7777",
        },
      }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("cache-control")).toBe("no-store");
    expect(outcome.headers.get("access-control-allow-origin")).toBe(
      "http://100.100.0.2:7777",
    );
    const denied = await handler(
      request(undefined, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.test" },
      }),
    );
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-headers")).toContain(
      "Idempotency-Key",
    );
  });

  test("deduplicates concurrent and retried keys, rejects conflicts, and bounds settled records", async () => {
    let release!: () => void;
    const submitted = new Promise<{ status: "pending"; id: string }>(
      (resolve) => {
        release = () => resolve({ status: "pending", id: answerId });
      },
    );
    const submit = vi.fn(() => submitted);
    const handler = createRequestHandler(source, {
      submitAnswer: submit,
      answerIdempotencyStore: new TestAnswerIdempotencyStore(),
    });
    const body = JSON.stringify({ question: "Q1", option: "A" });
    const first = handler(
      request(undefined, { method: "POST", headers, body }),
    );
    const second = handler(
      request(undefined, { method: "POST", headers, body }),
    );
    release();
    expect((await first).status).toBe(202);
    expect((await second).status).toBe(202);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      (
        await handler(
          request(undefined, {
            method: "POST",
            headers,
            body: JSON.stringify({ question: "Q2", option: "A" }),
          }),
        )
      ).status,
    ).toBe(409);
  });

  test("retains an ambiguous failed submission across restart", async () => {
    const store = new TestAnswerIdempotencyStore();
    const submit = vi.fn().mockRejectedValue(new Error("ambiguous"));
    const firstHandler = createRequestHandler(source, {
      submitAnswer: submit,
      answerIdempotencyStore: store,
    });
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Q1", option: "A" }),
    };

    const first = await firstHandler(request(undefined, init));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: "Submission status uncertain; operator verification required",
    });
    expect(submit).toHaveBeenCalledTimes(1);

    const restartedSubmit = vi.fn();
    const restartedHandler = createRequestHandler(source, {
      submitAnswer: restartedSubmit,
      answerIdempotencyStore: store,
    });
    const retry = await restartedHandler(request(undefined, init));
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual({
      error: "Submission status uncertain; operator verification required",
    });
    expect(restartedSubmit).not.toHaveBeenCalled();
  });

  test("returns a completed durable result from a fresh handler without resubmitting", async () => {
    const store = new TestAnswerIdempotencyStore();
    const firstSubmit = vi.fn(async () => ({
      status: "pending" as const,
      id: answerId,
    }));
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Q1", option: "A" }),
    };
    const firstHandler = createRequestHandler(source, {
      submitAnswer: firstSubmit,
      answerIdempotencyStore: store,
    });
    expect((await firstHandler(request(undefined, init))).status).toBe(202);

    const restartedSubmit = vi.fn();
    const restartedHandler = createRequestHandler(source, {
      submitAnswer: restartedSubmit,
      answerIdempotencyStore: store,
    });
    const response = await restartedHandler(request(undefined, init));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", id: answerId });
    expect(restartedSubmit).not.toHaveBeenCalled();
  });

  test("does not resubmit a durable reservation left after completion fails", async () => {
    const store = new TestAnswerIdempotencyStore();
    store.failCompletion = true;
    const submit = vi.fn(async () => ({
      status: "pending" as const,
      id: answerId,
    }));
    const init = {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "Q1", option: "A" }),
    };
    const firstHandler = createRequestHandler(source, {
      submitAnswer: submit,
      answerIdempotencyStore: store,
    });
    expect((await firstHandler(request(undefined, init))).status).toBe(503);
    expect(submit).toHaveBeenCalledTimes(1);

    store.failCompletion = false;
    const restartedSubmit = vi.fn();
    const restartedHandler = createRequestHandler(source, {
      submitAnswer: restartedSubmit,
      answerIdempotencyStore: store,
    });
    expect((await restartedHandler(request(undefined, init))).status).toBe(503);
    expect(restartedSubmit).not.toHaveBeenCalled();
  });

  test("fails discovered answer submit and outcome closed after the accepted child is replaced", async () => {
    const codeRoot = temporaryRoot();
    const replacementRoot = temporaryRoot();
    const repositoryPath = join(codeRoot, "discovered");
    const replacement = join(replacementRoot, "replacement");
    writeFactoryState(repositoryPath, "original");
    writeFactoryState(replacement, "replacement-secret");
    const discovered = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: unavailableRemote },
    );
    rmSync(repositoryPath, { recursive: true });
    symlinkSync(replacement, repositoryPath);
    const submit = vi.fn();
    const outcome = vi.fn();
    const handler = createRequestHandler(
      {
        ...config([]),
        codeRoots: [codeRoot],
        answerIntake: { actor: "operator", secret },
      },
      {
        discovery: async () => discovered,
        submitAnswer: submit,
        answerOutcome: outcome,
        answerIdempotencyStore: new TestAnswerIdempotencyStore(),
      },
    );

    const submission = await handler(
      new Request("http://localhost/api/repo/discovered/answers", {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "Q1", option: "A" }),
      }),
    );
    const result = await handler(
      new Request(`http://localhost/api/repo/discovered/answers/${answerId}`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    );

    expect(submission.status).toBe(503);
    expect(result.status).toBe(503);
    expect(await submission.json()).toEqual({
      error: "Answer intake unavailable",
    });
    expect(await result.json()).toEqual({ error: "Answer intake unavailable" });
    expect(submit).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
  });

  test("fails answer results closed when a discovered child changes during the helper call", async () => {
    const codeRoot = temporaryRoot();
    const replacementRoot = temporaryRoot();
    const repositoryPath = join(codeRoot, "discovered");
    const replacement = join(replacementRoot, "replacement");
    writeFactoryState(repositoryPath, "original");
    writeFactoryState(replacement, "replacement-secret");
    const discover = async () =>
      discoverRepositories(
        { repositories: [], codeRoots: [codeRoot] },
        { runner: unavailableRemote },
      );
    const replace = () => {
      rmSync(repositoryPath, { recursive: true });
      symlinkSync(replacement, repositoryPath);
    };
    const submitHandler = createRequestHandler(
      {
        ...config([]),
        codeRoots: [codeRoot],
        answerIntake: { actor: "operator", secret },
      },
      {
        discovery: discover,
        submitAnswer: async () => {
          replace();
          return { status: "pending", id: answerId };
        },
        answerIdempotencyStore: new TestAnswerIdempotencyStore(),
      },
    );
    const submission = await submitHandler(
      new Request("http://localhost/api/repo/discovered/answers", {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "Q1", option: "A" }),
      }),
    );

    rmSync(repositoryPath, { force: true });
    writeFactoryState(repositoryPath, "original-again");
    const outcomeHandler = createRequestHandler(
      {
        ...config([]),
        codeRoots: [codeRoot],
        answerIntake: { actor: "operator", secret },
      },
      {
        discovery: discover,
        answerOutcome: async () => {
          replace();
          return { status: "unknown-record" };
        },
      },
    );
    const result = await outcomeHandler(
      new Request(`http://localhost/api/repo/discovered/answers/${answerId}`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    );

    expect(submission.status).toBe(503);
    expect(await submission.json()).toEqual({
      error: "Submission status uncertain; operator verification required",
    });
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "Answer intake unavailable" });
  });
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
    routing: { status: "unavailable", warnings: [warning] },
    costs: { status: "unavailable", warnings: [warning] },
    metrics: { status: "unavailable", warnings: [warning] },
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
  test("rejects cheap invalid API routes, methods, and answer authentication before discovery", async () => {
    const discovery = vi.fn(async () => ({ repositories: [], warnings: [] }));
    const handler = createRequestHandler(
      {
        ...config([{ name: "owned", path: "/owned" }]),
        answerIntake: { actor: "operator", secret: "secret" },
      },
      { discovery },
    );

    const responses = await Promise.all([
      handler(new Request("http://localhost/api/fleet", { method: "POST" })),
      handler(new Request("http://localhost/api/not-a-route")),
      handler(
        new Request("http://localhost/api/repo/owned", { method: "DELETE" }),
      ),
      handler(
        new Request("http://localhost/api/repo/owned/answers", {
          method: "POST",
        }),
      ),
      handler(
        new Request("http://localhost/api/repo/owned/answers", {
          method: "GET",
        }),
      ),
      handler(
        new Request("http://localhost/api/repo/discovered/answers", {
          method: "POST",
        }),
      ),
      handler(
        new Request("http://localhost/api/repo/unknown/answers", {
          method: "POST",
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      405, 404, 405, 401, 405, 404, 404,
    ]);
    expect(discovery).not.toHaveBeenCalled();
  });

  test("never exposes a replacement reached through a discovered child symlink", async () => {
    const codeRoot = temporaryRoot();
    const replacementRoot = temporaryRoot();
    const repositoryPath = join(codeRoot, "discovered");
    const replacement = join(replacementRoot, "replacement");
    writeFactoryState(repositoryPath, "original");
    writeFactoryState(replacement, "replacement-secret");
    const discovered = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: unavailableRemote },
    );
    rmSync(repositoryPath, { recursive: true });
    symlinkSync(replacement, repositoryPath);
    const handler = createRequestHandler(
      { ...config([]), codeRoots: [codeRoot] },
      { discovery: async () => discovered },
    );

    const fleet = await handler(new Request("http://localhost/api/fleet"));
    const repository = await handler(
      new Request("http://localhost/api/repo/discovered"),
    );
    const fleetBody = await fleet.json();
    const repositoryBody = await repository.json();

    expect(fleetBody.repositories).toHaveLength(1);
    expect(fleetBody.repositories[0]).toMatchObject({
      name: "discovered",
      status: "unavailable",
    });
    expect(repositoryBody).toMatchObject({
      name: "discovered",
      status: "unavailable",
    });
    expect(JSON.stringify([fleetBody, repositoryBody])).not.toContain(
      "replacement-secret",
    );
  });

  test("discards a repository result when its discovered identity changes during the read", async () => {
    const codeRoot = temporaryRoot();
    const replacementRoot = temporaryRoot();
    const repositoryPath = join(codeRoot, "discovered");
    const replacement = join(replacementRoot, "replacement");
    writeFactoryState(repositoryPath, "original");
    writeFactoryState(replacement, "replacement-secret");
    const discovered = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: unavailableRemote },
    );
    const readRepository = vi.fn(async () => {
      rmSync(repositoryPath, { recursive: true });
      symlinkSync(replacement, repositoryPath);
      return unavailable("replacement-secret");
    });
    const handler = createRequestHandler(config([]), {
      discovery: async () => discovered,
      repositorySnapshot: readRepository,
    });

    const response = await handler(new Request("http://localhost/api/fleet"));
    const body = await response.json();

    expect(readRepository).toHaveBeenCalledTimes(1);
    expect(body.repositories[0]).toMatchObject({
      name: "discovered",
      status: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("replacement-secret");
  });

  test("resolves discovery once per API request, refreshes fleets, routes discoveries, and falls back safely", async () => {
    const discovery = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ name: "first", path: "/first" }],
        warnings: [],
      })
      .mockResolvedValueOnce({
        repositories: [{ name: "later", path: "/later" }],
        warnings: [],
      })
      .mockRejectedValueOnce(new Error("private root"));
    const snapshot = vi.fn(async (source: AppConfigSource) => ({
      hostname: source.machine,
      repositories: source.repositories.map(({ name }) => unavailable(name)),
      peers: source.peers,
      currentRouting: {
        status: "unavailable" as const,
        warnings: [
          {
            code: "CURRENT_ROUTING_NOT_CONFIGURED",
            message: "current opencode routing is not configured",
          },
        ],
      },
    }));
    const readRepository = vi.fn(async (repository: RepositorySource) =>
      unavailable(repository.name),
    );
    const handler = createRequestHandler(
      config([{ name: "explicit", path: "/explicit" }]),
      {
        discovery,
        snapshot,
        repositorySnapshot: readRepository,
      },
    );

    const firstFleet = await handler(new Request("http://localhost/api/fleet"));
    const discoveredRoute = await handler(
      new Request("http://localhost/api/repo/later"),
    );
    const fallbackFleet = await handler(
      new Request("http://localhost/api/fleet"),
    );
    await handler(new Request("http://localhost/"));

    expect(
      (await firstFleet.json()).repositories.map(
        ({ name }: { name: string }) => name,
      ),
    ).toEqual(["first"]);
    expect(discoveredRoute.status).toBe(200);
    expect(readRepository).toHaveBeenLastCalledWith({
      name: "later",
      path: "/later",
    });
    expect((await fallbackFleet.json()).warnings).toEqual([
      {
        code: "DISCOVERY_UNAVAILABLE",
        message: "repository discovery could not be completed",
      },
    ]);
    expect(snapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        repositories: [{ name: "explicit", path: "/explicit" }],
      }),
    );
    expect(discovery).toHaveBeenCalledTimes(3);
  });

  test("uses discovered repositories for answer routes", async () => {
    const secret = "secret";
    const discovery = vi.fn(async () => ({
      repositories: [{ name: "discovered", path: "/discovered" }],
      warnings: [],
    }));
    const submit = vi.fn(async () => ({
      status: "pending" as const,
      id: "123e4567-e89b-42d3-a456-426614174000",
    }));
    const handler = createRequestHandler(
      { ...config([]), answerIntake: { actor: "operator", secret } },
      {
        discovery,
        submitAnswer: submit,
        answerIdempotencyStore: new TestAnswerIdempotencyStore(),
      },
    );
    const response = await handler(
      new Request("http://localhost/api/repo/discovered/answers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        },
        body: JSON.stringify({ question: "Q1", option: "A" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryPath: "/discovered" }),
    );
    expect(discovery).toHaveBeenCalledTimes(1);
  });

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
        "## Q7 (task T7, open) — Which schema?\nContext: API contract\nParked branch: `factory/t7-api`\nOptions considered: A — Version one (recommended: compatible) / B — Version two\nFor B, state whether clients have migrated.\n**A:**",
      ),
      fixture.writeWorklog("- 2026-08-16 UTC - T7 API work"),
      fixture.writeRouting({
        schemaVersion: 1,
        recordedAt: "2026-08-16T11:44:00Z",
        model: "openai/gpt-5.6",
        smallModel: "opencode/gpt-5-mini",
        agents: {
          builder: { provider: "openai", model: "gpt-5.6", steps: 25 },
        },
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
              cacheRead: 0.125,
              cacheWrite: null,
            },
          },
        },
      }),
    ]);
    fixture.writeDriverLog(
      "driver-20260816-110000-0.log",
      "bounded narration\n",
    );
    fixture.writeCycleLog("cycle-20260816-113000.log", "cycle\n");
    fixture.writeShepherdLog(CURRENT_SHEPHERD_LOG_NAME, "review\n");

    const handler = createRequestHandler(
      config([
        {
          name: "factory-ui",
          path: fixture.root,
          githubUrl: "https://github.com/example/factory-ui",
        },
      ]),
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
    expect(body.prUrl).toBe("https://github.com/example/factory-ui/pull/17");
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
    expect(body.questions.data.open[0]).toMatchObject({
      id: "Q7",
      context: "API contract\nParked branch: `factory/t7-api`",
      branch: "factory/t7-api",
      branchUrl: "https://github.com/example/factory-ui/tree/factory/t7-api",
      options: [
        {
          label: "A",
          text: "Version one (recommended: compatible)",
          recommended: true,
        },
        { label: "B", text: "Version two" },
      ],
      qualifier: "For B, state whether clients have migrated.",
    });
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
    expect(body.logs.warnings).not.toContainEqual(
      expect.objectContaining({ code: "LOG_NAME_INVALID" }),
    );
    expect(body.routing).toEqual({
      status: "available",
      data: {
        schemaVersion: 1,
        recordedAt: "2026-08-16T11:44:00Z",
        model: "openai/gpt-5.6",
        smallModel: "opencode/gpt-5-mini",
        agents: {
          builder: { provider: "openai", model: "gpt-5.6", steps: 25 },
        },
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
              cacheRead: 0.125,
              cacheWrite: null,
            },
          },
        },
      },
      warnings: [],
    });
    expect(["RUNNING", "STOPPED", "CANNOT_VERIFY"]).toContain(
      body.liveness.state,
    );
    expect(body.liveness.checkedAt).toEqual(expect.any(String));
  });

  test("keeps logs available through the repository API above 256 entries", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await fixture.writeState({ project: "factory-ui", phase: "build" });
    for (let i = 0; i < 256; i++) {
      fixture.writeDriverLog(
        `driver-20240101-120000-${i}.log`,
        "older driver narration\n",
      );
    }
    fixture.writeDriverLog(
      "driver-20240102-120000-0.log",
      "newest driver narration\n",
    );

    const handler = createRequestHandler(
      config([{ name: "factory-ui", path: fixture.root }]),
      {
        // The API test exercises the real reader while keeping the process probe
        // at its dependency boundary rather than depending on host lsof.
        repositorySnapshot: async (repository) => {
          const data = await readRepositoryFactoryData(
            repository,
            async () => ({
              state: "CANNOT_VERIFY",
              checkedAt: "2026-08-16T12:00:00.000Z",
            }),
          );
          return {
            ...data,
            status: "available",
            project: "factory-ui",
            phase: "build",
          };
        },
      },
    );
    const response = await handler(
      new Request("http://localhost/api/repo/factory-ui"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.logs).toMatchObject({
      status: "available",
      data: {
        narration: "newest driver narration\n",
        driver: { startedAt: "2024-01-02T12:00:00.000Z" },
      },
    });
    expect(body.logs.warnings).not.toContainEqual(
      expect.objectContaining({ code: "LOGS_TOO_MANY_ENTRIES" }),
    );
    expect(body.logs.warnings).not.toContainEqual(
      expect.objectContaining({ code: "LOGS_UNAVAILABLE" }),
    );
  });

  test("reports over-bound logs as unavailable through the repository API", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await fixture.writeState({ project: "factory-ui", phase: "build" });
    for (let i = 0; i <= MAX_LOG_ENTRIES; i++) {
      fixture.writeDriverLog(
        `driver-20240101-120000-${i}.log`,
        "driver narration\n",
      );
    }

    const handler = createRequestHandler(
      config([{ name: "factory-ui", path: fixture.root }]),
      {
        repositorySnapshot: async (repository) => {
          const data = await readRepositoryFactoryData(
            repository,
            async () => ({
              state: "CANNOT_VERIFY",
              checkedAt: "2026-08-16T12:00:00.000Z",
            }),
          );
          return {
            ...data,
            status: "available",
            project: "factory-ui",
            phase: "build",
          };
        },
      },
    );
    const response = await handler(
      new Request("http://localhost/api/repo/factory-ui"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.logs).toEqual({
      status: "unavailable",
      warnings: [expect.objectContaining({ code: "LOGS_TOO_MANY_ENTRIES" })],
    });
    expect(body.liveness).toEqual({
      state: "CANNOT_VERIFY",
      checkedAt: "2026-08-16T12:00:00.000Z",
    });
  });

  test("builds all GitHub links from trusted data", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await Promise.all([
      fixture.writeState({
        project: "factory-ui",
        phase: "build",
        branch: "factory/t17-github-links",
        pr: null,
      }),
      fixture.writePlan(`- [R] T17 (standard) — Link GitHub work
  - acceptance: Fixes #17 and Fixes #23
  - pr: 42
  - deps: none`),
    ]);

    const handler = createRequestHandler(
      config([
        {
          name: "factory-ui",
          path: fixture.root,
          githubUrl: "https://github.com/example/factory-ui",
        },
      ]),
    );
    const response = await handler(
      new Request("http://localhost/api/repo/factory-ui"),
    );
    const body = (await response.json()) as Record<string, unknown>;
    const task = (body.plan as { data: { tasks: Record<string, unknown>[] } })
      .data.tasks[0]!;

    expect(response.status).toBe(200);
    expect(body.repositoryUrl).toBe("https://github.com/example/factory-ui");
    expect(body.branchUrl).toBe(
      "https://github.com/example/factory-ui/tree/factory/t17-github-links",
    );
    expect(task.prUrl).toBe("https://github.com/example/factory-ui/pull/42");
    expect(task.issueUrls).toEqual([
      "https://github.com/example/factory-ui/issues/17",
      "https://github.com/example/factory-ui/issues/23",
    ]);
  });

  test("omits links for hostile GitHub inputs", async () => {
    const fixture = createFactoryFixture();
    fixtures.push(fixture);
    await Promise.all([
      fixture.writeState({
        project: "factory-ui",
        phase: "build",
        branch: "factory/../private",
        pr: null,
      }),
      fixture.writePlan(`- [R] T17 (standard) — Link GitHub work
  - acceptance: Fixes #0
  - pr: 0
  - deps: none`),
      Bun.write(`${fixture.factoryPath}/spec.md`, "# Spec"),
      fixture.writeWorklog("- 2026-08-16 UTC - shipped"),
      fixture.writeQuestions("## Q1 (task T1, open) — Question\nContext"),
    ]);

    const handler = createRequestHandler(
      config([
        {
          name: "factory-ui",
          path: fixture.root,
          githubUrl: "https://github.com/example/factory-ui?redirect=evil",
        },
      ]),
    );
    const body = (await (
      await handler(new Request("http://localhost/api/repo/factory-ui"))
    ).json()) as Record<string, unknown>;
    const task = (body.plan as { data: { tasks: Record<string, unknown>[] } })
      .data.tasks[0]!;

    expect(body.repositoryUrl).toBeUndefined();
    expect(body.branchUrl).toBeUndefined();
    expect(body.specUrl).toBeUndefined();
    expect(body.planUrl).toBeUndefined();
    expect(body.worklogUrl).toBeUndefined();
    expect(body.questionsUrl).toBeUndefined();
    expect(task.prUrl).toBeUndefined();
    expect(task.issueUrls).toBeUndefined();
  });

  test.each(["-private", "/private"])(
    "omits a branch link for rejected branch %s",
    async (branch) => {
      const fixture = createFactoryFixture();
      fixtures.push(fixture);
      await fixture.writeState({
        project: "factory-ui",
        phase: "build",
        branch,
        pr: null,
      });
      const handler = createRequestHandler(
        config([
          {
            name: "factory-ui",
            path: fixture.root,
            githubUrl: "https://github.com/example/factory-ui",
          },
        ]),
      );

      const body = (await (
        await handler(new Request("http://localhost/api/repo/factory-ui"))
      ).json()) as Record<string, unknown>;

      expect(body.repositoryUrl).toBe("https://github.com/example/factory-ui");
      expect(body.branchUrl).toBeUndefined();
    },
  );

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
    expect(await staticPage.text()).toContain(
      '<script src="/app.js" type="module">',
    );
  });

  test("applies restrictive CSP, nosniff, referrer policy on HTML page", async () => {
    const handler = createRequestHandler(config([]));
    const response = await handler(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:7777 http://100.100.0.2:7777 http://localhost:3000; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  test("applies restrictive CSP on JS response", async () => {
    const handler = createRequestHandler(config([]));
    const response = await handler(new Request("http://localhost/app.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:7777 http://100.100.0.2:7777 http://localhost:3000; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  test("applies restrictive CSP on CSS response", async () => {
    const handler = createRequestHandler(config([]));
    const response = await handler(new Request("http://localhost/styles.css"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:7777 http://100.100.0.2:7777 http://localhost:3000; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
  });

  test("index.html uses type=module for script and links to styles.css", async () => {
    const handler = createRequestHandler(config([]));
    const response = await handler(new Request("http://localhost/"));
    const html = await response.text();

    expect(html).toContain('<script src="/app.js" type="module">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("onload=");
    expect(html).not.toContain("onclick=");
  });
});
