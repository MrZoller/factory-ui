# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted - mark the heading `answered` once
acted on.

---

## Q1 (task T49, open) — Proceed before the external answer-intake contract exists?
Context: T49 depends on MrZoller/opencode-factory#83, which is open and owns the record schema, spool location, validation, and rejection semantics. That issue belongs to another repository and cannot be widened into this repository's label-filtered import; leaving this unanswered keeps T49 waiting.
Options considered: Proceed — drop the external prerequisite and authorize factory-ui to define a provisional contract locally.
**A:**

## Q2 (task T49, open) — What should authorize answer delivery over the tailnet?
Context: T49 introduces the first write-capable endpoint into a service that is currently strictly read-only. The issue leaves the trust boundary open, and the choice changes configuration, CORS, audit identity, deployment, and security tests.
Options considered: A — rely on existing tailnet ACLs and record a configured actor identity / B — require a minimal shared secret plus actor identity / C — wait for a different authenticated intake design (recommended if neither A nor B is acceptable)
**A:**

## Q3 (task T50, open) — What is the authoritative filed-at time for a question?
Context: Issue #60 requires an age such as “blocking T6 for 2 days,” but the current question heading has no timestamp and `questions.md` mtime applies to the whole file, not an individual question. Choosing an approximation silently would make queue ordering and displayed age misleading.
Options considered: A — use the file mtime as an explicitly approximate age / B — omit age until the factory protocol records a per-question timestamp / C — derive age from another named durable source (state that source)
**A:**
