import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_CODE_ROOTS,
  MAX_REPOSITORIES,
  loadConfig,
  parseConfig,
} from "./config";
import {
  GIT_EXECUTABLE,
  GIT_REMOTE_TIMEOUT_MS,
  MAX_DISCOVERY_CANDIDATES,
  MAX_DISCOVERY_ROOT_ENTRIES,
  MAX_DISCOVERY_WARNINGS,
  MAX_GIT_REMOTE_OUTPUT_BYTES,
  discoverRepositories,
  isRepositoryIdentityCurrent,
} from "./discovery";

const roots: string[] = [];

function root(): string {
  const value = realpathSync(
    mkdtempSync(join(tmpdir(), "factory-ui-discovery-")),
  );
  roots.push(value);
  return value;
}

function state(path: string, project = "project"): void {
  mkdirSync(join(path, ".factory"), { recursive: true });
  writeFileSync(
    join(path, ".factory", "state.json"),
    JSON.stringify({
      project,
      phase: "build",
      spec_approved: true,
      plan_approved: true,
      current_task: null,
      branch: null,
      pr: null,
      hold: false,
      updated: "2026-08-31T00:00:00Z",
    }),
  );
}

const remote = async () => ({
  exitCode: 0,
  stdout: "https://github.com/acme/project.git\n",
  stderr: "",
});

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("repository discovery", () => {
  test("discovers only direct children with valid state and invokes fixed Git argv", async () => {
    const codeRoot = root();
    const direct = join(codeRoot, "direct");
    state(direct, "direct");
    state(join(direct, "nested"), "nested");
    writeFileSync(join(codeRoot, "plain-file"), "not a repository");
    mkdirSync(join(codeRoot, "invalid"));
    writeFileSync(join(codeRoot, "invalid", ".factory"), "not a directory");
    const runner = vi.fn(remote);

    const result = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner },
    );

    expect(result.repositories).toEqual([
      {
        name: "direct",
        path: direct,
        githubUrl: "https://github.com/acme/project",
      },
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DISCOVERY_STATE_INVALID" }),
    );
    expect(runner).toHaveBeenCalledWith(
      GIT_EXECUTABLE,
      ["remote", "get-url", "origin"],
      {
        cwd: direct,
        timeoutMs: GIT_REMOTE_TIMEOUT_MS,
        maxOutputBytes: MAX_GIT_REMOTE_OUTPUT_BYTES,
      },
    );
  });

  test("rejects symlink escapes and hostile names with non-leaking warnings", async () => {
    const codeRoot = root();
    const outside = root();
    state(outside, "outside");
    symlinkSync(outside, join(codeRoot, "escape"));
    state(join(codeRoot, "valid"));
    mkdirSync(join(codeRoot, "bad name"));
    const result = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: remote },
    );

    expect(result.repositories.map(({ name }) => name)).toEqual(["valid"]);
    expect(result.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "DISCOVERY_ENTRY_UNSAFE",
        "DISCOVERY_ENTRY_INVALID",
      ]),
    );
    expect(JSON.stringify(result.warnings)).not.toContain(outside);
    expect(JSON.stringify(result.warnings)).not.toContain("bad name");
  });

  test("keeps explicit repository name, path, and URL over discovered duplicates deterministically", async () => {
    const codeRoot = root();
    const sameName = join(codeRoot, "explicit-name");
    const samePath = join(codeRoot, "other-name");
    state(sameName);
    state(samePath);
    const explicit = {
      name: "explicit-name",
      path: sameName,
      githubUrl: "https://github.com/acme/explicit",
    };
    const result = await discoverRepositories(
      {
        repositories: [explicit, { name: "other", path: samePath }],
        codeRoots: [codeRoot],
      },
      { runner: remote },
    );

    expect(result.repositories).toEqual([
      explicit,
      { name: "other", path: samePath },
    ]);
    expect(
      result.warnings.filter(({ code }) => code === "DISCOVERY_DUPLICATE"),
    ).toHaveLength(2);
  });

  test("isolates unavailable roots and invalid, multiline, oversized, and hostile remotes", async () => {
    const codeRoot = root();
    for (const name of ["bad-one", "bad-two", "bad-three", "bad-four"])
      state(join(codeRoot, name));
    const outputs = [
      "https://github.com/acme/one\nextra\n",
      "x".repeat(MAX_GIT_REMOTE_OUTPUT_BYTES + 1),
      "ssh://git@github.com/acme/three\n",
      "https://github.com/acme/four\n",
    ];
    const runner = vi.fn(async () => {
      const stdout = outputs.shift() ?? "";
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        outputTruncated: stdout.length > MAX_GIT_REMOTE_OUTPUT_BYTES,
      };
    });
    const result = await discoverRepositories(
      {
        repositories: [],
        codeRoots: ["/definitely/unavailable/root", codeRoot],
      },
      { runner },
    );

    expect(result.repositories).toHaveLength(4);
    expect(result.repositories[3]?.githubUrl).toBe(
      "https://github.com/acme/four",
    );
    expect(result.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "DISCOVERY_ROOT_UNAVAILABLE",
        "DISCOVERY_REMOTE_UNAVAILABLE",
      ]),
    );
    expect(JSON.stringify(result.warnings)).not.toContain(
      "definitely/unavailable",
    );
  });

  test("enforces repository and warning bounds", async () => {
    const codeRoot = root();
    for (let index = 0; index <= MAX_REPOSITORIES; index++)
      state(join(codeRoot, `candidate-${index}`));
    const candidates = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: remote },
    );
    expect(candidates.repositories).toHaveLength(MAX_REPOSITORIES);
    expect(candidates.warnings).toContainEqual(
      expect.objectContaining({ code: "DISCOVERY_REPOSITORY_LIMIT" }),
    );

    const invalidRoot = root();
    for (let index = 0; index < MAX_DISCOVERY_WARNINGS + 5; index++)
      mkdirSync(join(invalidRoot, `bad name ${index}`));
    const warnings = await discoverRepositories({
      repositories: [],
      codeRoots: [invalidRoot],
    });
    expect(warnings.warnings).toHaveLength(MAX_DISCOVERY_WARNINGS);
    expect(warnings.warnings.at(-1)).toEqual(
      expect.objectContaining({ code: "DISCOVERY_WARNINGS_TRUNCATED" }),
    );

    const tooManyEntries = root();
    for (let index = 0; index <= MAX_DISCOVERY_ROOT_ENTRIES; index++)
      mkdirSync(join(tooManyEntries, `entry-${index}`));
    const rootLimit = await discoverRepositories({
      repositories: [],
      codeRoots: [tooManyEntries],
    });
    expect(rootLimit.warnings).toEqual([
      {
        code: "DISCOVERY_ROOT_LIMIT",
        message: "a code root exceeded the discovery entry limit",
      },
    ]);

    const candidateRoot = root();
    for (let index = 0; index <= MAX_DISCOVERY_CANDIDATES; index++)
      mkdirSync(join(candidateRoot, `candidate-${index}`));
    const readState = vi.fn(async () => ({
      status: "unavailable" as const,
      warnings: [],
    }));
    await discoverRepositories(
      { repositories: [], codeRoots: [candidateRoot] },
      { readState },
    );
    expect(readState).toHaveBeenCalledTimes(MAX_DISCOVERY_CANDIDATES);
  });

  test("drops a candidate whose identity changes while discovery reads it", async () => {
    const codeRoot = root();
    const candidate = join(codeRoot, "changing");
    const replaced = join(codeRoot, "replaced");
    state(candidate);
    const readState = vi.fn(async () => {
      renameSync(candidate, replaced);
      state(candidate);
      return {
        status: "available" as const,
        data: { project: "changing", phase: "build" as const },
        warnings: [] as [],
      };
    });
    const result = await discoverRepositories(
      { repositories: [], codeRoots: [codeRoot] },
      { runner: remote, readState },
    );

    expect(result.repositories).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "DISCOVERY_IDENTITY_CHANGED",
        message: "a discovery candidate changed while being checked",
      },
    ]);
  });

  test("observes additions and removals on repeated scans", async () => {
    const codeRoot = root();
    const first = join(codeRoot, "first");
    state(first);
    expect(
      (
        await discoverRepositories(
          { repositories: [], codeRoots: [codeRoot] },
          { runner: remote },
        )
      ).repositories.map(({ name }) => name),
    ).toEqual(["first"]);
    rmSync(first, { recursive: true });
    state(join(codeRoot, "second"));
    expect(
      (
        await discoverRepositories(
          { repositories: [], codeRoots: [codeRoot] },
          { runner: remote },
        )
      ).repositories.map(({ name }) => name),
    ).toEqual(["second"]);
  });

  test("tracks discovered identity privately while explicit sources remain untracked", async () => {
    const codeRoot = root();
    const outside = root();
    const candidate = join(codeRoot, "tracked");
    state(candidate);
    state(outside, "replacement");
    const [repository] = (
      await discoverRepositories(
        { repositories: [], codeRoots: [codeRoot] },
        { runner: remote },
      )
    ).repositories;
    expect(repository).toBeDefined();
    if (repository === undefined) return;

    expect(await isRepositoryIdentityCurrent(repository)).toBe(true);
    expect(
      await isRepositoryIdentityCurrent({
        name: repository.name,
        path: repository.path,
      }),
    ).toBe(true);
    rmSync(candidate, { recursive: true });
    symlinkSync(outside, candidate);
    expect(await isRepositoryIdentityCurrent(repository)).toBe(false);
    expect(JSON.stringify(repository)).not.toContain("device");
    expect(JSON.stringify(repository)).not.toContain("inode");
  });
});

