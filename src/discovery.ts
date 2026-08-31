import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  MAX_REPOSITORIES,
  parseGithubUrl,
  parseRepositoryName,
} from "./config";
import type {
  AppConfigSource,
  ReaderWarning,
  RepositorySource,
} from "./contracts";
import { readFactoryState } from "./readers/state";

export const GIT_EXECUTABLE = "git";
export const GIT_REMOTE_TIMEOUT_MS = 2_000;
export const MAX_GIT_REMOTE_OUTPUT_BYTES = 4 * 1024;
export const MAX_DISCOVERY_ROOT_ENTRIES = 4_096;
export const MAX_DISCOVERY_CANDIDATES = 256;
export const MAX_DISCOVERY_WARNINGS = 32;

export interface GitRemoteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
  outputInvalid?: boolean;
}

export type GitRemoteRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }>,
) => Promise<GitRemoteResult>;

export interface DiscoveryDependencies {
  runner?: GitRemoteRunner;
  readState?: typeof readFactoryState;
}

export interface DiscoveryResult {
  repositories: RepositorySource[];
  warnings: ReaderWarning[];
}

interface DiscoveredRepositoryIdentity {
  root: string;
  name: string;
  rootDevice: bigint;
  rootInode: bigint;
  rootHandle: FileHandle;
  path: string;
  device: bigint;
  inode: bigint;
  handle: FileHandle;
}

const discoveredRepositoryIdentities = new WeakMap<
  RepositorySource,
  DiscoveredRepositoryIdentity
>();
const openDiscoveredHandles = new Set<FileHandle>();

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<{ text: string; invalid: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      return { text: "", invalid: true };
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
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      invalid: false,
    };
  } catch {
    return { text: "", invalid: true };
  }
}

export const runGitRemote: GitRemoteRunner = async (
  executable,
  args,
  options,
) => {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, options.maxOutputBytes),
      readBounded(child.stderr, options.maxOutputBytes),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      outputTruncated: stdout.invalid || stderr.invalid,
      outputInvalid: stdout.invalid || stderr.invalid,
    };
  } finally {
    clearTimeout(timer);
  }
};

function warning(code: string, message: string): ReaderWarning {
  return { code, message };
}

function addWarning(warnings: ReaderWarning[], value: ReaderWarning): void {
  if (warnings.length < MAX_DISCOVERY_WARNINGS) {
    warnings.push(value);
  } else if (
    warnings.length === MAX_DISCOVERY_WARNINGS &&
    !warnings.some(({ code }) => code === "DISCOVERY_WARNINGS_TRUNCATED")
  ) {
    warnings[MAX_DISCOVERY_WARNINGS - 1] = warning(
      "DISCOVERY_WARNINGS_TRUNCATED",
      "additional discovery warnings were omitted",
    );
  }
}

async function rootIdentity(root: string): Promise<{
  device: bigint;
  inode: bigint;
}> {
  const metadata = await lstat(root, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("invalid-root");
  }
  const canonical = await realpath(root);
  const after = await lstat(root, { bigint: true });
  if (
    canonical !== root ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino
  ) {
    throw new Error("invalid-root");
  }
  return { device: after.dev, inode: after.ino };
}

