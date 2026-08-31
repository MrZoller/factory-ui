import type {
  CurrentRoutingData,
  ReaderResult,
  RoutingAgent,
} from "../contracts";
import { readExternalFile } from "./external-file";
import {
  MAX_AGENT_NAME_LENGTH,
  MAX_ROUTING_AGENTS,
  MAX_ROUTING_STEPS,
  MAX_ROUTING_STRING_LENGTH,
} from "./routing";

export const MAX_OPENCODE_CONFIG_BYTES = 256 * 1024;
const MAX_OBJECT_FIELDS = 256;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;

function unavailable(
  code: string,
  message: string,
): ReaderResult<CurrentRoutingData> {
  return { status: "unavailable", warnings: [{ code, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ROUTING_STRING_LENGTH &&
    MODEL_ID.test(value)
  );
}

function splitModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
  };
}

function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else {
      output += character;
    }
  }
  if (inString || blockComment) throw new Error("unterminated JSONC token");

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(output[lookahead] ?? "")) lookahead += 1;
      if (output[lookahead] === "}" || output[lookahead] === "]") continue;
    }
    withoutTrailingCommas += character;
  }
  return JSON.parse(withoutTrailingCommas) as unknown;
}

export function parseCurrentRouting(
  bytes: Uint8Array,
): ReaderResult<CurrentRoutingData> {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = parseJsonc(text);
  } catch {
    return unavailable(
      "CURRENT_ROUTING_INVALID_JSONC",
      "the current opencode configuration is not valid bounded JSONC",
    );
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_FIELDS) {
    return unavailable(
      "CURRENT_ROUTING_INVALID_ROOT",
      "the current opencode configuration has an invalid root object",
    );
  }
  if (!isModelId(value.model) || !isModelId(value.small_model)) {
    return unavailable(
      "CURRENT_ROUTING_INVALID_FIELD",
      "the current opencode configuration has invalid default model fields",
    );
  }
  if (value.agent !== undefined && !isRecord(value.agent)) {
    return unavailable(
      "CURRENT_ROUTING_INVALID_FIELD",
      "the current opencode configuration has an invalid agent map",
    );
  }
  const entries = Object.entries(value.agent ?? {});
  if (entries.length > MAX_ROUTING_AGENTS) {
    return unavailable(
      "CURRENT_ROUTING_TOO_MANY_AGENTS",
      "the current opencode configuration contains too many agents",
    );
  }
  const agents: Record<string, RoutingAgent> = Object.create(null);
  const warnings: { code: string; message: string }[] = [];
  for (const [name, rawAgent] of entries) {
    if (
      name.length === 0 ||
      name.length > MAX_AGENT_NAME_LENGTH ||
      !isRecord(rawAgent) ||
      Object.keys(rawAgent).length > MAX_OBJECT_FIELDS
    ) {
      warnings.push({
        code: "CURRENT_ROUTING_INVALID_AGENT",
        message: "an invalid current agent routing entry was omitted",
      });
      continue;
    }
    if (rawAgent.model === undefined) continue;
    if (
      !isModelId(rawAgent.model) ||
      (rawAgent.steps !== undefined &&
        (!Number.isSafeInteger(rawAgent.steps) ||
          (rawAgent.steps as number) < 0 ||
          (rawAgent.steps as number) > MAX_ROUTING_STEPS))
    ) {
      warnings.push({
        code: "CURRENT_ROUTING_INVALID_AGENT",
        message: "an invalid current agent routing entry was omitted",
      });
      continue;
    }
    const model = splitModel(rawAgent.model);
    agents[name] = {
      ...model,
      steps: rawAgent.steps === undefined ? null : (rawAgent.steps as number),
    };
  }
  const data: CurrentRoutingData = {
    model: value.model,
    smallModel: value.small_model,
    agents,
  };
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readCurrentRouting(
  path: string | undefined,
): Promise<ReaderResult<CurrentRoutingData>> {
  if (path === undefined) {
    return unavailable(
      "CURRENT_ROUTING_NOT_CONFIGURED",
      "current opencode routing is not configured",
    );
  }
  const result = await readExternalFile(path, MAX_OPENCODE_CONFIG_BYTES);
  if (result.status === "available") return parseCurrentRouting(result.bytes);
  if (result.status === "too-large") {
    return unavailable(
      "CURRENT_ROUTING_TOO_LARGE",
      "the current opencode configuration exceeds the safe read limit",
    );
  }
  return unavailable(
    result.status === "missing"
      ? "CURRENT_ROUTING_MISSING"
      : "CURRENT_ROUTING_UNAVAILABLE",
    result.status === "missing"
      ? "the current opencode configuration is missing"
      : "the current opencode configuration could not be read safely",
  );
}
