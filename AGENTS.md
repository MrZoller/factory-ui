# factory-ui

Read-only tailnet web dashboard for the opencode software factory fleet. A
small Bun server reads configured local product-repository clones and serves
a JSON API plus a static browser dashboard that fans out to peers over
MagicDNS.

## Commands

- setup: `bun install`
- test: `bun test`
- lint: `bun run lint`
- run: `bun run start`

## Stack & layout

- Bun 1.x, strict TypeScript, no framework, no build step
- `src/` - HTTP server, factory-file readers, static UI, and colocated tests
- `.factory/` - durable factory specification, plan, state, questions, and worklog

## Conventions

- Keep dashboard reads strictly read-only and use fixed, bounded parsing
  limits. The owner-approved answer-intake exception may invoke only the fixed
  `factory-answers` helper when enabled by `answerActor` plus
  `FACTORY_ANSWER_SECRET`; configuration omission keeps it disabled, and the
  service never edits `questions.md` directly. Browser answer auth defaults to
  the shared secret; only explicit `answerAuth: "tailnet-open"` removes it,
  while the helper secret remains mandatory. Answer routes never emit CORS
  allow-origin headers, so peer questions link to their owning dashboard.
- Treat every repository-derived string as untrusted and render it as text,
  never HTML.
- Use Bun's test runner; linting means Prettier check plus strict TypeScript
  type-checking without emit.

## Factory

This repo is on the software-factory line: state lives in `.factory/`
(spec, plan, worklog, questions). Agents load the `factory-protocol` skill
before factory work. Humans: `/status` for the dashboard, `/blocked` for
open questions.

## Gotchas

- Liveness is tristate. Missing or failed `lsof` is `CANNOT_VERIFY`, never
  evidence that the driver is running or stopped.
- The browser, not this server, fans out to peer machines over MagicDNS.
- Phase-2 token accounting is explicitly out of scope.
