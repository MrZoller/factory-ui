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
  excerpt?: string;
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
  pr?: number;
  issueNumbers?: number[];
  prUrl?: string;
  issueUrls?: string[];
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

export interface RoutingModelPrices {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface RoutingModel {
  source: "models.dev" | null;
  pricesAsOf: string;
  name: string;
  family: string;
  releaseDate: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricePerMillion: RoutingModelPrices;
}

export interface RoutingData {
  schemaVersion: 1;
  recordedAt: string;
  model: string;
  smallModel: string;
  agents: Record<string, RoutingAgent>;
  models?: Record<string, RoutingModel>;
}

export interface CostTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostCounters {
  usd: number;
  messages: number;
  sessions: number;
  tokens: CostTokens;
}

export interface CostTask extends CostCounters {
  byModel: Record<string, CostCounters>;
  firstAt: string;
  lastAt: string;
}

export interface CostsData {
  schemaVersion: 1;
  recordedAt: string;
  currency: string;
  tasks: Record<string, CostTask>;
}

export interface MetricFindings {
  blocking: number;
  minor: number;
}

export interface InternalMetricFindings extends MetricFindings {
  invalid: number;
}

export interface ExternalMetricFindings extends MetricFindings {
  refuted: number;
}

export interface ShipMetric {
  schemaVersion: 1;
  task: string;
  event: "ship";
  size: TaskSize;
  reclassifiedFrom: TaskSize | null;
  internal: {
    rounds: number;
    findings: InternalMetricFindings;
    fixed: number;
  } | null;
}

export interface ExternalReviewMetric {
  rounds: number;
  findings: ExternalMetricFindings;
  fixPushes: number;
}

export interface MergeMetric {
  schemaVersion: 1;
  task: string;
  event: "merge";
  pr: number;
  external: Record<string, ExternalReviewMetric>;
  ci: { runs: number; reruns: number };
}

export interface PullRequestMetric {
  schemaVersion: 1;
  task: string;
  event: "pr";
  by: "factory-git";
  openedAt: string;
  mergedAt: string;
  commits: number;
  commitsAfterOpen: number;
  reviews: Record<string, number>;
  issueComments: Record<string, number>;
  reactions: Record<string, Record<string, number>>;
  threads: Record<string, { total: number; resolved: number }>;
  checkRuns: { total: number; failed: number };
}

export interface TaskMetrics {
  ship?: ShipMetric;
  merge?: MergeMetric;
  pr?: PullRequestMetric;
}

export interface MetricsData {
  tasks: Record<string, TaskMetrics>;
}

export interface RepositoryFactoryData {
  name: string;
  state: ReaderResult<FactoryStateData>;
  plan: ReaderResult<PlanData>;
  questions: ReaderResult<QuestionsData>;
  worklog: ReaderResult<WorklogData>;
  logs: ReaderResult<LogsData>;
  routing: ReaderResult<RoutingData>;
  costs: ReaderResult<CostsData>;
  metrics: ReaderResult<MetricsData>;
  liveness: LivenessSnapshot;
}

export const API_SCHEMA_VERSION = 1 as const;

export interface RepositoryFactorySnapshot extends RepositoryFactoryData {
  status: "available" | "unavailable";
  project?: string;
  phase?: FactoryPhase;
  prUrl?: string;
  repositoryUrl?: string;
  branchUrl?: string;
  specUrl?: string;
  planUrl?: string;
  worklogUrl?: string;
  questionsUrl?: string;
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
