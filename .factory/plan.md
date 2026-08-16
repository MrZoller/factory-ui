# Plan: Read-only tailnet dashboard for the software factory fleet

## Approach

Build a thin vertical slice first: a loopback Bun service reads bounded
`state.json` data from configured clones, exposes it through a pure request
handler, and renders it in a static page. Harden that slice's configuration,
filesystem, bind, and CORS boundaries before expanding the read surface. Add
the protocol readers and fixed `lsof` probe as small modules that return
explicit partial or unknown states, then finalize the versioned API. Complete
the text-only local dashboard before adding isolated browser-side peer fan-out,
and finish with the launcher and three-machine runbook. Keep `src/index.ts` as
the composition root, colocate Bun tests with modules, add no runtime framework
or build step, and require `bun test` plus `bun run lint` to pass for every
task.

## Tasks

- [x] T1 (standard) — Ship a loopback local-dashboard walking skeleton
  - acceptance: In `src/config.ts`, `src/contracts.ts`, `src/snapshot.ts`, `src/server.ts`, `src/index.ts`, and `src/public/`, load a minimal JSON config containing a machine name, multiple named clone paths, peers, and an optional port defaulting to 7777; serve loopback only; make `GET /api/fleet` return hostname plus bounded project/phase data from each clone's `state.json`; make `GET /` fetch and render that local data with text-only DOM APIs; isolate a missing or malformed clone, return 404/405 for unsupported requests, and cover the handler/config/temp-tree behavior with Bun tests; format `BRIEF.md` so the existing full lint command is green (spec 1, 2, 5, 6, 8, 9).
  - deps: none
- [x] T2 (major) — Establish configuration, filesystem, bind, and CORS boundaries
  - acceptance: In `src/config.ts`, `src/paths.ts`, `src/server.ts`, and colocated tests, validate unique path-safe repository names, canonical clone roots, bounded repository/peer counts, literal loopback or tailnet bind addresses, peer origins, GitHub repository URLs, and explicit localhost development origins; reject wildcard/public/hostname-ambiguous binds, traversal and symlink escapes, and unsafe origins before listening; read only fixed documented `.factory` paths; grant browser CORS only to the local dashboard, configured peers, and explicit development origins with `Vary: Origin`; prove errors do not leak clone paths and no request value controls a filesystem path or command argument (spec 1, 3, 8, 9, 10).
  - deps: T1
- [~] T3 (standard) — Add conservative cross-platform driver liveness
  - acceptance: In `src/liveness.ts` and tests, select only a recognized driver log under a configured clone, invoke a fixed shell-free and timeout-bounded `lsof` probe through an injectable runner, report `RUNNING` only for an exact `tee` opener and `STOPPED` only for an unambiguous successful no-opener result, and report `CANNOT_VERIFY` for a missing executable, timeout, failure, malformed output, unsafe target, or ambiguous exit; prove `tail -F`, unrelated processes, and browser/repository values cannot produce `RUNNING` or alter process arguments; expose the result and check time through `src/snapshot.ts` (spec 4, 9).
  - deps: T2
- [ ] T4 (standard) — Parse bounded state and runnable plan data
  - acceptance: In `src/readers/state.ts`, `src/readers/plan.ts`, `src/test-support.ts`, `src/contracts.ts`, and tests, conservatively parse the approved state fields and exact top-level `[ ]`, `[~]`, `[R]`, `[x]`, and `[!]` plan tasks with sizes and dependencies; group active/review, next runnable, completed, blocked, and remaining work without treating nested bullets as tasks; mark work runnable only when all declared dependencies are completed; return bounded partial/unavailable results and warnings for missing, malformed, duplicate, oversized, hostile, or partially written input without inventing values or losing configured repository identity (spec 2, 5, 7).
  - deps: T2
- [ ] T5 (standard) — Add open-question and recent-worklog readers
  - acceptance: In `src/readers/questions.ts`, `src/readers/worklog.ts`, `src/snapshot.ts`, `src/contracts.ts`, and tests, return only explicitly open questions and the newest bounded worklog entries supported by the factory protocol; preserve question, narration, and worklog text verbatim within byte, entry, line, and line-length limits; treat Markdown and HTML as uninterpreted text; and produce explicit warnings rather than crashes for empty, malformed, oversized, hostile, or partially written content (spec 2, 5, 7, 8).
  - deps: T4
