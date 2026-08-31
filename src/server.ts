import { createHash, timingSafeEqual } from "node:crypto";

import {
  ANSWER_UUID,
  getAnswerOutcome,
  submitAnswer,
  validateAnswerRequest,
} from "./answer-intake";
import {
  DurableAnswerIdempotencyStore,
  MAX_ANSWER_IDEMPOTENCY_RECORDS,
  type AnswerIdempotencyStore,
} from "./answer-idempotency";
import type {
  AnswerOutcome,
  AnswerRequest,
  AnswerSubmissionResult,
  AppConfig,
  AppConfigSource,
  FactoryFleetData,
  FleetSnapshot,
  RepositoryFactorySnapshot,
  RepositorySource,
  UnknownAnswerOutcome,
} from "./contracts";
import { API_SCHEMA_VERSION } from "./contracts";
import { discoverRepositories, type DiscoveryResult } from "./discovery";
import {
  createFactoryFleetData,
  readRepositoryFactorySnapshot,
  unavailableRepositoryFactorySnapshot,
} from "./snapshot";

const PUBLIC_ROOT = new URL("./public/", import.meta.url);
const MAX_ANSWER_BODY_BYTES = 16 * 1024;

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/how", { file: "how.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/how.js", { file: "how.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

type FleetData = FactoryFleetData | FleetSnapshot;

export interface HandlerDependencies {
  discovery?: (config: AppConfigSource) => Promise<DiscoveryResult>;
  snapshot?: (config: AppConfigSource) => Promise<FleetData>;
  repositorySnapshot?: (
    repository: RepositorySource,
  ) => Promise<RepositoryFactorySnapshot>;
  now?: () => Date;
  submitAnswer?: (
    input: AnswerRequest & {
      repositoryPath: string;
      actor: string;
      secret: string;
    },
  ) => Promise<AnswerSubmissionResult>;
  answerOutcome?: (input: {
    repositoryPath: string;
    id: string;
    secret: string;
  }) => Promise<AnswerOutcome | UnknownAnswerOutcome>;
  answerIdempotencyStore?: AnswerIdempotencyStore;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function methodNotAllowed(allowed = "GET"): Response {
  const response = textResponse(405, "Method Not Allowed");
  response.headers.set("allow", allowed);
  return response;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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

type AnswerRoute =
  | { repository: RepositorySource; kind: "submit" }
  | { repository: RepositorySource; kind: "outcome"; id: string };

function answerRoute(
  pathname: string,
  repositories: RepositorySource[],
): AnswerRoute | null {
  const prefix = "/api/repo/";
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/");
  if (
    (segments.length !== 2 && segments.length !== 3) ||
    segments[1] !== "answers" ||
    !segments[0]
  ) {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (name.includes("/") || name.includes("\\")) return null;
  const repository = repositories.find((entry) => entry.name === name);
  if (repository === undefined) return null;
  if (segments.length === 2) return { repository, kind: "submit" };
  const id = segments[2];
  return id === undefined ? null : { repository, kind: "outcome", id };
}

function authenticated(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(left, right);
}

async function readAnswerBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new Error("invalid-content-type");
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_ANSWER_BODY_BYTES)
  ) {
    throw new Error("invalid-size");
  }
  if (request.body === null) throw new Error("invalid-json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BODY_BYTES) {
      await reader.cancel();
      throw new Error("invalid-size");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid-json");
  }
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
  const submit = dependencies.submitAnswer ?? submitAnswer;
  const outcome = dependencies.answerOutcome ?? getAnswerOutcome;
  const idempotencyStore =
    dependencies.answerIdempotencyStore ?? new DurableAnswerIdempotencyStore();
  const discover = dependencies.discovery ?? discoverRepositories;
  const inFlightSubmissions = new Map<
    string,
    {
      fingerprint: string;
      result: Promise<
        | { status: "result"; value: AnswerSubmissionResult }
        | { status: "conflict" | "uncertain" | "unavailable" }
      >;
    }
  >();
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
    let response: Response | undefined;

