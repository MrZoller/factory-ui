import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";

export type ExternalFileRead =
  | { status: "available"; bytes: Uint8Array }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "unavailable" };

export interface ExternalFileReadDependencies {
  /** Test-only seam for exercising changes between validation and the read. */
  afterOpen?: (path: string) => void | Promise<void>;
}

export async function readExternalFile(
  path: string,
  maximumBytes: number,
  dependencies: ExternalFileReadDependencies = {},
): Promise<ExternalFileRead> {
  try {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "unavailable" };
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      return { status: "unavailable" };
    }

    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const [opened, current, currentLink] = await Promise.all([
        handle.stat(),
        stat(path),
        lstat(path),
      ]);
      if (
        !opened.isFile() ||
        !current.isFile() ||
        !currentLink.isFile() ||
        currentLink.isSymbolicLink() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        opened.dev !== currentLink.dev ||
        opened.ino !== currentLink.ino
      ) {
        return { status: "unavailable" };
      }
      await dependencies.afterOpen?.(path);
      const bytes = new Uint8Array(
        await Bun.file(handle.fd)
          .slice(0, maximumBytes + 1)
          .arrayBuffer(),
      );
      const [after, currentAfter, currentLinkAfter] = await Promise.all([
        handle.stat(),
        stat(path),
        lstat(path),
      ]);
      if (
        !after.isFile() ||
        !currentAfter.isFile() ||
        !currentLinkAfter.isFile() ||
        currentLinkAfter.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.dev !== currentAfter.dev ||
        after.ino !== currentAfter.ino ||
        after.dev !== currentLinkAfter.dev ||
        after.ino !== currentLinkAfter.ino
      ) {
        return { status: "unavailable" };
      }
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
