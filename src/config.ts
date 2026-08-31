import { isAbsolute, normalize, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";

import type { AppConfig, PeerConfig, RepositoryConfig } from "./contracts";

export const DEFAULT_PORT = 7777;
export const DEFAULT_BIND = "127.0.0.1";
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_REPOSITORIES = 32;
export const MAX_CODE_ROOTS = 32;
export const MAX_PEERS = 32;

const MAX_NAME_LENGTH = 64;
const MAX_MACHINE_LENGTH = 128;
const MAX_ANSWER_ACTOR_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function readIdentifier(value: unknown, field: string): string {
  const result = readString(value, field, MAX_NAME_LENGTH);
  if (!IDENTIFIER.test(result) || result === "." || result === "..") {
    throw new Error(`${field} must be a path-safe identifier`);
  }
  return result;
}

export function parseRepositoryName(
  value: unknown,
  field = "repository name",
): string {
  return readIdentifier(value, field);
}

function parseIpv6(value: string): number[] | null {
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2 || value.includes(".") || value.includes("%"))
    return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  return [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
}

function isIpv4Loopback(value: string): boolean {
  if (!isIPv4(value)) return false;
  return Number(value.split(".")[0]) === 127;
}

function isIpv6Loopback(value: string): boolean {
  const words = isIPv6(value) ? parseIpv6(value) : null;
  return (
    words !== null &&
    words.slice(0, 7).every((word) => word === 0) &&
    words[7] === 1
  );
}

function parseBind(value: unknown): string {
  const bind = readString(value ?? DEFAULT_BIND, "bind", 64);
  if (bind.includes("%") || isIP(bind) === 0) {
    throw new Error("bind must be an allowed literal IP address");
  }
  if (isIPv4(bind)) {
    const octets = bind.split(".").map(Number);
    if (
      octets[0] === 127 ||
      (octets[0] === 100 &&
        octets[1] !== undefined &&
        octets[1] >= 64 &&
        octets[1] <= 127)
    ) {
      return bind;
    }
  } else {
    const words = parseIpv6(bind);
    if (
      words &&
      (isIpv6Loopback(bind) ||
        (words[0] === 0xfd7a && words[1] === 0x115c && words[2] === 0xa1e0))
    ) {
      return bind;
    }
  }
  throw new Error("bind must be an allowed literal IP address");
}

function parseOrigin(
  value: unknown,
  field: string,
  development: boolean,
): string {
  const input = readString(value, field, MAX_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${field} must be a valid HTTP origin`);
  }
  if (
    !/^https?:\/\/[^/]+\/?$/i.test(input) ||
    input.includes("\\") ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname.includes("*")
  ) {
    throw new Error(`${field} must be an exact HTTP origin`);
  }
  if (development) {
    const host = url.hostname.startsWith("[")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    if (
      host !== "localhost" &&
      !isIpv4Loopback(host) &&
      !isIpv6Loopback(host)
    ) {
      throw new Error(`${field} must use localhost or a loopback IP`);
    }
  }
  return url.origin;
}

export function parseGithubUrl(value: unknown, field = "githubUrl"): string {
  const input = readString(value, field, MAX_URL_LENGTH);
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(input);
  if (match === null) {
    throw new Error(`${field} must be a GitHub repository URL`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${field} must be a GitHub repository URL`);
  }
  if (
    input.includes("\\") ||
    input.includes("%") ||
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${field} must be a GitHub repository URL`);
  }
  const owner = match[1];
  const matchedRepository = match[2];
  if (owner === undefined || matchedRepository === undefined) {
    throw new Error(`${field} must be a GitHub repository URL`);
  }
  const repository = matchedRepository.endsWith(".git")
    ? matchedRepository.slice(0, -4)
    : matchedRepository;
  if (
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPOSITORY.test(repository) ||
    repository.length > 100 ||
    repository === "." ||
    repository === ".."
  ) {
    throw new Error(`${field} has invalid owner or repository segments`);
  }
  const accepted = [
    `https://github.com/${owner}/${repository}`,
    `https://github.com/${owner}/${repository}/`,
    `https://github.com/${owner}/${repository}.git`,
    `https://github.com/${owner}/${repository}.git/`,
  ];
  if (!accepted.includes(url.href)) {
    throw new Error(`${field} must be a canonical GitHub repository URL`);
  }
  const canonical = accepted[0];
  if (canonical === undefined) {
    throw new Error(`${field} must be a canonical GitHub repository URL`);
  }
  return canonical;
}

function parseRepository(value: unknown, index: number): RepositoryConfig {
  if (!isRecord(value)) {
    throw new Error(`repositories[${index}] must be an object`);
  }
  return {
    name: parseRepositoryName(value.name, `repositories[${index}].name`),
    path: parseRepositoryPath(value.path, `repositories[${index}].path`),
    githubUrl: parseGithubUrl(
      value.githubUrl,
      `repositories[${index}].githubUrl`,
    ),
  };
}

function parseRepositoryPath(value: unknown, field: string): string {
  const path = readString(value, field, MAX_PATH_LENGTH);
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.split(sep).some((component) => component === "..")
  ) {
    throw new Error(
      `${field} must be an absolute normalized path without traversal`,
    );
  }
  return path;
}

function parsePeer(value: unknown, index: number): PeerConfig {
  if (!isRecord(value)) {
    throw new Error(`peers[${index}] must be an object`);
  }
  return {
    name: readIdentifier(value.name, `peers[${index}].name`),
    origin: parseOrigin(value.origin, `peers[${index}].origin`, false),
  };
}

