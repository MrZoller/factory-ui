export const FACTORY_PHASES = ["specify", "plan", "build", "idle"] as const;

export type FactoryPhase = (typeof FACTORY_PHASES)[number];

export interface RepositorySource {
  name: string;
  path: string;
  githubUrl?: string;
}

export interface RepositoryConfig extends RepositorySource {
  githubUrl: string;
}

export interface PeerConfig {
  name: string;
  origin: string;
}

export interface AppConfigSource {
  machine: string;
  repositories: RepositorySource[];
  peers: PeerConfig[];
  port: number;
  bind?: string;
  developmentOrigins?: string[];
}

export interface AppConfig extends AppConfigSource {
  repositories: RepositoryConfig[];
  bind: string;
  developmentOrigins: string[];
}

export const LIVENESS_STATES = ["RUNNING", "STOPPED", "CANNOT_VERIFY"] as const;

export type LivenessState = (typeof LIVENESS_STATES)[number];

export interface LivenessSnapshot {
  state: LivenessState;
  checkedAt: string;
}

export type RepositorySnapshot =
  | {
      name: string;
      liveness: LivenessSnapshot;
      status: "available";
      project: string;
      phase: FactoryPhase;
    }
  | {
      name: string;
      liveness: LivenessSnapshot;
      status: "unavailable";
      warning: string;
    };

export interface FleetSnapshot {
  hostname: string;
  repositories: RepositorySnapshot[];
  peers: PeerConfig[];
}

export const TASK_SIZES = ["trivial", "standard", "major"] as const;
export const TASK_STATUSES = [
  "todo",
  "active",
  "review",
  "completed",
  "blocked",
] as const;

export type TaskSize = (typeof TASK_SIZES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface ReaderWarning {
  code: string;
  message: string;
  line?: number;
}

export type ReaderResult<T> =
  | { status: "available"; data: T; warnings: [] }
  | { status: "partial"; data: T; warnings: ReaderWarning[] }
  | { status: "unavailable"; warnings: ReaderWarning[] };

export interface FactoryStateData {
  project?: string;
  phase?: FactoryPhase;
  specApproved?: boolean;
  planApproved?: boolean;
  currentTask?: string | null;
  branch?: string | null;
  pr?: number | null;
  hold?: boolean;
  updated?: string;
}

export interface PlanData {
  tasks: PlanTask[];
  completed: PlanTask[];
  active: PlanTask[];
  review: PlanTask[];
  blocked: PlanTask[];
  remaining: PlanTask[];
  nextRunnable: PlanTask[];
}

export interface PlanTask {
  id: string;
  status: TaskStatus;
  size: TaskSize;
  title: string;
  dependencies: string[] | null;
  runnable: boolean;
}

export interface OpenQuestion {
  id: string;
  taskId: string;
  title: string;
  text: string;
}

export interface QuestionsData {
  open: OpenQuestion[];
}

export interface WorklogEntry {
  date: string;
  time?: string;
  text: string;
}

export interface WorklogData {
  entries: WorklogEntry[];
}

export interface LogTiming {
  startedAt: string;
  lastActivityAt: string;
  durationMs?: number;
}

export interface LogSourceAges {
  driver?: string;
  cycle?: string;
  shepherd?: string;
  overall?: string;
}

export interface LogsData {
  narration: string;
  driver?: LogTiming;
  cycle?: LogTiming;
  shepherd?: LogTiming;
  asOf: LogSourceAges;
}

export interface RoutingAgent {
  provider: string;
  model: string;
  steps: number | null;
}

export interface RoutingData {
  schemaVersion: 1;
  recordedAt: string;
  model: string;
  smallModel: string;
  agents: Record<string, RoutingAgent>;
}

export interface RepositoryFactoryData {
  name: string;
  state: ReaderResult<FactoryStateData>;
  plan: ReaderResult<PlanData>;
  questions: ReaderResult<QuestionsData>;
  worklog: ReaderResult<WorklogData>;
  logs: ReaderResult<LogsData>;
  routing: ReaderResult<RoutingData>;
  liveness: LivenessSnapshot;
}

export const API_SCHEMA_VERSION = 1 as const;

export interface RepositoryFactorySnapshot extends RepositoryFactoryData {
  status: "available" | "unavailable";
  project?: string;
  phase?: FactoryPhase;
  prUrl?: string;
  warning?: string;
}

export interface FactoryFleetData {
  hostname: string;
  repositories: RepositoryFactorySnapshot[];
  peers: PeerConfig[];
}

export interface FleetApiResponse extends FactoryFleetData {
  schemaVersion: typeof API_SCHEMA_VERSION;
  generatedAt: string;
}

export interface RepositoryApiResponse extends RepositoryFactorySnapshot {
  schemaVersion: typeof API_SCHEMA_VERSION;
  generatedAt: string;
  hostname: string;
}