async function openRootIdentity(root: string): Promise<{
  device: bigint;
  inode: bigint;
  handle: FileHandle;
}> {
  const handle = await open(root, "r");
  try {
    const held = await handle.stat({ bigint: true });
    const current = await rootIdentity(root);
    if (
      !held.isDirectory() ||
      held.dev !== current.device ||
      held.ino !== current.inode
    ) {
      throw new Error("changed-root");
    }
    return { ...current, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function sameRootIdentity(
  root: string,
  expected: { device: bigint; inode: bigint; handle: FileHandle },
): Promise<boolean> {
  try {
    const held = await expected.handle.stat({ bigint: true });
    const current = await rootIdentity(root);
    return (
      held.isDirectory() &&
      held.dev === expected.device &&
      held.ino === expected.inode &&
      current.device === expected.device &&
      current.inode === expected.inode
    );
  } catch {
    return false;
  }
}

async function childIdentity(
  root: string,
  name: string,
  rootExpected: { device: bigint; inode: bigint; handle: FileHandle },
): Promise<{ path: string; device: bigint; inode: bigint }> {
  if (!(await sameRootIdentity(root, rootExpected))) {
    throw new Error("changed-root");
  }
  const path = join(root, name);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error("symbolic-link");
  if (!metadata.isDirectory()) throw new Error("not-directory");
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (
    canonical !== path ||
    dirname(canonical) !== root ||
    basename(canonical) !== name ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino
  ) {
    throw new Error("invalid-child");
  }
  return { path: canonical, device: after.dev, inode: after.ino };
}

async function sameChildIdentity(
  root: string,
  name: string,
  rootExpected: { device: bigint; inode: bigint; handle: FileHandle },
  expected: { path: string; device: bigint; inode: bigint },
): Promise<boolean> {
  try {
    const current = await childIdentity(root, name, rootExpected);
    return (
      current.path === expected.path &&
      current.device === expected.device &&
      current.inode === expected.inode
    );
  } catch {
    return false;
  }
}

async function isHeldChildIdentityCurrent(
  expected: DiscoveredRepositoryIdentity,
): Promise<boolean> {
  try {
    const held = await expected.handle.stat({ bigint: true });
    if (
      !held.isDirectory() ||
      held.dev !== expected.device ||
      held.ino !== expected.inode
    ) {
      return false;
    }
    return sameChildIdentity(
      expected.root,
      expected.name,
      {
        device: expected.rootDevice,
        inode: expected.rootInode,
        handle: expected.rootHandle,
      },
      {
        path: expected.path,
        device: expected.device,
        inode: expected.inode,
      },
    );
  } catch {
    return false;
  }
}

export async function isRepositoryIdentityCurrent(
  repository: RepositorySource,
): Promise<boolean> {
  const expected = discoveredRepositoryIdentities.get(repository);
  if (expected === undefined) return true;
  return isHeldChildIdentityCurrent(expected);
}

export async function disposeDiscoveredRepositories(
  repositories: readonly RepositorySource[],
): Promise<void> {
  const handles = new Set<FileHandle>();
  for (const repository of repositories) {
    const identity = discoveredRepositoryIdentities.get(repository);
    if (identity !== undefined) {
      handles.add(identity.handle);
      handles.add(identity.rootHandle);
    }
  }
  await Promise.all(
    [...handles].map(async (handle) => {
      try {
        await handle.close();
        openDiscoveredHandles.delete(handle);
      } catch {
        // Closing an already-closed descriptor needs no recovery action.
      }
    }),
  );
}

export async function disposeAllDiscoveredRepositories(): Promise<void> {
  const handles = [...openDiscoveredHandles];
  openDiscoveredHandles.clear();
  await Promise.all(handles.map(async (handle) => handle.close()));
}

async function childNames(root: string): Promise<string[] | null> {
  const directory = await opendir(root);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (names.length === MAX_DISCOVERY_ROOT_ENTRIES) return null;
      names.push(entry.name);
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // Async iteration closes the handle on normal completion and early return.
    }
  }
  return names.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function githubUrl(
  repositoryPath: string,
  runner: GitRemoteRunner,
): Promise<{ url?: string; invalid: boolean }> {
  const result = await runner(GIT_EXECUTABLE, ["remote", "get-url", "origin"], {
    cwd: repositoryPath,
    timeoutMs: GIT_REMOTE_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_REMOTE_OUTPUT_BYTES,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    result.outputInvalid ||
    result.stderr !== "" ||
    !/^[^\r\n]+\n$/.test(result.stdout)
  ) {
    return { invalid: true };
  }
  try {
    return { url: parseGithubUrl(result.stdout.slice(0, -1)), invalid: false };
  } catch {
    return { invalid: true };
  }
}

export async function discoverRepositories(
  config: Pick<AppConfigSource, "repositories" | "codeRoots">,
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveryResult> {
  const repositories = [...config.repositories];
  const warnings: ReaderWarning[] = [];
  const names = new Set(repositories.map(({ name }) => name));
  const paths = new Set(repositories.map(({ path }) => path));
  const readState = dependencies.readState ?? readFactoryState;
  const runner = dependencies.runner ?? runGitRemote;

  for (const root of config.codeRoots ?? []) {
    if (repositories.length >= MAX_REPOSITORIES) break;
    let expectedRoot:
      | {
          device: bigint;
          inode: bigint;
          handle: FileHandle;
        }
      | undefined;
    let namesInRoot: string[] | null;
    try {
      expectedRoot = await openRootIdentity(root);
      openDiscoveredHandles.add(expectedRoot.handle);
      namesInRoot = await childNames(root);
      if (!(await sameRootIdentity(root, expectedRoot))) {
        throw new Error("changed-root");
      }
    } catch {
      if (expectedRoot !== undefined) {
        try {
          await expectedRoot.handle.close();
        } catch {
          // The root was not retained, so a close failure needs no recovery.
        }
        openDiscoveredHandles.delete(expectedRoot.handle);
      }
      addWarning(
        warnings,
        warning(
          "DISCOVERY_ROOT_UNAVAILABLE",
          "a code root could not be scanned safely",
        ),
      );
      continue;
    }
    if (namesInRoot === null) {
      await expectedRoot.handle.close();
      openDiscoveredHandles.delete(expectedRoot.handle);
      addWarning(
        warnings,
        warning(
          "DISCOVERY_ROOT_LIMIT",
          "a code root exceeded the discovery entry limit",
        ),
      );
      continue;
    }

    let candidates = 0;
    let retainedRoot = false;
    for (const childName of namesInRoot) {
      if (repositories.length >= MAX_REPOSITORIES) break;
      let identity: { path: string; device: bigint; inode: bigint };
      try {
        identity = await childIdentity(root, childName, expectedRoot);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message !== "not-directory" &&
          !error.message.includes("ENOENT")
        ) {
          addWarning(
            warnings,
            warning(
              "DISCOVERY_ENTRY_UNSAFE",
              "an unsafe discovery entry was ignored",
            ),
          );
        }
        continue;
      }
      let handle: FileHandle | undefined;
      try {
        handle = await open(identity.path, "r");
        const held = await handle.stat({ bigint: true });
        if (
          !held.isDirectory() ||
          held.dev !== identity.device ||
          held.ino !== identity.inode
        ) {
          throw new Error("changed-child");
        }
      } catch {
        try {
          await handle?.close();
        } catch {
          // The candidate was not accepted, so a close failure is not recoverable.
        }
        addWarning(
          warnings,
          warning(
            "DISCOVERY_IDENTITY_CHANGED",
            "a discovery candidate changed while being checked",
          ),
        );
        continue;
      }
      if (handle === undefined) continue;
      openDiscoveredHandles.add(handle);
      let name: string;
      try {
        name = parseRepositoryName(childName);
      } catch {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning("DISCOVERY_ENTRY_INVALID", "a discovery entry was ignored"),
        );
        continue;
      }
      candidates += 1;
      if (candidates > MAX_DISCOVERY_CANDIDATES) {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning(
            "DISCOVERY_CANDIDATE_LIMIT",
            "a code root exceeded the candidate limit",
          ),
        );
        break;
      }
      if (names.has(name) || paths.has(identity.path)) {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning(
            "DISCOVERY_DUPLICATE",
            "a duplicate discovered repository was ignored",
          ),
        );
        continue;
      }
      let state;
      try {
        state = await readState(identity.path);
      } catch {
        state = undefined;
      }
      if (
        state === undefined ||
        state.status === "unavailable" ||
        state.data.project === undefined ||
        state.data.phase === undefined
      ) {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning(
            "DISCOVERY_STATE_INVALID",
            "a discovery candidate had no valid factory state",
          ),
        );
        continue;
      }
      if (
        !(await isHeldChildIdentityCurrent({
          root,
          name: childName,
          rootDevice: expectedRoot.device,
          rootInode: expectedRoot.inode,
          rootHandle: expectedRoot.handle,
          ...identity,
          handle,
        }))
      ) {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning(
            "DISCOVERY_IDENTITY_CHANGED",
            "a discovery candidate changed while being checked",
          ),
        );
        continue;
      }
      let remote: { url?: string; invalid: boolean };
      try {
        remote = await githubUrl(identity.path, runner);
      } catch {
        remote = { invalid: true };
      }
      if (remote.invalid) {
        addWarning(
          warnings,
          warning(
            "DISCOVERY_REMOTE_UNAVAILABLE",
            "a discovered repository remote was ignored",
          ),
        );
      }
      if (
        !(await isHeldChildIdentityCurrent({
          root,
          name: childName,
          rootDevice: expectedRoot.device,
          rootInode: expectedRoot.inode,
          rootHandle: expectedRoot.handle,
          ...identity,
          handle,
        }))
      ) {
        await handle.close();
        openDiscoveredHandles.delete(handle);
        addWarning(
          warnings,
          warning(
            "DISCOVERY_IDENTITY_CHANGED",
            "a discovery candidate changed while being checked",
          ),
        );
        continue;
      }
      const repository: RepositorySource = {
        name,
        path: identity.path,
        ...(remote.url === undefined ? {} : { githubUrl: remote.url }),
      };
      discoveredRepositoryIdentities.set(repository, {
        root,
        name: childName,
        rootDevice: expectedRoot.device,
        rootInode: expectedRoot.inode,
        rootHandle: expectedRoot.handle,
        path: identity.path,
        device: identity.device,
        inode: identity.inode,
        handle,
      });
      repositories.push(repository);
      retainedRoot = true;
      names.add(name);
      paths.add(identity.path);
    }
    if (!retainedRoot) {
      await expectedRoot.handle.close();
      openDiscoveredHandles.delete(expectedRoot.handle);
    }
  }

  if (
    (config.codeRoots?.length ?? 0) > 0 &&
    repositories.length === MAX_REPOSITORIES
  ) {
    addWarning(
      warnings,
      warning(
        "DISCOVERY_REPOSITORY_LIMIT",
        "the repository limit was reached during discovery",
      ),
    );
  }

  return { repositories: repositories.slice(0, MAX_REPOSITORIES), warnings };
}
