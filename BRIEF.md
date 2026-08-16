# factory-ui — spec & backlog (draft)

Read-only tailnet dashboard for the software factory fleet: what each
factory is working on now, what's done, what's next, what's blocked,
open questions, holds, run liveness, and timing — per machine, with a
fleet view from any machine. Drafted 2026-08-15 as the brief for the
factory's own `/spec` gate.

## Goals

- Glanceable answer to "what is the factory doing?" across mini /
  macbook / legion without SSH or a Claude session.
- Zero engine risk: a pure consumer of `.factory/` files. No writes, no
  new engine state, no protocol changes.
- Honest liveness: a dead driver with stale state must read STOPPED.

## Non-goals (v1)

- No actions. Answering questions, releasing holds, merging — those
  stay in git/GitHub/operator sessions. The UI is a window, not a lever.
- No GitHub duplication. PR checks, threads, verdicts link out to the PR.
- No public exposure. Tailnet/localhost bind only; MagicDNS is the auth.
- No token accounting in v1 (phase 2, best-effort).

## Data contract (what the UI reads)

| Source | Fields consumed | Meaning |
|---|---|---|
| `.factory/state.json` | project, phase, current_task, branch, pr, hold, updated | The "now" |
| `.factory/plan.md` | status marks `[ ] [~] [R] [x] [!]`, sizes, deps, Ad-hoc note | Done / doing / next / blocked |
| `.factory/questions.md` | `## Qn (task, open)` entries | What waits on the human |
| `.factory/worklog.md` | newest N entries, rendered as text | History |
| `.factory/logs/driver-*.log` | filename stamps, mtime, tail lines | Run start, last narration |
| `.factory/logs/cycle-*.log`, `shepherd-*.log` | filename stamps, mtimes | Cycle/pass timing |
| lsof on driver logs | `tee` opener present | RUNNING / STOPPED / CANNOT VERIFY |

The file formats are factory-protocol's contract; this table is the
UI's complete read surface. Anything more the UI wants must become a
factory bookkeeping improvement first, never a UI-side database.

## Liveness & staleness rules

- Tristate, never boolean: RUNNING (a `tee` holds a driver log),
  STOPPED (lsof ran, no tee opener), CANNOT VERIFY (lsof missing —
  shown as such, never as either real state). Count only `tee`
  openers; a watcher's `tail -F` must not read as a live factory.
- Every panel carries an "as of" timestamp from file mtimes. A stale
  `state.json` next to a dead driver renders STOPPED + last-known, not
  a live-looking dashboard.

## Security

- Read-only filesystem access to the configured clone paths; nothing else.
- Bind to the tailnet interface or localhost only. No auth layer in v1
  — the tailnet is the boundary (same trust model as SSH between the
  machines).
- ALL rendered content is untrusted: worklog, questions, and logs
  quote PR/review/bot text verbatim. Escape everything; no raw
  markdown-to-HTML of repo content in v1. This is the XSS boundary and
  the reason the page task is sized major.
- No secrets read, no commands executed on behalf of the browser.

## Architecture

One small bun HTTP server per machine (`factory-ui serve`), configured
with a list of clone paths and peer machines. It serves a JSON API
(`/api/fleet`, `/api/repo/<name>`) plus one static page. The page
renders the local machine's repos and fans out client-side to peers
over MagicDNS for the fleet view; unreachable peers render as
UNREACHABLE, never silently dropped. Hostname rides in every payload.
bun is already the factory repo's toolchain; no framework, no build
step beyond what CI already runs.

## Phase 2: token usage

opencode's local session storage holds per-session token counts that
can be correlated to cycle logs. It is version-coupled and may drift
per opencode release — best-effort display, absent when unparseable,
never a blocker. Bedrock-lane numbers are the ones that mean money;
the ChatGPT-Max driver tier is subscription.

## Backlog

| ID | Size | Task | Deps |
|---|---|---|---|
| T1 | standard | Scaffold: bun project, config format (clones, port, peers), CI, lint/format | — |
| T2 | standard | `.factory` reader library: typed snapshot of state/plan/questions/worklog + fixture-tree tests | T1 |
| T3 | standard | Liveness & timing module: tee-probe tristate, run/cycle durations from log names+mtimes | T1 |
| T4 | standard | HTTP server + JSON API, tailnet/localhost bind rules, serialization tests | T2, T3 |
| T5 | major | The page: now/next/done/blocked, questions, holds, narration tail, as-of stamps — the XSS boundary | T4 |
| T6 | standard | Fleet fan-out: peer fetch over MagicDNS, per-machine columns, UNREACHABLE state | T5 |
| T7 | standard | `factory-ui serve` launcher + README install/run docs per machine | T4 |

(T8 — phase-2 token usage — is deferred by decision; it arrives as a
later issue import, not in this plan.)

Acceptance criteria per task get written at `/plan` time by the
architect against this spec; each must be testable and name the files
it touches.

## Risks & tripwires

- opencode storage format drift breaks T8 → display absent, never wrong.
- lsof missing on a machine → CANNOT VERIFY state, never fake-dead.
- Clone paths differ per machine → per-machine config file, no shared registry.
- Log volume → tail bounded N lines server-side.
- If parsing plan.md gets fragile mid-build, stop and record it — the
  fix may belong in factory-protocol (stricter format), not the parser.

## Decisions (Chris, 2026-08-15)

1. Repo: `~/code/factory-ui`, **public** GitHub repo.
2. Port: **7777**.
3. Serve from **all three machines** (mini / macbook / legion).
4. Phase 2 (tokens): **later** — T8 is out of the initial backlog and
   returns as a future issue import.

## How it ships

From `~/code`: `opencode run --command new-project "factory-ui <this
doc as brief>"` → `/spec` (you approve) → `/plan` (you approve) →
headless runs. T5 is major and will hold its PR — proxy review applies.
