import {
  type PlanData,
  type PlanTask,
  type ReaderResult,
  type ReaderWarning,
  type TaskSize,
  type TaskStatus,
} from "../contracts";
import { readFactoryFile } from "./file";
import { readerWarning } from "./warnings";

export const MAX_PLAN_BYTES = 256 * 1024;
export const MAX_PLAN_LINES = 4096;
export const MAX_PLAN_LINE_LENGTH = 8192;
export const MAX_PLAN_TASKS = 256;
export const MAX_TASK_DEPENDENCIES = 32;
export const MAX_TASK_ISSUES = 32;
export const MAX_PLAN_WARNINGS = 32;

export const PLAN_WARNING_CODES = [
  "WARNINGS_TRUNCATED",
  "PLAN_TOO_MANY_LINES",
  "PLAN_LINE_TOO_LONG",
  "PLAN_MALFORMED_TASK",
  "PLAN_TOO_MANY_TASKS",
  "PLAN_MALFORMED_PR",
  "PLAN_MALFORMED_ISSUE",
  "PLAN_TOO_MANY_ISSUES",
  "PLAN_MALFORMED_DEPS",
  "PLAN_DUPLICATE_DEP",
  "PLAN_TOO_MANY_DEPS",
  "PLAN_MISSING_DEPS",
  "PLAN_DUPLICATE_TASK",
  "PLAN_SELF_DEP",
  "PLAN_UNKNOWN_DEP",
  "PLAN_AMBIGUOUS_DEP",
  "PLAN_INVALID_UTF8",
  "PLAN_MISSING",
  "PLAN_TOO_LARGE",
  "PLAN_UNAVAILABLE",
] as const;

const TASK_LINE =
  /^- \[([ ~Rx!])\] (T[1-9][0-9]*) \((trivial|standard|major)\) — (.+)$/;
const DEPENDENCIES_LINE = /^  - deps:\s*(.*)$/;
const LOCAL_DEPENDENCY = /^T[1-9][0-9]*$/;
// Match factory-status schema v1 exactly. Existence and remote state are
// deliberately not queried; qualified references are offline metadata.
const CROSS_REPO_DEPENDENCY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}#)[A-Za-z0-9._-]+#[1-9][0-9]*$/;
const PR_LINE = /^  - pr:(?: (.*))?$/;
const ACCEPTANCE_LINE = /^  - acceptance: (.*)$/;
const STATUS: Record<string, TaskStatus> = {
  " ": "todo",
  "~": "active",
  R: "review",
  x: "completed",
  "!": "blocked",
};

interface ParsedTask extends Omit<PlanTask, "runnable"> {
  line: number;
  prMetadataPresent: boolean;
  acceptanceMetadataPresent: boolean;
}

function emptyPlan(tasks: PlanTask[]): PlanData {
  return {
    tasks,
    active: tasks.filter((task) => task.status === "active"),
    review: tasks.filter((task) => task.status === "review"),
    nextRunnable: tasks.filter((task) => task.runnable),
    completed: tasks.filter((task) => task.status === "completed"),
    blocked: tasks.filter((task) => task.status === "blocked"),
    remaining: tasks.filter((task) => task.status === "todo" && !task.runnable),
  };
}

function addWarning(warnings: ReaderWarning[], warning: ReaderWarning): void {
  if (warnings.length < MAX_PLAN_WARNINGS - 1) warnings.push(warning);
  else if (!warnings.some((item) => item.code === "WARNINGS_TRUNCATED")) {
    warnings.push({
      code: "WARNINGS_TRUNCATED",
      message: "additional plan warnings were omitted",
    });
  }
}

function planWarning(
  code: string,
  message: string,
  line?: number,
  sourceLine?: string,
): ReaderWarning {
  return readerWarning(code, message, line, sourceLine);
}

