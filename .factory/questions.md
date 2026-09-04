# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted - mark the heading `answered` once
acted on.

---

## Q1 (task T49, consumed) — Proceed before the external answer-intake contract exists?
Context: T49 depends on MrZoller/opencode-factory#83, which is open and owns the record schema, spool location, validation, and rejection semantics. That issue belongs to another repository and cannot be widened into this repository's label-filtered import; leaving this unanswered keeps T49 waiting.
Options considered: A — proceed: drop the external prerequisite and authorize factory-ui to define a provisional contract locally.
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

## Q4 (task T49, consumed, filed-at 2026-08-30T14:03:37Z) — How should retries resolve an ambiguous answer-helper failure?
Context: The re-review confirmed that `factory-answers` can durably publish a pending record and then fail before factory-ui receives its UUID, so automatically releasing the idempotency reservation can create a duplicate on retry. Parked branch: `factory/t49-answer-delivery`; resolving this changes whether recovery is manual in factory-ui or requires another engine-contract extension.
Options considered: A — retain the reservation on every ambiguous helper failure and require operator verification before cleanup, fail closed and at-most-once (recommended) / B — extend the engine intake contract with a client-supplied idempotency key before shipping T49
For A, confirm that manual inspection and cleanup of a rare stranded reservation is acceptable.
**A:** A — retain the idempotency reservation on every ambiguous helper failure and require operator verification before cleanup; fail closed, at-most-once. Manual inspection and cleanup of a rare stranded reservation is acceptable (Chris, 2026-08-30).

## Q5 (task T68, consumed, filed-at 2026-09-01T05:56:28Z) — Should T68 receive another fix-and-review round after exhausting its panel budget?
Context:
Observable failure: An active repository's cost history can contain an invalid older task, but the dashboard currently labels the retained newer totals as Partial instead of warning that the source is unavailable. The required initial panel and one re-panel each found a blocking validation defect, so the factory protocol now requires the task to stop rather than silently taking another review round. Parked branch: `factory/t68-bounded-cost-window`.
Engine detail: The bounded reader fully parses up to 4 MiB, but validates only task entries retained by the 256 KiB recent window; a malformed older entry outside that window is therefore masked.
Options considered: A — the factory owner authorizes one additional fix-and-review round that validates every bounded-source task before retention (recommended) / B — the product owner abandons the recent-window behavior and restores fail-closed unavailability for every file above 64 KiB
Option A: The T68 implementation owner adds a full bounded validation pass, retains the requested recent-window behavior, and runs the complete suite plus one final panel.
Owner: T68 implementation owner.
Day-to-day consequence: active repositories keep partial recent costs instead of losing the panel when the file crosses 64 KiB.
Cost or risk: one exception to the normal two-panel-round convergence budget and another implementation/review pass.
Option B: The dashboard product owner accepts that repositories above 64 KiB continue to show costs as unavailable.
Owner: dashboard product owner.
Day-to-day consequence: operators lose cost visibility again as active histories grow.
Cost or risk: T68's stated acceptance and Fixes #89 outcome are not delivered and would require replanning.
Recommendation rationale: A fixes the confirmed fail-closed gap without weakening the approved bounded-window acceptance criteria.
**A:** A — the factory owner authorizes one additional fix-and-review round: validate every bounded-source task entry before retention, keep the approved recent-window behavior, full suite plus one final panel (Chris, 2026-09-01).

## Q6 (task T74, consumed, filed-at 2026-09-03T02:26:13Z) — Should T74 receive another fix-and-review round after exhausting its panel budget?
Context:
Observable failure: A maintainer writes a long, hard-wrapped option explanation, but the dashboard silently replaces the structured option details with raw question text and gives no oversized-content warning. The required initial panel and one re-panel each found a defect, so the factory protocol requires work to stop before another fix. Parked branch: `factory/t74-question-option-details`.
Engine detail: The elaboration parser enforces the existing 8,192-character structured-field bound, but its over-limit result is currently indistinguishable from malformed input and therefore does not emit `QUESTIONS_OPTION_TOO_LONG`.
Options considered: A — the factory owner authorizes one additional fix-and-review round that propagates the oversized-elaboration result (recommended) / B — the dashboard product owner abandons structured option elaboration for T74 and replans the issue
Option A: The T74 implementation owner adds the missing oversized-result signal, a regression for hard-wrapped elaboration above the field bound, and runs the complete suite plus one final panel.
Owner: T74 implementation owner.
Day-to-day consequence: maintainers receive an explicit warning and lossless raw fallback when an elaboration exceeds the structured-rendering bound.
Cost or risk: one exception to the normal two-panel-round convergence budget and another implementation/review pass.
Option B: The dashboard product owner declines another panel round and replaces T74 with a newly planned approach rather than shipping the current partial implementation.
Owner: dashboard product owner.
Day-to-day consequence: option elaboration remains unstructured until replacement work is approved and completed.
Cost or risk: Fixes #102 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A is a small bounded correction that preserves the approved structured-detail behavior and makes the existing oversized-content contract truthful.
**A:** A — the factory owner authorizes one additional fix-and-review round: propagate the oversized-elaboration result as an explicit QUESTIONS_OPTION_TOO_LONG-class warning with lossless raw fallback, add the hard-wrapped over-bound regression, full suite plus one final panel (Chris, 2026-09-03).

