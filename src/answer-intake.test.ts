import { describe, expect, test } from "bun:test";

import {
  ANSWER_EXECUTABLE,
  ANSWER_TIMEOUT_MS,
  MAX_ANSWER_OUTPUT_BYTES,
  getAnswerOutcome,
  submitAnswer,
  validateAnswerRequest,
} from "./answer-intake";
import type { AnswerRunner } from "./answer-intake";

const id = "123e4567-e89b-42d3-a456-426614174000";
const submittedAt = "2026-08-30T12:00:00.000Z";

function runner(result: AnswerRunner): { runner: AnswerRunner } {
  return { runner: result };
}

describe("answer intake boundary", () => {
  test("strictly accepts only bounded option and/or text request fields", () => {
    expect(
      validateAnswerRequest({ question: "Q9", option: "A", text: "detail" }),
    ).toEqual({ question: "Q9", option: "A", text: "detail" });
    for (const value of [
      {},
      { question: "Q0", option: "A" },
      { question: "Q9" },
      { question: "Q9", option: "AA" },
      { question: "Q9", text: "  " },
      { question: "Q9", text: "bad\ntext" },
      { question: "Q9", option: "A", extra: true },
      { question: "Q9", text: "x".repeat(10_001) },
    ])
      expect(validateAnswerRequest(value)).toBeNull();
  });

  test("submits through fixed shell-free arguments and keeps its secret out of argv", async () => {
    let invocation: unknown;
    const result = await submitAnswer(
      {
        question: "Q9",
        option: "A",
        text: "hostile; $(no)",
        repositoryPath: "/trusted/repo",
        actor: "Chris",
        secret: "do-not-put-in-argv",
      },
      runner(async (...args) => {
        invocation = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: "pending", id }),
          stderr: "",
        };
      }),
    );
    expect(result).toEqual({ status: "pending", id });
    expect(invocation).toEqual([
      ANSWER_EXECUTABLE,
      [
        "submit",
        "--question",
        "Q9",
        "--option",
        "A",
        "--text",
        "hostile; $(no)",
        "--actor",
        "Chris",
        "--source",
        "factory-ui",
      ],
      expect.objectContaining({
        cwd: "/trusted/repo",
        timeoutMs: ANSWER_TIMEOUT_MS,
        maxOutputBytes: MAX_ANSWER_OUTPUT_BYTES,
        env: expect.objectContaining({
          FACTORY_ANSWER_SECRET: "do-not-put-in-argv",
        }),
      }),
    ]);
    expect(JSON.stringify(invocation)).not.toContain("--secret");
  });

  test("rejects invalid submission input and helper timeout, truncation, malformed JSON, and exit failures", async () => {
    await expect(
      submitAnswer(
        {
          question: "Q9",
          repositoryPath: "/repo",
          actor: "bad\nactor",
          secret: "s",
        },
        runner(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })),
      ),
    ).rejects.toThrow("invalid answer submission");
    for (const result of [
      { exitCode: 0, stdout: "{}", stderr: "", timedOut: true },
      { exitCode: 0, stdout: "{}", stderr: "", outputTruncated: true },
      { exitCode: 0, stdout: "not json", stderr: "" },
      {
        exitCode: 1,
        stdout: JSON.stringify({ status: "pending", id }),
        stderr: "",
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({ status: "pending", id: "not-a-uuid" }),
        stderr: "",
      },
    ])
      await expect(
        submitAnswer(
          {
            question: "Q9",
            option: "A",
            repositoryPath: "/repo",
            actor: "Chris",
            secret: "s",
          },
          runner(async () => result),
        ),
      ).rejects.toThrow();
  });

  test("maps every valid outcome and rejects hostile or malformed helper records", async () => {
    for (const [status, extra] of [
      ["pending", {}],
      ["inflight", { preparedAt: submittedAt }],
      ["accepted", { preparedAt: submittedAt, settledAt: submittedAt }],
      ["rejected", { settledAt: submittedAt, reason: "question is terminal" }],
    ] as const) {
      const outcome = await getAnswerOutcome(
        { repositoryPath: "/repo", id, secret: "s" },
        runner(async () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: 1,
            id,
            status,
            question: "Q9",
            option: "A",
            actor: "Chris",
            source: "factory-ui",
            submittedAt,
            ...extra,
          }),
        })),
      );
      expect(outcome, `outcome ${status}`).toMatchObject({ status, id });
    }
    await expect(
      getAnswerOutcome(
        { repositoryPath: "/repo", id, secret: "s" },
        runner(async () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: 1,
            id,
            status: "accepted",
            question: "Q9",
            option: "A",
            actor: "<img onerror=1>",
            source: "factory-ui",
            submittedAt,
            preparedAt: submittedAt,
            settledAt: submittedAt,
            extra: true,
          }),
        })),
      ),
    ).rejects.toThrow();

    for (const extra of [
      { reason: "question is terminal" },
      {
        preparedAt: submittedAt,
        settledAt: submittedAt,
        reason: "question is terminal",
      },
      { settledAt: "2026-02-30T12:00:00.000Z", reason: "terminal" },
    ]) {
      await expect(
        getAnswerOutcome(
          { repositoryPath: "/repo", id, secret: "s" },
          runner(async () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              schemaVersion: 1,
              id,
              status: "rejected",
              question: "Q9",
              option: "A",
              actor: "Chris",
              source: "factory-ui",
              submittedAt,
              ...extra,
            }),
          })),
        ),
      ).rejects.toThrow();
    }
  });

  test("returns unknown only for the helper's exact unknown-record protocol", async () => {
    await expect(
      getAnswerOutcome(
        { repositoryPath: "/repo", id, secret: "s" },
        runner(async () => ({
          exitCode: 5,
          stdout: '{"status":"unknown-record"}',
          stderr: "",
        })),
      ),
    ).resolves.toEqual({ status: "unknown-record" });
    await expect(
      getAnswerOutcome(
        { repositoryPath: "/repo", id, secret: "s" },
        runner(async () => ({
          exitCode: 5,
          stdout: '{"status":"unknown-record","extra":true}',
          stderr: "",
        })),
      ),
    ).rejects.toThrow();
  });
});
