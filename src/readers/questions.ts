import {
  type OpenQuestion,
  type QuestionsData,
  type ReaderResult,
  type ReaderWarning,
} from "../contracts";
import { readFactoryFile } from "./file";
import { readerWarning } from "./warnings";

export const MAX_QUESTIONS_BYTES = 256 * 1024;
export const MAX_QUESTIONS_LINES = 4096;
export const MAX_QUESTION_LINE_LENGTH = 8192;
export const MAX_QUESTIONS = 128;
export const MAX_QUESTIONS_WARNINGS = 32;

export const QUESTIONS_WARNING_CODES = [
  "WARNINGS_TRUNCATED",
  "QUESTIONS_TOO_MANY_LINES",
  "QUESTIONS_LINE_TOO_LONG",
  "QUESTIONS_EMPTY",
  "QUESTIONS_TOO_MANY_ENTRIES",
  "QUESTIONS_MALFORMED_ENTRY",
  "QUESTIONS_INCOMPLETE_ENTRY",
  "QUESTIONS_DUPLICATE_ID",
  "QUESTIONS_INVALID_UTF8",
  "QUESTIONS_MISSING",
  "QUESTIONS_TOO_LARGE",
  "QUESTIONS_UNAVAILABLE",
] as const;

const QUESTION_HEADING =
  /^## (Q[1-9][0-9]*) \(task (T[1-9][0-9]*), (open|answered)\) — (.+)$/;

interface SourceLine {
  value: string;
  start: number;
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let end = 0; end <= text.length; end += 1) {
    if (end === text.length || text[end] === "\n") {
      const raw = text.slice(start, end);
      lines.push({ value: raw.replace(/\r$/, ""), start });
      start = end + 1;
    }
  }
  return lines;
}

function addWarning(
  warnings: ReaderWarning[],
  code: string,
  message: string,
  line?: number,
  sourceLine?: string,
): void {
  if (warnings.length < MAX_QUESTIONS_WARNINGS - 1) {
    warnings.push(readerWarning(code, message, line, sourceLine));
  } else if (
    !warnings.some((warning) => warning.code === "WARNINGS_TRUNCATED")
  ) {
    warnings.push({
      code: "WARNINGS_TRUNCATED",
      message: "additional question warnings were omitted",
    });
  }
}

export function parseFactoryQuestions(
  text: string,
): ReaderResult<QuestionsData> {
  const lines = sourceLines(text);
  if (lines.length > MAX_QUESTIONS_LINES) {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "QUESTIONS_TOO_MANY_LINES",
          message: "questions.md has too many lines",
        },
      ],
    };
  }
  const overlongLine = lines.findIndex(
    (line) => line.value.length > MAX_QUESTION_LINE_LENGTH,
  );
  if (overlongLine !== -1) {
    return {
      status: "unavailable",
      warnings: [
        readerWarning(
          "QUESTIONS_LINE_TOO_LONG",
          "questions.md contains an oversized line",
          overlongLine + 1,
          lines[overlongLine]?.value,
        ),
      ],
    };
  }

  const warnings: ReaderWarning[] = [];
  if (text.trim().length === 0) {
    addWarning(warnings, "QUESTIONS_EMPTY", "questions.md is empty");
  }

  const boundaries = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.value.startsWith("## Q"));
  if (boundaries.length > MAX_QUESTIONS) {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "QUESTIONS_TOO_MANY_ENTRIES",
          message: "questions.md has too many question entries",
        },
      ],
    };
  }

  const open: OpenQuestion[] = [];
  const identifiers = new Map<string, number[]>();
  for (let boundary = 0; boundary < boundaries.length; boundary += 1) {
    const current = boundaries[boundary]!;
    const match = QUESTION_HEADING.exec(current.line.value);
    if (!match) {
      addWarning(
        warnings,
        "QUESTIONS_MALFORMED_ENTRY",
        "a question heading is malformed",
        current.index + 1,
        current.line.value,
      );
      continue;
    }
    const id = match[1]!;
    const taskId = match[2]!;
    const status = match[3]!;
    const title = match[4]!;
    const seenAt = identifiers.get(id) ?? [];
    seenAt.push(current.index + 1);
    identifiers.set(id, seenAt);
    if (status !== "open") continue;

    const nextStart = boundaries[boundary + 1]?.line.start ?? text.length;
    const textSlice = text.slice(current.line.start, nextStart);
    const bodyLines = lines.slice(
      current.index + 1,
      boundaries[boundary + 1]?.index ?? lines.length,
    );
    const hasContext = bodyLines.some((line) =>
      line.value.startsWith("Context:"),
    );
    const hasOptions = bodyLines.some((line) =>
      line.value.startsWith("Options considered:"),
    );
    const hasAnswer = bodyLines.some((line) => line.value.startsWith("**A:**"));
    if (!hasContext || !hasOptions || !hasAnswer) {
      addWarning(
        warnings,
        "QUESTIONS_INCOMPLETE_ENTRY",
        "an open question is missing protocol fields",
        current.index + 1,
        current.line.value,
      );
    }
    open.push({ id, taskId, title, text: textSlice });
  }

  for (const duplicateLines of identifiers.values()) {
    if (duplicateLines.length < 2) continue;
    for (const line of duplicateLines) {
      addWarning(
        warnings,
        "QUESTIONS_DUPLICATE_ID",
        "questions.md contains a duplicate question identifier",
        line,
        lines[line - 1]?.value,
      );
    }
  }

  const data = { open };
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readFactoryQuestions(
  repositoryPath: string,
): Promise<ReaderResult<QuestionsData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "questions",
    MAX_QUESTIONS_BYTES,
  );
  if (result.status === "available") {
    try {
      return parseFactoryQuestions(
        new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
      );
    } catch {
      return {
        status: "unavailable",
        warnings: [
          {
            code: "QUESTIONS_INVALID_UTF8",
            message: "questions.md is not valid UTF-8",
          },
        ],
      };
    }
  }
  const code =
    result.status === "missing"
      ? "QUESTIONS_MISSING"
      : result.status === "too-large"
        ? "QUESTIONS_TOO_LARGE"
        : "QUESTIONS_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "questions.md is missing"
      : result.status === "too-large"
        ? "questions.md is too large"
        : "questions.md could not be read safely";
  return { status: "unavailable", warnings: [{ code, message }] };
}