## Q7 (task T76, consumed, filed-at 2026-09-03T04:09:01Z) — Should T76 receive another fix-and-review round after exhausting its panel budget?
Context:
Observable failure: A maintainer follows an old question link while a different question is open, but the dashboard makes that unrelated open question impossible to answer until the maintainer manually removes the stale link from the address bar. The required initial panel and one re-panel each found a blocking defect, so the factory protocol requires work to stop before another fix. Parked branch: `factory/t76-stale-question-links`.
Engine detail: The stale-target guard is applied to every question card rather than only to the missing target identified by the URL hash; the re-panel also requested a regression proving controls recover after the hash changes.
Options considered: A — the factory owner authorizes one additional fix-and-review round that scopes suppression to the exact stale target and adds hash-recovery coverage (recommended) / B — the dashboard product owner abandons the current stale-link implementation and replans issue #93
Option A: The T76 implementation owner narrows the stale-target predicate per card, adds the requested hash-change regression, and runs the complete suite plus one final panel.
Owner: T76 implementation owner.
Day-to-day consequence: stale links still show an inert explanation while unrelated open questions remain answerable.
Cost or risk: one exception to the normal two-panel-round convergence budget and another implementation/review pass.
Option B: The dashboard product owner replaces T76 with a newly planned approach rather than shipping the parked implementation.
Owner: dashboard product owner.
Day-to-day consequence: stale question links continue to provide no dedicated explanation until replacement work is approved and completed.
Cost or risk: Fixes #93 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A is a small scoped correction that preserves the validated stale-target and lifecycle behavior without blocking unrelated questions.
**A:** A — the factory owner authorizes one additional fix-and-review round: scope stale-target suppression to the exact missing target per card, add the hash-change recovery regression, full suite plus one final panel (Chris, 2026-09-03).

## Q8 (task T74, consumed, filed-at 2026-09-03T10:50:48Z) — Should T74 receive another fix-and-review round for an unknown-field fallback defect?
Context:
Observable failure: A maintainer adds a future labelled field after the option list, but the dashboard displays that field as part of the final option instead of preserving the complete question as raw text. The operator-authorized final panel found this blocking defect, so work is parked on branch `factory/t74-question-option-details` before another unapproved round.
Engine detail: When no recognized elaboration prefix appears, the parser includes every line through `**A:**` in the options slice and never applies its unknown-envelope-field guard.
Options considered: A — the factory owner authorizes one additional fix-and-review round that detects a standalone unknown trailing field (recommended) / B — the dashboard product owner abandons the current structured-elaboration implementation and replans issue #102
Option A: The T74 implementation owner detects unknown labelled fields throughout the options-to-answer region, preserves the whole question through raw fallback, adds a focused regression, and runs the complete suite plus one final panel.
Owner: T74 implementation owner.
Day-to-day consequence: future question fields remain visible and are not misrepresented as option text.
Cost or risk: one more exception to the normal panel-round budget and another implementation/review pass.
Option B: The dashboard product owner replaces T74 with a newly planned approach rather than shipping the parked implementation.
Owner: dashboard product owner.
Day-to-day consequence: structured option elaboration remains unavailable until replacement work is approved and completed.
Cost or risk: Fixes #102 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A is a bounded parser correction that restores the implementation's documented lossless-fallback contract.
**A:** A — the factory owner authorizes one additional fix-and-review round: detect standalone unknown labelled fields throughout the options-to-answer region and preserve the complete question via raw fallback, with a focused regression, full suite, and one final panel (Chris, 2026-09-03).
## Q9 (task T76, consumed, filed-at 2026-09-03T11:04:08Z) — Should T76 receive another fix-and-review round for hidden answer lifecycle status?
Context:
Observable failure: A maintainer follows an old numeric question link after an answer attempt, but the dashboard hides that answer's pending or rejected status and its rejection reason even though the matching question is still open. The operator-authorized final panel found this blocking defect, so work is parked on branch `factory/t76-stale-question-links` before another unapproved round.
Engine detail: The legacy numeric link is normalized to the open question id and suppresses answer controls, but the stale-target return also skips the existing lifecycle renderer.
Options considered: A — the factory owner authorizes one additional fix-and-review round that renders matched lifecycle status without answer controls (recommended) / B — the dashboard product owner abandons the current stale-link implementation and replans issue #93
Option A: The T76 implementation owner renders any matched pending, accepted, or rejected lifecycle on the stale target with resume and submission controls disabled, adds legacy-link regressions, and runs the complete suite plus one final panel.
Owner: T76 implementation owner.
Day-to-day consequence: maintainers using an old numeric link can still see the durable answer outcome without being offered a duplicate submission.
Cost or risk: one more exception to the normal panel-round budget and another implementation/review pass.
Option B: The dashboard product owner replaces T76 with a newly planned approach rather than shipping the parked implementation.
Owner: dashboard product owner.
Day-to-day consequence: stale question links continue to lack a dedicated explanation and preserved lifecycle display until replacement work is approved and completed.
Cost or risk: Fixes #93 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A reuses the existing inert lifecycle renderer and directly restores the acceptance requirement without widening the feature.
**A:** A — the factory owner authorizes one additional fix-and-review round: render matched pending/accepted/rejected lifecycle on the stale target with resume and submission controls disabled, add legacy-link regressions, full suite plus one final panel (Chris, 2026-09-03).

