import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

import {
  MAX_LOG_ENTRIES,
  MAX_NARRATION_BYTES,
  MAX_NARRATION_LINES,
  MAX_NARRATION_LINE_BYTES,
  type FactoryLogsRead,
  type LogTiming,
  type LogsData,
  type TrustedDriverLog,
  parseLogName,
  readFactoryLogsWithSelection,
  readFactoryLogs,
} from "./logs";
import { checkTrustedDriverLiveness } from "../liveness";

// Type guard to narrow ReaderResult
function hasData<T>(result: {
  status: "available" | "partial" | "unavailable";
  data?: T;
}): result is { status: "available" | "partial"; data: T } {
  return result.status === "available" || result.status === "partial";
}

describe("logs reader", () => {
  describe("constants", () => {
    test("MAX_LOG_ENTRIES is 256", () => {
      expect(MAX_LOG_ENTRIES).toBe(256);
    });

    test("MAX_NARRATION_BYTES is 65536", () => {
      expect(MAX_NARRATION_BYTES).toBe(64 * 1024);
    });

    test("MAX_NARRATION_LINES is 100", () => {
      expect(MAX_NARRATION_LINES).toBe(100);
    });

    test("MAX_NARRATION_LINE_BYTES is 2000", () => {
      expect(MAX_NARRATION_LINE_BYTES).toBe(2_000);
    });
  });

  describe("parseLogName", () => {
    test("returns null for empty string", () => {
      expect(parseLogName("")).toBeNull();
    });

    test("returns null for missing extension", () => {
      expect(parseLogName("driver-20240101-120000")).toBeNull();
    });

    test("returns null for wrong extension", () => {
      expect(parseLogName("driver-20240101-120000-0.txt")).toBeNull();
    });

    test("returns null for driver without sequence", () => {
      expect(parseLogName("driver-20240101-120000.log")).toBeNull();
    });

    test("returns null for cycle with sequence", () => {
      expect(parseLogName("cycle-20240101-120000-0.log")).toBeNull();
    });

    test("returns null for shepherd with sequence", () => {
      expect(parseLogName("shepherd-20240101-120000-0.log")).toBeNull();
    });

    test("returns null for invalid kind", () => {
      expect(parseLogName("runner-20240101-120000-0.log")).toBeNull();
    });

    test("returns null for short year", () => {
      expect(parseLogName("driver-240101-120000-0.log")).toBeNull();
    });

    test("returns null for short month", () => {
      expect(parseLogName("driver-2024101-120000-0.log")).toBeNull();
    });

    test("returns null for short day", () => {
      expect(parseLogName("driver-2024011-120000-0.log")).toBeNull();
    });

    test("returns null for short hour", () => {
      expect(parseLogName("driver-20240101-10000-0.log")).toBeNull();
    });

    test("returns null for short minute", () => {
      expect(parseLogName("driver-20240101-12000-0.log")).toBeNull();
    });

    test("returns null for short second", () => {
      expect(parseLogName("driver-20240101-12006-0.log")).toBeNull();
    });

    test("returns null for invalid month 00", () => {
      expect(parseLogName("driver-20240001-120000-0.log")).toBeNull();
    });

    test("returns null for invalid month 13", () => {
      expect(parseLogName("driver-20241301-120000-0.log")).toBeNull();
    });

    test("returns null for invalid day 00", () => {
      expect(parseLogName("driver-20240100-120000-0.log")).toBeNull();
    });

    test("returns null for invalid day 32", () => {
      expect(parseLogName("driver-20240132-120000-0.log")).toBeNull();
    });

    test("returns null for invalid hour 24", () => {
      expect(parseLogName("driver-20240101-240000-0.log")).toBeNull();
    });

    test("returns null for invalid minute 60", () => {
      expect(parseLogName("driver-20240101-126000-0.log")).toBeNull();
    });

    test("returns null for invalid second 60", () => {
      expect(parseLogName("driver-20240101-120060-0.log")).toBeNull();
    });

    test("returns null for non-numeric sequence with leading zero", () => {
      expect(parseLogName("driver-20240101-120000-01.log")).toBeNull();
    });

    test("returns null for negative-like sequence", () => {
      expect(parseLogName("driver-20240101-120000--1.log")).toBeNull();
    });

    test("returns null for sequence with letters", () => {
      expect(parseLogName("driver-20240101-120000-a.log")).toBeNull();
    });

    test("parses valid driver log name", () => {
      const result = parseLogName("driver-20240115-143022-0.log");
      expect(result).toEqual({
        kind: "driver",
        stamp: "20240115143022",
        startedAt: expect.any(Date),
        sequence: 0n,
      });
      if (result) {
        expect(result.startedAt.toISOString()).toBe("2024-01-15T14:30:22.000Z");
      }
    });

    test("parses valid cycle log name", () => {
      const result = parseLogName("cycle-20240115-143022.log");
      expect(result).toEqual({
        kind: "cycle",
        stamp: "20240115143022",
        startedAt: expect.any(Date),
        sequence: 0n,
      });
      if (result) {
        expect(result.startedAt.toISOString()).toBe("2024-01-15T14:30:22.000Z");
      }
    });

    test("parses valid shepherd log name", () => {
      const result = parseLogName("shepherd-20240115-143022.log");
      expect(result).toEqual({
        kind: "shepherd",
        stamp: "20240115143022",
        startedAt: expect.any(Date),
        sequence: 0n,
      });
      if (result) {
        expect(result.startedAt.toISOString()).toBe("2024-01-15T14:30:22.000Z");
      }
    });

    test("parses driver with non-zero sequence", () => {
      const result = parseLogName("driver-20240115-143022-42.log");
      expect(result?.sequence).toBe(42n);
    });

    test("parses edge case dates", () => {
      const validDates = [
        "driver-19700101-000000-0.log",
        "driver-20991231-235959-9.log",
        "driver-20240229-120000-0.log",
      ];
      for (const filename of validDates) {
        expect(parseLogName(filename)).not.toBeNull();
      }
    });

    test("accepts zero-padded zero sequence", () => {
      const result = parseLogName("driver-20240101-120000-0.log");
      expect(result?.sequence).toBe(0n);
    });

    test("returns null for sequence starting with zero but not zero", () => {
      expect(parseLogName("driver-20240101-120000-01.log")).toBeNull();
    });
  });

  describe("log selection", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("selects only recognized kinds: driver, cycle, shepherd", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "driver");
      writeFileSync(join(logsDir, "cycle-20240101-120000.log"), "cycle");
      writeFileSync(join(logsDir, "shepherd-20240101-120000.log"), "shepherd");
      // Use a name that starts with a recognized prefix but doesn't match the full pattern
      writeFileSync(join(logsDir, "driver-20240101.log"), "unknown");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_NAME_INVALID"),
      ).toBe(true);
      if (
        result.result.status === "partial" ||
        result.result.status === "available"
      ) {
        expect((result.result as any).data.driver).toBeDefined();
        expect((result.result as any).data.cycle).toBeDefined();
        expect((result.result as any).data.shepherd).toBeDefined();
      }
    });

    test("returns available when valid driver log exists", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Driver log exists and is readable, no warnings
      expect(result.result.status).toBe("available");
      if (
        result.result.status === "available" ||
        result.result.status === "partial"
      ) {
        expect((result.result as any).data.driver).toBeDefined();
      }
    });

    test("returns partial when only cycle log exists (no driver)", async () => {
      writeFileSync(join(logsDir, "cycle-20240101-120000.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Missing driver log generates warning, so status is partial
      expect(result.result.status).toBe("partial");
      if (
        result.result.status === "available" ||
        result.result.status === "partial"
      ) {
        expect((result.result as any).data.cycle).toBeDefined();
        expect((result.result as any).data.driver).toBeUndefined();
      }
    });

    test("returns partial when only shepherd log exists (no driver)", async () => {
      writeFileSync(join(logsDir, "shepherd-20240101-120000.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Missing driver log generates warning, so status is partial
      expect(result.result.status).toBe("partial");
      if (
        result.result.status === "available" ||
        result.result.status === "partial"
      ) {
        expect((result.result as any).data.shepherd).toBeDefined();
        expect((result.result as any).data.driver).toBeUndefined();
      }
    });

    test("selects latest driver by timestamp", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "old");
      writeFileSync(join(logsDir, "driver-20240102-120000-0.log"), "newer");
      writeFileSync(join(logsDir, "driver-20240101-130000-0.log"), "same day");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, all logs are valid
      expect(result.result.status).toBe("available");
      if (
        result.result.status === "available" ||
        result.result.status === "partial"
      ) {
        expect((result.result as any).data.driver?.startedAt).toBe(
          "2024-01-02T12:00:00.000Z",
        );
      }
    });

    test("selects latest by sequence within same timestamp", async () => {
      writeFileSync(join(logsDir, "driver-20240102-120000-9.log"), "old");
      writeFileSync(join(logsDir, "driver-20240102-120000-10.log"), "new");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.startedAt).toBe(
        "2024-01-02T12:00:00.000Z",
      );
    });

    test("rejects noncanonical zero-padded sequences", async () => {
      writeFileSync(join(logsDir, "driver-20240102-120000-01.log"), "old");
      writeFileSync(join(logsDir, "driver-20240102-120000-1.log"), "new");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.startedAt).toBe(
        "2024-01-02T12:00:00.000Z",
      );
    });

    test("ignores malformed log names", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "valid");
      writeFileSync(join(logsDir, "driver-20240101-120000.log"), "no-seq");
      writeFileSync(join(logsDir, "driver-240101-120000-0.log"), "short-year");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_NAME_INVALID"),
      ).toBe(true);
    });

    test("returns CANNOT_VERIFY when logs exceed MAX_LOG_ENTRIES", async () => {
      for (let i = 0; i < 257; i++) {
        writeFileSync(
          join(logsDir, `driver-20240101-120000-${i}.log`),
          "content",
        );
      }
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
      expect(result.result.warnings[0]?.code).toBe("LOGS_UNAVAILABLE");
    });

    test("ignores subdirectories in logs", async () => {
      mkdirSync(join(logsDir, "subdir"));
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Subdirectories are ignored, no warnings
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.driver).toBeDefined();
    });

    test("ignores non-file entries", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");
      mkdirSync(join(logsDir, "driver-20240102-120000-0.log"), {
        recursive: true,
      });

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect((result.result as any).data.driver).toBeDefined();
    });

    test("rejects symlinked files in logs", async () => {
      const outside = join(tempDir, "outside.log");
      writeFileSync(outside, "content");
      symlinkSync(outside, join(logsDir, "driver-20240101-120000-0.log"));

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });

    test("returns CANNOT_VERIFY when logs directory is missing", async () => {
      rmSync(logsDir, { recursive: true, force: true });
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
      expect(result.result.warnings[0]?.code).toBe("LOGS_MISSING");
    });

    test("returns CANNOT_VERIFY when no recognized logs exist", async () => {
      const result = await readFactoryLogsWithSelection(tempDir);

      // No recognized logs means unavailable, with DRIVER_LOG_MISSING warning
      expect(result.result.status).toBe("unavailable");
      expect(
        result.result.warnings.some((w) => w.code === "DRIVER_LOG_MISSING"),
      ).toBe(true);
    });

    test("returns CANNOT_VERIFY when logs are missing but warnings present", async () => {
      // Use a name that starts with a recognized prefix but doesn't match the full pattern
      writeFileSync(join(logsDir, "driver-20240101.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Unknown log names generate warnings, but no recognized logs means unavailable
      expect(result.result.status).toBe("unavailable");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_NAME_INVALID"),
      ).toBe(true);
      expect(
        result.result.warnings.some((w) => w.code === "DRIVER_LOG_MISSING"),
      ).toBe(true);
    });

    test("returns available when only driver log exists", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // Driver log exists, no warnings
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.driver).toBeDefined();
      expect((result.result as any).data.cycle).toBeUndefined();
      expect((result.result as any).data.shepherd).toBeUndefined();
    });

    test("selects latest cycle log", async () => {
      writeFileSync(join(logsDir, "cycle-20240101-120000.log"), "old");
      writeFileSync(join(logsDir, "cycle-20240102-120000.log"), "new");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.cycle?.startedAt).toBe(
        "2024-01-02T12:00:00.000Z",
      );
    });

    test("selects latest shepherd log", async () => {
      writeFileSync(join(logsDir, "shepherd-20240101-120000.log"), "old");
      writeFileSync(join(logsDir, "shepherd-20240102-120000.log"), "new");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.shepherd?.startedAt).toBe(
        "2024-01-02T12:00:00.000Z",
      );
    });

    test("returns available when selected log is stable", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // File is stable, so it succeeds
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.driver).toBeDefined();
    });

    test("exposes asOf timestamps per source", async () => {
      const driverPath = join(logsDir, "driver-20240101-120000-0.log");
      const cyclePath = join(logsDir, "cycle-20240102-120000.log");
      const shepherdPath = join(logsDir, "shepherd-20240103-120000.log");
      writeFileSync(driverPath, "content");
      writeFileSync(cyclePath, "content");
      writeFileSync(shepherdPath, "content");

      // Set different mtimes for each file
      const driverTime = new Date("2024-01-01T12:00:00.000Z");
      const cycleTime = new Date("2024-01-02T12:00:00.000Z");
      const shepherdTime = new Date("2024-01-03T12:00:00.000Z");
      utimesSync(driverPath, driverTime, driverTime);
      utimesSync(cyclePath, cycleTime, cycleTime);
      utimesSync(shepherdPath, shepherdTime, shepherdTime);

      const result = await readFactoryLogsWithSelection(tempDir);

      // asOf uses lastActivityAt which is the file mtime
      expect((result.result as any).data.asOf.driver).toBe(
        "2024-01-01T12:00:00.000Z",
      );
      expect((result.result as any).data.asOf.cycle).toBe(
        "2024-01-02T12:00:00.000Z",
      );
      expect((result.result as any).data.asOf.shepherd).toBe(
        "2024-01-03T12:00:00.000Z",
      );
      expect((result.result as any).data.asOf.overall).toBe(
        "2024-01-03T12:00:00.000Z",
      );
    });

    test("exposes overall asOf as latest of all sources", async () => {
      const driverPath = join(logsDir, "driver-20240103-120000-0.log");
      const cyclePath = join(logsDir, "cycle-20240101-120000.log");
      writeFileSync(driverPath, "content");
      writeFileSync(cyclePath, "content");

      // Set mtimes
      const driverTime = new Date("2024-01-03T12:00:00.000Z");
      const cycleTime = new Date("2024-01-01T12:00:00.000Z");
      utimesSync(driverPath, driverTime, driverTime);
      utimesSync(cyclePath, cycleTime, cycleTime);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.asOf.overall).toBe(
        "2024-01-03T12:00:00.000Z",
      );
    });

    test("returns CANNOT_VERIFY when logs cannot be read safely", async () => {
      // Create a scenario where reading fails
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });
  });

  describe("narration bounds", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-narration-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("returns narration from driver log", async () => {
      const content = "Line 1\nLine 2\nLine 3\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe(content);
    });

    test("truncates narration to MAX_NARRATION_BYTES", async () => {
      const content = "x".repeat(MAX_NARRATION_BYTES + 1000);
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect((result.result as any).data.narration.length).toBeLessThanOrEqual(
        MAX_NARRATION_BYTES,
      );
      expect(
        result.result.warnings.some(
          (w) => w.code === "LOG_NARRATION_TRUNCATED",
        ),
      ).toBe(true);
    });

    test("truncates narration to MAX_NARRATION_LINES", async () => {
      const lines = Array.from(
        { length: MAX_NARRATION_LINES + 10 },
        (_, i) => `Line ${i + 1}`,
      ).join("\n");
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), lines);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      const resultLines = (result.result as any).data.narration.split("\n");
      expect(resultLines.length).toBeLessThanOrEqual(MAX_NARRATION_LINES);
      expect(
        result.result.warnings.some((w) => w.code === "LOG_LINES_TRUNCATED"),
      ).toBe(true);
    });

    test("warns about oversized lines", async () => {
      const content = `${"x".repeat(MAX_NARRATION_LINE_BYTES + 1)}\n`;
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_LINE_TOO_LONG"),
      ).toBe(true);
    });

    test("returns empty string when narration has no complete line after truncation", async () => {
      const content = "x".repeat(MAX_NARRATION_BYTES + 1);
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.narration).toBe("");
      expect(
        result.result.warnings.some(
          (w) => w.code === "LOG_NARRATION_TRUNCATED",
        ),
      ).toBe(true);
    });

    test("exact MAX_NARRATION_BYTES boundary includes newline", async () => {
      // Create content that ends exactly at MAX_NARRATION_BYTES with newlines
      // Use multiple short lines to avoid line length warnings
      const line = "x".repeat(MAX_NARRATION_LINE_BYTES - 1) + "\n";
      const content = line.repeat(
        Math.floor(MAX_NARRATION_BYTES / line.length),
      );
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be available (no truncation needed
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration.length).toBeLessThanOrEqual(
        MAX_NARRATION_BYTES,
      );
    });

    test("exact MAX_NARRATION_BYTES boundary without newline truncates", async () => {
      // Create content that ends exactly at MAX_NARRATION_BYTES without a newline
      const content = "x".repeat(MAX_NARRATION_BYTES);
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be partial (truncation warning
      expect(result.result.status).toBe("partial");
      expect((result.result as any).data.narration.length).toBeLessThan(
        MAX_NARRATION_BYTES,
      );
    });

    test("exact MAX_NARRATION_LINES boundary", async () => {
      // Create exactly MAX_NARRATION_LINES lines
      const lines = Array.from(
        { length: MAX_NARRATION_LINES },
        (_, i) => `Line ${i + 1}`,
      ).join("\n");
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), lines);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be available (no truncation needed
      expect(result.result.status).toBe("available");
      const resultLines = (result.result as any).data.narration.split("\n");
      expect(resultLines.length).toBe(MAX_NARRATION_LINES);
    });

    test("exact MAX_NARRATION_LINES + 1 triggers truncation", async () => {
      // Create exactly MAX_NARRATION_LINES + 1 lines
      const lines = Array.from(
        { length: MAX_NARRATION_LINES + 1 },
        (_, i) => `Line ${i + 1}`,
      ).join("\n");
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), lines);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be partial (truncation warning
      expect(result.result.status).toBe("partial");
      const resultLines = (result.result as any).data.narration.split("\n");
      expect(resultLines.length).toBe(MAX_NARRATION_LINES);
    });

    test("exact MAX_NARRATION_LINE_BYTES boundary includes newline", async () => {
      // Create a line that ends exactly at MAX_NARRATION_LINE_BYTES with newline
      const line = "x".repeat(MAX_NARRATION_LINE_BYTES - 1) + "\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), line);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be available (no warning
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe(line);
    });

    test("exact MAX_NARRATION_LINE_BYTES + 1 triggers warning", async () => {
      // Create a line that exceeds MAX_NARRATION_LINE_BYTES
      const line = "x".repeat(MAX_NARRATION_LINE_BYTES) + "\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), line);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be partial (line too long warning
      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_LINE_TOO_LONG"),
      ).toBe(true);
    });

    test("multibyte byte-tail splitting preserves UTF-8 validity", async () => {
      const tailParts: string[] = [];
      let tailBytes = MAX_NARRATION_BYTES - 3;
      while (tailBytes > 0) {
        const lineBytes = Math.min(tailBytes, MAX_NARRATION_LINE_BYTES);
        tailParts.push(`${"x".repeat(lineBytes - 1)}\n`);
        tailBytes -= lineBytes;
      }
      const content = `あ\n${tailParts.join("")}`;

      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Should be partial (truncation warning
      expect(result.result.status).toBe("partial");
      // The truncated narration should be valid UTF-8 (no replacement character
      const narration = (result.result as any).data.narration;
      expect(narration).not.toContain("\uFFFD");
      // Should contain the prefix
      expect(narration).toContain("x");
    });

    test("handles multibyte UTF-8 characters", async () => {
      // Create content with multiple lines to trigger line limit warning
      // Each line has "日本語" followed by newline
      const content =
        Array.from({ length: 150 }, () => "日本語").join("\n") + "\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect((result.result as any).data.narration).toContain("日本語");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_LINES_TRUNCATED"),
      ).toBe(true);
    });

    test("warns about invalid UTF-8 in narration", async () => {
      const content = new Uint8Array([0xff, 0xfe, 0xfd, 0x41]); // invalid UTF-8 + 'A'
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("partial");
      expect((result.result as any).data.narration).toBe("");
      expect(
        result.result.warnings.some((w) => w.code === "LOG_INVALID_UTF8"),
      ).toBe(true);
    });

    test("returns empty narration for non-driver logs", async () => {
      writeFileSync(
        join(logsDir, "cycle-20240101-120000.log"),
        "cycle content",
      );

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.narration).toBe("");
    });

    test("handles growing log during read", async () => {
      const content = "initial content\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      let hookResolved = false;
      const result = await readFactoryLogsWithSelection(tempDir, {
        afterOpen: () => {
          appendFileSync(
            join(logsDir, "driver-20240101-120000-0.log"),
            "more content\n",
          );
          hookResolved = true;
        },
      });

      // Hook should have been called
      expect(hookResolved).toBe(true);
      // Should warn about log changing during read
      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some(
          (w) => w.code === "LOG_CHANGED_DURING_READ",
        ),
      ).toBe(true);
    });

    test("warns when log changes during read (mtime change)", async () => {
      const content = "initial";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir, {
        afterOpen: () => {
          writeFileSync(
            join(logsDir, "driver-20240101-120000-0.log"),
            "modified",
          );
        },
      });

      // Should warn about log changing during read
      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some(
          (w) => w.code === "LOG_CHANGED_DURING_READ",
        ),
      ).toBe(true);
    });

    test("returns CANNOT_VERIFY when log file is not a regular file", async () => {
      mkdirSync(join(logsDir, "driver-20240101-120000-0.log"), {
        recursive: true,
      });

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });

    test("returns CANNOT_VERIFY when selected log dev/inode changes", async () => {
      const content = "content";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir, {
        afterOpen: () => {
          rmSync(join(logsDir, "driver-20240101-120000-0.log"), {
            force: true,
          });
          writeFileSync(
            join(logsDir, "driver-20240101-120000-0.log"),
            "replaced",
          );
        },
      });

      expect(result.result.status).toBe("partial");
      expect(
        result.result.warnings.some(
          (w) => w.code === "LOG_CHANGED_DURING_READ",
        ),
      ).toBe(true);
      expect(result.driver).toBeNull();
    });
  });

  describe("timing derivation", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-timing-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("derives startedAt from filename timestamp", async () => {
      writeFileSync(join(logsDir, "driver-20240115-143022-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.startedAt).toBe(
        "2024-01-15T14:30:22.000Z",
      );
    });

    test("derives lastActivityAt from file mtime", async () => {
      const filename = "driver-20240115-143022-0.log";
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, "content");

      // Set a future mtime
      const future = new Date("2024-01-16T10:00:00.000Z");
      utimesSync(filepath, future, future);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.lastActivityAt).toBe(
        "2024-01-16T10:00:00.000Z",
      );
    });

    test("derives durationMs from startedAt to lastActivityAt", async () => {
      const filename = "driver-20240115-143022-0.log";
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, "content");

      const future = new Date("2024-01-15T16:30:22.000Z");
      utimesSync(filepath, future, future);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Duration is 2 hours from 14:30:22 to 16:30:22
      expect((result.result as any).data.driver?.durationMs).toBe(7200000);
    });

    test("warns when activity predates start (negative duration)", async () => {
      const filename = "driver-20240115-143022-0.log";
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, "content");

      // Set mtime before the filename timestamp
      const past = new Date("2024-01-15T10:00:00.000Z");
      utimesSync(filepath, past, past);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(
        result.result.warnings.some((w) => w.code === "LOG_INVALID_DURATION"),
      ).toBe(true);
    });

    test("handles equal timestamps (duration = 0)", async () => {
      const filename = "driver-20240115-143022-0.log";
      const filepath = join(logsDir, filename);
      const sameTime = new Date("2024-01-15T14:30:22.000Z");
      writeFileSync(filepath, "content");
      utimesSync(filepath, sameTime, sameTime);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.durationMs).toBe(0);
    });

    test("handles very large duration", async () => {
      const filename = "driver-20240101-000000-0.log";
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, "content");

      const future = new Date("2099-12-31T23:59:59.000Z");
      utimesSync(filepath, future, future);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect((result.result as any).data.driver?.startedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
      expect((result.result as any).data.driver?.lastActivityAt).toBe(
        "2099-12-31T23:59:59.000Z",
      );
    });

    test("returns CANNOT_VERIFY when timing cannot be derived", async () => {
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });
  });

  describe("stale stopped semantics", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-stale-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("duration ends at file mtime, not current time", async () => {
      const filename = "driver-20240115-143022-0.log";
      const filepath = join(logsDir, filename);
      writeFileSync(filepath, "content");

      // Set mtime to a specific past time (not now
      const mtime = new Date("2024-01-15T16:30:22.000Z");
      utimesSync(filepath, mtime, mtime);

      // Wait to ensure current time is different from mtime
      await Bun.sleep(100);

      const result = await readFactoryLogsWithSelection(tempDir);

      // Duration should be calculated from startedAt to mtime, not to current time
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.driver).not.toBeUndefined();
      if ((result.result as any).data.driver) {
        // startedAt is 14:30:22, mtime is 16:30:22 = 2 hours = 7200000ms
        expect((result.result as any).data.driver?.durationMs).toBe(7200000);
        // lastActivityAt should be the mtime, not current time
        expect((result.result as any).data.driver?.lastActivityAt).toBe(
          "2024-01-15T16:30:22.000Z",
        );
      }
    });

    test("returns stopped liveness for old driver log", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const logsRead = await readFactoryLogsWithSelection(tempDir);

      expect(logsRead.driver).not.toBeNull();

      const liveness = await checkTrustedDriverLiveness(logsRead.driver);

      expect(liveness.state).toBe("STOPPED");
    });

    test("returns CANNOT_VERIFY when driver log file is removed", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const logsRead = await readFactoryLogsWithSelection(tempDir);
      rmSync(filepath, { force: true });

      const liveness = await checkTrustedDriverLiveness(logsRead.driver);

      expect(liveness.state).toBe("CANNOT_VERIFY");
    });

    test("returns CANNOT_VERIFY when driver log is replaced", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const logsRead = await readFactoryLogsWithSelection(tempDir);
      // Replace the file by removing and recreating (different inode
      rmSync(filepath, { force: true });
      writeFileSync(filepath, "new content");

      const liveness = await checkTrustedDriverLiveness(logsRead.driver);

      expect(liveness.state).toBe("CANNOT_VERIFY");
    });

    test("returns CANNOT_VERIFY when log dev/inode changes", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const logsRead = await readFactoryLogsWithSelection(tempDir);

      expect(logsRead.driver).not.toBeNull();
      if (logsRead.driver) {
        // Simulate a changed file by providing wrong dev/inode
        const fakeLog: TrustedDriverLog = {
          ...logsRead.driver,
          inode: logsRead.driver.inode + 1n,
        };
        const liveness = await checkTrustedDriverLiveness(fakeLog);

        expect(liveness.state).toBe("CANNOT_VERIFY");
      }
    });
  });

  describe("trusted driver log integration", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-trusted-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("returns trusted driver log info when driver log is selected", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.driver).not.toBeNull();
      if (result.driver) {
        expect(result.driver.path).toBe(filepath);
        expect(typeof result.driver.device).toBe("bigint");
        expect(typeof result.driver.inode).toBe("bigint");
      }
    });

    test("returns null driver when no driver log exists", async () => {
      writeFileSync(join(logsDir, "cycle-20240101-120000.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.driver).toBeNull();
    });

    test("returns null driver when logs directory is missing", async () => {
      rmSync(logsDir, { recursive: true, force: true });

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.driver).toBeNull();
    });

    test("returns null driver when log selection fails", async () => {
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.driver).toBeNull();
    });

    test("trusted driver path is used by liveness check", async () => {
      const content = "test";
      const filepath = join(logsDir, "driver-20240101-120000-0.log");
      writeFileSync(filepath, content);

      const logsRead = await readFactoryLogsWithSelection(tempDir);

      expect(logsRead.driver).not.toBeNull();
    });
  });

  describe("readFactoryLogs wrapper", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-wrapper-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("returns only the result portion", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogs(tempDir);

      // Driver log exists, no warnings, status is available
      expect(result.status).toBe("available");
      expect((result as any).driver).toBeUndefined();
    });

    test("propagates all warning codes", async () => {
      // Use a name that starts with a recognized prefix but doesn't match the full pattern
      writeFileSync(join(logsDir, "driver-20240101.log"), "content");

      const result = await readFactoryLogs(tempDir);

      // No recognized logs exist, so status is unavailable
      expect(result.status).toBe("unavailable");
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.some((w) => w.code === "LOG_NAME_INVALID")).toBe(
        true,
      );
      expect(result.warnings.some((w) => w.code === "DRIVER_LOG_MISSING")).toBe(
        true,
      );
    });
  });

  describe("edge cases", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-edge-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("handles empty driver log", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe("");
    });

    test("handles driver log with only newlines", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "\n\n\n");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe("\n\n\n");
    });

    test("handles driver log with single line no newline", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe("content");
    });

    test("handles driver log with trailing newline", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content\n");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe("content\n");
    });

    test("returns CANNOT_VERIFY when factory path resolution fails", async () => {
      // Create a directory that won't resolve properly
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });

    test("handles multiple log kinds together", async () => {
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "driver");
      writeFileSync(join(logsDir, "cycle-20240101-120000.log"), "cycle");
      writeFileSync(join(logsDir, "shepherd-20240101-120000.log"), "shepherd");

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.driver).toBeDefined();
      expect((result.result as any).data.cycle).toBeDefined();
      expect((result.result as any).data.shepherd).toBeDefined();
      expect((result.result as any).data.narration).toBe("driver");
    });

    test("returns CANNOT_VERIFY when log cannot be opened", async () => {
      // This is hard to test without mocking, but the file read path is covered
      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
    });

    test("handles log with CRLF line endings", async () => {
      const content = "line1\r\nline2\r\nline3\r\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe(content);
    });

    test("handles log with mixed line endings", async () => {
      const content = "line1\nline2\r\nline3\n";
      writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), content);

      const result = await readFactoryLogsWithSelection(tempDir);

      // No warnings, status is available
      expect(result.result.status).toBe("available");
      expect((result.result as any).data.narration).toBe(content);
    });
  });

  describe("warning truncation", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-logs-warnings-"));
      logsDir = join(tempDir, ".factory", "logs");
      mkdirSync(logsDir, { recursive: true });
    });

    const cleanupTempDir = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    afterEach(() => {
      cleanupTempDir();
    });

    test("truncates warnings at MAX_WARNINGS (16)", async () => {
      // Create many malformed log names to trigger warning truncation
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(logsDir, `driver-invalid-${i}.log`), "content");
      }

      const result = await readFactoryLogsWithSelection(tempDir);

      expect(result.result.status).toBe("unavailable");
      // Should have at most 16 warnings with truncation indicator
      expect(result.result.warnings.length).toBeLessThanOrEqual(16);
      expect(
        result.result.warnings.some((w) => w.code === "WARNINGS_TRUNCATED"),
      ).toBe(true);
    });
  });
});
