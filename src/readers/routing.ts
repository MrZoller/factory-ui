import {
  type ReaderResult,
  type RoutingAgent,
  type RoutingData,
  type RoutingModel,
  type RoutingModelPrices,
} from "../contracts";
import { readFactoryFile } from "./file";

export const MAX_ROUTING_BYTES = 256 * 1024;
export const MAX_ROUTING_AGENTS = 64;
export const MAX_ROUTING_MODELS = 64;
export const MAX_AGENT_NAME_LENGTH = 128;
export const MAX_ROUTING_STRING_LENGTH = 1024;
export const MAX_ROUTING_MODEL_STRING_LENGTH = 200;
export const MAX_ROUTING_STEPS = 1_000_000;

export const ROUTING_WARNING_CODES = [
  "ROUTING_INVALID_UTF8",
  "ROUTING_INVALID_JSON",
  "ROUTING_INVALID_ROOT",
  "ROUTING_UNSUPPORTED_SCHEMA",
  "ROUTING_INVALID_FIELD",
  "ROUTING_TOO_MANY_AGENTS",
  "ROUTING_INVALID_AGENT",
  "ROUTING_TOO_MANY_MODELS",
  "ROUTING_INVALID_MODEL",
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

function isBoundedModelString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROUTING_MODEL_STRING_LENGTH
  );
}

function isMetadataModelId(value: string): boolean {
  if (!isBoundedModelString(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function isTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPrice(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function parseModel(value: unknown): RoutingModel | undefined {
  if (
    !isRecord(value) ||
    !(value.source === "models.dev" || value.source === null) ||
    !isBoundedModelString(value.pricesAsOf) ||
    !isBoundedModelString(value.name) ||
    !isBoundedModelString(value.family) ||
    !isBoundedModelString(value.releaseDate) ||
    !isTokenLimit(value.contextWindow) ||
    !isTokenLimit(value.maxOutputTokens) ||
    !isRecord(value.pricePerMillion)
  ) {
    return undefined;
  }
  const prices = value.pricePerMillion;
  if (
    !isPrice(prices.input) ||
    !isPrice(prices.output) ||
    !isPrice(prices.cacheRead) ||
    !isPrice(prices.cacheWrite)
  ) {
    return undefined;
  }
  const pricePerMillion: RoutingModelPrices = {
    input: prices.input,
    output: prices.output,
    cacheRead: prices.cacheRead,
    cacheWrite: prices.cacheWrite,
  };
  return {
    source: value.source,
    pricesAsOf: value.pricesAsOf,
    name: value.name,
    family: value.family,
    releaseDate: value.releaseDate,
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    pricePerMillion,
  };
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

  let models: Record<string, RoutingModel> | undefined;
  const warnings: { code: string; message: string }[] = [];
  if (value.models !== undefined) {
    if (!isRecord(value.models)) {
      warnings.push({
        code: "ROUTING_INVALID_MODEL",
        message: "routing.json models must contain an object",
      });
    } else {
      models = Object.create(null) as Record<string, RoutingModel>;
      const modelEntries = Object.entries(value.models);
      if (modelEntries.length > MAX_ROUTING_MODELS) {
        warnings.push({
          code: "ROUTING_TOO_MANY_MODELS",
          message:
            "routing.json contains too many models; extra entries were dropped",
        });
      }
      for (const [id, modelValue] of modelEntries.slice(
        0,
        MAX_ROUTING_MODELS,
      )) {
        const model = parseModel(modelValue);
        if (!isMetadataModelId(id) || model === undefined) {
          warnings.push({
            code: "ROUTING_INVALID_MODEL",
            message: "routing.json contains an invalid model entry",
          });
          continue;
        }
        models[id] = model;
      }
    }
  }

  const data: RoutingData = {
    schemaVersion: 1,
    recordedAt: value.recordedAt,
    model: value.model,
    smallModel: value.smallModel,
    agents,
    ...(models === undefined ? {} : { models }),
  };
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
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
