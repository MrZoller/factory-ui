export function renderFleet(
  fleet: unknown,
  documentRoot?: Document,
  now?: Date,
): void;

export function loadFleet(
  documentRoot?: Document,
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  dependencies?: {
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
    now?: () => Date;
  },
): Promise<boolean>;
export function startDashboard(
  documentRoot?: Document,
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  dependencies?: {
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
    now?: () => Date;
    randomUUID?: () => string;
  },
): { cleanup(): void };
export const ANSWER_POLL_INTERVAL_MS: 5000;
export const PEER_FETCH_TIMEOUT_MS: 5000;
export const MAX_CONCURRENT_PEER_FETCHES: 4;
export const WARNING_EXPLANATIONS: Readonly<Record<string, string>>;
export const UNKNOWN_WARNING_EXPLANATION: string;
export function providerCategory(
  provider: unknown,
): "openai" | "opencode" | "amazon-bedrock" | "other";
export function readFleetResponse(response: Response): Promise<unknown>;
export function fetchPeerFleet(
  peer: { origin: string },
  fetcher: typeof fetch,
  dependencies: {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  },
): Promise<unknown>;
