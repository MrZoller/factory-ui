# factory-ui

Tailnet web dashboard for an opencode software-factory fleet. Each machine
reads explicit and locally discovered clones and serves their bounded
`.factory` status. The browser fetches peers directly; there is no registry,
database, or server-side peer proxy. The only control API submits authenticated
answer records through the factory engine's fixed `factory-answers` helper;
factory-ui never edits `questions.md` directly.

## Install and launch

Install [Bun 1.x](https://bun.sh/) and dependencies:

```sh
bun install
cp factory-ui.config.example.json factory-ui.config.json
bun run serve --config factory-ui.config.json
```

`serve --config <path>` is the only launch form. Explicit repository paths and
code roots are canonicalized and validated before the server listens. The port
defaults to `7777` when omitted. Machine-local
`factory-ui.config*.json` files are ignored by Git; the credential-free
`factory-ui.config.example.json` is the committed exception.

## Configuration

The example is a valid configuration for `mini`. Replace its illustrative IP,
clone paths, code roots, opencode config path, and GitHub URLs. A repository
path or code root must be an existing, canonicalizable local directory.
Repository names, repository paths, code roots, peer names, and peer origins
must each be unique.

`repositories` and `codeRoots` are both optional arrays, but at least one must
contain an entry. Explicit repositories keep their configured name, path, and
GitHub URL. Each code root contributes only its immediate, non-symlink
directory children whose bounded `.factory/state.json` is valid. A discovered
name is the path-safe child basename. Explicit repositories are merged first;
later name or canonical-path duplicates are ignored, and the final list never
exceeds the repository limit.

Discovery runs once for every API request, so newly added or removed child
repositories appear on the next dashboard refresh without restarting the
service. The fleet, individual-repository, and answer routes use that request's
same resolved list. Static HTML, JavaScript, and CSS requests do not scan code
roots. A failed root or candidate produces a generic bounded fleet warning and
does not prevent explicit repositories or other roots from being served.

`opencodeConfigPath` is optional. When present, it must be an explicit absolute,
normalized file path to this machine's `opencode.jsonc`. The service reads it
once per fleet snapshot through a bounded, descriptor-checked, read-only open;
regular files only are accepted, and symlinks are rejected. Omitting the field
disables the current/next-run routing view without failing startup. A missing,
unreadable, replaced, malformed, or oversized configured file makes only that
view unavailable and never exposes the configured path in API warnings.

To enable answering, set a non-secret `answerActor` in each machine's config
and provide the shared credential only in the server process environment:

```sh
FACTORY_ANSWER_SECRET='replace-me' bun run serve --config factory-ui.config.json
```

`answerActor` is the attribution asserted by that server. It is never accepted
from the browser. Omitting `answerActor` keeps answer routes disabled; setting
it without a non-empty `FACTORY_ANSWER_SECRET` fails before listen. The secret
must match the clone's engine answer-intake credential. It is entered in the
browser for submission and lifecycle tracking but is never logged or stored by
factory-ui.

Secret-authenticated browser requests are the default. An installation that
deliberately treats every client able to reach the dashboard port as an answer
operator may add `"answerAuth": "tailnet-open"` alongside `answerActor`. This
is the only accepted `answerAuth` value, and it is rejected without
`answerActor`. Open mode removes the browser's shared-secret prompt and Bearer
header, but the server process must still have a non-empty
`FACTORY_ANSWER_SECRET`; the fixed `factory-answers` helper receives that
private secret exactly as it does in the default mode. The committed example
does not enable this riskier mode.

For three-machine operation, give every machine its own file:

| Machine | `machine` | `bind`                         | Example clone root               | `peers`         |
| ------- | --------- | ------------------------------ | -------------------------------- | --------------- |
| mini    | `mini`    | mini's literal Tailscale IP    | `/Users/factory/code/factory-ui` | macbook, legion |
| macbook | `macbook` | macbook's literal Tailscale IP | `/Users/chris/code/factory-ui`   | mini, legion    |
| legion  | `legion`  | legion's literal Tailscale IP  | `/home/factory/code/factory-ui`  | mini, macbook   |

Use MagicDNS names in peer origins, for example `http://mini:7777`, but use a
literal IP in `bind`. Every machine must list the other dashboard origins so
browsers opened on any dashboard can fan out over CORS for read-only fleet
data. Answer routes never emit `Access-Control-Allow-Origin`, including on
errors and preflights. A peer question therefore links to its validated owning
dashboard and can be answered only after opening that same-origin page; it is
never proxied or submitted cross-origin. `developmentOrigins` is optional and
accepts only explicit localhost or loopback origins. Answer preflight metadata
lists `Content-Type` and `Idempotency-Key`, plus `Authorization` only in the
default secret-authenticated mode, but intentionally grants no origin.

### Bind and access boundary

The default bind is `127.0.0.1`. Accepted addresses are literal IPv4 or IPv6
loopback addresses and literal Tailscale-range addresses (`100.64.0.0/10` or
`fd7a:115c:a1e0::/48`). Hostnames, wildcard addresses, public addresses,
mapped/bracketed addresses, and zone-qualified IPv6 are rejected.

Tailnet membership and Tailscale ACLs protect dashboard reachability. By
default, a shared answer credential separately protects the write channel.
Allow the selected machines and users to reach TCP port 7777, and confirm
MagicDNS resolves each peer name. Access to this dashboard is
repository-equivalent trust: factory state, questions, worklogs, and narration
may contain sensitive repository context. Do not expose it to a broader
network.

The configured actor and shared credential provide cooperative identity, not
per-person cryptographic identity: anyone with the credential can submit as
that server's actor. Give the credential only to repository-equivalent trusted
operators and configure an actor name that accurately describes that group or
machine.

In `tailnet-open` mode, anyone who can reach the dashboard port can answer as
the configured actor without knowing the helper secret. Use it only when the
tailnet ACL and every reachable client are an acceptable write boundary; do
not expose the port to a broader LAN or public network.

## Fixed safety limits

- Config: 64 KiB; at most 32 explicit repositories, 32 code roots, 32 peers,
  and 32 development origins; names are at most 64 characters; port range is
  1–65535. Discovery examines at most 4,096 immediate entries and 256 directory
  candidates per root, retains at most 32 repositories after explicit-first
  deduplication, and returns at most 32 generic discovery warnings.
- State: 64 KiB. Plan, questions, and worklog inputs: 256 KiB, 4,096 lines,
  and 8,192 characters per line. Plans expose at most 256 tasks and 32
  dependencies per task; questions expose at most 128 entries; worklogs expose
  the newest 20 entries.
- Worklog entries may start with either `- YYYY-MM-DD UTC - ` or
  `- YYYY-MM-DD HH:MM UTC - `. Clock times use zero-padded 24-hour UTC time.
  The reader also tolerates legacy `## YYYY-MM-DD — <title>` headings (and the
  equivalent hyphen surrounded by spaces); stamped bullets remain the protocol
  form.
- Logs: at most 4,096 directory entries are scanned while retaining only the
  newest recognized driver, cycle, and shepherd entry; narration is capped at
  64 KiB, 100 lines, and 2,000 bytes per line.
- Agent routing: `.factory/logs/routing.json` is capped at 256 KiB, 64 agents,
  128 characters per agent name, and 1,024 characters per model/provider
  string; an agent's optional step cap is an integer from 0 through 1,000,000.
  Optional model metadata is capped at 64 entries and 200 characters per
  string.
- Current opencode routing: the optional configured `opencodeConfigPath` is
  capped at 256 KiB, 256 top-level or per-agent fields, 64 agents, 128
  characters per agent name, 1,024 characters per full provider/model id, and
  a step cap from 0 through 1,000,000. JSONC line and block comments plus
  trailing commas are accepted without treating comment-like string content as
  syntax.
- Task costs: `.factory/logs/costs.json` is capped at 64 KiB, 256 tasks, and 64
  models per task. Cost strings are capped at 1,024 characters.
- Review metrics: `.factory/metrics.jsonl` is capped at 256 KiB, 4,096 lines,
  and 8 KiB per line. Metric maps contain at most 64 entries and their keys
  are capped at 128 characters.
- Liveness: the fixed, shell-free `lsof` probe has a two-second timeout and
  bounded output. Missing `lsof`, timeout, failure, malformed output, or an
  ambiguous result is `CANNOT_VERIFY`, never evidence that the driver stopped.
- Discovery remote lookup: only the fixed shell-free
  `git remote get-url origin` invocation is allowed, with the discovered clone
  as its working directory, a two-second timeout, and a 4 KiB bound per output
  stream. Output must be fatal-UTF-8-decodable, exactly one non-empty
  newline-terminated line, and pass the existing canonical
  `https://github.com/<owner>/<repository>` policy. Otherwise the discovered
  repository remains usable without a GitHub URL.
- Browser fan-out: at most four peer requests run concurrently, each with a
  five-second timeout. Peer failures are isolated and shown as `UNREACHABLE`.
- Browser answer lifecycle storage: at most 128 strictly validated records.
  Confirmed outcomes retain only repository/machine/question identifiers,
  outcome UUID, status, actor, and rejection reason. An uncertain submission
  instead retains its idempotency key and confirmed option/free-text payload so
  the same reservation can be checked after reload. The shared secret and
  unconfirmed draft text are never persisted. Outcome polling uses one
  five-second timer per active answer and stops at an accepted or rejected
  outcome.
- Server answer idempotency: at most 512 private records per repository under
  `<git-common-dir>/factory/factory-ui-answer-idempotency/`. Records contain
  only the UUID key, a SHA-256 payload fingerprint, reservation/completion
  status, and the engine outcome UUID after completion; they are mode `0600`
  in a mode-`0700` directory. Secrets and answer text are never stored there.
  The service fails closed when the store is full or cannot be verified.

Inputs beyond a limit become unavailable or partial with warnings; exceeding
the log-directory scan has its own diagnostic rather than masquerading as a
missing or failed liveness probe. The service does not silently expand its read
surface. Answer delivery is the sole exception to read-only operation: it runs
the fixed `factory-answers` executable from `PATH`, with the configured clone
as its working directory and `FACTORY_ANSWER_SECRET` passed only in the helper
environment. Install the opencode-factory helper at that fixed command name;
factory-ui does not accept a configurable executable or helper arguments.

## Answer delivery and lifecycle

The question queue accepts structured open questions. A submission contains a
selected option and/or non-empty single-line text, never an actor. The browser
requires an explicit review followed by confirm, sends a UUID idempotency key,
and reuses that key if delivery must be retried. Only repositories owned by the
dashboard's same origin expose answer controls. Peer repositories show a link
to the validated owning dashboard and never trigger a cross-origin answer
fetch.

The engine owns application. `pending` and `inflight` records display as
`pending application`; an accepted outcome displays `applied/consumed` and the
verified `Answered by <actor> via factory-ui` attribution. A terminal-question
race or other engine refusal displays `rejected` with the engine reason and is
never presented as success. Pending and terminal metadata remains visible if
the open question disappears or the page reloads. Because the credential is
not persisted, reloaded pending records in the default mode require the
password and **Resume tracking**. Open-mode records resume polling without a
browser credential. A legacy fleet response that omits the answer-intake
descriptor is treated as disabled, rather than guessing that an unadvertised
write route is safe. Factory-ui submits only to the intake spool and polls
outcomes; it never writes, rewrites, or removes entries in
`.factory/questions.md`.

The server reserves each idempotency key durably before invoking
`factory-answers`. A completed same-key, same-payload retry, including after a
server restart, returns the original pending outcome UUID without invoking the
helper again; a changed payload conflicts. Every observed helper failure is
ambiguous because the engine may have published the record before the failure
became visible, so the server retains the reservation and returns `503` rather
than risking a duplicate submission. This is an intentional at-most-once crash
disposition: the same key is never automatically resubmitted without operator
verification. Before the first request, the browser stores the idempotency key
and answer payload (never the shared secret) in local storage so a reload can
check the same reservation; if that durable browser write fails, no request is
sent. Such a reservation, and a full store, require operator
inspection. Remove a reserved UUID record only after confirming from the
engine intake/outcomes that no submission occurred; then retry with the same
key. Completed records may be retired when their clients will no longer retry
them. Factory-ui automatically reclaims crash-left temporary write files but
provides no automatic expiry or cleanup of canonical reservations or
completed records.

## `.factory` read surface

For configured repositories, the service reads only the fixed targets
`.factory/state.json`, `.factory/spec.md`, `.factory/plan.md`,
`.factory/questions.md`, `.factory/worklog.md`, the bounded
driver/cycle/shepherd files selected from `.factory/logs/`,
`.factory/logs/routing.json`, `.factory/logs/costs.json`, and
`.factory/metrics.jsonl`. Canonical containment, target type, symlink, and
opened-descriptor identity checks apply before bounded reads. The service reads
at most 256 KiB from `spec.md` only to determine whether its GitHub document
link can be shown; its contents are not returned. Routing, cost, metrics, or
spec absence and invalidity are independent and do not make repository state
unavailable.

The optional machine-level `opencodeConfigPath` is deliberately outside the
repository `.factory` fixed-path allowlist. It is the only configuration-owned
read target: no request or repository value can select it. The reader returns
only top-level `model`, `small_model`, and bounded `agent.<name>.model`/`steps`
routing fields; all unrelated opencode settings are ignored. Full
`provider/model` identifiers are validated, output maps have null prototypes,
and warning text never contains the external path. The dashboard labels this
data as current configuration for the next factory run.

Configured code roots add one narrow discovery boundary: the service reads
bounded immediate directory metadata, rejects symlinks, validates and rechecks
canonical direct-child identity, and applies the existing bounded
`.factory/state.json` reader before accepting a child. The accepted root and
child device/inode identities stay private to the process and are rechecked
before and after snapshot reads and before answer intake. A persistent child
replacement is unavailable and its data is not returned. It does not recurse.
Only accepted discovered children may be passed as the working directory to
the fixed Git remote lookup described above; no repository, remote, request, or
configuration value can select an executable or add arguments. Discovery
warnings expose generic codes/messages, never paths, remote values, or raw
filesystem/subprocess errors.

These checks are a cooperative same-user local-filesystem boundary, not an
`openat`-style capability. A same-user process that swaps a path and restores
the original object between adjacent identity checks remains outside the
service's guarantees.

Routing uses schema version 1:

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-08-16T12:00:00Z",
  "model": "openai/gpt-5.6",
  "smallModel": "opencode/gpt-5-mini",
  "agents": {
    "builder": { "provider": "openai", "model": "gpt-5.6", "steps": 25 }
  },
  "models": {
    "openai/gpt-5.6": {
      "source": "models.dev",
      "pricesAsOf": "2026-08-16",
      "name": "GPT 5.6",
      "family": "gpt",
      "releaseDate": "2026-08-01",
      "contextWindow": 1050000,
      "maxOutputTokens": 128000,
      "pricePerMillion": {
        "input": 1.25,
        "output": 10,
        "cacheRead": 0.125,
        "cacheWrite": null
      }
    }
  }
}
```

`recordedAt` must be an ISO-8601 UTC timestamp. `model` and `smallModel` are
`provider/model` identifiers. Each agent has bounded non-empty `provider` and
`model` strings and an integer or null `steps`; unknown keys are ignored. A
missing, oversized, malformed, unsupported-version, or otherwise invalid file
is reported as routing `Unavailable` with a warning. The optional `models` map
is additive: malformed entries are omitted with partial status, model metadata
strings are bounded, token limits are non-negative safe integers, and prices
are finite non-negative numbers or null.

Repository routing is the last routing recorded when that repository's factory
ran. Each repository panel displays its validated `recordedAt` time and age so
it can be compared directly with the machine's current/next-run configuration.
The `/how` page prefers current routing; for older peer snapshots that omit the
additive `currentRouting` field, it falls back to the first available repository
snapshot and explicitly labels that source as a legacy last-run fallback.

Costs use schema version 1:

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-08-16T12:00:00Z",
  "currency": "USD",
  "tasks": {
    "T23": {
      "usd": 1.23,
      "messages": 4,
      "sessions": 1,
      "tokens": {
        "input": 1000,
        "output": 500,
        "reasoning": 200,
        "cacheRead": 800,
        "cacheWrite": 100
      },
      "byModel": {
        "openai/gpt-5.6": {
          "usd": 1.23,
          "messages": 4,
          "sessions": 1,
          "tokens": {
            "input": 1000,
            "output": 500,
            "reasoning": 200,
            "cacheRead": 800,
            "cacheWrite": 100
          }
        }
      },
      "firstAt": "2026-08-16T11:00:00Z",
      "lastAt": "2026-08-16T12:00:00Z"
    }
  }
}
```

