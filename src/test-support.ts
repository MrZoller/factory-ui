import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FactoryFixture {
  root: string;
  factoryPath: string;
  writeState(value: unknown | string | Uint8Array): Promise<void>;
  writePlan(value: string | Uint8Array): Promise<void>;
  writeQuestions(value: string | Uint8Array): Promise<void>;
  writeWorklog(value: string | Uint8Array): Promise<void>;
  writeRouting(value: unknown | string | Uint8Array): Promise<void>;
  writeCosts(value: unknown | string | Uint8Array): Promise<void>;
  writeDriverLog(name: string, content: string | Uint8Array): void;
  writeCycleLog(name: string, content: string | Uint8Array): void;
  writeShepherdLog(name: string, content: string | Uint8Array): void;
  cleanup(): void;
}

export function createFactoryFixture(): FactoryFixture {
  const root = mkdtempSync(join(tmpdir(), "factory-ui-"));
  const factoryPath = join(root, ".factory");
  mkdirSync(factoryPath);
  mkdirSync(join(factoryPath, "logs"));
  return {
    root,
    factoryPath,
    writeState: async (value) => {
      await Bun.write(
        join(factoryPath, "state.json"),
        typeof value === "string" || value instanceof Uint8Array
          ? value
          : JSON.stringify(value),
      );
    },
    writePlan: async (value) => {
      await Bun.write(join(factoryPath, "plan.md"), value);
    },
    writeQuestions: async (value) => {
      await Bun.write(join(factoryPath, "questions.md"), value);
    },
    writeWorklog: async (value) => {
      await Bun.write(join(factoryPath, "worklog.md"), value);
    },
    writeRouting: async (value) => {
      await Bun.write(
        join(factoryPath, "logs", "routing.json"),
        typeof value === "string" || value instanceof Uint8Array
          ? value
          : JSON.stringify(value),
      );
    },
    writeCosts: async (value) => {
      await Bun.write(
        join(factoryPath, "logs", "costs.json"),
        typeof value === "string" || value instanceof Uint8Array
          ? value
          : JSON.stringify(value),
      );
    },
    writeDriverLog: (name, content) => {
      writeFileSync(join(factoryPath, "logs", name), content);
    },
    writeCycleLog: (name, content) => {
      writeFileSync(join(factoryPath, "logs", name), content);
    },
    writeShepherdLog: (name, content) => {
      writeFileSync(join(factoryPath, "logs", name), content);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
