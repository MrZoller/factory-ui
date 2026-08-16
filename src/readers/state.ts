import {
  FACTORY_PHASES,
  type FactoryPhase,
  type FactoryStateData,
  type ReaderResult,
  type ReaderWarning,
} from "../contracts";
import { readFactoryFile } from "./file";

export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_PROJECT_LENGTH = 200;
export const MAX_STATE_STRING_LENGTH = 1024;

const TASK_ID = /^T[1-9][0-9]*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_STATE_STRING_LENGTH ||
    !UTC_TIMESTAMP.test(value)
  )
    return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) =>
      fraction === undefined ? ".000Z" : `.${fraction.padEnd(3, "0")}Z`,
  );
  return parsed.toISOString() === normalized;
}

function warning(message: string): ReaderWarning {
  return { code: "STATE_INVALID_FIELD", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is FactoryPhase {
  return (
    typeof value === "string" && FACTORY_PHASES.includes(value as FactoryPhase)
  );
}

export function parseFactoryState(
  bytes: Uint8Array,
): ReaderResult<FactoryStateData> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "STATE_INVALID_UTF8",
          message: "state.json is not valid UTF-8",
        },
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      status: "unavailable",
      warnings: [
        { code: "STATE_INVALID_JSON", message: "state.json is not valid JSON" },
      ],
    };
  }
  if (!isRecord(value)) {
    return {
      status: "unavailable",
      warnings: [
        {
          code: "STATE_INVALID_ROOT",
          message: "state.json must contain an object",
        },
      ],
    };
  }

  const data: FactoryStateData = {};
  const warnings: ReaderWarning[] = [];

  if (
    typeof value.project === "string" &&
    value.project.length > 0 &&
    value.project.length <= MAX_PROJECT_LENGTH
  )
    data.project = value.project;
  else warnings.push(warning("state project is missing or invalid"));

  if (isPhase(value.phase)) data.phase = value.phase;
  else warnings.push(warning("state phase is missing or invalid"));

  for (const [source, target] of [
    ["spec_approved", "specApproved"],
    ["plan_approved", "planApproved"],
    ["hold", "hold"],
  ] as const) {
    if (typeof value[source] === "boolean") data[target] = value[source];
    else warnings.push(warning(`state ${source} is missing or invalid`));
  }

  if (
    value.current_task === null ||
    (typeof value.current_task === "string" && TASK_ID.test(value.current_task))
  )
    data.currentTask = value.current_task;
  else warnings.push(warning("state current_task is missing or invalid"));

  if (
    value.branch === null ||
    (typeof value.branch === "string" &&
      value.branch.length > 0 &&
      value.branch.length <= MAX_STATE_STRING_LENGTH)
  )
    data.branch = value.branch;
  else warnings.push(warning("state branch is missing or invalid"));

  if (
    value.pr === null ||
    (typeof value.pr === "number" &&
      Number.isSafeInteger(value.pr) &&
      value.pr > 0)
  )
    data.pr = value.pr;
  else warnings.push(warning("state pr is missing or invalid"));

  if (isUtcTimestamp(value.updated)) data.updated = value.updated;
  else warnings.push(warning("state updated is missing or invalid"));

  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readFactoryState(
  repositoryPath: string,
): Promise<ReaderResult<FactoryStateData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "state",
    MAX_STATE_BYTES,
  );
  if (result.status === "available") return parseFactoryState(result.bytes);
  const code =
    result.status === "missing"
      ? "STATE_MISSING"
      : result.status === "too-large"
        ? "STATE_TOO_LARGE"
        : "STATE_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "state.json is missing"
      : result.status === "too-large"
        ? "state.json is too large"
        : "state.json could not be read safely";
  return { status: "unavailable", warnings: [{ code, message }] };
}
