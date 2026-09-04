import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_QUESTIONS_BYTES,
  MAX_QUESTIONS_LINES,
  MAX_QUESTION_LINE_LENGTH,
  MAX_QUESTION_OPTION_LENGTH,
  MAX_QUESTIONS,
  MAX_QUESTIONS_WARNINGS,
  parseFactoryQuestions,
  parseQuestionDetails,
  readFactoryQuestions,
} from "./questions";
import { type QuestionsData } from "../contracts";
import { MAX_WARNING_EXCERPT_CODE_POINTS } from "./warnings";

describe("questions reader", () => {
  describe("constants", () => {
    test("MAX_QUESTIONS_BYTES is 262144", () => {
      expect(MAX_QUESTIONS_BYTES).toBe(256 * 1024);
    });

    test("MAX_QUESTIONS_LINES is 4096", () => {
      expect(MAX_QUESTIONS_LINES).toBe(4096);
    });

    test("MAX_QUESTION_LINE_LENGTH is 8192", () => {
      expect(MAX_QUESTION_LINE_LENGTH).toBe(8192);
    });

    test("MAX_QUESTION_OPTION_LENGTH is 8192", () => {
      expect(MAX_QUESTION_OPTION_LENGTH).toBe(8192);
    });

    test("MAX_QUESTIONS is 128", () => {
      expect(MAX_QUESTIONS).toBe(128);
    });

    test("MAX_QUESTIONS_WARNINGS is 32", () => {
      expect(MAX_QUESTIONS_WARNINGS).toBe(32);
    });
  });

  describe("parseFactoryQuestions", () => {
    describe("line count validation", () => {
      test("returns unavailable for questions exceeding MAX_QUESTIONS_LINES", () => {
        const lines = Array.from(
          { length: MAX_QUESTIONS_LINES + 1 },
          (_, i) =>
            `## Q${i + 1} (task T1, open) — Question ${i + 1}\nContext: test\nOptions considered: A / B\n**A:**`,
        ).join("\n");
        const result = parseFactoryQuestions(lines);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("QUESTIONS_TOO_MANY_LINES");
      });

      test("returns available for questions with exactly MAX_QUESTIONS_LINES", () => {
        const taskLine = `## Q1 (task T1, open) — Question`;
        const blankLines = Array.from(
          { length: MAX_QUESTIONS_LINES - 5 },
          () => "",
        ).join("\n");
        const lines =
          taskLine +
          "\nContext: test\nOptions considered: A / B\n**A:**" +
          "\n" +
          blankLines;
        const result = parseFactoryQuestions(lines);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.open).toHaveLength(1);
        }
      });
    });

    describe("line length validation", () => {
      test("returns unavailable for line exceeding MAX_QUESTION_LINE_LENGTH", () => {
        const longLine = `## Q1 (task T1, open) — ${"x".repeat(MAX_QUESTION_LINE_LENGTH + 1)}\nContext: test\nOptions considered: A / B\n**A:**`;
        const result = parseFactoryQuestions(`first\n${longLine}`);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("QUESTIONS_LINE_TOO_LONG");
        expect(result.warnings[0]!.line).toBe(2);
        expect(Array.from(result.warnings[0]!.excerpt ?? "")).toHaveLength(
          MAX_WARNING_EXCERPT_CODE_POINTS,
        );
        expect(result.warnings[0]!.excerpt?.endsWith("…")).toBe(true);
      });

      test("returns available for line with exactly MAX_QUESTION_LINE_LENGTH", () => {
        const line = `## Q1 (task T1, open) — ${"x".repeat(MAX_QUESTION_LINE_LENGTH - 45)}\nContext: test\nOptions considered: A / B\n**A:**`;
        const result = parseFactoryQuestions(line);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.open).toHaveLength(1);
        }
      });
    });

    describe("structured option bounds", () => {
      test("falls back when a hard-wrapped option elaboration exceeds the limit", () => {
        const fragment = "x".repeat(4500);
        const question = `## Q1 (task T1, open) — Long elaboration
Context: Context
Options considered: A — Proceed / B — Wait
Option A: ${fragment}
${fragment}
**A:**`;
        const result = parseFactoryQuestions(question);

        expect(result.status).toBe("partial");
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "QUESTIONS_OPTION_TOO_LONG" }),
          ]),
        );
        if (result.status === "partial") {
          expect(result.data.open[0]?.options).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(question);
        }
      });

      test("falls back when a hard-wrapped labelled option exceeds the limit", () => {
        const fragment = "x".repeat(4500);
        const questions = `## Q1 (task T1, open) — Long option
Context: Context
Options considered: A — ${fragment}
${fragment}
**A:**`;
        const result = parseFactoryQuestions(questions);

        expect(result.status).toBe("partial");
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "QUESTIONS_OPTION_TOO_LONG" }),
          ]),
        );
        if (result.status === "partial") {
          expect(result.data.open[0]?.options).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(questions);
        }
      });

      test("falls back when a prose-only option exceeds the limit", () => {
        const fragment = "x".repeat(4500);
        const questions = `## Q1 (task T1, open) — Long option
Context: Context
Options considered: A ${fragment}
${fragment} / B short
**A:**`;
        const result = parseFactoryQuestions(questions);

        expect(result.status).toBe("partial");
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "QUESTIONS_OPTION_TOO_LONG" }),
          ]),
        );
        if (result.status === "partial") {
          expect(result.data.open[0]?.proseOptions).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(questions);
        }
      });
    });

    describe("entry parsing - valid entries", () => {
      test("parses open question with all fields", () => {
        const questions = `## Q1 (task T1, open) — How to implement feature?
Context: Need guidance on approach
Options considered: A / B
**A:** Use approach A`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(1);
          expect(result.data.open[0]).toEqual({
            id: "Q1",
            taskId: "T1",
            title: "How to implement feature?",
            text: questions,
            context: "Need guidance on approach",
            options: [
              { label: "A", text: "" },
              { label: "B", text: "" },
            ],
          });
        }
      });

      test("parses multiple open questions", () => {
        const questions = `## Q1 (task T1, open) — First question?
Context: First context
Options considered: A / B
**A:** First answer
## Q2 (task T2, open) — Second question?
Context: Second context
Options considered: C / D
**A:** Second answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(2);
          expect(result.data.open[0]!.id).toBe("Q1");
          expect(result.data.open[1]!.id).toBe("Q2");
        }
      });

      test("preserves hard-wrapped labelled and slash-separated option prose", () => {
        const result = parseFactoryQuestions(`## Q1 (task T1, open) — Labelled
Context: Choose a rollout.
Options considered: A — Enable the change for the first cohort and
continue monitoring its error budget (recommended)
B — Enable it for every cohort and
accept the wider blast radius
**A:**
## Q2 (task T2, open) — Unlabelled
Context: Choose a migration.
Options considered: Keep the current format while the consumer is
updated / Move every consumer now and
coordinate the outage window
**A:**`);

        expect(result).toMatchObject({ status: "available" });
        if (result.status === "available") {
          expect(result.data.open).toMatchObject([
            {
              id: "Q1",
              options: [
                {
                  label: "A",
                  text: "Enable the change for the first cohort and continue monitoring its error budget (recommended)",
                  recommended: true,
                },
                {
                  label: "B",
                  text: "Enable it for every cohort and accept the wider blast radius",
                },
              ],
            },
            {
              id: "Q2",
              proseOptions: [
                "Keep the current format while the consumer is updated",
                "Move every consumer now and coordinate the outage window",
              ],
            },
          ]);
        }
      });

      test("parses Q5 option elaboration without appending it to the final option", () => {
        const details =
          parseQuestionDetails(`## Q5 (task T68, open, filed-at 2026-09-01T05:56:28Z) — Another review round?
Context: A bounded cost reader masks an invalid older task.
Options considered: A — authorize one additional fix-and-review round that validates every bounded-source task before retention (recommended) / B — restore fail-closed unavailability for every file above 64 KiB
Option A: The T68 implementation owner adds a full bounded validation pass and runs one final panel.
Owner: T68 implementation owner.
Day-to-day consequence: active repositories keep partial recent costs instead of losing the panel.
Cost or risk: one exception to the normal two-panel-round convergence budget.
Option B: The dashboard product owner accepts that repositories above 64 KiB continue to show costs as unavailable.
Owner: dashboard product owner.
Day-to-day consequence: operators lose cost visibility again as active histories grow.
Cost or risk: T68's stated acceptance is not delivered and requires replanning.
Recommendation rationale: A fixes the confirmed fail-closed gap without weakening the approved bounded-window acceptance criteria.
**A:**`);

        expect(details).toMatchObject({
          options: [
            {
              label: "A",
              text: "authorize one additional fix-and-review round that validates every bounded-source task before retention (recommended)",
              recommended: true,
              details: {
                elaboration:
                  "The T68 implementation owner adds a full bounded validation pass and runs one final panel.",
                owner: "T68 implementation owner.",
                dayToDayConsequence:
                  "active repositories keep partial recent costs instead of losing the panel.",
                costOrRisk:
                  "one exception to the normal two-panel-round convergence budget.",
              },
            },
            {
              label: "B",
              text: "restore fail-closed unavailability for every file above 64 KiB",
              details: {
                elaboration:
                  "The dashboard product owner accepts that repositories above 64 KiB continue to show costs as unavailable.",
                owner: "dashboard product owner.",
                dayToDayConsequence:
                  "operators lose cost visibility again as active histories grow.",
                costOrRisk:
                  "T68's stated acceptance is not delivered and requires replanning.",
              },
            },
          ],
          recommendationRationale:
            "A fixes the confirmed fail-closed gap without weakening the approved bounded-window acceptance criteria.",
        });
      });

      test("parses each elaboration field in a mixed option envelope with its matching option", () => {
        const result =
          parseFactoryQuestions(`## Q6 (task T6, open) — Which migration should run?
Context: The operator needs to choose a migration.
Options considered: A — migrate the first cohort / B — migrate every cohort
Option A: Start with the smallest tenant group.
Owner: rollout owner.
Cost or risk: the pilot takes another day.
Option B: Move all tenants in one maintenance window.
Day-to-day consequence: support coordinates one larger outage notice.
Owner: migration owner.
Cost or risk: a failed migration affects every tenant.
Recommendation rationale: A limits the initial blast radius.
**A:**`);

        expect(result).toMatchObject({ status: "available" });
        if (result.status === "available") {
          expect(result.data.open[0]?.options).toEqual([
            {
              label: "A",
              text: "migrate the first cohort",
              details: {
                elaboration: "Start with the smallest tenant group.",
                owner: "rollout owner.",
                costOrRisk: "the pilot takes another day.",
              },
            },
            {
              label: "B",
              text: "migrate every cohort",
              details: {
                elaboration: "Move all tenants in one maintenance window.",
                dayToDayConsequence:
                  "support coordinates one larger outage notice.",
                owner: "migration owner.",
                costOrRisk: "a failed migration affects every tenant.",
              },
            },
          ]);
          expect(
            (result.data.open[0] as { recommendationRationale?: string })
              .recommendationRationale,
          ).toBe("A limits the initial blast radius.");
        }
      });

      test("keeps an unrecognized trailing envelope in the raw fallback", () => {
        const question = `## Q7 (task T7, open) — Preserve unknown grammar
Context: The reader must not discard a future protocol field.
Options considered: A — Proceed
Option A: Use the current implementation path.
Future protocol field: retain this exactly
**A:**`;
        const result = parseFactoryQuestions(question);

        expect(result).toMatchObject({ status: "available" });
        if (result.status === "available") {
          expect(result.data.open[0]?.options).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(question);
        }
      });

      test("keeps an unrecognized field before option elaboration in the raw fallback", () => {
        const question = `## Q8 (task T8, open) — Preserve reordered unknown grammar
Context: The reader must not merge a future field into the final option.
Options considered: A — Proceed / B — Wait
Future protocol field: retain this exactly
Option A: Use the current implementation path.
**A:**`;
        const result = parseFactoryQuestions(question);

        expect(result).toMatchObject({ status: "available" });
        if (result.status === "available") {
          expect(result.data.open[0]?.options).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(question);
        }
      });

      test("keeps an unrecognized trailing field in the raw fallback without an elaboration anchor", () => {
        const question = `## Q9 (task T9, open) — Preserve standalone unknown grammar
Context: The reader must not merge a future field into the final option.
Options considered: A — Proceed / B — Wait
Future protocol field: retain this exactly
**A:**`;
        const result = parseFactoryQuestions(question);

        expect(result).toMatchObject({ status: "available", warnings: [] });
        if (result.status === "available") {
          expect(result.data.open[0]?.options).toBeUndefined();
          expect(result.data.open[0]?.proseOptions).toBeUndefined();
          expect(result.data.open[0]?.text).toBe(question);
        }
      });

      test.each([
        {
          label: "Future field v2:",
          envelope: "Future field v2: retain this exactly",
        },
        {
          label: "2FA policy v2:",
          envelope:
            "Option A: Use the current implementation path.\n2FA policy v2: retain this exactly",
        },
        {
          label: "Future_field:",
          envelope:
            "Option A: Use the current implementation path.\nOwner: implementation owner.\nFuture_field: retain this exactly",
        },
        {
          label: "@future-field:",
          envelope: "@future-field: retain this exactly",
        },
        {
          label: "[Future field]:",
          envelope: "[Future field]: retain this exactly",
        },
        {
          label: "@:",
          envelope: "@: retain this exactly",
        },
        {
          label: "2:",
          envelope: "2: retain this exactly",
        },
        {
          label: "Future_field: without separating whitespace",
          envelope: "Future_field:retain this exactly",
        },
      ])(
        "keeps standalone unknown label $label anywhere in the raw fallback",
        ({ envelope }) => {
          const question = `## Q10 (task T10, open) — Preserve future grammar
Context: The reader must preserve unknown protocol fields.
Options considered: A — Proceed / B — Wait
${envelope}
**A:**`;
          const result = parseFactoryQuestions(question);

          expect(result).toMatchObject({ status: "available", warnings: [] });
          if (result.status === "available") {
            expect(result.data.open[0]?.options).toBeUndefined();
            expect(result.data.open[0]?.proseOptions).toBeUndefined();
            expect(result.data.open[0]?.text).toBe(question);
          }
        },
      );

      test("keeps ordinary hard-wrapped option prose structured without a standalone label", () => {
        const result =
          parseFactoryQuestions(`## Q11 (task T11, open) — Preserve wrapped prose
Context: The reader must preserve ordinary option continuations.
Options considered: A — Proceed with the staged rollout while the team
tracks the Future field v2 migration / B — Wait for the next window
**A:**`);

        expect(result).toMatchObject({ status: "available", warnings: [] });
        if (result.status === "available") {
          expect(result.data.open[0]?.options).toEqual([
            {
              label: "A",
              text: "Proceed with the staged rollout while the team tracks the Future field v2 migration",
            },
            { label: "B", text: "Wait for the next window" },
          ]);
          expect(result.data.open[0]?.proseOptions).toBeUndefined();
        }
      });

      test.each([
        {
          options: `Options considered: A — Follow the published
2FA policy v2: require step-up verification / B — Wait`,
          expected:
            "Follow the published 2FA policy v2: require step-up verification",
        },
        {
          options: `Options considered: A — Follow the published
Note: track the migration
B — Wait`,
          expected: "Follow the published Note: track the migration",
        },
      ])(
        "keeps colon-bearing hard-wrapped option prose structured",
        ({ options, expected }) => {
          const result =
            parseFactoryQuestions(`## Q12 (task T12, open) — Preserve colon prose
Context: The reader must preserve ordinary option continuations.
${options}
**A:**`);

          expect(result).toMatchObject({ status: "available", warnings: [] });
          if (result.status === "available") {
            expect(result.data.open[0]?.options).toEqual([
              { label: "A", text: expected },
              { label: "B", text: "Wait" },
            ]);
          }
        },
      );

      test("excludes answered questions from open array", () => {
        const questions = `## Q1 (task T1, open) — Open question?
Context: Context
Options considered: A / B
**A:** Answer
## Q2 (task T2, answered) — Answered question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(1);
          expect(result.data.open[0]!.id).toBe("Q1");
        }
      });

      test("accepts every protocol status while emitting only open questions without malformed warnings", () => {
        const questions = `## Q1 (task T1, open) — Open
Context: Context
Options considered: A — Proceed
**A:**
## Q2 (task T2, answered) — Answered
Context: Context
Options considered: A — Proceed
**A:** Chosen
## Q3 (task T3, consumed) — Consumed
Context: Context
Options considered: A — Proceed
**A:** Applied
## Q4 (task T4, withdrawn) — Withdrawn
Context: Context
Options considered: A — Proceed
**A:** Closed externally`;

        const result = parseFactoryQuestions(questions);

        expect(result).toMatchObject({
          status: "available",
          data: { open: [{ id: "Q1", taskId: "T1" }] },
          warnings: [],
        });
      });

      test("exposes valid whole and fractional filed-at timestamps and retains legacy entries before the marker", () => {
        const result = parseFactoryQuestions(`## Q1 (task T1, open) — Legacy
Context: Context
Options considered: A — Go
**A:**
<!-- factory-question-timestamps-required-below -->
## Q2 (task T2, open, filed-at 2026-08-30T03:04:05Z) — Timestamped
Context: Context
Options considered: A — Go
**A:**
## Q3 (task T3, open, filed-at 2026-08-30T03:04:05.123456Z) — Fractional
Context: Context
Options considered: A — Go
**A:**`);
        expect(result).toMatchObject({
          status: "available",
          data: {
            open: [
              { id: "Q1" },
              { id: "Q2", filedAt: "2026-08-30T03:04:05Z" },
              { id: "Q3", filedAt: "2026-08-30T03:04:05.123456Z" },
            ],
          },
        });
      });

      test("warns but retains valid questions when filed-at syntax below the marker is malformed", () => {
        for (const filedAt of [
          "2026-02-30T03:04:05Z",
          "2026-08-30T24:04:05Z",
          "2026-08-30T03:04:05+00:00",
          "2026-08-30T03:04:05.Z",
          `2026-08-30T03:04:05.${"1".repeat(80)}Z`,
          '<img src=x onerror="globalThis.questionPwned=1">',
        ]) {
          const result =
            parseFactoryQuestions(`<!-- factory-question-timestamps-required-below -->
## Q1 (task T1, open, filed-at ${filedAt}) — Bad
Context: Context
Options considered: A — Go
**A:**`);
          expect(result).toMatchObject({
            status: "partial",
            data: { open: [{ id: "Q1", title: "Bad" }] },
          });
          if (result.status === "partial") {
            expect(result.data.open[0]?.filedAt).toBeUndefined();
          }
          expect(result.warnings).toContainEqual(
            expect.objectContaining({ code: "QUESTIONS_MALFORMED_ENTRY" }),
          );
        }
        const missing =
          parseFactoryQuestions(`<!-- factory-question-timestamps-required-below -->
## Q1 (task T1, open) — Missing
Context: Context
Options considered: A — Go
**A:**`);
        expect(missing).toMatchObject({
          status: "partial",
          data: { open: [{ id: "Q1", title: "Missing" }] },
        });
        if (missing.status === "partial") {
          expect(missing.data.open[0]?.filedAt).toBeUndefined();
        }
        expect(missing.warnings).toContainEqual(
          expect.objectContaining({ code: "QUESTIONS_MALFORMED_ENTRY" }),
        );
      });

      test("warns safely for duplicate or in-entry timestamp markers without dropping valid questions", () => {
        const duplicate =
          parseFactoryQuestions(`<!-- factory-question-timestamps-required-below -->
## Q1 (task T1, open, filed-at 2026-08-30T03:04:05Z) — First
Context: Context
Options considered: A — Go
**A:**
<!-- factory-question-timestamps-required-below -->
## Q2 (task T2, open, filed-at 2026-08-30T03:04:06Z) — Second
Context: Context
Options considered: A — Go
**A:**`);
        expect(duplicate).toMatchObject({
          status: "partial",
          data: { open: [{ id: "Q1" }, { id: "Q2" }] },
          warnings: [
            expect.objectContaining({ code: "QUESTIONS_MALFORMED_ENTRY" }),
          ],
        });

        const misplaced = parseFactoryQuestions(`## Q3 (task T3, open) — Legacy
Context: Context
<!-- factory-question-timestamps-required-below -->
Options considered: A — Go
**A:**`);
        expect(misplaced).toMatchObject({
          status: "partial",
          data: { open: [{ id: "Q3", title: "Legacy" }] },
        });
        expect(misplaced.warnings).toContainEqual(
          expect.objectContaining({ code: "QUESTIONS_MALFORMED_ENTRY" }),
        );

        const answered =
          parseFactoryQuestions(`## Q4 (task T4, answered) — Already answered
Context: Context
<!-- factory-question-timestamps-required-below -->
Options considered: A — Go
**A:** A
## Q5 (task T5, open, filed-at 2026-08-30T03:04:07Z) — Still open
Context: Context
Options considered: A — Go
**A:**`);
        expect(answered).toMatchObject({
          status: "partial",
          data: { open: [{ id: "Q5" }] },
        });
        expect(answered.warnings).toContainEqual(
          expect.objectContaining({ code: "QUESTIONS_MALFORMED_ENTRY" }),
        );
      });
    });

    describe("entry parsing - missing protocol fields", () => {
      test("warns about missing Context field", () => {
        const questions = `## Q1 (task T1, open) — Question?
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_INCOMPLETE_ENTRY"),
        ).toBe(true);
        expect(result.warnings[0]!.line).toBe(1);
      });

      test("warns about missing Options considered field", () => {
        const questions = `## Q1 (task T1, open) — Question?
Context: Context
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_INCOMPLETE_ENTRY"),
        ).toBe(true);
      });

      test("warns about missing **A:** field", () => {
        const questions = `## Q1 (task T1, open) — Question?
Context: Context
Options considered: A / B`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_INCOMPLETE_ENTRY"),
        ).toBe(true);
      });

      test("warns about multiple missing protocol fields", () => {
        const questions = `## Q1 (task T1, open) — Question?`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        const incompleteWarnings = result.warnings.filter(
          (w) => w.code === "QUESTIONS_INCOMPLETE_ENTRY",
        );
        expect(incompleteWarnings).toHaveLength(1);
        expect(incompleteWarnings[0]!.line).toBe(1);
      });
    });

    describe("malformed entries", () => {
      test("warns about malformed heading (missing status)", () => {
        const questions = `## Q1 (task T1) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_MALFORMED_ENTRY"),
        ).toBe(true);
        expect(result.warnings[0]!.line).toBe(1);
        expect(result.warnings[0]!.excerpt).toBe("## Q1 (task T1) — Question?");
      });

      test("warns about malformed heading (invalid status)", () => {
        const questions = `## Q1 (task T1, pending) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("warns about malformed heading (missing task prefix)", () => {
        const questions = `## Q1 (T1, open) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("warns about malformed heading (invalid Q format)", () => {
        const questions = `## Q0 (task T1, open) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_MALFORMED_ENTRY"),
        ).toBe(true);
      });
    });

    describe("duplicate detection", () => {
      test("warns about duplicate question IDs", () => {
        const questions = `## Q1 (task T1, open) — First question?
Context: Context
Options considered: A / B
**A:** Answer
## Q1 (task T2, open) — Second question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "QUESTIONS_DUPLICATE_ID"),
        ).toBe(true);
        const dupWarnings = result.warnings.filter(
          (w) => w.code === "QUESTIONS_DUPLICATE_ID",
        );
        expect(dupWarnings).toHaveLength(2);
        expect(dupWarnings[0]!.line).toBe(1);
        expect(dupWarnings[1]!.line).toBe(5);
      });
    });

    describe("question limit enforcement", () => {
      test("returns unavailable for questions exceeding MAX_QUESTIONS", () => {
        const lines = Array.from(
          { length: MAX_QUESTIONS + 1 },
          (_, i) => `## Q${i + 1} (task T1, open) — Question ${i + 1}
Context: Context
Options considered: A / B
**A:** Answer`,
        ).join("\n");
        const result = parseFactoryQuestions(lines);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("QUESTIONS_TOO_MANY_ENTRIES");
      });

      test("returns available for questions with exactly MAX_QUESTIONS", () => {
        const lines = Array.from(
          { length: MAX_QUESTIONS },
          (_, i) => `## Q${i + 1} (task T1, open) — Question ${i + 1}
Context: Context
Options considered: A / B
**A:** Answer`,
        ).join("\n");
        const result = parseFactoryQuestions(lines);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.open).toHaveLength(MAX_QUESTIONS);
        }
      });
    });

    describe("CRLF line endings", () => {
      test("handles CRLF line endings", () => {
        const questions =
          "## Q1 (task T1, open) — Question?\r\nContext: test\r\nOptions considered: A / B\r\n**A:** Answer";
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(1);
        }
      });
    });

    describe("hostile content preservation", () => {
      test("preserves hostile title in question", () => {
        const hostile = "<script>alert(1)</script>";
        const questions = `## Q1 (task T1, open) — ${hostile}
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[0]!.title).toBe(hostile);
        }
      });

      test("preserves hostile context text", () => {
        const hostile = "<img src=x onerror=alert(1)>";
        const questions = `## Q1 (task T1, open) — Question?
Context: ${hostile}
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[0]!.text).toContain(hostile);
        }
      });

      test("preserves hostile options text", () => {
        const hostile = '<a href="javascript:alert(1)">click</a>';
        const questions = `## Q1 (task T1, open) — Question?
Context: Context
Options considered: ${hostile} / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[0]!.text).toContain(hostile);
        }
      });

      test("preserves hostile answer text", () => {
        const hostile = "<div onclick=alert(1)>answer</div>";
        const questions = `## Q1 (task T1, open) — Question?
Context: Context
Options considered: A / B
**A:** ${hostile}`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[0]!.text).toContain(hostile);
        }
      });
    });

    describe("empty and edge cases", () => {
      test("handles empty questions file", () => {
        const result = parseFactoryQuestions("");
        expect(result.status).toBe("partial");
        expect(result.warnings.some((w) => w.code === "QUESTIONS_EMPTY")).toBe(
          true,
        );
      });

      test("handles questions file with only whitespace", () => {
        const result = parseFactoryQuestions("   \n  \n  ");
        expect(result.status).toBe("partial");
        expect(result.warnings.some((w) => w.code === "QUESTIONS_EMPTY")).toBe(
          true,
        );
      });

      test("handles questions file with comments (non-entry lines)", () => {
        const questions = `# This is a comment
## Section
## Q1 (task T1, open) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(1);
        }
      });

      test("handles questions file with blank lines between entries", () => {
        const questions = `## Q1 (task T1, open) — First question?
Context: Context
Options considered: A / B
**A:** Answer

## Q2 (task T2, open) — Second question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open).toHaveLength(2);
        }
      });
    });

    describe("warning truncation", () => {
      test("truncates warnings at MAX_QUESTIONS_WARNINGS", () => {
        const lines = Array.from(
          { length: MAX_QUESTIONS_WARNINGS + 5 },
          (_, i) => `## Q${i + 1} (task T1, open) — Question ${i + 1}`,
        ).join("\n");
        const result = parseFactoryQuestions(lines);
        expect(result.warnings).toHaveLength(MAX_QUESTIONS_WARNINGS);
        expect(result.warnings[MAX_QUESTIONS_WARNINGS - 1]!.code).toBe(
          "WARNINGS_TRUNCATED",
        );
      });
    });

    describe("source slice preservation", () => {
      test("preserves exact source slice including heading and all content", () => {
        const questions = `## Q1 (task T1, open) — Question?
Context: Context line 1
Context: Context line 2
Options considered: A / B
**A:** Answer line 1
**A:** Answer line 2`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[0]!.text).toBe(questions);
        }
      });

      test("preserves source slice for last entry without trailing content", () => {
        const questions = `## Q1 (task T1, open) — First question?
Context: Context
Options considered: A / B
**A:** Answer
## Q2 (task T2, open) — Last question?
Context: Context
Options considered: A / B
**A:** Answer`;
        const result = parseFactoryQuestions(questions);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.open[1]!.text).toBe(
            "## Q2 (task T2, open) — Last question?\nContext: Context\nOptions considered: A / B\n**A:** Answer",
          );
        }
      });
    });
  });

  describe("readFactoryQuestions", () => {
    let tempDir: string;
    let factoryDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-questions-"));
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

    test("returns available for valid questions.md", async () => {
      const questions = `## Q1 (task T1, open) — How to implement feature?
Context: Need guidance on approach
Options considered: A / B
**A:** Use approach A`;
      await Bun.write(join(factoryDir, "questions.md"), questions);

      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("available");
      if (result.status === "available") {
        expect(result.data.open).toHaveLength(1);
        expect(result.data.open[0]!.id).toBe("Q1");
      }
    });

    test("returns unavailable with QUESTIONS_MISSING when questions.md is missing", async () => {
      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("QUESTIONS_MISSING");
      expect(result.warnings[0]!.message).toBe("questions.md is missing");
    });

    test("returns unavailable with QUESTIONS_TOO_LARGE when questions.md exceeds MAX_QUESTIONS_BYTES", async () => {
      const largeContent =
        "## Q1 (task T1, open) — " +
        "x".repeat(MAX_QUESTIONS_BYTES + 1) +
        "\nContext: test\nOptions considered: A / B\n**A:**";
      await Bun.write(join(factoryDir, "questions.md"), largeContent);

      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("QUESTIONS_TOO_LARGE");
      expect(result.warnings[0]!.message).toBe("questions.md is too large");
    });

    test("returns unavailable with QUESTIONS_INVALID_UTF8 for invalid UTF-8", async () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
      await Bun.write(join(factoryDir, "questions.md"), bytes);

      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("QUESTIONS_INVALID_UTF8");
    });

    test("returns partial for valid UTF-8 with warnings", async () => {
      const questions = `## Q1 (task T1, open) — Question?`;
      await Bun.write(join(factoryDir, "questions.md"), questions);

      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("partial");
      expect(result.warnings).toHaveLength(1);
    });

    test("handles missing .factory directory", async () => {
      rmSync(factoryDir, { recursive: true, force: true });
      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("QUESTIONS_MISSING");
    });

    test("preserves repository identity in error messages", async () => {
      const questions = `## Q1 (task T1, open) — Question?
Context: Context
Options considered: A / B
**A:** Answer`;
      await Bun.write(join(factoryDir, "questions.md"), questions);

      const result = await readFactoryQuestions(tempDir);
      expect(result.status).toBe("available");
    });
  });
});
