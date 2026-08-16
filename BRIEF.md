# factory-ui brief

## Purpose

`factory-ui` is a public, strictly read-only web dashboard for an opencode
software-factory fleet. One small Bun HTTP server runs on each configured
machine (`mini`, `macbook`, and `legion`) on port 7777 and reads local product
repository clones. A single static page summarizes the local machine and fans
out from the browser to peer machines over Tailscale MagicDNS.

Phase-2 token accounting is explicitly deferred. It is not part of this
project's first specification, plan, API, UI, or configuration.

## Runtime and deployment

- Bun and strict TypeScript, with no framework and no build step.
- One process per machine, started using `bun src/index.ts`.
- Listen only on an explicitly configured localhost or Tailscale address.
  Wildcard binds (`0.0.0.0` and `::`) are rejected. Default port: 7777.
- Configuration identifies the machine, local repository clones, peer
  MagicDNS names, and the public GitHub URL for each product repository.
- Configuration contains paths and public topology only. It must contain no
  credentials, tokens, cookies, private keys, or other secrets.
- Missing repositories and malformed or partially written factory files
  degrade that repository's result; they must not crash the whole server.

## HTTP surface

- `GET /` returns the single static dashboard page.
- `GET /api/fleet` returns this server's machine metadata and summaries for
  every configured local product-repository clone.
- `GET /api/repo/<name>` returns the detailed local summary for one configured
  repository. `<name>` is one URL-encoded path segment and must match a
  configured name; it is never interpreted as a filesystem path.
- All other routes return JSON or plain-text `404`; non-GET methods return
  `405`. There are no mutation, action, proxy, shell, GitHub, or filesystem
  browsing endpoints.
- API responses include an explicit schema version and generation timestamp.
  CORS is limited to the configured localhost and tailnet dashboard origins
  needed for browser-side fleet fan-out.

## Data contract

The initial JSON contract is version `1`. Additive fields may be introduced;
incompatible changes require a version change.

```ts
type FleetResponse = {
  schemaVersion: 1;
  generatedAt: string; // ISO-8601 UTC
  machine: { name: string; baseUrl: string };
  repos: RepoSummary[];
};

type RepoResponse = {
  schemaVersion: 1;
  generatedAt: string;
  machine: string;
  repo: RepoSummary;
};

type RepoSummary = {
  name: string;
  githubUrl: string; // configured public repository URL
  availability: "AVAILABLE" | "UNAVAILABLE";
  error?: { code: string; message: string };
  state: {
    phase: "specify" | "plan" | "build" | "idle" | "UNKNOWN";
    currentTask: string | null;
    branch: string | null;
    pr: { number: number; url: string } | null;
    hold: boolean | null;
    updatedAt: string | null;
    staleness: "FRESH" | "STALE" | "UNKNOWN";
  };
  plan: {
    done: PlanItem[];
    doing: PlanItem[]; // [~] and [R]
    next: PlanItem[]; // runnable-looking [ ] entries in source order
    blocked: PlanItem[];
  };
  questions: Array<{
    id: string;
    task: string | null;
    title: string;
    context: string;
  }>;
  worklog: Array<{ heading: string; body: string }>;
  narration: Array<{ timestamp: string | null; text: string }>;
  timing: {
    runStartedAt: string | null;
    lastCycleStartedAt: string | null;
    lastCycleEndedAt: string | null;
    lastActivityAt: string | null;
    cycleDurationMs: number | null;
  };
  liveness: {
    status: "RUNNING" | "STOPPED" | "CANNOT_VERIFY";
    checkedAt: string;
    detail: string;
  };
};

type PlanItem = {
  id: string;
  size: "trivial" | "standard" | "major" | "unknown";
  title: string;
  status: "done" | "doing" | "review" | "todo" | "blocked";
};
```

Unknown or invalid source values are represented conservatively rather than
invented. API errors expose safe diagnostics, not absolute paths or file
contents beyond the bounded fields intended for display. Collection limits
for worklog entries, narration lines, line length, and bytes read are fixed
and documented in configuration or constants.

## Source interpretation

- Current task, branch, PR number, hold, phase, and update time come only from
  `.factory/state.json`.
- Plan groups come from exact factory marks in `.factory/plan.md`: `[x]` is
  done, `[~]` is doing, `[R]` is doing/review, `[ ]` is next, and `[!]` is
  blocked. No dependency solver is required for the first version; `next`
  preserves plan order and must not claim guaranteed runnability.
- Questions include only headings marked `open`, with bounded context from
  `.factory/questions.md`; answered entries are excluded.
- Worklog entries are newest-first selections from the bottom of
  `.factory/worklog.md`.
- Narration is a bounded tail of the newest configured driver log. Timestamps
  are parsed only when they match a documented log-stamp format.
- Run and cycle timing is derived from recognized driver-log stamps. Missing,
  malformed, or unmatched stamps produce `null`, never guessed times.
- GitHub data is not fetched or copied. PR links are constructed from the
  configured public GitHub repository URL and the state PR number. The UI
  links out to GitHub and does not reproduce titles, checks, reviews, labels,
  authors, comments, or other GitHub data.

## Liveness and staleness

Liveness and data freshness are separate signals.

- `RUNNING` requires a successful `lsof` probe showing the expected `tee`
  process currently has the selected driver-log file open.
- `STOPPED` is reported only when `lsof` is available, the probe completes
  successfully, and no matching `tee` opener exists.
- `CANNOT_VERIFY` is reported when `lsof` is absent, cannot run, times out,
  returns uninterpretable output, or the target log cannot be selected
  safely. The dashboard never converts probe uncertainty into alive or dead.
- The only child process permitted is a fixed-argument, timeout-bounded
  invocation of `lsof` for this probe. No request or repository text may
  influence the executable, options, environment, or target outside the
  already validated configured log path. There is no general exec facility.