`recordedAt`, `firstAt`, and `lastAt` must be ISO-8601 UTC timestamps. Task
keys must be `T1` or greater without leading zeroes, or `unattributed`; model
keys are `provider/model` identifiers. Every counter is a finite,
non-negative number. Unknown keys are ignored. A missing, oversized,
malformed, unsupported-version, or otherwise invalid file is reported as
costs `Unavailable` with a warning.

Review metrics are newline-delimited schema-version-1 JSON events. Each line
has a `task` (`T1` or greater) and an `event`: `ship` records task size,
optional reclassification, and nullable internal panel rounds/findings/fixes;
`merge` records its positive PR number, per-reviewer external
rounds/findings/fix pushes, and CI runs/reruns. A `pr` event comes from
`factory-git` and records UTC open/merge times, commit counts, per-login
reviews, comments, reactions and threads, plus check-run totals. All counters
are non-negative safe integers. External reviewer ids use `[a-z0-9-]+`; login
and other map keys are bounded.

The event-specific fields are:

- `ship`: `size`, `reclassifiedFrom`, and `internal: null` or
  `{rounds, findings: {blocking, minor, invalid}, fixed}`.
- `merge`: `pr`, `external` keyed by `[a-z0-9-]+` reviewer id with
  `{rounds, findings: {blocking, minor, refuted}, fixPushes}`, and
  `ci: {runs, reruns}`.
