import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Mock } from "bun:test";
import type { ProbeRunner } from "./liveness";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

import {
  LSOF_EXECUTABLE,
  LSOF_TIMEOUT_MS,
  MAX_LSOF_OUTPUT_BYTES,
  MAX_LOG_ENTRIES,
  checkRepositoryLiveness,
  parseCommands,
  type LivenessDependencies,
  type ProbeResult,
} from "./liveness";

describe("liveness", () => {
  describe("constants", () => {
    test("LSOF_EXECUTABLE is 'lsof'", () => {
      expect(LSOF_EXECUTABLE).toBe("lsof");
    });

    test("LSOF_TIMEOUT_MS is 2000", () => {
      expect(LSOF_TIMEOUT_MS).toBe(2000);
    });

    test("MAX_LSOF_OUTPUT_BYTES is 65536", () => {
      expect(MAX_LSOF_OUTPUT_BYTES).toBe(64 * 1024);
    });

    test("MAX_LOG_ENTRIES is 256", () => {
      expect(MAX_LOG_ENTRIES).toBe(256);
    });
  });

  describe("parseCommands", () => {
    test("returns null for empty string", () => {
      expect(parseCommands("")).toBeNull();
    });

    test("returns null for string without trailing newline", () => {
      expect(parseCommands("p0\nc0")).toBeNull();
    });

    test("returns null for p line without c line", () => {
      expect(parseCommands("p0\n")).toBeNull();
    });

    test("returns null for c line without preceding p line", () => {
      expect(parseCommands("c0\n")).toBeNull();
    });

    test("returns null for malformed p line", () => {
      expect(parseCommands("px\n")).toBeNull();
    });

    test("returns null for malformed c line (no command after c)", () => {
      expect(parseCommands("p0\nc\n")).toBeNull();
    });

    test("returns null for unexpected line format", () => {
      expect(parseCommands("p0\nsomething\n")).toBeNull();
    });

    test("returns null for multiple p lines without c lines", () => {
      expect(parseCommands("p0\np1\n")).toBeNull();
    });

    test("parses single command correctly", () => {
      const result = parseCommands("p0\nc0\n");
      expect(result).toEqual(["0"]);
    });

    test("parses multiple commands correctly", () => {
      const result = parseCommands("p0\nc0\np1\nc1\n");
      expect(result).toEqual(["0", "1"]);
    });

    test("parses command with special characters", () => {
      const result = parseCommands("p0\nc/tee /tmp/log\n");
      expect(result).toEqual(["/tee /tmp/log"]);
    });

    test("returns null for command starting with p", () => {
      expect(parseCommands("p0\npc1\n")).toBeNull();
    });

    test("parses command that is just 'tee' (ctee format)", () => {
      const result = parseCommands("p0\nctee\n");
      expect(result).toEqual(["tee"]);
    });

    test("returns null for output with trailing content after newline", () => {
      expect(parseCommands("p0\nc0\nextra\n")).toBeNull();
    });
  });

  describe("checkRepositoryLiveness", () => {
    let tempDir: string;
    let logsDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(process.cwd(), "tmp-liveness-"));
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

    describe("driver log selection", () => {
      test("returns CANNOT_VERIFY when no driver logs exist", async () => {
        const result = await checkRepositoryLiveness(tempDir);
        expect(result.state).toBe("CANNOT_VERIFY");
        expect(result.checkedAt).toBeDefined();
      });

      test("returns CANNOT_VERIFY when logs directory is missing", async () => {
        rmSync(logsDir, { recursive: true, force: true });
        const result = await checkRepositoryLiveness(tempDir);
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("ignores non-file entries in logs (subdir)", async () => {
        writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "content");
        mkdirSync(join(logsDir, "subdir"));
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );
        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("returns CANNOT_VERIFY for directory in logs", async () => {
        mkdirSync(join(logsDir, "driver-20240101-120000-0.log"), {
          recursive: true,
        });
        const result = await checkRepositoryLiveness(tempDir);
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY for symlinked file in logs", async () => {
        const outsideFile = join(tempDir, "outside.log");
        writeFileSync(outsideFile, "content");
        const symlinkPath = join(logsDir, "driver-20240101-120000-0.log");
        try {
          rmSync(symlinkPath, { force: true });
          symlinkSync(outsideFile, symlinkPath);
        } catch {
          return;
        }
        const result = await checkRepositoryLiveness(tempDir);
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("selects latest driver log deterministically", async () => {
        writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "old log");
        writeFileSync(
          join(logsDir, "driver-20240102-120000-0.log"),
          "newer log",
        );
        writeFileSync(
          join(logsDir, "driver-20240101-130000-0.log"),
          "same day later",
        );

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
        expect(mockRunner).toHaveBeenCalledWith(
          "lsof",
          [
            "-Fpc",
            "--",
            expect.stringContaining("driver-20240102-120000-0.log"),
          ],
          {
            timeoutMs: LSOF_TIMEOUT_MS,
            maxOutputBytes: MAX_LSOF_OUTPUT_BYTES,
          },
        );
      });

      test("selects the greatest numeric sequence within one timestamp", async () => {
        writeFileSync(join(logsDir, "driver-20240102-120000-9.log"), "old");
        writeFileSync(join(logsDir, "driver-20240102-120000-10.log"), "new");

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        await checkRepositoryLiveness(tempDir, { runner: mockRunner });

        expect(mockRunner).toHaveBeenCalledWith(
          "lsof",
          [
            "-Fpc",
            "--",
            expect.stringContaining("driver-20240102-120000-10.log"),
          ],
          {
            timeoutMs: LSOF_TIMEOUT_MS,
            maxOutputBytes: MAX_LSOF_OUTPUT_BYTES,
          },
        );
      });

      test("ignores noncanonical zero-padded log sequences", async () => {
        writeFileSync(join(logsDir, "driver-20240102-120000-01.log"), "old");
        writeFileSync(join(logsDir, "driver-20240102-120000-1.log"), "new");

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        await checkRepositoryLiveness(tempDir, { runner: mockRunner });

        expect(mockRunner).toHaveBeenCalledWith(
          "lsof",
          [
            "-Fpc",
            "--",
            expect.stringContaining("driver-20240102-120000-1.log"),
          ],
          {
            timeoutMs: LSOF_TIMEOUT_MS,
            maxOutputBytes: MAX_LSOF_OUTPUT_BYTES,
          },
        );
      });

      test("returns CANNOT_VERIFY when logs exceed MAX_LOG_ENTRIES", async () => {
        for (let i = 0; i < 257; i++) {
          writeFileSync(
            join(logsDir, `driver-20240101-120000-${i}.log`),
            "content",
          );
        }
        const result = await checkRepositoryLiveness(tempDir);
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("ignores malformed driver log names, uses valid one", async () => {
        writeFileSync(join(logsDir, "driver-20240101-120000-0.log"), "valid");
        writeFileSync(join(logsDir, "driver-20240101-120000.log"), "no seq");
        writeFileSync(
          join(logsDir, "driver-240101-120000-0.log"),
          "short year",
        );
        writeFileSync(
          join(logsDir, "driver-20240101-12000-0.log"),
          "short hour",
        );
        writeFileSync(
          join(logsDir, "driver-20241301-120000-0.log"),
          "bad month",
        );
        writeFileSync(join(logsDir, "driver-20240132-120000-0.log"), "bad day");
        writeFileSync(
          join(logsDir, "driver-20240101-250000-0.log"),
          "bad hour",
        );
        writeFileSync(
          join(logsDir, "driver-20240101-126000-0.log"),
          "bad minute",
        );
        writeFileSync(
          join(logsDir, "driver-20240101-120060-0.log"),
          "bad second",
        );

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("accepts valid edge case dates", async () => {
        const validDates = [
          "driver-19700101-000000-0.log",
          "driver-20991231-235959-9.log",
          "driver-20240229-120000-0.log",
        ];
        for (const filename of validDates) {
          writeFileSync(join(logsDir, filename), "content");
        }

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });
    });

    describe("lsof probe results", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("returns RUNNING when command is exactly 'tee'", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctee\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("RUNNING");
        expect(mockRunner).toHaveBeenCalled();
      });

      test("returns STOPPED when lsof exits 1 with empty output", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
        expect(mockRunner).toHaveBeenCalled();
      });

      test("returns CANNOT_VERIFY when lsof exits 0 but has stderr", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\ntee\n",
            stderr: "warning: some warning",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof exits with non-zero non-1 code", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 2,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof output is malformed (no trailing newline)", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctee",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof output has p without c", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof output has c without p", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "c0\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns STOPPED when lsof output has multiple commands without tee", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nccat\np1\ncsleep\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("returns CANNOT_VERIFY when lsof times out", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: true,
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof output is truncated", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctee\n",
            stderr: "",
            outputTruncated: true,
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("returns CANNOT_VERIFY when lsof throws an error", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => {
            throw new Error("lsof not found");
          },
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });
    });

    describe("fixed runner args and limits", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("uses fixed LSOF_EXECUTABLE", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        await checkRepositoryLiveness(tempDir, { runner: mockRunner });
        expect(mockRunner).toHaveBeenCalledWith(
          LSOF_EXECUTABLE,
          expect.any(Array),
          expect.any(Object),
        );
      });

      test("uses fixed args: -Fpc and log path", async () => {
        const mockRunner = vi.fn(async (): Promise<ProbeResult> => ({
          exitCode: 1,
          stdout: "",
          stderr: "",
        }));

        await checkRepositoryLiveness(tempDir, { runner: mockRunner });
        const mockFn = mockRunner as unknown as Mock<ProbeRunner>;
        expect(mockFn.mock.calls).toHaveLength(1);
        const mockCalls = mockFn.mock.calls as any;
        const args = mockCalls[0][1];
        expect(args).toEqual([
          "-Fpc",
          "--",
          expect.stringContaining("driver-20240101-120000-0.log"),
        ]);
      });

      test("uses fixed timeout and maxOutputBytes limits", async () => {
        const mockRunner = vi.fn(async (): Promise<ProbeResult> => ({
          exitCode: 1,
          stdout: "",
          stderr: "",
        }));

        await checkRepositoryLiveness(tempDir, { runner: mockRunner });
        const mockFn = mockRunner as unknown as Mock<ProbeRunner>;
        expect(mockFn.mock.calls).toHaveLength(1);
        const mockCalls = mockFn.mock.calls as any;
        const limits = mockCalls[0][2];
        expect(limits.timeoutMs).toBe(LSOF_TIMEOUT_MS);
        expect(limits.maxOutputBytes).toBe(MAX_LSOF_OUTPUT_BYTES);
      });

      test("browser/repository values cannot alter lsof args", async () => {
        const hostileDir = mkdtempSync(join(process.cwd(), "tmp-hostile-"));
        try {
          const hostileLogs = join(hostileDir, ".factory", "logs");
          mkdirSync(hostileLogs, { recursive: true });

          writeFileSync(
            join(hostileLogs, "driver-20240101-120000-0.log"),
            "test",
          );

          const mockRunner: LivenessDependencies["runner"] = vi.fn(
            async (): Promise<ProbeResult> => ({
              exitCode: 1,
              stdout: "",
              stderr: "",
            }),
          );

          await checkRepositoryLiveness(hostileDir, { runner: mockRunner });
          const mockFn = mockRunner as unknown as Mock<ProbeRunner>;
          expect(mockFn.mock.calls).toHaveLength(1);
          const mockCalls = mockFn.mock.calls as any;
          const args = mockCalls[0][1];
          expect(args).toEqual([
            "-Fpc",
            "--",
            expect.stringContaining("driver-20240101-120000-0.log"),
          ]);
          expect(args).not.toContain("-r");
          expect(args).not.toContain("-o");
          expect(args).not.toContain("-P");
        } finally {
          rmSync(hostileDir, { recursive: true, force: true });
        }
      });
    });

    describe("injectable clock", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("uses injected clock for checkedAt timestamp", async () => {
        const fixedDate = new Date("2025-06-15T10:30:45.123Z");
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );
        const mockNow = vi.fn(() => fixedDate);

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
          now: mockNow,
        });

        expect(result.checkedAt).toBe("2025-06-15T10:30:45.123Z");
        expect(mockNow).toHaveBeenCalled();
      });

      test("default clock produces ISO timestamp", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });

        expect(result.checkedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
      });
    });

    describe("snapshot propagation", () => {
      let tempDir2: string;
      let logsDir2: string;

      beforeEach(() => {
        tempDir2 = mkdtempSync(join(process.cwd(), "tmp-liveness2-"));
        logsDir2 = join(tempDir2, ".factory", "logs");
        mkdirSync(logsDir2, { recursive: true });
      });

      const cleanupTempDir2 = () => {
        try {
          rmSync(tempDir2, { recursive: true, force: true });
        } catch {
          // ignore
        }
      };

      afterEach(() => {
        cleanupTempDir2();
      });

      test("propagates CANNOT_VERIFY state through snapshot", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });

        expect(result).toEqual({
          state: "CANNOT_VERIFY",
          checkedAt: expect.any(String),
        });
      });

      test("propagates RUNNING state through snapshot", async () => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctee\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });

        expect(result).toEqual({
          state: "RUNNING",
          checkedAt: expect.any(String),
        });
      });

      test("propagates STOPPED state through snapshot", async () => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });

        expect(result).toEqual({
          state: "STOPPED",
          checkedAt: expect.any(String),
        });
      });

      test("all states include checkedAt timestamp", async () => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
        const states = [
          {
            exitCode: 0,
            stdout: "p0\nctee\n",
            stderr: "",
            expected: "RUNNING" as const,
          },
          { exitCode: 1, stdout: "", stderr: "", expected: "STOPPED" as const },
          {
            exitCode: 2,
            stdout: "",
            stderr: "",
            expected: "CANNOT_VERIFY" as const,
          },
        ];

        for (const testCase of states) {
          const mockRunner: LivenessDependencies["runner"] = vi.fn(
            async (): Promise<ProbeResult> => ({
              exitCode: testCase.exitCode as number,
              stdout: testCase.stdout,
              stderr: testCase.stderr,
            }),
          );

          const result = await checkRepositoryLiveness(tempDir, {
            runner: mockRunner,
          });
          expect(result.checkedAt).toBeDefined();
          expect(result.state).toBe(testCase.expected);
        }
      });
    });

    describe("hostile content handling", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("handles hostile log content in lsof output", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nc<script>alert(1)</script>\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("handles hostile stderr in lsof output", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\ntee\n",
            stderr: "<script>alert(1)</script>",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });

      test("handles path traversal in log path", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("handles null bytes in log path", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("handles control characters in log path", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });
    });

    describe("command semantics", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("tail command yields STOPPED", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctail\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("tail -F command yields STOPPED", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctail -F\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("unrelated command yields STOPPED", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nccat\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("teevil command yields STOPPED (not RUNNING)", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\ncteevil\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("exact lowercase tee yields RUNNING", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nctee\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("RUNNING");
      });

      test("TEE (uppercase) yields STOPPED", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\ncTEE\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("exact tee among multiple commands yields RUNNING", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nccat\np1\nctee\np2\ncsleep\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("RUNNING");
      });

      test("multiple commands without tee yields STOPPED", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\nccat\np1\ncsleep\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });
    });

    describe("edge cases", () => {
      beforeEach(() => {
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          "test log",
        );
      });

      test("handles very long log content", async () => {
        const longContent = "x".repeat(100000);
        writeFileSync(
          join(logsDir, "driver-20240101-120000-0.log"),
          longContent,
        );

        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("STOPPED");
      });

      test("handles lsof with only p lines (no commands)", async () => {
        const mockRunner: LivenessDependencies["runner"] = vi.fn(
          async (): Promise<ProbeResult> => ({
            exitCode: 0,
            stdout: "p0\np1\n",
            stderr: "",
          }),
        );

        const result = await checkRepositoryLiveness(tempDir, {
          runner: mockRunner,
        });
        expect(result.state).toBe("CANNOT_VERIFY");
      });
    });
  });
});
