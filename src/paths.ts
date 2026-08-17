import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type FactoryPathKey =
  | "state"
  | "spec"
  | "plan"
  | "questions"
  | "worklog"
  | "logs"
  | "routing"
  | "costs"
  | "metrics";

const TARGETS: Record<FactoryPathKey, { path: string; directory: boolean }> = {
  state: { path: "state.json", directory: false },
  spec: { path: "spec.md", directory: false },
  plan: { path: "plan.md", directory: false },
  questions: { path: "questions.md", directory: false },
  worklog: { path: "worklog.md", directory: false },
  logs: { path: "logs", directory: true },
  routing: { path: "logs/routing.json", directory: false },
  costs: { path: "logs/costs.json", directory: false },
  metrics: { path: "metrics.jsonl", directory: false },
};

function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function realpathOptional(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("dangling-link");
    } catch (linkError) {
      if (isMissing(linkError)) return null;
      throw linkError;
    }
    throw new Error("invalid-path");
  }
}

export async function resolveFactoryPath(
  repositoryRoot: string,
  key: FactoryPathKey,
): Promise<string | null> {
  try {
    const root = await realpath(repositoryRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("invalid-root");

    const factory = await realpathOptional(join(root, ".factory"));
    if (factory === null) return null;
    if (!contains(root, factory) || !(await stat(factory)).isDirectory()) {
      throw new Error("invalid-factory-directory");
    }

    const expected = TARGETS[key];
    const candidate = join(factory, expected.path);
    const target = await realpathOptional(candidate);
    if (target === null) return null;
    const targetStat = await stat(target);
    if (
      !contains(factory, target) ||
      (expected.directory ? !targetStat.isDirectory() : !targetStat.isFile())
    ) {
      throw new Error("invalid-target");
    }
    return target;
  } catch {
    throw new Error("factory path could not be resolved safely");
  }
}
