import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

import { type FactoryPathKey, resolveFactoryPath } from "../paths";

export type FactoryFileRead =
  | { status: "available"; bytes: Uint8Array }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "unavailable" };

export async function readFactoryFile(
  repositoryPath: string,
  key: FactoryPathKey,
  maximumBytes: number,
): Promise<FactoryFileRead> {
  try {
    const validatedPath = await resolveFactoryPath(repositoryPath, key);
    if (validatedPath === null) return { status: "missing" };

    const handle = await open(
      validatedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const currentPath = await resolveFactoryPath(repositoryPath, key);
      if (currentPath === null) return { status: "unavailable" };

      const [opened, current] = await Promise.all([
        handle.stat(),
        stat(currentPath),
      ]);
      if (
        !opened.isFile() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) {
        return { status: "unavailable" };
      }

      const bytes = new Uint8Array(
        await Bun.file(handle.fd)
          .slice(0, maximumBytes + 1)
          .arrayBuffer(),
      );
      return bytes.byteLength > maximumBytes
        ? { status: "too-large" }
        : { status: "available", bytes };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unavailable" };
  }
}