export function parseFactoryPlan(text: string): ReaderResult<PlanData> {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length > MAX_PLAN_LINES) {
    return {
      status: "unavailable",
      warnings: [
        { code: "PLAN_TOO_MANY_LINES", message: "plan.md has too many lines" },
      ],
    };
  }
  const overlongLine = lines.findIndex(
    (line) => line.length > MAX_PLAN_LINE_LENGTH,
  );
  if (overlongLine !== -1) {
    return {
      status: "unavailable",
      warnings: [
        planWarning(
          "PLAN_LINE_TOO_LONG",
          "plan.md contains an oversized line",
          overlongLine + 1,
          lines[overlongLine],
        ),
      ],
    };
  }

  const warnings: ReaderWarning[] = [];
  const parsed: ParsedTask[] = [];
  const fencedLines = new Set<number>();
  let fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null && match?.[1]) {
      fence = { marker: match[1][0] ?? "", length: match[1].length };
      fencedLines.add(index);
    } else if (fence !== null) {
      fencedLines.add(index);
      const closing = new RegExp(
        `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
      );
      if (closing.test(line)) fence = null;
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (fencedLines.has(index)) continue;
    const line = lines[index] ?? "";
    const match = TASK_LINE.exec(line);
    if (!match) {
      if (line.startsWith("- [")) {
        addWarning(
          warnings,
          planWarning(
            "PLAN_MALFORMED_TASK",
            "a top-level task line is malformed",
            index + 1,
            line,
          ),
        );
      }
      continue;
    }
    if (parsed.length >= MAX_PLAN_TASKS) {
      return {
        status: "unavailable",
        warnings: [
          {
            code: "PLAN_TOO_MANY_TASKS",
            message: "plan.md has too many tasks",
          },
        ],
      };
    }

    const marker = match[1];
    const id = match[2];
    const size = match[3];
    const title = match[4];
    const status = marker === undefined ? undefined : STATUS[marker];
    if (
      id === undefined ||
      size === undefined ||
      title === undefined ||
      !status
    )
      continue;

    // The protocol makes deps optional; omission means no prerequisites.
    // Null remains reserved for a present declaration that failed validation.
    let dependencies: string[] | null = [];
    let localDependencies: string[] | null = [];
    let crossRepoDependencies: string[] | null = [];
    let dependencyLines = 0;
    let pr: number | undefined;
    let prLines = 0;
    let acceptanceLines = 0;
    const issueNumbers: number[] = [];
    const seenIssues = new Set<number>();
    for (let child = index + 1; child < lines.length; child += 1) {
      if (fencedLines.has(child)) continue;
      const childLine = lines[child] ?? "";
      if (TASK_LINE.test(childLine) || childLine.startsWith("- [")) break;
      const prMatch = PR_LINE.exec(childLine);
      if (prMatch) {
        prLines += 1;
        const value = prMatch[1] ?? "";
        const parsedPr =
          value && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
        if (prLines > 1 || !Number.isSafeInteger(parsedPr)) {
          pr = undefined;
          addWarning(
            warnings,
            planWarning(
              "PLAN_MALFORMED_PR",
              "task PR metadata is malformed or duplicated",
              child + 1,
              childLine,
            ),
          );
        } else {
          pr = parsedPr;
        }
      }
      const acceptanceMatch = ACCEPTANCE_LINE.exec(childLine);
      if (acceptanceMatch) {
        acceptanceLines += 1;
        for (const match of acceptanceMatch[1]?.matchAll(
          /Fixes #([^\s,.;):!?]+)/g,
        ) ?? []) {
          const value = match[1] ?? "";
          const issue = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
          if (!Number.isSafeInteger(issue)) {
            addWarning(
              warnings,
              planWarning(
                "PLAN_MALFORMED_ISSUE",
                "task issue metadata is malformed",
                child + 1,
                childLine,
              ),
            );
          } else if (!seenIssues.has(issue)) {
            seenIssues.add(issue);
            if (issueNumbers.length < MAX_TASK_ISSUES) issueNumbers.push(issue);
            else
              addWarning(
                warnings,
                planWarning(
                  "PLAN_TOO_MANY_ISSUES",
                  "task has too many issue references",
                  child + 1,
                  childLine,
                ),
              );
          }
        }
      }
      if (!childLine.startsWith("  - deps:")) continue;
      dependencyLines += 1;
      const dependencyMatch = DEPENDENCIES_LINE.exec(childLine);
      if (!dependencyMatch || dependencyLines > 1) {
        dependencies = null;
        localDependencies = null;
        crossRepoDependencies = null;
        addWarning(
          warnings,
          planWarning(
            "PLAN_MALFORMED_DEPS",
            "task dependencies are malformed or duplicated",
            child + 1,
            childLine,
          ),
        );
        continue;
      }
      const value = dependencyMatch[1]?.trim() ?? "";
      const tokens =
        value === "none" ? [] : value.split(",").map((item) => item.trim());
      dependencies = tokens;
      localDependencies = [];
      crossRepoDependencies = [];
      if (
        value.length === 0 ||
        (value !== "none" &&
          (tokens.includes("") || tokens.includes("none"))) ||
        tokens.some(
          (dependency) =>
            !LOCAL_DEPENDENCY.test(dependency) &&
            !CROSS_REPO_DEPENDENCY.test(dependency),
        )
      ) {
        dependencies = null;
        localDependencies = null;
        crossRepoDependencies = null;
        addWarning(
          warnings,
          planWarning(
            "PLAN_MALFORMED_DEPS",
            "task dependencies are malformed or duplicated",
            child + 1,
            childLine,
          ),
        );
        continue;
      }
      for (const dependency of tokens) {
        if (LOCAL_DEPENDENCY.test(dependency))
          localDependencies.push(dependency);
        else crossRepoDependencies.push(dependency);
      }
      if (
        dependencies !== null &&
        new Set(dependencies).size !== dependencies.length
      ) {
        dependencies = null;
        localDependencies = null;
        crossRepoDependencies = null;
        addWarning(
          warnings,
          planWarning(
            "PLAN_DUPLICATE_DEP",
            "task repeats a dependency",
            child + 1,
            childLine,
          ),
        );
      }
      if (
        dependencies !== null &&
        dependencies.length > MAX_TASK_DEPENDENCIES
      ) {
        dependencies = null;
        localDependencies = null;
        crossRepoDependencies = null;
        addWarning(
          warnings,
          planWarning(
            "PLAN_TOO_MANY_DEPS",
            "task has too many dependencies",
            child + 1,
            childLine,
          ),
        );
      }
    }
    parsed.push({
      id,
      status,
      size: size as TaskSize,
      title,
      dependencies,
      localDependencies,
      crossRepoDependencies,
      pr,
      issueNumbers,
      prMetadataPresent: prLines > 0,
      acceptanceMetadataPresent: acceptanceLines > 0,
      line: index + 1,
    });
  }

  const byId = new Map<string, ParsedTask[]>();
  for (const task of parsed) {
    const matches = byId.get(task.id) ?? [];
    matches.push(task);
    byId.set(task.id, matches);
  }
  for (const matches of byId.values()) {
    if (matches.length > 1) {
      for (const task of matches) {
        addWarning(
          warnings,
          planWarning(
            "PLAN_DUPLICATE_TASK",
            "plan.md contains a duplicate task identifier",
            task.line,
            lines[task.line - 1],
          ),
        );
      }
    }
  }

  const tasks = parsed.map<PlanTask>((task) => {
    let dependenciesValid =
      task.dependencies !== null && byId.get(task.id)?.length === 1;
    for (const dependency of task.localDependencies ?? []) {
      const matches = byId.get(dependency);
      let code: string | null = null;
      if (dependency === task.id) code = "PLAN_SELF_DEP";
      else if (!matches) code = "PLAN_UNKNOWN_DEP";
      else if (matches.length !== 1) code = "PLAN_AMBIGUOUS_DEP";
      if (code !== null) {
        dependenciesValid = false;
        addWarning(
          warnings,
          planWarning(
            code,
            "task dependency cannot be resolved",
            task.line,
            lines[task.line - 1],
          ),
        );
      }
    }
    const runnable =
      task.status === "todo" &&
      dependenciesValid &&
      (task.localDependencies ?? []).every((dependency) => {
        const matches = byId.get(dependency);
        return matches?.length === 1 && matches[0]?.status === "completed";
      });
    return {
      id: task.id,
      status: task.status,
      size: task.size,
      title: task.title,
      dependencies: task.dependencies,
      localDependencies: task.localDependencies,
      crossRepoDependencies: task.crossRepoDependencies,
      runnable,
      ...(task.prMetadataPresent ? { pr: task.pr } : {}),
      ...(task.acceptanceMetadataPresent
        ? { issueNumbers: task.issueNumbers }
        : {}),
    };
  });

  const data = emptyPlan(tasks);
  return warnings.length === 0
    ? { status: "available", data, warnings: [] }
    : { status: "partial", data, warnings };
}

export async function readFactoryPlan(
  repositoryPath: string,
): Promise<ReaderResult<PlanData>> {
  const result = await readFactoryFile(repositoryPath, "plan", MAX_PLAN_BYTES);
  if (result.status === "available") {
    try {
      return parseFactoryPlan(
        new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
      );
    } catch {
      return {
        status: "unavailable",
        warnings: [
          { code: "PLAN_INVALID_UTF8", message: "plan.md is not valid UTF-8" },
        ],
      };
    }
  }
  const code =
    result.status === "missing"
      ? "PLAN_MISSING"
      : result.status === "too-large"
        ? "PLAN_TOO_LARGE"
        : "PLAN_UNAVAILABLE";
  const message =
    result.status === "missing"
      ? "plan.md is missing"
      : result.status === "too-large"
        ? "plan.md is too large"
        : "plan.md could not be read safely";
  return { status: "unavailable", warnings: [{ code, message }] };
}
