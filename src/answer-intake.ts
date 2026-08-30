import type {
  AnswerOutcome,
  AnswerRequest,
  AnswerSubmissionResult,
  UnknownAnswerOutcome,
} from "./contracts";

export const ANSWER_EXECUTABLE = "factory-answers";
export const ANSWER_TIMEOUT_MS = 5_000;
export const MAX_ANSWER_OUTPUT_BYTES = 64 * 1024;
export const MAX_ANSWER_TEXT_LENGTH = 10_000;

export interface AnswerProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export type AnswerRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    maxOutputBytes: number;
  }>,
) => Promise<AnswerProcessResult>;

export interface AnswerIntakeDependencies {
  runner?: AnswerRunner;
}

export interface SubmitAnswerInput extends AnswerRequest {
  repositoryPath: string;
  actor: string;
  secret: string;
}

export interface GetAnswerOutcomeInput {
  repositoryPath: string;
  id: string;
  secret: string;
}

const QUESTION_ID = /^Q[1-9][0-9]*$/;
const OPTION = /^[A-Z]$/;
export const ANSWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validPrivateString(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !ASCII_CONTROL.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339_MILLISECONDS.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function validateAnswerRequest(value: unknown): AnswerRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["question"], ["option", "text"])
  ) {
    return null;
  }
  if (
    typeof value.question !== "string" ||
    value.question.length > 32 ||
    !QUESTION_ID.test(value.question)
  ) {
    return null;
  }
  const option = value.option;
  const text = value.text;
  if (
    option !== undefined &&
    (typeof option !== "string" || !OPTION.test(option))
  ) {
    return null;
  }
  if (
    text !== undefined &&
    (typeof text !== "string" ||
      text.trim().length === 0 ||
      text.length > MAX_ANSWER_TEXT_LENGTH ||
      ASCII_CONTROL.test(text))
  ) {
    return null;
  }
  if (option === undefined && text === undefined) return null;
  return {
    question: value.question,
    ...(option === undefined ? {} : { option }),
    ...(text === undefined ? {} : { text }),
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      return { text: "", truncated: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      truncated: false,
    };
  } catch {
    return { text: "", truncated: true };
  }
}

export const runAnswerHelper: AnswerRunner = async (
  executable,
  args,
  options,
) => {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, options.maxOutputBytes),
      readBounded(child.stderr, options.maxOutputBytes),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      outputTruncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
};

function parseHelperJson(result: AnswerProcessResult): unknown {
  if (
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode === null ||
    result.stdout.length === 0 ||
    result.stdout.length > MAX_ANSWER_OUTPUT_BYTES ||
    result.stderr.length > MAX_ANSWER_OUTPUT_BYTES
  ) {
    throw new Error("answer helper failed");
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("answer helper returned invalid JSON");
  }
}

function helperOptions(repositoryPath: string, secret: string) {
  return {
    cwd: repositoryPath,
    env: { ...process.env, FACTORY_ANSWER_SECRET: secret },
    timeoutMs: ANSWER_TIMEOUT_MS,
    maxOutputBytes: MAX_ANSWER_OUTPUT_BYTES,
  };
}

function validOutcome(value: unknown, id: string): value is AnswerOutcome {
  if (!isRecord(value)) return false;
  const status = value.status;
  const optional = ["option", "text", "preparedAt", "settledAt", "reason"];
  if (
    !hasExactKeys(
      value,
      [
        "schemaVersion",
        "id",
        "status",
        "question",
        "actor",
        "source",
        "submittedAt",
      ],
      optional,
    ) ||
    value.schemaVersion !== 1 ||
    value.id !== id ||
    !["pending", "inflight", "accepted", "rejected"].includes(String(status)) ||
    typeof value.question !== "string" ||
    value.question.length > 32 ||
    !QUESTION_ID.test(value.question) ||
    !validPrivateString(value.actor) ||
    value.source !== "factory-ui" ||
    !validTimestamp(value.submittedAt)
  ) {
    return false;
  }
  if (
    value.option !== undefined &&
    (typeof value.option !== "string" || !OPTION.test(value.option))
  )
    return false;
  if (
    value.text !== undefined &&
    (typeof value.text !== "string" ||
      value.text.length > MAX_ANSWER_TEXT_LENGTH ||
      !value.text ||
      value.text.trim() !== value.text ||
      ASCII_CONTROL.test(value.text))
  )
    return false;
  if (value.preparedAt !== undefined && !validTimestamp(value.preparedAt))
    return false;
  if (value.settledAt !== undefined && !validTimestamp(value.settledAt))
    return false;
  if (value.reason !== undefined && !validPrivateString(value.reason))
    return false;
  if (value.option === undefined && value.text === undefined) return false;
  if (
    (status === "pending" &&
      (value.preparedAt !== undefined ||
        value.settledAt !== undefined ||
        value.reason !== undefined)) ||
    (status === "inflight" &&
      (value.settledAt !== undefined || value.reason !== undefined)) ||
    (status === "accepted" &&
      (value.preparedAt === undefined ||
        value.settledAt === undefined ||
        value.reason !== undefined)) ||
    (status === "rejected" &&
      (value.preparedAt !== undefined ||
        value.settledAt === undefined ||
        value.reason === undefined))
  ) {
    return false;
  }
  return true;
}

export async function submitAnswer(
  input: SubmitAnswerInput,
  dependencies: AnswerIntakeDependencies = {},
): Promise<AnswerSubmissionResult> {
  // The public input carries trusted server-only routing fields in addition to
  // the wire schema. Validate only the latter; validating the whole object
  // would reject every legitimate submission for having those required fields.
  const request = validateAnswerRequest({
    question: input.question,
    ...(input.option === undefined ? {} : { option: input.option }),
    ...(input.text === undefined ? {} : { text: input.text }),
  });
  if (request === null || !validPrivateString(input.actor)) {
    throw new Error("invalid answer submission");
  }
  const args = ["submit", "--question", request.question];
  if (request.option !== undefined) args.push("--option", request.option);
  if (request.text !== undefined) args.push("--text", request.text);
  args.push("--actor", input.actor, "--source", "factory-ui");
  const result = await (dependencies.runner ?? runAnswerHelper)(
    ANSWER_EXECUTABLE,
    args,
    helperOptions(input.repositoryPath, input.secret),
  );
  const value = parseHelperJson(result);
  if (
    result.exitCode !== 0 ||
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "id"]) ||
    value.status !== "pending" ||
    typeof value.id !== "string" ||
    !ANSWER_UUID.test(value.id)
  ) {
    throw new Error("answer helper rejected submission");
  }
  return { status: "pending", id: value.id };
}

export async function getAnswerOutcome(
  input: GetAnswerOutcomeInput,
  dependencies: AnswerIntakeDependencies = {},
): Promise<AnswerOutcome | UnknownAnswerOutcome> {
  if (!ANSWER_UUID.test(input.id)) throw new Error("invalid answer id");
  const result = await (dependencies.runner ?? runAnswerHelper)(
    ANSWER_EXECUTABLE,
    ["outcome", "--id", input.id],
    helperOptions(input.repositoryPath, input.secret),
  );
  const value = parseHelperJson(result);
  if (
    result.exitCode === 5 &&
    isRecord(value) &&
    hasExactKeys(value, ["status"]) &&
    value.status === "unknown-record"
  ) {
    return { status: "unknown-record" };
  }
  if (result.exitCode !== 0 || !validOutcome(value, input.id)) {
    throw new Error("answer helper returned an invalid outcome");
  }
  return value;
}