- [ ] T6 (standard) — Add bounded narration, timing, and source-age data
  - acceptance: In `src/readers/logs.ts`, `src/liveness.ts`, `src/snapshot.ts`, `src/contracts.ts`, and tests, enumerate only bounded recognized driver/cycle/shepherd log names, select logs deterministically, return a byte/line/line-length-bounded narration tail verbatim, and derive only defensible start/activity/duration values from names and filesystem timestamps; expose distinct per-source and overall “as of” timestamps, integrate the trusted driver log with liveness, and cover malformed names, equal timestamps, growing or multibyte oversized logs, missing logs, and stale stopped state without fabricating timing (spec 2, 4, 5, 7).
  - deps: T3, T4
- [ ] T7 (standard) — Finalize the versioned read-only API
  - acceptance: In `src/contracts.ts`, `src/snapshot.ts`, `src/server.ts`, and integration tests, finalize schema-versioned `GET /api/fleet` and `GET /api/repo/<encoded-name>` responses containing every spec-2 field; accept exactly one decoded configured repository name and reject malformed encodings, separators, and unknown names before filesystem or process work; isolate per-repository failures; include bounded warnings and generation/source timestamps; enforce security headers, CORS, 404/405 behavior, and safe errors; and prove representative page/API requests leave source contents and metadata unchanged and expose no absolute paths, environment values, or unrelated files (spec 2, 3, 5, 9).
  - deps: T5, T6
- [ ] T8 (major) — Render the complete local repository dashboard safely
  - acceptance: In `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`, browser-focused tests, and server tests, make current task/branch/PR/hold, active and review work, next runnable work, done and blocked work, open questions, worklog, narration, timing, liveness, warnings, and data age visually distinct and responsive; construct all source-derived content with text nodes or `textContent`, use only API-validated PR URLs with safe external-link behavior, and enforce a restrictive no-inline-script CSP plus `nosniff` and referrer policy; hostile fixtures containing tags, scripts, entities, event handlers, URL schemes, and closing-script text must remain literal and inert (spec 7, 8).
  - deps: T7
- [ ] T9 (standard) — Fan out to peers in the browser with failure isolation
  - acceptance: In `src/public/app.js`, `src/config.ts`, `src/contracts.ts`, and tests with mocked fetch and clocks, render every configured peer immediately and fetch each peer's `/api/fleet` directly from the browser with fixed timeout and concurrency bounds; keep local and successful peers usable when another request rejects, times out, violates CORS, or returns malformed data; show each failed peer in place as `UNREACHABLE`, never retain its prior data as current, allow refresh recovery, and add no server-side peer proxy (spec 3, 6, 10).
  - deps: T2, T8
- [ ] T10 (standard) — Document and package three-machine operation
  - acceptance: In `src/index.ts`, `package.json`, `README.md`, `.gitignore`, `factory-ui.config.example.json`, and tests, provide a documented `serve --config <path>` launch path with fail-before-listen validation and port 7777 default; ignore machine-local config while committing a credential-free example for mini, macbook, and legion with different clone paths; document loopback/tailnet binds, peer/CORS symmetry, MagicDNS and ACL assumptions, repository-equivalent trust, fixed limits, `lsof` uncertainty, troubleshooting, and the no-registry/no-proxy read-only model; verify the full test and lint commands are green (spec 1, 5, 10).
  - deps: T9

## Risks

- T2 is a security boundary. If deployment requires wildcard/public binding,
  hostname binding, following a repository-controlled symlink outside its
  clone, or browser origins beyond the approved set, stop and ask rather than
  weakening validation.
- T3 depends on macOS and Linux `lsof` behavior. If a platform cannot
  distinguish a verified no-opener result from probe failure, return
  `CANNOT_VERIFY`; if the product would need to call that `STOPPED`, stop and
  ask.
- T4 and T5 consume protocol Markdown. If representative valid files require
  heuristic task or entry inference, stop and ask whether factory-protocol
  should define a stricter format instead.
- T6 can infer activity from mtimes but logs do not contain authoritative end
  events. Do not label inferred activity as exact completion; stop and ask if
  exact end times become required.
- T8 is the primary XSS boundary and is major. Do not introduce `innerHTML`,
  rendered Markdown, inline script, dynamic CSS, a framework, or unvalidated
  external URLs to simplify rendering.
- Stop and ask before adding writes, controls, Git/GitHub calls,
  authentication, token accounting, persistent storage, server-side peer
  proxying, another subprocess, or reads outside the approved `.factory`
  surface. Split any task that grows materially beyond a reviewable session.
- Three-machine compatibility cannot be claimed from CI alone. T10 documents
  operation, but any claim of deployment verification requires actual access
  to and testing on mini, macbook, and legion.

## Ad-hoc

<!-- user-requested tasks get appended here by the driver -->

- [!] T11 (trivial) — parked review minors (batch)
  - Add `O_NONBLOCK` when opening validated `state.json` so a locally planted FIFO cannot block the fleet snapshot before the existing regular-file check rejects it (PR #2 review).