- Staleness is based on the newest valid timestamp among state and recognized
  log activity. It is `FRESH` within a documented configurable threshold,
  `STALE` beyond it, and `UNKNOWN` when no trustworthy timestamp exists.
- A stale repository may still be `RUNNING`; a fresh repository may be
  `STOPPED`. The UI displays both without collapsing them into one status.
- Peer reachability is browser-observed. A failed or timed-out peer fetch is
  rendered `UNREACHABLE`, distinct from every repository liveness value.

## Page behavior

- The page first renders local `/api/fleet`, then independently requests each
  configured peer's `http://<MagicDNS-name>:7777/api/fleet` with a timeout.
- A peer failure cannot suppress local or other peer results. Unreachable
  peers remain visible as `UNREACHABLE` and can recover on refresh.
- Each repository shows current task, branch, linked PR number, hold, grouped
  plan status, open questions, newest worklog entries, narration tail, timing,
  liveness, and staleness.
- Desktop and mobile layouts remain readable, keyboard navigable, and useful
  without JavaScript only to the extent of showing a clear requirement notice;
  fleet fan-out itself requires browser JavaScript.

## Security rules

- Strictly read-only: no writes to repositories, factory state, logs, config,
  Git, GitHub, processes, or services. No controls that imply factory actions.
- No generic command execution, shell interpolation, dynamic executable
  selection, plugins, hooks, or request-triggered process control.
- Repository access is an allowlist of configured, canonical clone roots.
  Reject traversal, separators in repository names, symlink escape, and any
  resolved source path outside its clone root.
- Bind only to validated loopback or local Tailscale addresses. Do not claim
  that MagicDNS alone is an authorization boundary; deployment also relies on
  tailnet ACLs and host firewall policy.
- All repository-derived text is untrusted, including Markdown, worklogs,
  questions, branch names, and driver logs that quote PR or bot content. The
  browser must render it as text using `textContent` or equivalent safe DOM
  construction. Never inject it through `innerHTML`, template interpolation
  into HTML, inline event handlers, URLs, CSS, or script.
- JSON serialization is not an HTML escaping strategy. The static page must
  not embed repository-derived JSON in a script element.
- Validate link schemes and construct PR URLs solely from validated config
  plus an integer PR number. External links use safe opener behavior.
- Set restrictive response headers, including a no-inline-script Content
  Security Policy compatible with the static asset design, `nosniff`, and a
  conservative referrer policy.
- Do not expose secrets, environment dumps, arbitrary absolute paths, raw
  errors, directory listings, source maps, or unrelated files.
- Bound read sizes, output sizes, line lengths, fan-out concurrency, and
  subprocess duration to resist accidental resource exhaustion.

## Backlog

- [ ] T1 (standard) - Define configuration and versioned API domain types
  - acceptance: strict validated config covers machine, bind address, port,
    clone allowlist, public GitHub URLs, peers, limits, and stale threshold;
    contract types and validation tests exist
  - deps: none
- [ ] T2 (major) - Implement bounded factory repository reader
  - acceptance: state, plan marks, open questions, newest worklog entries,
    narration, and timing are parsed conservatively with fixtures for missing,
    malformed, hostile, and partially written inputs; clone-root confinement
    is tested
  - deps: T1
- [ ] T3 (major) - Implement truthful liveness probe
  - acceptance: fixed `lsof` invocation detects only the expected tee opener;
    absent/failing/timed-out/unparseable lsof yields CANNOT_VERIFY; verified
    absence yields STOPPED; tests prove no request text reaches process args
  - deps: T1
- [ ] T4 (standard) - Serve read-only local HTTP API
  - acceptance: `/api/fleet` and encoded `/api/repo/<name>` implement contract
    v1, isolate per-repo failures, enforce method/routes/CORS/limits/security
    headers, reject unsafe binds, and expose no mutation or browsing surface
  - deps: T2, T3
- [ ] T5 (major) - Build escaped responsive dashboard
  - acceptance: one static page renders all required repo fields, separates
    liveness/staleness/reachability, creates all untrusted content as text,
    safely links PR numbers, and has XSS regression tests using hostile source
    fixtures
  - deps: T4
- [ ] T6 (standard) - Add client-side MagicDNS fleet fan-out
  - acceptance: configured peers load independently with bounded timeouts;
    failed peers show UNREACHABLE without hiding successful peers; CORS and
    recovery behavior are tested
  - deps: T5
- [ ] T7 (standard) - Document and verify three-machine operations
  - acceptance: README covers Bun setup, config examples, loopback/tailnet
    binding, tailnet ACL expectations, service launch on mini/macbook/legion,
    troubleshooting, and confirms lint/tests pass in CI with no build stage
  - deps: T6

## Risk tripwires

Stop and obtain explicit human approval before crossing any of these lines:

- Any write/action endpoint, factory control, process control, Git/GitHub API
  integration, authentication system, secret storage, or token accounting.
- Any framework, database, background collector, server-side fleet proxy,
  build/bundle step, or departure from one small process per machine.
- Any bind beyond loopback or a validated Tailscale interface, or any proposal
  to expose the dashboard to the public internet.
- Any liveness implementation that does not preserve the three states, uses
  age alone as proof, probes a process name without the exact log opener, or
  turns tool failure into RUNNING/STOPPED.
- Any use of raw HTML for repo-derived text, Markdown-to-HTML rendering,
  weakened CSP to accommodate inline dynamic content, or unsafe external URL.
- Any filesystem discovery outside configured clone roots, unbounded log/file
  reads, dynamic shell command, or request-controlled subprocess argument.
- Any API contract change that duplicates GitHub data or silently claims
  inferred/unknown data as authoritative.
