import {
  type AppConfigSource,
  type FleetSnapshot,
  type RepositorySource,
  type RepositoryFactoryData,
  type FactoryFleetData,
  type ReaderResult,
  type RepositoryFactorySnapshot,
  type RepositorySnapshot,
} from "./contracts";
import {
  checkRepositoryLiveness,
  checkTrustedDriverLiveness,
} from "./liveness";
import { readFactoryLogsWithSelection } from "./readers/logs";
import { readFactoryPlan } from "./readers/plan";
import { readFactoryQuestions } from "./readers/questions";
import { readFactoryState } from "./readers/state";
import { readFactoryWorklog } from "./readers/worklog";

export { MAX_PROJECT_LENGTH, MAX_STATE_BYTES } from "./readers/state";

export async function readRepositoryFactoryData(
  repository: RepositorySource,
  readLiveness: typeof checkTrustedDriverLiveness = checkTrustedDriverLiveness,
): Promise<RepositoryFactoryData> {
  const [state, plan, questions, worklog, logsRead] = await Promise.all([
    readFactoryState(repository.path),
    readFactoryPlan(repository.path),
    readFactoryQuestions(repository.path),
    readFactoryWorklog(repository.path),
    readFactoryLogsWithSelection(repository.path),
  ]);
  const liveness = await readLiveness(logsRead.driver);
  return {
    name: repository.name,
    state,
    plan,
    questions,
    worklog,
    logs: logsRead.result,
    liveness,
  };
}

function unavailableResult(code: string, message: string): ReaderResult<never> {
  return { status: "unavailable", warnings: [{ code, message }] };
}

export function unavailableRepositoryFactorySnapshot(
  name: string,
  checkedAt = new Date().toISOString(),
): RepositoryFactorySnapshot {
  return {
    name,
    status: "unavailable",
    warning: "repository data could not be read",
    state: unavailableResult("STATE_UNAVAILABLE", "state could not be read"),
    plan: unavailableResult("PLAN_UNAVAILABLE", "plan could not be read"),
    questions: unavailableResult(
      "QUESTIONS_UNAVAILABLE",
      "questions could not be read",
    ),
    worklog: unavailableResult(
      "WORKLOG_UNAVAILABLE",
      "worklog could not be read",
    ),
    logs: unavailableResult("LOGS_UNAVAILABLE", "logs could not be read"),
    liveness: { state: "CANNOT_VERIFY", checkedAt },
  };
}

export async function readRepositoryFactorySnapshot(
  repository: RepositorySource,
): Promise<RepositoryFactorySnapshot> {
  const data = await readRepositoryFactoryData(repository);
  const state =
    data.state.status === "unavailable" ? undefined : data.state.data;
  const available = state?.project !== undefined && state.phase !== undefined;
  const prUrl = createPullRequestUrl(repository.githubUrl, state?.pr);
  return {
    ...data,
    status: available ? "available" : "unavailable",
    ...(available
      ? { project: state.project, phase: state.phase }
      : { warning: "repository state is unavailable" }),
    ...(prUrl === undefined ? {} : { prUrl }),
  };
}

function createPullRequestUrl(
  githubUrl: string | undefined,
  pr: number | null | undefined,
): string | undefined {
  if (
    githubUrl === undefined ||
    !Number.isSafeInteger(pr) ||
    pr === undefined ||
    pr === null ||
    pr < 1 ||
    !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/.test(
      githubUrl,
    )
  ) {
    return undefined;
  }
  return `${githubUrl}/pull/${pr}`;
}

export async function createFactoryFleetData(
  config: AppConfigSource,
  readRepository: (
    repository: RepositorySource,
  ) => Promise<RepositoryFactorySnapshot> = readRepositoryFactorySnapshot,
): Promise<FactoryFleetData> {
  return {
    hostname: config.machine,
    repositories: await Promise.all(
      config.repositories.map(async (repository) => {
        try {
          return await readRepository(repository);
        } catch {
          return unavailableRepositoryFactorySnapshot(repository.name);
        }
      }),
    ),
    peers: config.peers,
  };
}

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
