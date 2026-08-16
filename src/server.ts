import type { AppConfig, FleetSnapshot } from "./contracts";
import { createFleetSnapshot } from "./snapshot";

const PUBLIC_ROOT = new URL("./public/", import.meta.url);

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

export interface HandlerDependencies {
  snapshot?: (config: AppConfig) => Promise<FleetSnapshot>;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function createRequestHandler(
  config: AppConfig,
  dependencies: HandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const snapshot = dependencies.snapshot ?? createFleetSnapshot;

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          allow: "GET",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/api/fleet") {
      return Response.json(await snapshot(config));
    }

    const asset = STATIC_FILES.get(pathname);
    if (asset) {
      const file = Bun.file(new URL(asset.file, PUBLIC_ROOT));
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": asset.type } });
      }
      return textResponse(500, "Dashboard asset unavailable");
    }

    return textResponse(404, "Not Found");
  };
}

export function startServer(config: AppConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: createRequestHandler(config),
  });
}
