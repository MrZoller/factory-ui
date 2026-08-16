export function renderFleet(
  fleet: unknown,
  documentRoot?: Document,
  now?: Date,
): void;

export function loadFleet(
  documentRoot?: Document,
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<void>;
