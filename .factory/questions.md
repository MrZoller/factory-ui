# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted - mark the heading `answered` once
acted on.

---

## Q1 (task T49, consumed) — Proceed before the external answer-intake contract exists?
Context: T49 depends on MrZoller/opencode-factory#83, which is open and owns the record schema, spool location, validation, and rejection semantics. That issue belongs to another repository and cannot be widened into this repository's label-filtered import; leaving this unanswered keeps T49 waiting.
Options considered: Proceed — drop the external prerequisite and authorize factory-ui to define a provisional contract locally.
**A:** No — do not drop the prerequisite. T49 waits for MrZoller/opencode-factory#83 (the engine-owned record schema, spool, validation, and rejection contract), per Chris's direction (2026-08-29, relayed from the opencode-factory operator session and reaffirmed at plan approval). Keep T49 blocked until that contract merges; the answer-intake requirements from Q2 are being fed into #83's design.

## Q2 (task T49, consumed) — What should authorize answer delivery over the tailnet?
Context: T49 introduces the first write-capable endpoint into a service that is currently strictly read-only. The issue leaves the trust boundary open, and the choice changes configuration, CORS, audit identity, deployment, and security tests.
Options considered: A — rely on existing tailnet ACLs and record a configured actor identity / B — require a minimal shared secret plus actor identity / C — wait for a different authenticated intake design (recommended if neither A nor B is acceptable)
**A:** B — require a minimal shared secret plus a recorded actor identity on every answer record (Chris, 2026-08-29, via the factory-ui operator session). Tailnet ACLs alone are machine-level, not person-level; the durable record must carry a verified author. This requirement goes into #83's contract design.

## Q3 (task T50, consumed) — What is the authoritative filed-at time for a question?
Context: Issue #60 requires an age such as “blocking T6 for 2 days,” but the current question heading has no timestamp and `questions.md` mtime applies to the whole file, not an individual question. Choosing an approximation silently would make queue ordering and displayed age misleading.
Options considered: A — use the file mtime as an explicitly approximate age / B — omit age until the factory protocol records a per-question timestamp / C — derive age from another named durable source (state that source)
**A:** B — omit the age display until the question grammar records a per-question filed-at timestamp; that timestamp is being requested in MrZoller/opencode-factory#83 so age becomes real data on a later grammar rev. T50 proceeds now without age: order entries deterministically (repo, then question id) and show no fabricated age (Chris, 2026-08-29).

<!-- factory-question-timestamps-required-below -->

## Q4 (task T49, open, filed-at 2026-08-30T14:03:37Z) — How should retries resolve an ambiguous answer-helper failure?
Context: The re-review confirmed that `factory-answers` can durably publish a pending record and then fail before factory-ui receives its UUID, so automatically releasing the idempotency reservation can create a duplicate on retry. Parked branch: `factory/t49-answer-delivery`; resolving this changes whether recovery is manual in factory-ui or requires another engine-contract extension.
Options considered: A — retain the reservation on every ambiguous helper failure and require operator verification before cleanup (recommended; fail closed and at-most-once) / B — extend the engine intake contract with a client-supplied idempotency key before shipping T49
For A, confirm that manual inspection and cleanup of a rare stranded reservation is acceptable.
**A:** A — retain the idempotency reservation on every ambiguous helper failure and require operator verification before cleanup; fail closed, at-most-once. Manual inspection and cleanup of a rare stranded reservation is acceptable (Chris, 2026-08-30).
