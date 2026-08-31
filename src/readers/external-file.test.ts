import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readExternalFile } from "./external-file";

describe("external file reader", () => {
  const roots: string[] = [];
  const root = () => {
    const created = mkdtempSync(join(tmpdir(), "factory-ui-external-file-"));
    roots.push(created);
    return created;
  };

  afterEach(() => {
    for (const path of roots.splice(0))
      rmSync(path, { recursive: true, force: true });
  });

  test("reads a stable regular file without test dependencies", async () => {
    const path = join(root(), "opencode.jsonc");
    writeFileSync(path, "current bytes");

    const result = await readExternalFile(path, 100);

    expect(result).toEqual({
      status: "available",
      bytes: new TextEncoder().encode("current bytes"),
    });
  });

  test("rejects stale bytes when the checked path is atomically replaced before the read", async () => {
    const directory = root();
    const path = join(directory, "opencode.jsonc");
    const replacement = join(directory, "replacement.jsonc");
    writeFileSync(path, "stale bytes");
    writeFileSync(replacement, "current bytes");

    let hookPath: string | undefined;
    const result = await readExternalFile(path, 100, {
      afterOpen: (openedPath) => {
        hookPath = openedPath;
        renameSync(replacement, path);
      },
    });

    expect(hookPath).toBe(path);
    expect(result).toEqual({ status: "unavailable" });
  });
});
