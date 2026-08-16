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
- [x] T3 (standard) — Add conservative cross-platform driver liveness
  - acceptance: In `src/liveness.ts` and tests, select only a recognized driver log under a configured clone, invoke a fixed shell-free and timeout-bounded `lsof` probe through an injectable runner, report `RUNNING` only for an exact `tee` opener and `STOPPED` only for an unambiguous successful no-opener result, and report `CANNOT_VERIFY` for a missing executable, timeout, failure, malformed output, unsafe target, or ambiguous exit; prove `tail -F`, unrelated processes, and browser/repository values cannot produce `RUNNING` or alter process arguments; expose the result and check time through `src/snapshot.ts` (spec 4, 9).
  - deps: T2
- [x] T4 (standard) — Parse bounded state and runnable plan data
  - acceptance: In `src/readers/state.ts`, `src/readers/plan.ts`, `src/test-support.ts`, `src/contracts.ts`, and tests, conservatively parse the approved state fields and exact top-level `[ ]`, `[~]`, `[R]`, `[x]`, and `[!]` plan tasks with sizes and dependencies; group active/review, next runnable, completed, blocked, and remaining work without treating nested bullets as tasks; mark work runnable only when all declared dependencies are completed; return bounded partial/unavailable results and warnings for missing, malformed, duplicate, oversized, hostile, or partially written input without inventing values or losing configured repository identity (spec 2, 5, 7).
  - deps: T2
- [x] T5 (standard) — Add open-question and recent-worklog readers
  - acceptance: In `src/readers/questions.ts`, `src/readers/worklog.ts`, `src/snapshot.ts`, `src/contracts.ts`, and tests, return only explicitly open questions and the newest bounded worklog entries supported by the factory protocol; preserve question, narration, and worklog text verbatim within byte, entry, line, and line-length limits; treat Markdown and HTML as uninterpreted text; and produce explicit warnings rather than crashes for empty, malformed, oversized, hostile, or partially written content (spec 2, 5, 7, 8).
  - deps: T4
- [x] T6 (standard) — Add bounded narration, timing, and source-age data
  - acceptance: In `src/readers/logs.ts`, `src/liveness.ts`, `src/snapshot.ts`, `src/contracts.ts`, and tests, enumerate only bounded recognized driver/cycle/shepherd log names, select logs deterministically, return a byte/line/line-length-bounded narration tail verbatim, and derive only defensible start/activity/duration values from names and filesystem timestamps; expose distinct per-source and overall “as of” timestamps, integrate the trusted driver log with liveness, and cover malformed names, equal timestamps, growing or multibyte oversized logs, missing logs, and stale stopped state without fabricating timing (spec 2, 4, 5, 7).
  - deps: T3, T4
- [x] T7 (standard) — Finalize the versioned read-only API
  - acceptance: In `src/contracts.ts`, `src/snapshot.ts`, `src/server.ts`, and integration tests, finalize schema-versioned `GET /api/fleet` and `GET /api/repo/<encoded-name>` responses containing every spec-2 field; accept exactly one decoded configured repository name and reject malformed encodings, separators, and unknown names before filesystem or process work; isolate per-repository failures; include bounded warnings and generation/source timestamps; enforce security headers, CORS, 404/405 behavior, and safe errors; and prove representative page/API requests leave source contents and metadata unchanged and expose no absolute paths, environment values, or unrelated files (spec 2, 3, 5, 9).
  - deps: T5, T6
- [x] T8 (major) — Render the complete local repository dashboard safely
  - acceptance: In `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`, browser-focused tests, and server tests, make current task/branch/PR/hold, active and review work, next runnable work, done and blocked work, open questions, worklog, narration, timing, liveness, warnings, and data age visually distinct and responsive; construct all source-derived content with text nodes or `textContent`, use only API-validated PR URLs with safe external-link behavior, and enforce a restrictive no-inline-script CSP plus `nosniff` and referrer policy; hostile fixtures containing tags, scripts, entities, event handlers, URL schemes, and closing-script text must remain literal and inert (spec 7, 8).
  - deps: T7
- [x] T9 (standard) — Fan out to peers in the browser with failure isolation
  - acceptance: In `src/public/app.js`, `src/config.ts`, `src/contracts.ts`, and tests with mocked fetch and clocks, render every configured peer immediately and fetch each peer's `/api/fleet` directly from the browser with fixed timeout and concurrency bounds; keep local and successful peers usable when another request rejects, times out, violates CORS, or returns malformed data; show each failed peer in place as `UNREACHABLE`, never retain its prior data as current, allow refresh recovery, and add no server-side peer proxy (spec 3, 6, 10).
  - deps: T2, T8
