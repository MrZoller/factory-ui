# Spec: Read-only tailnet dashboard for the software factory fleet

## Problem

The factory operator cannot quickly tell what the factories on mini, macbook,
and legion are doing without opening SSH or an operator session on each
machine. Existing factory state is spread across repository bookkeeping and
run logs, and stale state can look active even after a driver has stopped.
This makes fleet progress, blockers, holds, and failed runs unnecessarily hard
to spot.

## Outcome

From any factory machine, the operator can open one dashboard and see the
last-known state of every configured factory repository on every configured
machine. The view distinguishes live, stopped, unverifiable, and unreachable
factories; shows when each snapshot was observed; and exposes enough recent
context to decide whether an operator session is needed. The dashboard remains
a read-only view over existing factory state and introduces no new engine
state or control path.

## Scope

### In

- A small Bun service on each factory machine, configured with local clone
  paths, peer machines, a bind address, and port 7777 by default.
- A JSON API for local-machine and per-repository snapshots derived only from
  the configured clones' `.factory` files and logs, with browser access granted
  only to the local dashboard, configured peer origins, and explicitly allowed
  localhost development origins.
- Current phase and task, completed/active/next/blocked plan items, open
  questions, holds, PR links, recent worklog entries, bounded narration tails,
  and run/cycle timing.
- Honest tristate liveness: `RUNNING`, `STOPPED`, or `CANNOT_VERIFY`, plus
  source-derived “as of” timestamps.
- One static dashboard that shows local repositories and fans out from the
  browser to configured peers over the tailnet; configured peers that cannot
  be reached remain visible as `UNREACHABLE`.
- Safe handling of malformed, missing, oversized, and untrusted
  repository-derived content.

### Out

- Factory actions such as answering questions, releasing holds, starting
  runs, or merging PRs — these remain in git, GitHub, and operator sessions.
- GitHub checks, review threads, and verdict duplication — the dashboard links
  to the relevant PR instead.
- Public-internet exposure or application-level identity — v1 relies on the
  existing tailnet boundary.
- Token and cost accounting — deferred to a later phase because opencode's
  local storage format is version-coupled.
- Factory protocol changes, a shared repository registry, or a UI-side
  database — v1 consumes existing per-clone bookkeeping only.
- Markdown rendering of repository content — v1 displays untrusted content as
  text only.

## Acceptance criteria

1. An operator can configure multiple local clone paths and peer machines,
   start the service on port 7777 by default, and bind it only to localhost or
   a tailnet address; unsupported or ambiguous exposure is rejected clearly.
2. For each configured valid clone, the local API reports the hostname,
   project and phase, current task, branch, PR and hold state, plan items by
   status, open questions, recent worklog entries, a bounded recent narration
   tail, run/cycle timing, and source-derived “as of” timestamps. Narration and
   worklog text is served verbatim within those bounds and rendered only as
   text.
3. API reads are limited to the configured clone roots and the documented
   `.factory` read surface. Requests cannot select arbitrary filesystem paths,
   mutate repository or factory state, or supply arguments to a system
   command. Browser responses grant cross-origin access only to the local
   dashboard origin, configured peer origins, and explicitly allowed localhost
   development origins.
4. Liveness is `RUNNING` only when `tee` has a driver log open, `STOPPED` only
   when the probe succeeds and finds no such opener, and `CANNOT_VERIFY` when
   `lsof` is absent, fails, or returns an unparseable result. Other readers,
   including `tail -F`, never count as a running driver.
5. Missing or malformed files and entries produce an explicit partial or
   unavailable result without crashing the service or inventing state. Every
   file parse and log tail has fixed byte, entry, or line limits.
6. Opening the dashboard on any configured machine shows its local
   repositories and every configured peer. The browser fetches peer snapshots
   directly; a failed or timed-out peer remains in place as `UNREACHABLE`
   rather than being omitted or represented by stale data as if current.
7. Each repository view makes current work, next runnable work, completed and
   blocked work, open questions, holds, recent narration, liveness, timing,
   and data age distinguishable at a glance. Available PR references link to
   GitHub rather than reproducing GitHub status.
8. Every repository-derived string is inserted into the page as text, never
   as HTML or rendered Markdown. Adversarial state, plan, question, worklog,
   and log content cannot create markup, scripts, event handlers, or unsafe
   links.
9. Serving API and page requests leaves configured repositories unchanged and
   offers no mutation endpoint. The only external process used is the fixed,
   server-owned liveness probe; no browser value controls its executable or
   arguments.
10. The service and dashboard work independently on mini, macbook, and legion;
    clone-path differences are handled by each machine's own configuration,
    and one unavailable machine does not prevent the others from rendering.

## Risks & constraints

- The service is strictly read-only and must not extend or reinterpret the
  factory protocol to manufacture data the bookkeeping does not provide.
- Tailnet membership and ACLs are the v1 access-control boundary. The service
  must never bind to a public or wildcard interface by accident.
- Factory files and logs may contain hostile or sensitive text. All rendering
  must be text-only, all reads bounded, and operators must treat dashboard
  access as equivalent to repository access.
- Liveness is necessarily dependent on `lsof`; inability to run or understand
  the probe is uncertainty, not evidence that a driver is stopped.
- Plan parsing depends on the factory protocol's Markdown conventions. If
  valid plans cannot be parsed reliably, the protocol should be tightened
  separately rather than adding heuristic state to this service.
- The implementation remains Bun 1.x with strict TypeScript, no framework,
  and no browser build step.

## Open questions

None.

## Changelog

- 2026-08-15: Restricted browser origins and confirmed bounded, verbatim text
  for narration and worklog content.
