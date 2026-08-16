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
  dependencies per task; worklogs expose the newest 20 entries.
- Logs: at most 256 directory entries are considered; narration is capped at
  64 KiB, 100 lines, and 2,000 bytes per line.
- Liveness: the fixed, shell-free `lsof` probe has a two-second timeout and
  bounded output. Missing `lsof`, timeout, failure, malformed output, or an
  ambiguous result is `CANNOT_VERIFY`, never evidence that the driver stopped.
- Browser fan-out: at most four peer requests run concurrently, each with a
  five-second timeout. Peer failures are isolated and shown as `UNREACHABLE`.

Inputs beyond a limit become unavailable or partial with warnings; the service
does not silently expand its read surface.

## Three-machine runbook

1. Install Bun and clone this repository on mini, macbook, and legion.
2. Copy the example on each host and set that host's machine name, literal
   Tailscale bind address, canonical clone paths, and the other two peer
   origins.
3. Confirm MagicDNS and ACL access to port 7777 in both directions among all
   three machines.
4. Run `bun run serve --config factory-ui.config.json` on each host.
5. Open one dashboard and confirm local data and both peers. Repeat from each
   machine to verify CORS symmetry and route availability.

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
