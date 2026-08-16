import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

import {
  FACTORY_PHASES,
  type AppConfigSource,
  type FactoryPhase,
  type FleetSnapshot,
  type RepositorySource,
  type RepositorySnapshot,
} from "./contracts";
import { resolveFactoryPath } from "./paths";

export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_PROJECT_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is FactoryPhase {
  return (
    typeof value === "string" && FACTORY_PHASES.includes(value as FactoryPhase)
  );
}

async function readValidatedStateFile(
  repositoryPath: string,
  validatedPath: string,
): Promise<ArrayBuffer> {
  const handle = await open(
    validatedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    // A pathname can be replaced after resolveFactoryPath validates it. Re-run
    // that validation after opening, then require the descriptor to be the
    // same file before reading from the descriptor rather than the pathname.
    const currentPath = await resolveFactoryPath(repositoryPath, "state");
    if (currentPath === null) throw new Error("state.json is missing");

    const [opened, current] = await Promise.all([
      handle.stat(),
      stat(currentPath),
    ]);
    if (
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error("state.json changed while being opened");
    }

    return await Bun.file(handle.fd)
      .slice(0, MAX_STATE_BYTES + 1)
      .arrayBuffer();
  } finally {
    await handle.close();
  }
}

export async function readRepositorySnapshot(
  repository: RepositorySource,
): Promise<RepositorySnapshot> {
  const unavailable = (warning: string): RepositorySnapshot => ({
    name: repository.name,
    status: "unavailable",
    warning,
  });

  try {
    const path = await resolveFactoryPath(repository.path, "state");
    if (path === null) {
      return unavailable("state.json is missing");
    }
    const bytes = await readValidatedStateFile(repository.path, path);
    if (bytes.byteLength > MAX_STATE_BYTES) {
      return unavailable("state.json is too large");
    }

    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isRecord(value) ||
      typeof value.project !== "string" ||
      value.project.length === 0 ||
      value.project.length > MAX_PROJECT_LENGTH ||
      !isPhase(value.phase)
    ) {
      return unavailable("state.json has invalid project or phase data");
    }

    return {
      name: repository.name,
      status: "available",
      project: value.project,
      phase: value.phase,
    };
  } catch {
    return unavailable("state.json could not be read");
  }
}

export async function createFleetSnapshot(
  config: AppConfigSource,
): Promise<FleetSnapshot> {
  return {
    hostname: config.machine,
    repositories: await Promise.all(
      config.repositories.map(readRepositorySnapshot),
    ),
    peers: config.peers,
  };
}