- [x] T10 (standard) — Document and package three-machine operation
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
  - Preserve `.factory/logs` directory and selected-file identity across driver-log selection and the `lsof` probe to harden against concurrent local directory swaps (PR #3 review).
  - Ignore task-shaped lines inside fenced Markdown blocks so documentation examples cannot appear as runnable plan tasks (PR #4 review).
  - Recognize `Fixes #N` references followed by `:`, `!`, or `?` punctuation without treating the valid issue number as malformed (PR #17 review).
  - Warn when a present `pr:` metadata line has an empty value rather than silently treating it as absent (PR #17 review).
  - Distinguish a successfully fetched but already-old snapshot from `refresh failed`; T20's closed reason set currently has no truthful age-only reason (T20 panel review).
  - Guard peer-timeout status updates by load generation so a late timeout from an older overlapping refresh cannot temporarily mark a newer successful snapshot stale (PR #20 review).
  - Add `overflow-wrap: anywhere` to the dynamic dashboard machine heading so a valid long unbroken configured hostname cannot be clipped by the no-horizontal-body-scroll layout (PR #21 review).

- [x] T12 (standard) — Add MIT license and clean test scratch directories
  - acceptance: add a root `LICENSE` containing the MIT license text with `Copyright (c) 2026 Chris Zoller`; ensure tests remove `tmp-hostile-*`, `tmp-logs-debug-*`, and `tmp-test-oversized-*` scratch directories on success or failure; remove current scratch-directory litter; add the `tmp-` pattern to `.gitignore`; and pass `bun test` plus `bun run lint`.
  - deps: none

- [x] T13 (standard) — Accept and display a UTC clock time in worklog entry stamps
  - acceptance: In `src/readers/worklog.ts`, `src/contracts.ts`, `src/public/app.js`, `README.md`, and colocated tests, accept worklog entries stamped either `- YYYY-MM-DD UTC - ` (current form) or `- YYYY-MM-DD HH:MM UTC - ` (new form; 24-hour, zero-padded, `00`–`23` / `00`–`59`); expose an optional per-entry `time` field (`"HH:MM"`, absent when the stamp carries no time) alongside the existing `date`; render each entry heading text-only as `YYYY-MM-DD HH:MM UTC` when a time is present and `YYYY-MM-DD` otherwise; entries in either form parse, order, and count against the existing bounds identically; a malformed time (`24:00`, `9:05`, `13:5`, `13:05:00`) is rejected as a malformed line exactly like a malformed date; the README documents both stamp forms. Motivation: the factory protocol is moving its worklog stamp from date-only to date + `HH:MM` UTC (opencode-factory), and mixed-form worklogs must keep rendering.
  - deps: none

- [x] T14 (standard) — Fleet summary strip and per-machine tabs
  - acceptance: In `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`, and browser-focused tests, render a fleet summary strip above the repository content with exactly one row per configured machine (local first, then peers in configured order) showing: machine name, liveness pill (`RUNNING`/`STOPPED`/`CANNOT_VERIFY`/`Unavailable`), current task and PR (or `None`/`Unknown` per the existing unknown-vs-empty rules), a `HELD` badge when any repository on that machine has `hold: true`, the count of open questions, and data age; render the repository cards inside one tab per machine (same order), with the selected tab persisted in the URL hash (`#machine=<name>`, defaulting to the local machine and falling back to it for an unknown name), keyboard-operable (arrow keys / Enter / Space, `role="tablist"`/`role="tab"`/`role="tabpanel"`, `aria-selected`), and each tab label carrying the same HELD badge and open-question count as its strip row so nothing spec 7 calls out is hidden behind an unselected tab; a machine whose fetch fails or times out still gets its strip row and tab (rendered as `Unavailable`) so failure isolation is preserved; all source-derived strings continue to be inserted as text nodes; hostile machine/repository names in tab labels, hash values, and strip rows remain literal and inert; keep the no-inline-script CSP (no inline handlers — attach listeners in app.js); tests cover tab switching, hash round-trip, keyboard operation, badge/counter agreement between strip and tab, and the unavailable-machine case (spec 3, 7, 8).
  - deps: none
  - pr: 14

- [x] T15 (standard) — Show each machine's agent model routing
  - acceptance: The factory engine records the routing in effect at each cycle/shepherd start to `.factory/logs/routing.json` (machine-local, git-ignored) with schema `{ "schemaVersion": 1, "recordedAt": "<ISO-8601 UTC>", "model": "<provider/model>", "smallModel": "<provider/model>", "agents": { "<agent>": { "provider": "<provider>", "model": "<model>", "steps": <int|null> } } }` — provider is the text before the first `/` of the configured model id, model the rest. In `src/paths.ts`, `src/readers/`, `src/contracts.ts`, `src/snapshot.ts`, `src/public/app.js`, `src/public/styles.css`, and colocated tests: add `logs/routing.json` as a fixed documented `.factory` read target (same canonical containment, symlink, size, and type checks as the other targets; bounded ≤ 16 KiB), parse it into a bounded, validated `routing` reader result on the repository snapshot (unknown keys ignored; missing file, oversized, unparseable, or wrong `schemaVersion` → `unavailable` with a warning; agent names and model strings length-bounded), and render one compact "Routing" strip per machine tab (routing is per machine — take it from the machine's first repository that has it, and say `Unavailable` when none does) listing agent → provider/model (+ `steps` cap when present), with the provider text-only but visually classed (`openai` / `opencode` / `amazon-bedrock` / other) so a Bedrock or unknown provider is distinguishable at a glance; hostile strings in agent names, provider, and model remain literal and inert; document the target and schema in the README's `.factory` read-surface section (spec 3, 7, 8). External dependency: opencode-factory writes the file (PR pending at task start); until it lands, the reader must simply report `Unavailable`.
  - deps: T14
  - pr: 15

- [x] T16 (trivial) — Fix liveness parser rejecting lsof file-set lines
  - acceptance: `parseCommands` in `src/liveness.ts` accepts the real `lsof -Fpc` output shape, in which every process set is `p<pid>`, `c<command>`, followed by one or more file-set lines (`f<fd>` and any other single-letter-prefixed field lines lsof emits for the file, e.g. `a`, `l`, `t`, `n`, `k`, `i`, `s`) until the next `p` line — file-set lines are ignored, the `p`→`c` pairing and ordering rules stay strict (a `c` without a preceding `p`, a `p` without a `c`, an empty command, a line that is not `p`/`c`/a file-set field, or output not ending in `\n` still return `null`), and the probe returns `RUNNING` when any command is `tee`; the test fixtures in `src/liveness.test.ts` are replaced/extended with real captured `lsof -Fpc` output for a live run (`p22022\nctee\nf3\np22341\nctail\nf3\n` → `["tee","tail"]` → `RUNNING`), a stopped log (exit 1, empty output → `STOPPED`), and the strict-rejection cases; the change is confined to the parser and its tests (spec 4, spec "Honest tristate liveness").
  - deps: none
  - pr: 16

- [x] T17 (standard) — Link projects, branches, and tasks to GitHub
  - acceptance: The factory protocol now records `  - pr: N` under a plan task at ship time (kept at merge) and backlog tasks carry `Fixes #N` in acceptance. In `src/readers/plan.ts`, `src/contracts.ts`, `src/snapshot.ts`, `src/public/app.js`, and colocated tests: parse an optional `pr` (positive safe integer) and the set of `Fixes #N` issue numbers per plan task (bounded count; malformed values ignored with a warning, never a parse failure); build all links server-side from the config-validated `githubUrl` only — repository page (`<githubUrl>`), branch (`<githubUrl>/tree/<branch>` only when `state.branch` matches `^[A-Za-z0-9._/-]{1,200}$`, contains no `..` segment, and does not start with `-` or `/`), task PR (`<githubUrl>/pull/<pr>`), issue (`<githubUrl>/issues/<n>`) — and expose them as `repositoryUrl`, `branchUrl`, and per-task `prUrl`/`issueUrls` on the API alongside the existing `prUrl`; the client re-validates every URL with the same anchored https/github.com/no-credentials/no-query/no-hash rule it applies to `prUrl` before creating an anchor, renders links with `target="_blank"` and `rel="noopener noreferrer"`, and renders plain text (never a link) when a URL is absent or fails validation; the project name in the Current panel links to the repository, the branch value to the branch, each task line with a `pr` to its PR (`PR #N` text) and each `Fixes #N` to its issue; hostile `githubUrl`-shaped, branch, and `pr:` values in fixtures produce no anchor; tests cover every link kind positive and negative (spec 7, 8, 9).
  - deps: T15
  - pr: 17

- [x] T18 (standard) — Repository strip and sub-tabs inside each machine tab
  - acceptance: In `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`, and colocated browser-focused tests: inside every machine tab panel render a repository summary strip with exactly one row per repository on that machine (config order) showing repository name, `AVAILABLE`/`UNAVAILABLE`, liveness pill, current task and PR (or `None`/`Unknown` per the existing unknown-vs-empty rules), a `HELD` badge when `hold: true`, open-question count, and worklog age; below it render the repository cards as one sub-tab per repository (`role="tablist"`/`role="tab"`/`role="tabpanel"`, `aria-selected`, arrow keys / Enter / Space, same idiom as the machine tabs), with the selected repository persisted in the URL hash alongside the machine (`#machine=<m>&repo=<r>`; default first repository of the selected machine; unknown or missing → first; hash round-trips both keys and hostile values stay literal and inert); each repository sub-tab label carries the same `HELD` badge and open-question count as its strip row, and the machine tab label and fleet-strip row keep the aggregate over that machine's repositories, so nothing spec 7 calls out is hidden behind an unselected sub-tab; an unavailable machine renders no sub-tabs (its `Unavailable` panel stands); the routing strip (T15) stays above the repository strip and is not duplicated per repository; keep the no-inline-script CSP; all source-derived strings remain text nodes; tests cover sub-tab switching, two-key hash round-trip and fallback, keyboard operation, badge/counter agreement across strip row → sub-tab → machine tab, and a machine with a single repository (spec 3, 7, 8).
  - deps: T14
  - pr: 18

- [x] T19 (standard) — Auto-refresh the dashboard without losing place
  - acceptance: In `src/public/app.js`, `src/public/index.html`, and colocated tests: after the first load the client re-fetches `/api/fleet` (and re-fans-out to peers) every 30 s while the document is visible, pauses while `document.hidden` is true and refreshes immediately on the next `visibilitychange` to visible; a refresh keeps the current content on screen until the new snapshot has been read and validated (no "Loading…" flash, no cleared panels), preserves the selected machine tab, the selected repository sub-tab, and the panel scroll position, and updates the existing `Snapshot <age> · <time>` line, whose age text also ticks locally between fetches; a failed refresh leaves the last good snapshot rendered, shows the error in `#error` with the age of the last good snapshot, and backs off (60 s, 120 s, cap 300 s) until a fetch succeeds; a Refresh button and `?refresh=<seconds>` (bounded 5–3600; invalid → default 30) exist for manual/paced use; only one in-flight refresh at a time (the existing `loadGenerations` guard drops stale responses); no new server surface, no CSP change, no inline script; tests cover the visible/hidden pause, machine+repository selection and scroll preservation across a refresh, error back-off, and the stale-response guard.
  - deps: T18
  - pr: 19

- [x] T20 (standard) — Show snapshot freshness only when it is a signal
  - acceptance: In `src/public/app.js`, `src/public/styles.css`, and colocated tests: replace the always-visible `Snapshot <age> · <time>` line with a muted `Updated <local time>` (absolute time only, no ticking age) while the latest refresh succeeded within the active refresh interval; when the last successful snapshot is older than the interval, a refresh has failed, or refresh is paused (hidden tab), render instead a visibly classed `Stale · last good snapshot <age> (<time>) — <reason>` where reason is one of `refresh failed`, `paused`, `peer timed out`; clear back to `Updated …` on the next successful fetch; apply the same rule to the fleet strip's per-machine data-age cell (blank/muted within the interval, highlighted with the age beyond it); tests cover healthy → stale → healthy transitions and the three reasons (spec 7).
  - deps: T19
  - pr: 20

- [x] T21 (standard) — UI design pass: layout grid, card alignment, spacing and type rhythm
  - acceptance: In `src/public/index.html`, `src/public/styles.css`, `src/public/app.js` (structure only — no behaviour change), and colocated tests: introduce a documented design system in `styles.css` — CSS custom properties for a spacing scale, type scale, radii, and light/dark colour tokens (theme-aware, honouring `prefers-color-scheme` and any existing theme hook) — and lay every repository panel out on a single 12-column CSS grid with explicit, consistent card spans (e.g. Current 8 + Active 4; In review / Next runnable / Blocked 4+4+4; Completed 6 + Open questions 6; Worklog / Logs / Warnings on the same grid) so cards in a row share edges and rows share gutters, with a defined collapse order at narrow widths (≥ 1200 three-up, ≥ 800 two-up, else one column) and no horizontal body scroll; align task-line elements on shared columns (id, title, size label right-aligned on a fixed column, `deps:` on its own muted line) so size labels no longer float at differing x; make empty-state cards (`None`) compact rather than min-height-padded; unify header, strip, tab, and card typography (weights, tracking, mono for identifiers only) and status pill styling; keep every source-derived string a text node and the CSP unchanged; tests assert the grid classes/spans on each card and that no rendering behaviour (tristate text, badges, links) changed. Motivation: Screenshot 2026-08-16 2:03 PM — Current+Active leave a third of the width empty, the three middle cards have three different widths, Completed is narrow beside a wide Open questions.
  - deps: T20
  - pr: 21

- [~] T22 (trivial) — Give the dashboard a proper wordmark
  - acceptance: In `src/public/index.html`, `src/public/styles.css`, and colocated tests: replace the plain `<h1>` with a wordmark treatment — a display-weight system-font stack with tight tracking, two-tone or gradient text via `background-clip: text` with a solid-colour fallback, and a small inline SVG mark (no external fonts, images, or scripts; CSP unchanged) — that reads well in both light and dark themes and at narrow widths; the machine name / subtitle stays text-only and secondary; the document `<title>` and the `<h1>` text remain literal ("Factory"/product name) so screen readers and tabs are unchanged; tests assert the heading text and that no inline event handlers or external asset URLs were introduced (spec 3, 7, 8). Direction, not spec: modern, restrained, "control room" rather than "startup landing page"; Chris will redirect after seeing it.
  - deps: T21

- [ ] T23 (standard) — Show what each task cost
  - acceptance: The factory engine now writes `.factory/logs/costs.json` (schemaVersion 1: `recordedAt`, `currency`, `tasks.<T-id|unattributed>.{usd,messages,sessions,tokens{input,output,reasoning,cacheRead,cacheWrite},byModel{"<provider>/<model>": same counters},firstAt,lastAt}`; metered lanes carry real USD, subscription lanes report 0 and count as tokens). In `src/paths.ts`, `src/readers/`, `src/contracts.ts`, `src/snapshot.ts`, `src/public/app.js`, `src/public/styles.css`, README, and colocated tests: add `logs/costs.json` as a fixed documented `.factory` read target (same containment/symlink/size/type checks; bounded ≤ 64 KiB), parse it into a bounded, validated `costs` reader result on the repository snapshot (unknown keys ignored; missing/oversized/unparseable/wrong schemaVersion → `unavailable` with a warning; task-id keys validated `^T[1-9][0-9]*$` or `unattributed`; numbers finite and non-negative; at most 256 tasks and 64 models per task); render on each task line a compact metered cost (`$1.23`) with tokens on a title/secondary line, and `sub` (tokens only) when usd is 0 but tokens are non-zero; show `unattributed` and a per-repository metered total in the repository strip row and a per-machine total in the fleet strip; a task with no entry shows nothing (not `$0`); hostile keys/values remain literal and inert; document the target and schema in the README's read-surface section (spec 3, 7, 8). External dependency: opencode-factory writes the file (PR pending at task start); until it lands the reader reports `Unavailable`.
  - deps: T21

- [ ] T24 (standard) — "How it works" page: the factory as a live diagram
  - acceptance: Add a second page served at `/how` (same server, same CSP, no external assets, no inline scripts, text-only content insertion) linked from the main header, that renders an inline-SVG or CSS-grid diagram of the factory pipeline — `spec → plan → build → ship → shepherd → merge` with the approval gates and the `hold` (major) path drawn as branches, and one node per agent role (driver, architect, shepherd, reviewer, verifier, test-engineer, mapper, docsmith, plus `small_model`) attached to the phase it acts in — where the static structure is authored as data in the client and the LIVE overlay comes from the existing API: each agent node shows its provider/model and `steps` cap from the machine's routing (T15) with the same provider classing, and, when costs (T23) are available, the metered cost of that node's model on this machine; a machine selector at the top mirrors the main page's tabs (`#machine=<name>` hash, keyboard-operable); a machine or role without routing renders `Unavailable`; the page is responsive (diagram scrolls in its own container, never the body); tests cover the static structure, the routing overlay including an unavailable role, and hostile provider/model strings staying literal (spec 3, 7, 8). Direction: slick and modern but restrained — same visual language as the design system (T21) and wordmark (T22).
  - deps: T23