describe("discovery configuration", () => {
  const base = { machine: "mini", peers: [] };

  test("supports absent code roots and discovery-only configuration", () => {
    expect(
      parseConfig({
        ...base,
        repositories: [
          {
            name: "known",
            path: "/known",
            githubUrl: "https://github.com/acme/known",
          },
        ],
      }).codeRoots,
    ).toBeUndefined();
    expect(parseConfig({ ...base, codeRoots: ["/code"] })).toMatchObject({
      repositories: [],
      codeRoots: ["/code"],
    });
  });

  test("rejects invalid, duplicate, and canonical duplicate roots", async () => {
    expect(() => parseConfig({ ...base, codeRoots: ["relative"] })).toThrow(
      "codeRoots[0] must be an absolute normalized path",
    );
    expect(() =>
      parseConfig({ ...base, codeRoots: ["/code", "/code"] }),
    ).toThrow("code roots must be unique");
    expect(() =>
      parseConfig({
        ...base,
        codeRoots: Array(MAX_CODE_ROOTS + 1).fill("/code"),
      }),
    ).toThrow("codeRoots must be an array");
    const temp = root();
    const linked = join(temp, "linked");
    symlinkSync(temp, linked);
    const configPath = join(temp, "config.json");
    await Bun.write(
      configPath,
      JSON.stringify({ ...base, codeRoots: [temp, linked] }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      "canonical code roots must be unique",
    );
    await Bun.write(
      configPath,
      JSON.stringify({ ...base, codeRoots: [join(temp, "missing")] }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      "a code root is unavailable or invalid",
    );
  });
});