- `pr`: `by: "factory-git"`, `openedAt`, `mergedAt`, `commits`,
  `commitsAfterOpen`, count maps `reviews` and `issueComments`, nested count
  map `reactions`, `threads` entries `{total, resolved}`, and
  `checkRuns: {total, failed}`.

Malformed, invalid-UTF-8, oversized, or unsupported individual lines are
dropped with bounded line-number/excerpt warnings, leaving the source
`Partial`; they never invalidate other lines. For each task and event kind,
the API exposes the latest valid line in file order, folded under
`metrics.data.tasks.<task>`. A missing or unreadable file reports metrics as
`Unavailable` without changing repository availability.

## Three-machine runbook

1. Install Bun and clone this repository on mini, macbook, and legion.
2. Copy the example on each host and set that host's machine name, literal
   Tailscale bind address, canonical clone paths or code roots, and the other
   two peer origins.
3. Confirm MagicDNS and ACL access to port 7777 in both directions among all
   three machines.
4. Run `bun run serve --config factory-ui.config.json` on each host.
5. Open each dashboard through its configured MagicDNS origin (for example,
   `http://mini:7777`) and confirm local data and both peers. Do not use the
   literal Tailscale bind IP in the browser: peer requests must originate from
   a configured MagicDNS origin to pass CORS. Repeat from each machine to
   verify CORS symmetry and route availability.

