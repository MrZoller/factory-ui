import type { AppConfig, PeerConfig, RepositoryConfig } from "./contracts";

export const DEFAULT_PORT = 7777;
export const MAX_CONFIG_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseRepository(value: unknown, index: number): RepositoryConfig {
  if (!isRecord(value)) {
    throw new Error(`repositories[${index}] must be an object`);
  }
  return {
    name: readNonEmptyString(value.name, `repositories[${index}].name`),
    path: readNonEmptyString(value.path, `repositories[${index}].path`),
  };
}

function parsePeer(value: unknown, index: number): PeerConfig {
  if (!isRecord(value)) {
    throw new Error(`peers[${index}] must be an object`);
  }
  return {
    name: readNonEmptyString(value.name, `peers[${index}].name`),
    origin: readNonEmptyString(value.origin, `peers[${index}].origin`),
  };
}

export function parseConfig(value: unknown): AppConfig {
  if (!isRecord(value)) {
    throw new Error("config must be a JSON object");
  }
  if (!Array.isArray(value.repositories) || value.repositories.length === 0) {
    throw new Error("repositories must be a non-empty array");
  }
  if (!Array.isArray(value.peers)) {
    throw new Error("peers must be an array");
  }

  const port = value.port ?? DEFAULT_PORT;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535
  ) {
    throw new Error("port must be an integer from 1 to 65535");
  }

  return {
    machine: readNonEmptyString(value.machine, "machine"),
    repositories: value.repositories.map(parseRepository),
    peers: value.peers.map(parsePeer),
    port: port as number,
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error("config file does not exist");
  }
  const bytes = await file.slice(0, MAX_CONFIG_BYTES + 1).arrayBuffer();
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new Error("config file is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("config file is not valid JSON");
  }
  return parseConfig(value);
}