    try {
      const discovery = isApi
        ? await discover(config).catch(() => ({
            repositories: [...config.repositories],
            warnings: [
              {
                code: "DISCOVERY_UNAVAILABLE",
                message: "repository discovery could not be completed",
              },
            ],
          }))
        : undefined;
      const requestConfig =
        discovery === undefined
          ? config
          : { ...config, repositories: discovery.repositories };
      if (pathname === "/api/fleet") {
        if (request.method !== "GET") {
          response = methodNotAllowed();
        } else {
          response = Response.json({
            schemaVersion: API_SCHEMA_VERSION,
            generatedAt: now().toISOString(),
            ...(await snapshot(requestConfig)),
            ...(discovery !== undefined && discovery.warnings.length > 0
              ? { warnings: discovery.warnings }
              : {}),
          });
        }
      } else if (pathname.startsWith("/api/repo/")) {
        const intakeRoute = answerRoute(pathname, requestConfig.repositories);
        const answerIntake = config.answerIntake;
        if (intakeRoute !== null && answerIntake !== undefined) {
          const allowedMethod =
            intakeRoute.kind === "submit" ? "POST, OPTIONS" : "GET, OPTIONS";
          if (request.method === "OPTIONS") {
            response = new Response(null, { status: 204 });
            response.headers.set("allow", allowedMethod);
            response.headers.set("access-control-allow-methods", allowedMethod);
            response.headers.set(
              "access-control-allow-headers",
              "Authorization, Content-Type, Idempotency-Key",
            );
          } else if (
            request.method !== (intakeRoute.kind === "submit" ? "POST" : "GET")
          ) {
            response = methodNotAllowed(allowedMethod);
          } else if (
            !authenticated(
              request.headers.get("authorization"),
              answerIntake.secret,
            )
          ) {
            response = jsonError(401, "Unauthorized");
          } else if (intakeRoute.kind === "submit") {
            const idempotencyKey = request.headers.get("idempotency-key");
            if (idempotencyKey === null || !ANSWER_UUID.test(idempotencyKey)) {
              response = jsonError(400, "Invalid request");
            } else {
              let requestValue: AnswerRequest | null = null;
              try {
                requestValue = validateAnswerRequest(
                  await readAnswerBody(request),
                );
              } catch {
                requestValue = null;
              }
              if (requestValue === null) {
                response = jsonError(400, "Invalid request");
              } else {
                const payload = JSON.stringify({
                  ...requestValue,
                });
                const fingerprint = createHash("sha256")
                  .update(payload)
                  .digest("hex");
                const memoryKey = `${intakeRoute.repository.path}\0${idempotencyKey}`;
                const prior = inFlightSubmissions.get(memoryKey);
                if (prior !== undefined && prior.fingerprint !== fingerprint) {
                  response = jsonError(409, "Idempotency key conflict");
                } else {
                  let result = prior?.result;
                  if (result === undefined) {
                    if (
                      inFlightSubmissions.size >= MAX_ANSWER_IDEMPOTENCY_RECORDS
                    ) {
                      response = jsonError(503, "Answer intake unavailable");
                    } else {
                      result = (async () => {
                        try {
                          const reservation = await idempotencyStore.reserve(
                            intakeRoute.repository.path,
                            idempotencyKey,
                            fingerprint,
                          );
                          if (reservation.status === "conflict") {
                            return { status: "conflict" as const };
                          }
                          if (reservation.status === "complete") {
                            return {
                              status: "result" as const,
                              value: {
                                status: "pending" as const,
                                id: reservation.id,
                              },
                            };
                          }
                          if (reservation.status === "reserved") {
                            return { status: "uncertain" as const };
                          }
                          if (reservation.status === "full") {
                            return { status: "unavailable" as const };
                          }

                          try {
                            const value = await submit({
                              ...requestValue,
                              repositoryPath: intakeRoute.repository.path,
                              actor: answerIntake.actor,
                              secret: answerIntake.secret,
                            });
                            await idempotencyStore.complete(
                              intakeRoute.repository.path,
                              idempotencyKey,
                              fingerprint,
                              value.id,
                            );
                            return { status: "result" as const, value };
                          } catch {
                            // The helper may have published before its failure
                            // became observable. Retain the reservation so an
                            // automatic retry can never duplicate the answer.
                            return { status: "uncertain" as const };
                          }
                        } catch {
                          return { status: "unavailable" as const };
                        }
                      })();
                      inFlightSubmissions.set(memoryKey, {
                        fingerprint,
                        result,
                      });
                      void result.finally(() => {
                        if (
                          inFlightSubmissions.get(memoryKey)?.result === result
                        ) {
                          inFlightSubmissions.delete(memoryKey);
                        }
                      });
                    }
                  }
                  if (result !== undefined) {
                    const submission = await result;
                    response =
                      submission.status === "result"
                        ? Response.json(submission.value, { status: 202 })
                        : submission.status === "conflict"
                          ? jsonError(409, "Idempotency key conflict")
                          : submission.status === "uncertain"
                            ? jsonError(
                                503,
                                "Submission status uncertain; operator verification required",
                              )
                            : jsonError(503, "Answer intake unavailable");
                  }
                }
              }
            }
          } else {
            if (!ANSWER_UUID.test(intakeRoute.id)) {
              response = jsonError(400, "Invalid request");
            } else {
              try {
                const result = await outcome({
                  repositoryPath: intakeRoute.repository.path,
                  id: intakeRoute.id,
                  secret: answerIntake.secret,
                });
                response = Response.json(result, {
                  status: result.status === "unknown-record" ? 404 : 200,
                });
              } catch {
                response = jsonError(503, "Answer intake unavailable");
              }
            }
          }
        } else {
          const repository = repositorySelector(
            pathname,
            requestConfig.repositories,
          );
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

    if (response === undefined) {
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
