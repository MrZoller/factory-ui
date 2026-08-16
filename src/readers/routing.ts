import {
  type ReaderResult,
  type RoutingAgent,
  type RoutingData,
} from "../contracts";
import { readFactoryFile } from "./file";

export const MAX_ROUTING_BYTES = 16 * 1024;
export const MAX_ROUTING_AGENTS = 64;
export const MAX_AGENT_NAME_LENGTH = 128;
export const MAX_ROUTING_STRING_LENGTH = 1024;
export const MAX_ROUTING_STEPS = 1_000_000;

export const ROUTING_WARNING_CODES = [
  "ROUTING_INVALID_UTF8",
  "ROUTING_INVALID_JSON",
  "ROUTING_INVALID_ROOT",
  "ROUTING_UNSUPPORTED_SCHEMA",
  "ROUTING_INVALID_FIELD",
  "ROUTING_TOO_MANY_AGENTS",
  "ROUTING_INVALID_AGENT",
  "ROUTING_MISSING",
  "ROUTING_TOO_LARGE",
  "ROUTING_UNAVAILABLE",
] as const;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROUTING_STRING_LENGTH
  );
}

function isModelId(value: unknown): value is string {
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

function unavailable(code: string, message: string): ReaderResult<RoutingData> {
  return { status: "unavailable", warnings: [{ code, message }] };
}

export function parseFactoryRouting(
  bytes: Uint8Array,
): ReaderResult<RoutingData> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unavailable(
      "ROUTING_INVALID_UTF8",
      "routing.json is not valid UTF-8",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unavailable(
      "ROUTING_INVALID_JSON",
      "routing.json is not valid JSON",
    );
  }
  if (!isRecord(value)) {
    return unavailable(
      "ROUTING_INVALID_ROOT",
      "routing.json must contain an object",
    );
  }
  if (value.schemaVersion !== 1) {
    return unavailable(
      "ROUTING_UNSUPPORTED_SCHEMA",
      "routing.json schemaVersion must be 1",
    );
  }
  if (
    !isUtcTimestamp(value.recordedAt) ||
    !isModelId(value.model) ||
    !isModelId(value.smallModel) ||
    !isRecord(value.agents)
  ) {
    return unavailable(
      "ROUTING_INVALID_FIELD",
      "routing.json contains a missing or invalid field",
    );
  }

  const entries = Object.entries(value.agents);
  if (entries.length > MAX_ROUTING_AGENTS) {
    return unavailable(
      "ROUTING_TOO_MANY_AGENTS",
      "routing.json contains too many agents",
    );
  }
  const agents: Record<string, RoutingAgent> = Object.create(null);
  for (const [name, agent] of entries) {
    if (
      name.length === 0 ||
      name.length > MAX_AGENT_NAME_LENGTH ||
      !isRecord(agent) ||
      !isBoundedString(agent.provider) ||
      !isBoundedString(agent.model) ||
      !(
        agent.steps === null ||
        (typeof agent.steps === "number" &&
          Number.isSafeInteger(agent.steps) &&
          agent.steps >= 0 &&
          agent.steps <= MAX_ROUTING_STEPS)
      )
    ) {
      return unavailable(
        "ROUTING_INVALID_AGENT",
        "routing.json contains an invalid agent",
      );
    }
    agents[name] = {
      provider: agent.provider,
      model: agent.model,
      steps: agent.steps,
    };
  }

  return {
    status: "available",
    data: {
      schemaVersion: 1,
      recordedAt: value.recordedAt,
      model: value.model,
      smallModel: value.smallModel,
      agents,
    },
    warnings: [],
  };
}

export async function readFactoryRouting(
  repositoryPath: string,
): Promise<ReaderResult<RoutingData>> {
  const result = await readFactoryFile(
    repositoryPath,
    "routing",
    MAX_ROUTING_BYTES,
  );
  if (result.status === "available") return parseFactoryRouting(result.bytes);
  const code =
    result.status === "missing"
      ? "ROUTING_MISSING"
      : result.status === "too-large"
        ? "ROUTING_TOO_LARGE"
        : "ROUTING_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "routing.json is missing"
      : result.status === "too-large"
        ? "routing.json is too large"
        : "routing.json could not be read safely";
  return unavailable(code, message);
}
