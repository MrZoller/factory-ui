import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

import { type FactoryPathKey, resolveFactoryPath } from "../paths";

export type FactoryFileRead =
  | { status: "available"; bytes: Uint8Array }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "unavailable" };

export type FactoryFileWindowRead =
  | { status: "available"; bytes: Uint8Array }
  | {
      status: "window";
      prefix: Uint8Array;
      suffix: Uint8Array;
      suffixOffset: number;
      fileSize: number;
    }
  | { status: "missing" }
  | { status: "unavailable" };

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error("file changed during read");
    offset += bytesRead;
  }
  return bytes;
}

/**
 * Read a complete small file or fixed prefix/suffix windows from one verified
 * descriptor. The second identity check makes a concurrent replacement or
 * in-place rewrite unavailable rather than combining bytes from two states.
 */
export async function readFactoryFileWindow(
  repositoryPath: string,
  key: FactoryPathKey,
  completeBytes: number,
  prefixBytes: number,
  suffixBytes: number,
): Promise<FactoryFileWindowRead> {
  try {
    const validatedPath = await resolveFactoryPath(repositoryPath, key);
    if (validatedPath === null) return { status: "missing" };
    const handle = await open(
      validatedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const beforePath = await resolveFactoryPath(repositoryPath, key);
      if (beforePath === null) return { status: "unavailable" };
      const [openedBefore, pathBefore] = await Promise.all([
        handle.stat({ bigint: true }),
        stat(beforePath, { bigint: true }),
      ]);
      if (
        !openedBefore.isFile() ||
        !sameIdentity(openedBefore, pathBefore) ||
        openedBefore.size < 0n ||
        openedBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return { status: "unavailable" };
      }

      const fileSize = Number(openedBefore.size);
      const complete = fileSize <= completeBytes;
      const prefixLength = complete
        ? fileSize
        : Math.min(fileSize, prefixBytes);
      const suffixLength = complete ? 0 : Math.min(fileSize, suffixBytes);
      const suffixOffset = fileSize - suffixLength;
      const [prefix, suffix] = await Promise.all([
        readAt(handle, prefixLength, 0),
        complete
          ? Promise.resolve(new Uint8Array())
          : readAt(handle, suffixLength, suffixOffset),
      ]);

      const afterPath = await resolveFactoryPath(repositoryPath, key);
      if (afterPath === null) return { status: "unavailable" };
      const [openedAfter, pathAfter] = await Promise.all([
        handle.stat({ bigint: true }),
        stat(afterPath, { bigint: true }),
      ]);
      if (
        !sameIdentity(openedAfter, pathAfter) ||
        !sameIdentity(openedBefore, openedAfter) ||
        openedAfter.size !== openedBefore.size ||
        openedAfter.mtimeNs !== openedBefore.mtimeNs ||
        openedAfter.ctimeNs !== openedBefore.ctimeNs
      ) {
        return { status: "unavailable" };
      }
      return complete
        ? { status: "available", bytes: prefix }
        : { status: "window", prefix, suffix, suffixOffset, fileSize };
    } finally {
      await handle.close();
    }
  } catch {
    return { status: "unavailable" };
  }
}

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
