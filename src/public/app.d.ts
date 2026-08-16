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
  },
): { cleanup(): void };
export const PEER_FETCH_TIMEOUT_MS: 5000;
export const MAX_CONCURRENT_PEER_FETCHES: 4;
