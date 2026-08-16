import { loadConfig } from "./config";
import { startServer } from "./server";

export const serviceName = "factory-ui";
const USAGE = "Usage: bun run serve --config <path>";

export function parseCliArgs(args: string[]): { configPath: string } {
  if (
    args.length !== 3 ||
    args[0] !== "serve" ||
    args[1] !== "--config" ||
    !args[2]
  ) {
    throw new Error(USAGE);
  }
  return { configPath: args[2] };
}

export async function launch(
  args: string[],
  dependencies?: {
    loadConfig?: typeof loadConfig;
    startServer?: typeof startServer;
  },
): Promise<ReturnType<typeof startServer>> {
  const { configPath } = parseCliArgs(args);

  const {
    loadConfig: loadConfigFn = loadConfig,
    startServer: startServerFn = startServer,
  } = dependencies ?? {};

  const config = await loadConfigFn(configPath);
  return startServerFn(config);
}

if (import.meta.main) {
  const server = await launch(process.argv.slice(2));
  console.log(`${serviceName} listening on ${server.url.origin}`);
}
