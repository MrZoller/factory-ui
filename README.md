# factory-ui

Read-only tailnet web dashboard for an opencode software-factory fleet. Each
machine reads configured local clones and serves their bounded `.factory`
status. The browser fetches peers directly; there is no registry, database,
server-side peer proxy, or write/control API.

## Install and launch

Install [Bun 1.x](https://bun.sh/) and dependencies:

```sh
bun install
cp factory-ui.config.example.json factory-ui.config.json
bun run serve --config factory-ui.config.json
```

`serve --config <path>` is the only launch form. The complete configuration,
including every repository root, is loaded and validated before the server
listens. The port defaults to `7777` when omitted. Machine-local
`factory-ui.config*.json` files are ignored by Git; the credential-free
`factory-ui.config.example.json` is the committed exception.

## Configuration

The example is a valid configuration for `mini`. Replace its illustrative IP,
clone paths, and GitHub URLs. A repository path must be an existing,
canonicalizable local directory. Repository names, roots, peer names, and peer
origins must each be unique.

For three-machine operation, give every machine its own file:

| Machine | `machine` | `bind`                         | Example clone root               | `peers`         |
| ------- | --------- | ------------------------------ | -------------------------------- | --------------- |
| mini    | `mini`    | mini's literal Tailscale IP    | `/Users/factory/code/factory-ui` | macbook, legion |
| macbook | `macbook` | macbook's literal Tailscale IP | `/Users/chris/code/factory-ui`   | mini, legion    |
| legion  | `legion`  | legion's literal Tailscale IP  | `/home/factory/code/factory-ui`  | mini, macbook   |

Use MagicDNS names in peer origins, for example
`http://mini:7777`, but use a literal IP in `bind`. Every machine must list the
other dashboard origins: this symmetry lets browsers opened on any dashboard
pass CORS when they fan out to the other two. `developmentOrigins` is optional
and accepts only explicit localhost or loopback origins.

### Bind and access boundary

The default bind is `127.0.0.1`. Accepted addresses are literal IPv4 or IPv6
loopback addresses and literal Tailscale-range addresses (`100.64.0.0/10` or
`fd7a:115c:a1e0::/48`). Hostnames, wildcard addresses, public addresses,
mapped/bracketed addresses, and zone-qualified IPv6 are rejected.

Tailnet membership and Tailscale ACLs are the v1 access-control boundary.
Allow the selected machines and users to reach TCP port 7777, and confirm
MagicDNS resolves each peer name. Access to this dashboard is
repository-equivalent trust: factory state, questions, worklogs, and narration
may contain sensitive repository context. Do not expose it to a broader
network.

## Fixed safety limits

- Config: 64 KiB; at most 32 repositories, 32 peers, and 32 development
  origins; names are at most 64 characters; port range is 1–65535.
- State: 64 KiB. Plan, questions, and worklog inputs: 256 KiB, 4,096 lines,
  and 8,192 characters per line. Plans expose at most 256 tasks and 32
  dependencies per task; questions expose at most 128 entries; worklogs expose
  the newest 20 entries.
- Worklog entries may start with either `- YYYY-MM-DD UTC - ` or
  `- YYYY-MM-DD HH:MM UTC - `. Clock times use zero-padded 24-hour UTC time.
- Logs: at most 256 directory entries are considered; narration is capped at
  64 KiB, 100 lines, and 2,000 bytes per line.
- Agent routing: `.factory/logs/routing.json` is capped at 16 KiB, 64 agents,
  128 characters per agent name, and 1,024 characters per model/provider
  string; an agent's optional step cap is an integer from 0 through 1,000,000.
- Task costs: `.factory/logs/costs.json` is capped at 64 KiB, 256 tasks, and 64
  models per task. Cost strings are capped at 1,024 characters.
- Liveness: the fixed, shell-free `lsof` probe has a two-second timeout and
  bounded output. Missing `lsof`, timeout, failure, malformed output, or an
  ambiguous result is `CANNOT_VERIFY`, never evidence that the driver stopped.
- Browser fan-out: at most four peer requests run concurrently, each with a
  five-second timeout. Peer failures are isolated and shown as `UNREACHABLE`.

Inputs beyond a limit become unavailable or partial with warnings; the service
does not silently expand its read surface.

## `.factory` read surface

The service reads only the fixed targets `.factory/state.json`,
`.factory/spec.md`, `.factory/plan.md`, `.factory/questions.md`,
`.factory/worklog.md`, the bounded driver/cycle/shepherd files selected from `.factory/logs/`,
`.factory/logs/routing.json`, and `.factory/logs/costs.json`. Canonical
containment, target type, symlink, and opened-descriptor identity checks apply
before bounded reads. The service reads at most 256 KiB from `spec.md` only to
determine whether its GitHub document link can be shown; its contents are not
returned. Routing, cost, or spec absence and invalidity are independent and do
not make repository state unavailable.

Routing uses schema version 1:

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-08-16T12:00:00Z",
  "model": "openai/gpt-5.6",
  "smallModel": "opencode/gpt-5-mini",
  "agents": {
    "builder": { "provider": "openai", "model": "gpt-5.6", "steps": 25 }
  }
}
```

`recordedAt` must be an ISO-8601 UTC timestamp. `model` and `smallModel` are
`provider/model` identifiers. Each agent has bounded non-empty `provider` and
`model` strings and an integer or null `steps`; unknown keys are ignored. A
missing, oversized, malformed, unsupported-version, or otherwise invalid file
is reported as routing `Unavailable` with a warning.

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

## Three-machine runbook

1. Install Bun and clone this repository on mini, macbook, and legion.
2. Copy the example on each host and set that host's machine name, literal
   Tailscale bind address, canonical clone paths, and the other two peer
   origins.
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
  normalized absolute paths, existing clone directories, canonical GitHub
  URLs, and the documented limits. Errors intentionally omit clone paths.
- **Bind is rejected:** use `127.0.0.1`, `::1`, or the host's literal
  Tailscale IP—not a MagicDNS hostname, wildcard, or public address.
- **Address already in use:** stop the conflicting process or choose the same
  alternate port consistently in that host's config, peer origins, and ACLs.
- **Peer is `UNREACHABLE`:** check that its service is running, its MagicDNS
  name resolves in the browser, its ACL permits the port, and its origin is
  listed as a peer on the receiving host. A CORS error usually means the peer
  lists are not symmetric.
- **Liveness is `CANNOT_VERIFY`:** install `lsof` and ensure it is executable.
  Do not interpret uncertainty as `STOPPED`.
- **Repository is partial/unavailable:** inspect that clone's bounded
  `.factory` files. The service reads only its documented fixed paths and does
  not follow alternate request-selected files.

## Development

```sh
bun test
bun run lint
```
