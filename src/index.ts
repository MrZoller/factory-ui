import { loadConfig } from "./config";
import { startServer } from "./server";

export const serviceName = "factory-ui";

if (import.meta.main) {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error(`Usage: bun run start -- <config.json>`);
  }

  const config = await loadConfig(configPath);
  const server = startServer(config);
  console.log(`${serviceName} listening on ${server.url.origin}`);
}
