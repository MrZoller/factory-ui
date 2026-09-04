import {
  type OpenQuestion,
  type QuestionOption,
  type QuestionOptionDetails,
  type QuestionsData,
  type ReaderResult,
  type ReaderWarning,
} from "../contracts";
import { readFactoryFile } from "./file";
import { readerWarning } from "./warnings";

export const MAX_QUESTIONS_BYTES = 256 * 1024;
export const MAX_QUESTIONS_LINES = 4096;
export const MAX_QUESTION_LINE_LENGTH = 8192;
export const MAX_QUESTION_OPTION_LENGTH = 8192;
export const MAX_QUESTIONS = 128;
export const MAX_QUESTIONS_WARNINGS = 32;
export const MAX_QUESTION_FILED_AT_LENGTH = 64;

export const QUESTIONS_WARNING_CODES = [
  "WARNINGS_TRUNCATED",
  "QUESTIONS_TOO_MANY_LINES",
  "QUESTIONS_LINE_TOO_LONG",
  "QUESTIONS_OPTION_TOO_LONG",
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
  /^## (Q[1-9][0-9]*) \(task (T[1-9][0-9]*), (open|answered|consumed|withdrawn)(?:, filed-at (.*?))?\) — (.+)$/;
const TIMESTAMP_MARKER = "<!-- factory-question-timestamps-required-below -->";
const RFC3339_Z =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?Z$/;
const PARKED_BRANCH = /(?:^|\s)Parked branch: `([^`]+)`(?:[.\s]|$)/;

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

function validFiledAt(value: string): boolean {
  const fields = RFC3339_Z.exec(value);
  if (fields === null || Number.isNaN(Date.parse(value))) return false;
  const date = new Date(value);
  return (
    date.getUTCFullYear() === Number(fields[1]) &&
    date.getUTCMonth() + 1 === Number(fields[2]) &&
    date.getUTCDate() === Number(fields[3]) &&
    date.getUTCHours() === Number(fields[4]) &&
    date.getUTCMinutes() === Number(fields[5]) &&
    date.getUTCSeconds() === Number(fields[6])
  );
}

function bodyField(
  lines: SourceLine[],
  start: number,
  end: number,
  prefix: string,
): string | undefined {
  if (start < 0 || end <= start) return undefined;
  const first = lines[start]?.value.slice(prefix.length).trim() ?? "";
  const rest = lines
    .slice(start + 1, end)
    .map((line) => line.value)
    .join("\n");
  const value = `${first}${rest ? `\n${rest}` : ""}`.trim();
  return value || undefined;
}

function joinHardWraps(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function parseOptions(value: string | undefined): {
  options?: QuestionOption[];
  proseOptions?: string[];
  optionsTooLong?: true;
} {
  if (!value) return {};
  const lines = value.split("\n").filter((line) => line.trim().length > 0);
  const first = lines[0]?.trim() ?? "";
  const labelledStart = /^([A-Z])(?:\s*(?:—|-|:)\s*([\s\S]*)|\s*)$/;

  // Legacy prose hard-wraps are continuations of the current option. A label
  // at a line start, or after the historical semicolon/slash separators,
  // starts the next option; ordinary capitals inside prose do not.
  if (
    labelledStart.test(
      first.split(
        /\s*;\s+(?=[A-Z]\s*(?:—|-|:))|\s+\/\s+(?=[A-Z](?:\s*(?:—|-|:)|\s*(?:\/|$)))/,
      )[0] ?? "",
    )
  ) {
    const segments: string[] = [];
    for (const line of lines) {
      const fragments = line
        .trim()
        .split(
          /\s*;\s+(?=[A-Z]\s*(?:—|-|:))|\s+\/\s+(?=[A-Z](?:\s*(?:—|-|:)|\s*(?:\/|$)))/,
        );
      for (const fragment of fragments) {
        if (labelledStart.test(fragment.trim())) segments.push(fragment.trim());
        else if (segments.length > 0)
          segments[segments.length - 1] =
            `${segments.at(-1)} ${fragment.trim()}`;
        else return {};
      }
    }
    if (segments.length < 1 || segments.length > 26) return {};
    const options: QuestionOption[] = [];
    for (const segment of segments) {
      const match = labelledStart.exec(segment);
      if (match === null) return {};
      const label = match[1];
      if (label === undefined) return {};
      const raw = (match[2] ?? "").trim();
      if (raw.length > MAX_QUESTION_OPTION_LENGTH) {
        return { optionsTooLong: true };
      }
      const recommended = /\(\s*recommended\b/i.test(raw);
      options.push({
        label,
        text: raw,
        ...(recommended ? { recommended: true } : {}),
      });
    }
    return { options };
  }

  const proseOptions = joinHardWraps(value)
    .split(/\s+\/\s+/)
    .map((option) => option.trim())
    .filter(Boolean);
  if (
    proseOptions.some((option) => option.length > MAX_QUESTION_OPTION_LENGTH)
  ) {
    return { optionsTooLong: true };
  }
  return proseOptions.length >= 2 && proseOptions.length <= 26
    ? { proseOptions }
    : {};
}

type ElaborationField =
  | { kind: "option"; label: string; value: string }
  | {
      kind: "owner" | "dayToDayConsequence" | "costOrRisk";
      value: string;
    }
  | { kind: "recommendationRationale"; value: string };

function elaborationField(value: string): ElaborationField | undefined {
  const option = /^Option ([A-Z]):\s*(.*)$/.exec(value);
  if (option) {
    const label = option[1];
    if (label !== undefined)
      return { kind: "option", label, value: option[2] ?? "" };
  }
  const fields = [
    ["Owner:", "owner"],
    ["Day-to-day consequence:", "dayToDayConsequence"],
    ["Cost or risk:", "costOrRisk"],
    ["Recommendation rationale:", "recommendationRationale"],
  ] as const;
  for (const [prefix, kind] of fields) {
    if (value.startsWith(prefix)) {
      return { kind, value: value.slice(prefix.length).trim() };
    }
  }
  return undefined;
}

function looksLikeUnknownElaborationField(value: string): boolean {
  // A one-letter `A:` line is still a valid legacy option. Longer labelled
  // lines after the choices are a protocol envelope: unknown labels must send
  // the whole question through the lossless raw fallback.
  return /^[A-Za-z][A-Za-z -]+:\s*/.test(value);
}

function parseOptionElaborations(
  lines: SourceLine[],
  options: QuestionOption[],
):
  | {
      options: QuestionOption[];
      recommendationRationale?: string;
    }
  | { optionsTooLong: true }
  | undefined {
  const labels = new Set(options.map((option) => option.label));
  const details = new Map<string, QuestionOptionDetails>();
  const seen = new Map<string, Set<keyof QuestionOptionDetails>>();
  let selectedLabel: string | undefined;
  let current: ElaborationField | undefined;
  let continuations: string[] = [];
  let recommendationRationale: string | undefined;
  let optionsTooLong = false;

  const flush = (): boolean => {
    if (current === undefined) return true;
    const value = joinHardWraps([current.value, ...continuations].join("\n"));
    continuations = [];
    if (value.length > MAX_QUESTION_OPTION_LENGTH) {
      optionsTooLong = true;
      return false;
    }
    if (current.kind === "recommendationRationale") {
      if (recommendationRationale !== undefined || value.length === 0)
        return false;
      recommendationRationale = value;
      current = undefined;
      return true;
    }
    if (current.kind === "option") {
      selectedLabel = current.label;
      if (!labels.has(selectedLabel) || details.has(selectedLabel))
        return false;
      details.set(selectedLabel, value ? { elaboration: value } : {});
      seen.set(selectedLabel, value ? new Set(["elaboration"]) : new Set());
      current = undefined;
      return true;
    }
    if (selectedLabel === undefined) return false;
    const optionDetails = details.get(selectedLabel);
    const optionSeen = seen.get(selectedLabel);
    if (
      optionDetails === undefined ||
      optionSeen === undefined ||
      optionSeen.has(current.kind) ||
      value.length === 0
    )
      return false;
    optionDetails[current.kind] = value;
    optionSeen.add(current.kind);
    current = undefined;
    return true;
  };

  for (const line of lines) {
    const field = elaborationField(line.value);
    if (field !== undefined) {
      if (!flush())
        return optionsTooLong ? { optionsTooLong: true } : undefined;
      if (field.kind === "recommendationRationale") selectedLabel = undefined;
      current = field;
      continue;
    }
    if (looksLikeUnknownElaborationField(line.value)) return undefined;
    if (current === undefined) return undefined;
    continuations.push(line.value);
  }
  if (!flush()) return optionsTooLong ? { optionsTooLong: true } : undefined;

  return {
    options: options.map((option) => {
      const optionDetails = details.get(option.label);
      return optionDetails === undefined ||
        Object.keys(optionDetails).length === 0
        ? option
        : { ...option, details: optionDetails };
    }),
    ...(recommendationRationale === undefined
      ? {}
      : { recommendationRationale }),
  };
}

type ParsedQuestionDetails = Omit<
  OpenQuestion,
  "id" | "taskId" | "title" | "text"
> & { optionsTooLong?: true };

export function parseQuestionDetails(text: string): ParsedQuestionDetails {
  const lines = sourceLines(text).slice(1);
  const contextIndex = lines.findIndex((line) =>
    line.value.startsWith("Context:"),
  );
  const optionsIndex = lines.findIndex((line) =>
    line.value.startsWith("Options considered:"),
  );
  const answerIndex = lines.findIndex((line) =>
    line.value.startsWith("**A:**"),
  );
  const qualifierIndex = lines.findIndex(
    (line, index) =>
      index > optionsIndex &&
      index < answerIndex &&
      /^(?:Qualifier(?: prompt)?:|Please\b|For\s+[A-Z](?:\s*(?:,|or|and)\s*[A-Z])*\s*,?\s+state whether\b)/i.test(
        line.value,
      ),
  );
  const detailsEnd =
    qualifierIndex >= 0
      ? qualifierIndex
      : answerIndex >= 0
        ? answerIndex
        : lines.length;
  const envelopeIndex = lines.findIndex(
    (line, index) =>
      index > optionsIndex &&
      index < detailsEnd &&
      elaborationField(line.value) !== undefined,
  );
  // Unknown protocol fields require the lossless raw fallback even when no
  // recognized elaboration field follows them. Otherwise parseOptions treats
  // a trailing labelled line as hard-wrapped text for the final option.
  const unknownEnvelopeField = lines
    .slice(optionsIndex + 1, detailsEnd)
    .some(
      (line) =>
        elaborationField(line.value) === undefined &&
        looksLikeUnknownElaborationField(line.value),
    );
  const context = bodyField(
    lines,
    contextIndex,
    optionsIndex >= 0 ? optionsIndex : lines.length,
    "Context:",
  );
  const optionsText = bodyField(
    lines,
    optionsIndex,
    envelopeIndex >= 0 ? envelopeIndex : detailsEnd,
    "Options considered:",
  );
  const qualifierLine = lines[qualifierIndex]?.value ?? "";
  const qualifierPrefix = qualifierLine.match(
    /^(?:Qualifier(?: prompt)?:\s*)/i,
  )?.[0];
  const qualifier = bodyField(
    lines,
    qualifierIndex,
    answerIndex >= 0 ? answerIndex : lines.length,
    qualifierPrefix ?? "",
  );
  const parsedOptions = parseOptions(optionsText);
  const parsedElaborations =
    envelopeIndex >= 0 && parsedOptions.options !== undefined
      ? parseOptionElaborations(
          lines.slice(envelopeIndex, detailsEnd),
          parsedOptions.options,
        )
      : undefined;
  const elaborationsTooLong =
    parsedElaborations !== undefined &&
    "optionsTooLong" in parsedElaborations &&
    parsedElaborations.optionsTooLong;
  const malformedEnvelope =
    unknownEnvelopeField ||
    (envelopeIndex >= 0 &&
      (parsedElaborations === undefined || elaborationsTooLong));
  const branch = PARKED_BRANCH.exec(context ?? "")?.[1];
  return {
    ...(context === undefined ? {} : { context }),
    ...(malformedEnvelope
      ? parsedOptions.optionsTooLong || elaborationsTooLong
        ? { optionsTooLong: true as const }
        : {}
      : (parsedElaborations ?? parsedOptions)),
    ...(qualifier === undefined ? {} : { qualifier }),
    ...(branch === undefined ? {} : { branch }),
  };
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
  const markerIndices = lines.flatMap((line, index) =>
    line.value === TIMESTAMP_MARKER ? [index] : [],
  );
  const markerIndex = markerIndices[0] ?? -1;
  for (const duplicateIndex of markerIndices.slice(1)) {
    addWarning(
      warnings,
      "QUESTIONS_MALFORMED_ENTRY",
      "questions.md contains more than one timestamp marker",
      duplicateIndex + 1,
      lines[duplicateIndex]?.value,
    );
  }
  lines.forEach((line, index) => {
    if (
      line.value !== TIMESTAMP_MARKER &&
      /^\s*<!--\s*factory-question-timestamps-required-below/.test(line.value)
    ) {
      addWarning(
        warnings,
        "QUESTIONS_MALFORMED_ENTRY",
        "a question timestamp marker is malformed",
        index + 1,
        line.value,
      );
    }
  });
  for (let boundary = 0; boundary < boundaries.length; boundary += 1) {
    const current = boundaries[boundary];
    if (current === undefined) continue;
    const timestampRequired = markerIndex >= 0 && current.index > markerIndex;
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
    const filedAtCandidate = match[4];
    const filedAtValid =
      filedAtCandidate !== undefined &&
      filedAtCandidate.length <= MAX_QUESTION_FILED_AT_LENGTH &&
      validFiledAt(filedAtCandidate);
    if (
      (timestampRequired && !filedAtValid) ||
      (!timestampRequired && filedAtCandidate !== undefined && !filedAtValid)
    ) {
      addWarning(
        warnings,
        "QUESTIONS_MALFORMED_ENTRY",
        timestampRequired && filedAtCandidate === undefined
          ? "a question below the timestamp marker is missing filed-at"
          : "a question filed-at timestamp is malformed",
        current.index + 1,
        current.line.value,
      );
    }
    const id = match[1];
    const taskId = match[2];
    const status = match[3];
    const title = match[5];
    if (
      id === undefined ||
      taskId === undefined ||
      status === undefined ||
      title === undefined
    ) {
      addWarning(
        warnings,
        "QUESTIONS_MALFORMED_ENTRY",
        "a question heading is malformed",
        current.index + 1,
        current.line.value,
      );
      continue;
    }
    const seenAt = identifiers.get(id) ?? [];
    seenAt.push(current.index + 1);
    identifiers.set(id, seenAt);
    const nextBoundaryStart =
      boundaries[boundary + 1]?.line.start ?? text.length;
    const nextMarkerIndex = markerIndices.find(
      (index) => index > current.index,
    );
    const nextBoundaryIndex = boundaries[boundary + 1]?.index ?? lines.length;
    let bodyEndIndex =
      nextMarkerIndex !== undefined
        ? Math.min(nextBoundaryIndex, nextMarkerIndex)
        : nextBoundaryIndex;
    let bodyLines = lines.slice(current.index + 1, bodyEndIndex);
    const markerInsideEntry =
      nextMarkerIndex !== undefined &&
      nextMarkerIndex < nextBoundaryIndex &&
      !["Context:", "Options considered:", "**A:**"].every((prefix) =>
        bodyLines.some((line) => line.value.startsWith(prefix)),
      );
    if (markerInsideEntry) {
      bodyEndIndex = nextBoundaryIndex;
      bodyLines = lines.slice(current.index + 1, bodyEndIndex);
      addWarning(
        warnings,
        "QUESTIONS_MALFORMED_ENTRY",
        "a question timestamp marker is misplaced inside an entry",
        nextMarkerIndex + 1,
        lines[nextMarkerIndex]?.value,
      );
    }
    if (status !== "open") continue;
    const markerStart =
      nextMarkerIndex === undefined || markerInsideEntry
        ? text.length
        : (lines[nextMarkerIndex]?.start ?? text.length);
    const nextStart = Math.min(nextBoundaryStart, markerStart);
    const textSlice = text.slice(current.line.start, nextStart);
    const contextIndex = bodyLines.findIndex((line) =>
      line.value.startsWith("Context:"),
    );
    const optionsIndex = bodyLines.findIndex((line) =>
      line.value.startsWith("Options considered:"),
    );
    const answerIndex = bodyLines.findIndex((line) =>
      line.value.startsWith("**A:**"),
    );
    const hasContext = contextIndex >= 0;
    const hasOptions = optionsIndex >= 0;
    const hasAnswer = answerIndex >= 0;
    if (!hasContext || !hasOptions || !hasAnswer) {
      addWarning(
        warnings,
        "QUESTIONS_INCOMPLETE_ENTRY",
        "an open question is missing protocol fields",
        current.index + 1,
        current.line.value,
      );
    }
    const details = parseQuestionDetails(textSlice);
    if (details.optionsTooLong) {
      addWarning(
        warnings,
        "QUESTIONS_OPTION_TOO_LONG",
        "a question option exceeds the structured rendering limit",
        current.index + 1,
        current.line.value,
      );
    }
    const { optionsTooLong: _optionsTooLong, ...questionDetails } = details;
    open.push({
      id,
      taskId,
      title,
      ...(filedAtValid ? { filedAt: filedAtCandidate } : {}),
      text: textSlice,
      ...questionDetails,
    });
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