## Q10 (task T74, consumed, filed-at 2026-09-03T18:55:56Z) — Should T74 receive a fifth panel round for two newly confirmed defects?
Context:
Observable failure: A maintainer uses a numbered future field such as `Future field v2:` and the dashboard still appends it to the final option; when option details contain balanced backticks, the dashboard also shows the backticks literally instead of the established monospace treatment. The Q8-authorized panel confirmed both defects after the standalone-field fix. Work is parked on branch `factory/t74-question-option-details`.
Engine detail: The unknown-field detector excludes digits from labels, and the new detail/rationale rendering paths bypass the bounded inline-code renderer added by T75. Four panel rounds have now run for T74, reaching the standing delegation's human-escalation threshold.
Options considered: A — the factory owner authorizes one additional fix-and-review round for both confirmed defects (recommended) / B — the dashboard product owner abandons the current structured-elaboration implementation and replans issue #102
Option A: The T74 implementation owner accepts digits in unknown protocol labels, routes elaboration fields and recommendation rationale through the bounded inline-code renderer, adds focused reader and both-surface browser regressions, and runs the complete suite plus one final panel.
Owner: T74 implementation owner.
Day-to-day consequence: future numbered fields preserve lossless raw fallback and inline code remains consistent throughout structured questions.
Cost or risk: this authorizes a fifth panel round after repeated distinct defects in the same task.
Option B: The dashboard product owner replaces T74 with a newly planned approach rather than shipping the parked implementation.
Owner: dashboard product owner.
Day-to-day consequence: structured option elaboration remains unavailable until replacement work is approved and completed.
Cost or risk: Fixes #102 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A addresses two bounded, reproduced integration gaps without changing the approved question grammar or rendering trust boundary.
**A:** A — the factory owner authorizes one additional fix-and-review round for both confirmed defects: accept digits in unknown protocol labels and route elaboration fields plus recommendation rationale through the bounded inline-code renderer, with focused reader and both-surface browser regressions, full suite, and one final panel. Owner proviso: a sixth budget question on this task is answered with a ship-what-passes-and-split plan, not another round (Chris, 2026-09-03).
## Q11 (task T76, consumed, filed-at 2026-09-03T19:15:20Z) — Should T76 receive a fifth panel round for a stale peer-link defect?
Context:
Observable failure: A maintainer follows an old numeric question link for a peer machine, sees a warning that the target is stale, but is also offered a link that opens an unrelated live question's answer form on that peer. The Q9-authorized panel confirmed this defect after the matched-lifecycle fix. Work is parked on branch `factory/t76-stale-question-links`.
Engine detail: Peer question cards return before the local stale-target guard and still build an owning-dashboard link from the normalized `Q<n>` identifier. Four panel rounds have now run for T76, reaching the standing delegation's human-escalation threshold.
Options considered: A — the factory owner authorizes one additional fix-and-review round that suppresses the peer owner link for the exact stale target (recommended) / B — the dashboard product owner abandons the current stale-link implementation and replans issue #93
Option A: The T76 implementation owner gates the peer owner link on the stale-target check, adds a focused peer regression, and runs the complete suite plus one final panel.
Owner: T76 implementation owner.
Day-to-day consequence: old numeric peer links remain inert while valid canonical peer links continue to reach their owning dashboard.
Cost or risk: this authorizes a fifth panel round after repeated distinct defects in the same task.
Option B: The dashboard product owner replaces T76 with a newly planned approach rather than shipping the parked implementation.
Owner: dashboard product owner.
Day-to-day consequence: stale question links continue to lack a complete safe explanation until replacement work is approved and completed.
Cost or risk: Fixes #93 remains undelivered and the parked implementation may be discarded.
Recommendation rationale: A is a bounded peer-path correction that prevents the stale warning from leading directly to an unrelated answer form.
**A:** A — the factory owner authorizes one additional fix-and-review round: gate the peer owner link on the exact stale-target check, add the focused peer regression, full suite plus one final panel. Owner proviso: a sixth budget question on this task is answered with a ship-what-passes-and-split plan, not another round (Chris, 2026-09-03).

