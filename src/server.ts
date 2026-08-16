import type { AppConfig, AppConfigSource, FleetSnapshot } from "./contracts";
import { createFleetSnapshot } from "./snapshot";

const PUBLIC_ROOT = new URL("./public/", import.meta.url);

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

export interface HandlerDependencies {
  snapshot?: (config: AppConfigSource) => Promise<FleetSnapshot>;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function createRequestHandler(
  config: AppConfigSource,
  dependencies: HandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const snapshot = dependencies.snapshot ?? createFleetSnapshot;
  const bind = config.bind ?? "127.0.0.1";
  const dashboardHost = bind.includes(":") ? `[${bind}]` : bind;
  const allowedOrigins = new Set([
    new URL(`http://${dashboardHost}:${config.port}`).origin,
    ...config.peers.map(({ origin }) => origin),
    ...(config.developmentOrigins ?? []),
  ]);

  return async (request: Request): Promise<Response> => {
    let response: Response;
    if (request.method !== "GET") {
      response = new Response("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "GET",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    } else {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/fleet") {
        response = Response.json(await snapshot(config));
      } else {
        const asset = STATIC_FILES.get(pathname);
        if (asset) {
          const file = Bun.file(new URL(asset.file, PUBLIC_ROOT));
          response = (await file.exists())
            ? new Response(file, { headers: { "content-type": asset.type } })
            : textResponse(500, "Dashboard asset unavailable");
        } else {
          response = textResponse(404, "Not Found");
        }
      }
    }
    response.headers.set("vary", "Origin");
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
