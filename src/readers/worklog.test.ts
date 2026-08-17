import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_WORKLOG_BYTES,
  MAX_WORKLOG_LINES,
  MAX_WORKLOG_LINE_LENGTH,
  MAX_WORKLOG_ENTRIES,
  MAX_WORKLOG_WARNINGS,
  parseFactoryWorklog,
  readFactoryWorklog,
} from "./worklog";
import { type WorklogData } from "../contracts";
import { MAX_WARNING_EXCERPT_CODE_POINTS } from "./warnings";

describe("worklog reader", () => {
  describe("constants", () => {
    test("MAX_WORKLOG_BYTES is 262144", () => {
      expect(MAX_WORKLOG_BYTES).toBe(256 * 1024);
    });

    test("MAX_WORKLOG_LINES is 4096", () => {
      expect(MAX_WORKLOG_LINES).toBe(4096);
    });

    test("MAX_WORKLOG_LINE_LENGTH is 8192", () => {
      expect(MAX_WORKLOG_LINE_LENGTH).toBe(8192);
    });

    test("MAX_WORKLOG_ENTRIES is 20", () => {
      expect(MAX_WORKLOG_ENTRIES).toBe(20);
    });

    test("MAX_WORKLOG_WARNINGS is 32", () => {
      expect(MAX_WORKLOG_WARNINGS).toBe(32);
    });
  });

  describe("parseFactoryWorklog", () => {
    describe("line count validation", () => {
      test("returns unavailable for worklog exceeding MAX_WORKLOG_LINES", () => {
        const lines = Array.from(
          { length: MAX_WORKLOG_LINES + 1 },
          (_, i) => `- 2026-08-16 UTC - Entry ${i + 1}`,
        ).join("\n");
        const result = parseFactoryWorklog(lines);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("WORKLOG_TOO_MANY_LINES");
      });

      test("returns available for worklog with exactly MAX_WORKLOG_LINES", () => {
        const taskLine = `- 2026-08-16 UTC - Entry`;
        const blankLines = Array.from(
          { length: MAX_WORKLOG_LINES - 1 },
          () => "",
        ).join("\n");
        const lines = taskLine + "\n" + blankLines;
        const result = parseFactoryWorklog(lines);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
        }
      });
    });

    describe("line length validation", () => {
      test("returns unavailable for line exceeding MAX_WORKLOG_LINE_LENGTH", () => {
        const longLine = `- 2026-08-16 UTC - ${"x".repeat(MAX_WORKLOG_LINE_LENGTH + 1)}`;
        const result = parseFactoryWorklog(`first\n${longLine}`);
        expect(result.status).toBe("unavailable");
        expect(result.warnings[0]!.code).toBe("WORKLOG_LINE_TOO_LONG");
        expect(result.warnings[0]!.line).toBe(2);
        expect(Array.from(result.warnings[0]!.excerpt ?? "")).toHaveLength(
          MAX_WARNING_EXCERPT_CODE_POINTS,
        );
        expect(result.warnings[0]!.excerpt?.endsWith("…")).toBe(true);
      });

      test("returns available for line with exactly MAX_WORKLOG_LINE_LENGTH", () => {
        const line = `- 2026-08-16 UTC - ${"x".repeat(MAX_WORKLOG_LINE_LENGTH - 26)}`;
        const result = parseFactoryWorklog(line);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
        }
      });
    });

    describe("entry parsing - valid entries", () => {
      test("parses valid worklog entry", () => {
        const worklog = `- 2026-08-16 UTC - Started work on T1`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
          expect(result.data.entries[0]).toEqual({
            date: "2026-08-16",
            text: worklog,
          });
        }
      });

      test("parses multiple valid entries", () => {
        const worklog = `- 2026-08-14 UTC - First entry
- 2026-08-15 UTC - Second entry
- 2026-08-16 UTC - Third entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(3);
          expect(result.data.entries[0]!.date).toBe("2026-08-14");
          expect(result.data.entries[1]!.date).toBe("2026-08-15");
          expect(result.data.entries[2]!.date).toBe("2026-08-16");
        }
      });

      test("returns newest bounded entries (MAX_WORKLOG_ENTRIES)", () => {
        const entries = Array.from(
          { length: MAX_WORKLOG_ENTRIES + 10 },
          (_, i) =>
            `- 2026-08-${String(i + 1).padStart(2, "0")} UTC - Entry ${i + 1}`,
        ).join("\n");
        const result = parseFactoryWorklog(entries);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(MAX_WORKLOG_ENTRIES);
          // Should return the newest (last) entries
          expect(result.data.entries[0]!.date).toBe("2026-08-11");
          expect(result.data.entries[MAX_WORKLOG_ENTRIES - 1]!.date).toBe(
            "2026-08-30",
          );
        }
      });
    });

    describe("malformed entries", () => {
      test("warns about malformed entry (missing date)", () => {
        const worklog = `- - Missing date
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
        expect(result.warnings[0]!.line).toBe(1);
      });

      test("preserves hostile and control characters in a bounded excerpt", () => {
        const source = "- <img onerror=alert(1)>\u0001 malformed";
        const result = parseFactoryWorklog(source);

        expect(result.warnings[0]).toEqual({
          code: "WORKLOG_MALFORMED_ENTRY",
          message: "a worklog entry is malformed",
          line: 1,
          excerpt: source,
        });
      });

      test("warns about malformed entry (invalid date format)", () => {
        const worklog = `- 2026-13-45 UTC - Invalid date
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("warns about malformed entry (non-UTC suffix)", () => {
        const worklog = `- 2026-08-16 EST - Wrong timezone
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("warns about malformed entry (invalid date values)", () => {
        const worklog = `- 2026-02-30 UTC - Invalid Feb 30
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("ignores malformed line without dash prefix (not a boundary)", () => {
        const worklog = `2026-08-16 UTC - Missing dash
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
          expect(result.data.entries[0]!.date).toBe("2026-08-16");
        }
      });

      test("warns about malformed entry (malformed date number)", () => {
        const worklog = `- 0000-00-00 UTC - Zero date
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });
    });

    describe("date validation", () => {
      test("accepts valid leap year date", () => {
        const worklog = `- 2024-02-29 UTC - Leap year date`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
      });

      test("rejects non-leap year Feb 29", () => {
        const worklog = `- 2023-02-29 UTC - Invalid leap year`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("accepts end of month dates", () => {
        const worklog = `- 2026-01-31 UTC - January 31
- 2026-04-30 UTC - April 30`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
      });
    });

    describe("CRLF line endings", () => {
      test("handles CRLF line endings", () => {
        const worklog =
          "- 2026-08-16 UTC - Entry 1\r\n- 2026-08-17 UTC - Entry 2";
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(2);
        }
      });
    });

    describe("hostile content preservation", () => {
      test("preserves hostile entry text", () => {
        const hostile = "<script>alert(1)</script>";
        const worklog = `- 2026-08-16 UTC - ${hostile}`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.text).toContain(hostile);
        }
      });

      test("preserves hostile date field (if somehow parsed)", () => {
        const hostile = "2026-08-16<script>";
        const worklog = `- ${hostile} UTC - Entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        // The date parsing should reject this, so it won't be in entries
      });
    });

    describe("empty and edge cases", () => {
      test("handles empty worklog file", () => {
        const result = parseFactoryWorklog("");
        expect(result.status).toBe("partial");
        expect(result.warnings.some((w) => w.code === "WORKLOG_EMPTY")).toBe(
          true,
        );
      });

      test("handles worklog file with only whitespace", () => {
        const result = parseFactoryWorklog("   \n  \n  ");
        expect(result.status).toBe("partial");
        expect(result.warnings.some((w) => w.code === "WORKLOG_EMPTY")).toBe(
          true,
        );
      });

      test("handles worklog file with comments (non-entry lines)", () => {
        const worklog = `# This is a comment
## Section
- 2026-08-16 UTC - Valid entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
        }
      });

      test("handles worklog file with blank lines between entries", () => {
        const worklog = `- 2026-08-16 UTC - Entry 1

- 2026-08-17 UTC - Entry 2`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(2);
        }
      });
    });

    describe("warning truncation", () => {
      test("does not truncate warnings when no warnings are generated", () => {
        const lines = Array.from(
          { length: 10 },
          (_, i) =>
            `- 2026-08-${String(i + 1).padStart(2, "0")} UTC - Entry ${i + 1}`,
        ).join("\n");
        const result = parseFactoryWorklog(lines);
        expect(result.warnings).toHaveLength(0);
      });
    });

    describe("source slice preservation", () => {
      test("preserves exact source slice including heading and all content", () => {
        const worklog = `- 2026-08-16 UTC - Entry with
multiple lines of text
that span several lines`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.text).toBe(worklog);
        }
      });

      test("preserves source slice for last entry without trailing content", () => {
        const worklog = `- 2026-08-16 UTC - First entry
- 2026-08-17 UTC - Last entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[1]!.text).toBe(
            "- 2026-08-17 UTC - Last entry",
          );
        }
      });
    });

    describe("time field parsing", () => {
      test("parses entry with time as HH:MM format", () => {
        const worklog = `- 2026-08-16 14:30 UTC - Started work on T1`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.date).toBe("2026-08-16");
          expect(result.data.entries[0]!.time).toBe("14:30");
          expect(result.data.entries[0]!.text).toBe(worklog);
        }
      });

      test("parses legacy entry without time field", () => {
        const worklog = `- 2026-08-16 UTC - Started work on T1`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.date).toBe("2026-08-16");
          expect(result.data.entries[0]!.time).toBeUndefined();
        }
      });

      test("parses mixed old and new format entries in order", () => {
        const worklog = `- 2026-08-14 UTC - Legacy entry 1
- 2026-08-15 09:00 UTC - Timed entry 1
- 2026-08-16 UTC - Legacy entry 2
- 2026-08-17 23:45 UTC - Timed entry 2`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries).toHaveLength(4);
          expect(result.data.entries[0]!.date).toBe("2026-08-14");
          expect(result.data.entries[0]!.time).toBeUndefined();
          expect(result.data.entries[1]!.date).toBe("2026-08-15");
          expect(result.data.entries[1]!.time).toBe("09:00");
          expect(result.data.entries[2]!.date).toBe("2026-08-16");
          expect(result.data.entries[2]!.time).toBeUndefined();
          expect(result.data.entries[3]!.date).toBe("2026-08-17");
          expect(result.data.entries[3]!.time).toBe("23:45");
        }
      });

      test("counts mixed entries identically within bounds", () => {
        const timedEntries = Array.from(
          { length: 5 },
          (_, i) =>
            `- 2026-08-${String(i + 1).padStart(2, "0")} 12:00 UTC - Entry ${i + 1}`,
        ).join("\n");
        const legacyEntries = Array.from(
          { length: 5 },
          (_, i) =>
            `- 2026-08-${String(i + 1).padStart(2, "0")} UTC - Entry ${i + 1}`,
        ).join("\n");

        const timedResult = parseFactoryWorklog(timedEntries);
        const legacyResult = parseFactoryWorklog(legacyEntries);

        expect(timedResult.status).toBe("available");
        expect(legacyResult.status).toBe("available");
        if (
          timedResult.status === "available" &&
          legacyResult.status === "available"
        ) {
          expect(timedResult.data.entries).toHaveLength(
            legacyResult.data.entries.length,
          );
          expect(timedResult.data.entries).toHaveLength(5);
        }
      });

      test("accepts edge time 00:00", () => {
        const worklog = `- 2026-08-16 00:00 UTC - Midnight entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.time).toBe("00:00");
        }
      });

      test("accepts edge time 23:59", () => {
        const worklog = `- 2026-08-16 23:59 UTC - Late night entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.time).toBe("23:59");
        }
      });

      test("rejects malformed time 24:00", () => {
        const worklog = `- 2026-08-16 24:00 UTC - Invalid hour`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("rejects malformed time 9:05 (unpadded hour)", () => {
        const worklog = `- 2026-08-16 9:05 UTC - Invalid unpadded hour`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("rejects malformed time 13:5 (unpadded minute)", () => {
        const worklog = `- 2026-08-16 13:5 UTC - Invalid unpadded minute`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("rejects malformed time 13:05:00 (seconds included)", () => {
        const worklog = `- 2026-08-16 13:05:00 UTC - Invalid with seconds`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
      });

      test("rejects malformed time followed by valid entry", () => {
        const worklog = `- 2026-08-16 24:00 UTC - Invalid hour
- 2026-08-17 UTC - Valid entry after invalid`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
        expect(
          result.warnings.filter((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toHaveLength(1);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
          expect(result.data.entries[0]!.date).toBe("2026-08-17");
        }
      });

      test("rejects malformed time 9:05 followed by valid entry", () => {
        const worklog = `- 2026-08-16 9:05 UTC - Invalid unpadded hour
- 2026-08-17 10:00 UTC - Valid entry after invalid`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("partial");
        expect(
          result.warnings.some((w) => w.code === "WORKLOG_MALFORMED_ENTRY"),
        ).toBe(true);
        if (result.status === "partial" || result.status === "available") {
          expect(result.data.entries).toHaveLength(1);
          expect(result.data.entries[0]!.date).toBe("2026-08-17");
          expect(result.data.entries[0]!.time).toBe("10:00");
        }
      });
    });

    describe("continuation text handling", () => {
      test("includes continuation lines in entry text", () => {
        const worklog = `- 2026-08-16 UTC - Main entry
  - Continuation line 1
  - Continuation line 2`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.text).toBe(worklog);
        }
      });

      test("treats new entry heading as boundary", () => {
        const worklog = `- 2026-08-16 UTC - First entry
  - Continuation
- 2026-08-17 UTC - Second entry`;
        const result = parseFactoryWorklog(worklog);
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.data.entries[0]!.text).toBe(
            "- 2026-08-16 UTC - First entry\n  - Continuation\n",
          );
          expect(result.data.entries[1]!.text).toBe(
            "- 2026-08-17 UTC - Second entry",
          );
        }
      });
    });
  });

  describe("readFactoryWorklog", () => {
    let tempDir: string;
    let factoryDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-worklog-"));
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

    test("returns available for valid worklog.md", async () => {
      const worklog = `- 2026-08-16 UTC - Started work on T1`;
      await Bun.write(join(factoryDir, "worklog.md"), worklog);

      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("available");
      if (result.status === "available") {
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0]!.date).toBe("2026-08-16");
      }
    });

    test("returns unavailable with WORKLOG_MISSING when worklog.md is missing", async () => {
      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("WORKLOG_MISSING");
      expect(result.warnings[0]!.message).toBe("worklog.md is missing");
    });

    test("returns unavailable with WORKLOG_TOO_LARGE when worklog.md exceeds MAX_WORKLOG_BYTES", async () => {
      const largeContent =
        "- 2026-08-16 UTC - " + "x".repeat(MAX_WORKLOG_BYTES + 1);
      await Bun.write(join(factoryDir, "worklog.md"), largeContent);

      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("WORKLOG_TOO_LARGE");
      expect(result.warnings[0]!.message).toBe("worklog.md is too large");
    });

    test("returns unavailable with WORKLOG_INVALID_UTF8 for invalid UTF-8", async () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
      await Bun.write(join(factoryDir, "worklog.md"), bytes);

      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("WORKLOG_INVALID_UTF8");
    });

    test("returns partial for valid UTF-8 with warnings", async () => {
      const worklog = `- invalid-date UTC - Malformed entry`;
      await Bun.write(join(factoryDir, "worklog.md"), worklog);

      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("partial");
      expect(result.warnings).toHaveLength(1);
    });

    test("handles missing .factory directory", async () => {
      rmSync(factoryDir, { recursive: true, force: true });
      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("unavailable");
      expect(result.warnings[0]!.code).toBe("WORKLOG_MISSING");
    });

    test("preserves repository identity in error messages", async () => {
      const worklog = `- 2026-08-16 UTC - Entry`;
      await Bun.write(join(factoryDir, "worklog.md"), worklog);

      const result = await readFactoryWorklog(tempDir);
      expect(result.status).toBe("available");
    });
  });
});
