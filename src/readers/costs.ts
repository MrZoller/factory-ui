import {
  type CostCounters,
  type CostTask,
  type CostsData,
  type CostTokens,
  type ReaderResult,
} from "../contracts";
import { readFactoryFile } from "./file";

export const MAX_COSTS_BYTES = 64 * 1024;
export const MAX_COST_TASKS = 256;
export const MAX_COST_MODELS_PER_TASK = 64;
export const MAX_COST_STRING_LENGTH = 1024;

const TASK_ID = /^T[1-9][0-9]*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_COST_STRING_LENGTH
  );
}

function isModelId(value: string): boolean {
  if (!isBoundedString(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function isUtcTimestamp(value: unknown): value is string {
  if (!isBoundedString(value) || !UTC_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) =>
      fraction === undefined ? ".000Z" : `.${fraction.padEnd(3, "0")}Z`,
  );
  return parsed.toISOString() === normalized;
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTokens(value: unknown): CostTokens | null {
  if (
    !isRecord(value) ||
    !isCounter(value.input) ||
    !isCounter(value.output) ||
    !isCounter(value.reasoning) ||
    !isCounter(value.cacheRead) ||
    !isCounter(value.cacheWrite)
  ) {
    return null;
  }
  return {
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  };
}

function parseCounters(value: unknown): CostCounters | null {
  if (
    !isRecord(value) ||
    !isCounter(value.usd) ||
    !isCounter(value.messages) ||
    !isCounter(value.sessions)
  ) {
    return null;
  }
  const tokens = parseTokens(value.tokens);
  if (tokens === null) return null;
  return {
    usd: value.usd,
    messages: value.messages,
    sessions: value.sessions,
    tokens,
  };
}

function unavailable(code: string, message: string): ReaderResult<CostsData> {
  return { status: "unavailable", warnings: [{ code, message }] };
}

export function parseFactoryCosts(bytes: Uint8Array): ReaderResult<CostsData> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unavailable("COSTS_INVALID_UTF8", "costs.json is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unavailable("COSTS_INVALID_JSON", "costs.json is not valid JSON");
  }
  if (!isRecord(value)) {
    return unavailable(
      "COSTS_INVALID_ROOT",
      "costs.json must contain an object",
    );
  }
  if (value.schemaVersion !== 1) {
    return unavailable(
      "COSTS_UNSUPPORTED_SCHEMA",
      "costs.json schemaVersion must be 1",
    );
  }
  if (
    !isUtcTimestamp(value.recordedAt) ||
    !isBoundedString(value.currency) ||
    !isRecord(value.tasks)
  ) {
    return unavailable(
      "COSTS_INVALID_FIELD",
      "costs.json contains a missing or invalid field",
    );
  }

  const taskEntries = Object.entries(value.tasks);
  if (taskEntries.length > MAX_COST_TASKS) {
    return unavailable(
      "COSTS_TOO_MANY_TASKS",
      "costs.json contains too many tasks",
    );
  }

  const tasks: Record<string, CostTask> = Object.create(null);
  for (const [taskId, taskValue] of taskEntries) {
    if (
      (taskId !== "unattributed" && !TASK_ID.test(taskId)) ||
      !isRecord(taskValue) ||
      !isUtcTimestamp(taskValue.firstAt) ||
      !isUtcTimestamp(taskValue.lastAt) ||
      !isRecord(taskValue.byModel)
    ) {
      return unavailable(
        "COSTS_INVALID_TASK",
        "costs.json contains an invalid task",
      );
    }
    const counters = parseCounters(taskValue);
    if (counters === null) {
      return unavailable(
        "COSTS_INVALID_TASK",
        "costs.json contains an invalid task",
      );
    }

    const modelEntries = Object.entries(taskValue.byModel);
    if (modelEntries.length > MAX_COST_MODELS_PER_TASK) {
      return unavailable(
        "COSTS_TOO_MANY_MODELS",
        "costs.json contains too many models for a task",
      );
    }
    const byModel: Record<string, CostCounters> = Object.create(null);
    for (const [modelId, modelValue] of modelEntries) {
      const modelCounters = parseCounters(modelValue);
      if (!isModelId(modelId) || modelCounters === null) {
        return unavailable(
          "COSTS_INVALID_MODEL",
          "costs.json contains an invalid model entry",
        );
      }
      byModel[modelId] = modelCounters;
    }

    tasks[taskId] = {
      ...counters,
      byModel,
      firstAt: taskValue.firstAt,
      lastAt: taskValue.lastAt,
    };
  }

  return {
    status: "available",
    data: {
      schemaVersion: 1,
      recordedAt: value.recordedAt,
      currency: value.currency,
      tasks,
    },
    warnings: [],
  };
}

export async function readFactoryCosts(
  repositoryPath: string,
): Promise<ReaderResult<CostsData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "costs",
    MAX_COSTS_BYTES,
  );
  if (result.status === "available") return parseFactoryCosts(result.bytes);
  const code =
    result.status === "missing"
      ? "COSTS_MISSING"
      : result.status === "too-large"
        ? "COSTS_TOO_LARGE"
        : "COSTS_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "costs.json is missing"
      : result.status === "too-large"
        ? "costs.json is too large"
        : "costs.json could not be read safely";
  return unavailable(code, message);
}