This repository documents the topology; it does not claim the three named
machines have been deployed or verified.

## Troubleshooting

- **Configuration fails before startup:** check JSON syntax, duplicate names,
  normalized absolute paths, existing clone/code-root directories, canonical
  GitHub URLs, and the documented limits. Errors intentionally omit paths.
- **Current routing is unavailable:** configure an absolute normalized regular
  `opencode.jsonc` path, not a symlink, and check its JSONC syntax and size.
  Omitting `opencodeConfigPath` intentionally leaves this feature disabled.
- **A discovered repository is absent:** it must be an immediate non-symlink
  directory with a path-safe basename and a valid bounded
  `.factory/state.json`. Check fleet discovery warnings for a generic limit or
  safety reason. A missing or non-canonical GitHub origin removes links only;
  it does not remove the repository.
- **Bind is rejected:** use `127.0.0.1`, `::1`, or the host's literal
  Tailscale IP—not a MagicDNS hostname, wildcard, or public address.
- **Address already in use:** stop the conflicting process or choose the same
  alternate port consistently in that host's config, peer origins, and ACLs.
- **Peer is `UNREACHABLE`:** check that its service is running, its MagicDNS
  name resolves in the browser, its ACL permits the port, and its origin is
  listed as a peer on the receiving host. A CORS error usually means the peer
  lists are not symmetric.
- **Liveness is `CANNOT_VERIFY`:** inspect repository warnings first. A log-scan
  limit warning means old top-level logs should be archived; without that
  warning, install `lsof` and ensure it is executable. Do not interpret
  uncertainty as `STOPPED`.
- **Repository is partial/unavailable:** inspect that clone's bounded
  `.factory` files. The service reads only its documented fixed paths and does
  not follow alternate request-selected files.

## Development

```sh
bun test
bun run lint
```