## Q12 (task T74, consumed, filed-at 2026-09-04T00:47:35Z) — How should the repeatedly failing question-parser work be split?
Context:
Observable failure: A maintainer adds a future labelled field such as `2FA policy v2:` or `Future_field:`, but the dashboard displays it as part of the final answer option instead of preserving the complete question as raw text. T74's owner-authorized fifth panel found this new blocking case, so the task cannot ship under the factory review rules. Work is parked on branch `factory/t74-question-option-details`.
Engine detail: The unknown-field detector recognizes labels made from letters, digits, spaces, and hyphens only when they begin with a letter. Expanding that detector safely needs another reviewed change, but the Q10 answer directs a sixth budget question toward a ship-what-passes-and-split plan rather than another T74 panel round.
Options considered: A — replace T74 with two fresh standard tasks that reuse the parked work (recommended) / B — abandon the parked implementation and replan issue #102 from scratch as one fresh standard task
Option A: Mark T74 dropped; create T77 for the option elaboration, detail, rationale, oversized fallback, and inline-code rendering already present on the parked branch; create dependent T78 to complete conservative unknown trailing-field fallback for letter-, digit-, and punctuation-bearing labels and carry `Fixes #102`; each fresh task receives the normal verification and panel budget before shipping.
Owner: factory-ui product owner and the implementation owners of T77 and T78.
Day-to-day consequence: the independently reviewable rendering work can ship first, while parser fallback hardening follows without granting T74 a sixth panel round.
Cost or risk: two PRs and duplicated integration verification, plus careful extraction from the parked branch.
Option B: Mark T74 dropped, discard the parked implementation, and create one new standard task that redesigns all issue #102 parsing and rendering behavior without reusing the branch.
Owner: factory-ui product owner and the replacement task's implementation owner.
Day-to-day consequence: no part ships until the complete replacement passes a fresh review cycle.
Cost or risk: more reimplementation time, but the replacement starts without T74's accumulated parser assumptions.
Recommendation rationale: A follows the owner's ship-what-passes-and-split direction while restoring a fresh review budget around the unresolved blocking parser boundary.
**A:** A — replace T74 with two fresh standard tasks that reuse the parked work Answered by Chris via operator. [factory-answer-intake: bf0bdba7-3f5c-4262-846c-0123a2a0907f]

## Q13 (task T71, open, filed-at 2026-09-04T04:18:41Z) — Should T71 receive another fix-and-review round for interleaved future fields?
Context:
Observable failure: A maintainer places a future field such as `Future field v2:` between two answer options, but the dashboard appends that field to the first option and presents it as selectable answer text. The required initial panel and one re-panel each found a blocking defect, so work is parked on branch `factory/t71-parked-review-minors` before another unapproved round.
Engine detail: The interleaved-field guard recognizes punctuation-bearing labels but deliberately leaves ordinary `Note:` prose alone; it does not yet distinguish a multiword alphanumeric future-field label from that prose.
Options considered: A — authorize one additional bounded fix-and-review round for multiword alphanumeric future fields (recommended) / B — abandon T71's interleaved-field change and replan that review minor separately
Option A: The T71 implementation owner recognizes the documented `Future field v2:` class without treating ordinary `Note:` continuations as protocol fields, adds a paired regression, and runs the complete suite plus one final panel.
Owner: T71 implementation owner.
Day-to-day consequence: future fields remain lossless while ordinary colon-bearing option prose stays structured.
Cost or risk: one exception to the normal two-panel-round convergence budget and another implementation/review pass.
Option B: The dashboard product owner removes the incomplete interleaved-field change from T71 and creates a fresh standard task for a redesigned discriminator.
Owner: dashboard product owner.
Day-to-day consequence: the other four parked minors can ship, but interleaved alphanumeric fields remain raw-parser debt until replacement work lands.
Cost or risk: another PR and delayed completion of the PR #108 review minor.
Recommendation rationale: A is a bounded correction for the exact documented field class and preserves the existing conservative treatment of ambiguous prose.
**A:** A — authorize one additional bounded fix-and-review round: recognize the multiword alphanumeric future-field class (`Future field v2:`) without reclassifying ordinary `Note:` continuations, paired regression, complete suite plus one final panel. Factory recommendation and operator assessment agree (distinct bounded defect, T71 round 3, no scope growth); answered by the operator session under the agreed-recommendation delegation and the 2026-09-03 panel-round delegation (operator, 2026-09-04).
