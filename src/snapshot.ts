import {
  type AppConfigSource,
  type FleetSnapshot,
  type RepositorySource,
  type RepositorySnapshot,
} from "./contracts";
import { checkRepositoryLiveness } from "./liveness";
import { readFactoryState } from "./readers/state";

export { MAX_PROJECT_LENGTH, MAX_STATE_BYTES } from "./readers/state";

export async function readRepositorySnapshot(
  repository: RepositorySource,
  readLiveness: typeof checkRepositoryLiveness = checkRepositoryLiveness,
): Promise<RepositorySnapshot> {
  const livenessPromise = readLiveness(repository.path);
  const unavailable = (warning: string): RepositorySnapshot => ({
    name: repository.name,
    liveness: awaitLiveness,
    status: "unavailable",
    warning,
  });

  const awaitLiveness = await livenessPromise;

  try {
    const result = await readFactoryState(repository.path);
    if (
      result.status === "unavailable" ||
      result.data.project === undefined ||
      result.data.phase === undefined
    ) {
      const code = result.warnings[0]?.code;
      if (code === "STATE_MISSING") return unavailable("state.json is missing");
      if (code === "STATE_TOO_LARGE")
        return unavailable("state.json is too large");
      if (code === "STATE_INVALID_ROOT")
        return unavailable("state.json has invalid project or phase data");
      if (result.status !== "unavailable")
        return unavailable("state.json has invalid project or phase data");
      return unavailable("state.json could not be read");
    }

    return {
      name: repository.name,
      liveness: awaitLiveness,
      status: "available",
      project: result.data.project,
      phase: result.data.phase,
    };
  } catch {
    return unavailable("state.json could not be read");
  }
}

export async function createFleetSnapshot(
  config: AppConfigSource,
  readLiveness: typeof checkRepositoryLiveness = checkRepositoryLiveness,
): Promise<FleetSnapshot> {
  return {
    hostname: config.machine,
    repositories: await Promise.all(
      config.repositories.map((repository) =>
        readRepositorySnapshot(repository, readLiveness),
      ),
    ),
    peers: config.peers,
  };
}
