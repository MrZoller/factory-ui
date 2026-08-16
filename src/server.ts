import type {
  AppConfig,
  AppConfigSource,
  FactoryFleetData,
  FleetSnapshot,
  RepositoryFactorySnapshot,
  RepositorySource,
} from "./contracts";
import { API_SCHEMA_VERSION } from "./contracts";
import {
  createFactoryFleetData,
  readRepositoryFactorySnapshot,
  unavailableRepositoryFactorySnapshot,
} from "./snapshot";

const PUBLIC_ROOT = new URL("./public/", import.meta.url);

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

type FleetData = FactoryFleetData | FleetSnapshot;

export interface HandlerDependencies {
  snapshot?: (config: AppConfigSource) => Promise<FleetData>;
  repositorySnapshot?: (
    repository: RepositorySource,
  ) => Promise<RepositoryFactorySnapshot>;
  now?: () => Date;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function methodNotAllowed(): Response {
  const response = textResponse(405, "Method Not Allowed");
  response.headers.set("allow", "GET");
  return response;
}

function repositorySelector(
  pathname: string,
  repositories: RepositorySource[],
): RepositorySource | null {
  const prefix = "/api/repo/";
  if (!pathname.startsWith(prefix)) return null;
  const rawName = pathname.slice(prefix.length);
  if (rawName.length === 0 || rawName.includes("/") || rawName.includes("\\"))
    return null;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (name.includes("/") || name.includes("\\")) return null;
  return repositories.find((repository) => repository.name === name) ?? null;
}

export function createRequestHandler(
  config: AppConfigSource,
  dependencies: HandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const readRepository =
    dependencies.repositorySnapshot ?? readRepositoryFactorySnapshot;
  const snapshot =
    dependencies.snapshot ??
    ((source: AppConfigSource) =>
      createFactoryFleetData(source, readRepository));
  const now = dependencies.now ?? (() => new Date());
  const bind = config.bind ?? "127.0.0.1";
  const dashboardHost = bind.includes(":") ? `[${bind}]` : bind;
  const dashboardOrigin = new URL(`http://${dashboardHost}:${config.port}`)
    .origin;
  const allowedOrigins = new Set([
    dashboardOrigin,
    ...config.peers.map(({ origin }) => origin),
    ...(config.developmentOrigins ?? []),
  ]);
  const connectSources = [
    "'self'",
    dashboardOrigin,
    ...config.peers.map(({ origin }) => origin),
    ...(config.developmentOrigins ?? []),
  ];
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${[...new Set(connectSources)].join(" ")}`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const isApi = pathname === "/api/fleet" || pathname.startsWith("/api/");
    let response: Response;

    try {
      if (pathname === "/api/fleet") {
        if (request.method !== "GET") {
          response = methodNotAllowed();
        } else {
          response = Response.json({
            schemaVersion: API_SCHEMA_VERSION,
            generatedAt: now().toISOString(),
            ...(await snapshot(config)),
          });
        }
      } else if (pathname.startsWith("/api/repo/")) {
        const repository = repositorySelector(pathname, config.repositories);
        if (repository === null) {
          response = textResponse(404, "Not Found");
        } else if (request.method !== "GET") {
          response = methodNotAllowed();
        } else {
          let data: RepositoryFactorySnapshot;
          try {
            data = await readRepository(repository);
          } catch {
            data = unavailableRepositoryFactorySnapshot(repository.name);
          }
          response = Response.json({
            schemaVersion: API_SCHEMA_VERSION,
            generatedAt: now().toISOString(),
            hostname: config.machine,
            ...data,
          });
        }
      } else {
        const asset = STATIC_FILES.get(pathname);
        if (asset === undefined) {
          response = textResponse(404, "Not Found");
        } else if (request.method !== "GET") {
          response = methodNotAllowed();
        } else {
          const file = Bun.file(new URL(asset.file, PUBLIC_ROOT));
          response = (await file.exists())
            ? new Response(file, { headers: { "content-type": asset.type } })
            : textResponse(500, "Dashboard asset unavailable");
        }
      }
    } catch {
      response = textResponse(500, "Internal Server Error");
    }

    response.headers.set("vary", "Origin");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("content-security-policy", csp);
    if (isApi) response.headers.set("cache-control", "no-store");
    const origin = request.headers.get("origin");
    if (origin !== null && allowedOrigins.has(origin)) {
      response.headers.set("access-control-allow-origin", origin);
    }
    return response;
  };
}

export function startServer(config: AppConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: config.bind ?? "127.0.0.1",
    port: config.port,
    fetch: createRequestHandler(config),
  });
}