function requireUnique(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

export function parseConfig(value: unknown): AppConfig {
  if (!isRecord(value)) {
    throw new Error("config must be a JSON object");
  }
  if (
    value.repositories !== undefined &&
    (!Array.isArray(value.repositories) ||
      value.repositories.length > MAX_REPOSITORIES)
  ) {
    throw new Error("repositories must be a non-empty array");
  }
  if (
    value.codeRoots !== undefined &&
    (!Array.isArray(value.codeRoots) || value.codeRoots.length > MAX_CODE_ROOTS)
  ) {
    throw new Error("codeRoots must be an array");
  }
  if (
    (!Array.isArray(value.repositories) || value.repositories.length === 0) &&
    (!Array.isArray(value.codeRoots) || value.codeRoots.length === 0)
  ) {
    throw new Error("repositories must be a non-empty array");
  }
  if (!Array.isArray(value.peers) || value.peers.length > MAX_PEERS) {
    throw new Error("peers must be an array");
  }
  if (
    value.developmentOrigins !== undefined &&
    !Array.isArray(value.developmentOrigins)
  ) {
    throw new Error("developmentOrigins must be an array");
  }
  const developmentValues = value.developmentOrigins ?? [];
  if ((developmentValues as unknown[]).length > MAX_PEERS) {
    throw new Error("developmentOrigins has too many entries");
  }

  const port = value.port ?? DEFAULT_PORT;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535
  ) {
    throw new Error("port must be an integer from 1 to 65535");
  }

  const machine = readString(value.machine, "machine", MAX_MACHINE_LENGTH);
  const answerActor =
    value.answerActor === undefined
      ? undefined
      : readString(value.answerActor, "answerActor", MAX_ANSWER_ACTOR_LENGTH);
  const opencodeConfigPath =
    value.opencodeConfigPath === undefined
      ? undefined
      : parseRepositoryPath(value.opencodeConfigPath, "opencodeConfigPath");
  const repositoryValues = value.repositories ?? [];
  const codeRootValues = value.codeRoots ?? [];
  const repositories = (repositoryValues as unknown[]).map(parseRepository);
  const codeRoots = (codeRootValues as unknown[]).map((codeRoot, index) =>
    parseRepositoryPath(codeRoot, `codeRoots[${index}]`),
  );
  const peers = value.peers.map(parsePeer);
  const developmentOrigins = (developmentValues as unknown[]).map(
    (origin, index) =>
      parseOrigin(origin, `developmentOrigins[${index}]`, true),
  );
  requireUnique(
    repositories.map(({ name }) => name),
    "repository names must be unique",
  );
  requireUnique(
    repositories.map(({ path }) => path),
    "repository roots must be unique",
  );
  requireUnique(codeRoots, "code roots must be unique");
  requireUnique(
    [machine, ...peers.map(({ name }) => name)],
    "machine and peer names must be unique",
  );
  requireUnique(
    peers.map(({ origin }) => origin),
    "peer origins must be unique",
  );
  requireUnique(developmentOrigins, "development origins must be unique");
  requireUnique(
    [...peers.map(({ origin }) => origin), ...developmentOrigins],
    "configured origins must be unique",
  );

  return {
    machine,
    repositories,
    ...(value.codeRoots === undefined ? {} : { codeRoots }),
    peers,
    port: port as number,
    bind: parseBind(value.bind),
    developmentOrigins,
    ...(answerActor === undefined ? {} : { answerActor }),
    ...(opencodeConfigPath === undefined ? {} : { opencodeConfigPath }),
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const file = Bun.file(path);
  let bytes: ArrayBuffer;
  try {
    if (!(await file.exists())) throw new Error("missing");
    bytes = await file.slice(0, MAX_CONFIG_BYTES + 1).arrayBuffer();
  } catch {
    throw new Error("config file does not exist or could not be read");
  }
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new Error("config file is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("config file is not valid JSON");
  }
  const config = parseConfig(value);
  const answerIntake =
    config.answerActor === undefined
      ? undefined
      : (() => {
          const secret = process.env.FACTORY_ANSWER_SECRET;
          if (secret === undefined || secret.length === 0) {
            throw new Error(
              "FACTORY_ANSWER_SECRET must be non-empty when answerActor is configured",
            );
          }
          return { actor: config.answerActor, secret };
        })();
  const repositories = await Promise.all(
    config.repositories.map(async (repository) => {
      try {
        const canonicalPath = await realpath(repository.path);
        if (!(await stat(canonicalPath)).isDirectory())
          throw new Error("not-directory");
        return { ...repository, path: canonicalPath };
      } catch {
        throw new Error("a repository root is unavailable or invalid");
      }
    }),
  );
  requireUnique(
    repositories.map(({ path: repositoryPath }) => repositoryPath),
    "canonical repository roots must be unique",
  );
  const codeRoots = await Promise.all(
    (config.codeRoots ?? []).map(async (codeRoot) => {
      try {
        const canonicalPath = await realpath(codeRoot);
        if (!(await stat(canonicalPath)).isDirectory()) {
          throw new Error("not-directory");
        }
        return canonicalPath;
      } catch {
        throw new Error("a code root is unavailable or invalid");
      }
    }),
  );
  requireUnique(codeRoots, "canonical code roots must be unique");
  return {
    ...config,
    repositories,
    ...(config.codeRoots === undefined ? {} : { codeRoots }),
    ...(answerIntake === undefined ? {} : { answerIntake }),
  };
}
