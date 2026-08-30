# Cross-check: skill split and load-bearing invariants

**Date:** 2026-08-28 · **Verdict:** revise, then proceed. Four defects found, all
reproduced, all fixed, all now covered by regression tests.

## How this was run

`/cross` was attempted first and could not run: its only configured provider
returned `HTTP 429 … credit_balance_exhausted`. The goal prompt names **acpx** as
the alternative, and acpx runs on subscription logins rather than API keys, so
the review was performed there instead — two independent harnesses
(**GPT-5.6 Sol** and **Claude Opus 5**), each given the same adversarial prompt
and told to default to finding something wrong.

Both reviewers independently found the same class of defect. That agreement is
the reason these were treated as real rather than as reviewer noise.

## Findings and disposition

| # | Finding | Reviewers | Disposition |
| --- | --- | --- | --- |
| 1 | `answer()` bindings were **fail-open**: the action-hash and policy-version comparisons only ran when the caller happened to supply the current values, so omitting them skipped the check entirely | both | **FIXED.** Reproduced, then made fail-closed with a new `unbindable` refusal. The client now echoes the binding it was shown. |
| 2 | A **blank submit approved**: on an options ask, `{by}` alone skipped option validation, stored `''` and set the row `APPROVED` | both | **FIXED.** Reproduced, then added an `empty` refusal for both options and free-text asks. |
| 3 | **Lost wake.** The agent writes its ask mid-dispatch, so a fast human can answer before `dispatch()` returns; `succeed(BLOCKED)` then blind-wrote `next_due_at = NULL` over the verdict bump | Claude | **FIXED.** Reproduced. `succeed()` now checks for a verdict answered since the run started; a human bump outranks a scheduler-computed wake. |
| 4 | A **precondition-false tick created a run row**, contradicting the code's own comment and putting a phantom iteration in history for every idle tick | Claude | **FIXED.** Replaced with `backoffWithoutRun()`: the streak advances, no run is recorded. |
| 5 | Dead `getAgent(...)!` / `void agent` in `answer()` | Claude | **FIXED.** Removed. |

## Claims, re-judged after the fixes

**Claim 1 — atomicity of terminalise + successor wake.** Both reviewers called
this *overstated as written*, and they were right for a reason better than the
one they gave: atomicity was necessary but **not sufficient**, because finding 3
is a lost update across two individually-atomic transactions. The invariant now
holds; the wording in `army-hitl` was corrected to describe both halves.

**Claim 2 — bound verdicts.** Principle **holds**; the implementation **failed**
(finding 1) and now holds. Run-version binding remains declared-but-unchecked and
is recorded below as a known gap rather than claimed as done.

**Claim 3 — the LLM-free precondition.** GPT-5.6 Sol is right that this is not a
*correctness* requirement: a system without it is still correct, just expensive.
It is mandatory for **economic viability**, not for correctness, and the skill
text should not blur those. Claude's sharper point — that a false-negative
precondition decays an agent to the ceiling and it never runs to discover the
check was wrong — is a genuine limitation and is recorded below.

## Trigger overlap

Both reviewers flagged **`army-run` × `army-hitl`**, with essentially the same
misrouting prompt: *"my agent stopped waking after it asked me something."*
"Stopped waking" routes to `army-run`; the cause lives in `army-hitl`.

**Accepted as a real ambiguity, and deliberately not "fixed" by rewording.** The
prompt is genuinely ambiguous, and `army-run`'s diagnostic ladder sends the
reader to the right place on step 1 (`wake_reason = human` means blocked on you).
Splitting the trigger finer would make both descriptions worse. Recorded, not
papered over.

Claude's second flag, **`army-join` × `army-hitl`** on *"approve from a different
session"*, is real but resolves correctly either way: `army-join` states that a
joined session can never resolve an ask, which is the answer the user needs.

## Known gaps, recorded rather than closed

1. **Run-version binding is declared but never checked.** `approval_requests`
   carries `run_version`; `answer()` does not read a run row. A re-dispatched run
   still matches the old verdict through `row.run_id`. Action-hash binding covers
   the dangerous case (a changed plan), so this is a hardening gap, not an open
   hole.
2. **A false-negative precondition degrades to the ceiling.** A cheap check that
   wrongly says "nothing to do" pushes the agent toward `maxMs` and it never runs
   to discover the mistake. Mitigation today is that the check is per-agent and
   author-controlled; a periodic forced dispatch would close it.
3. **`RATE_LIMITED` relies on an external lane-reopen writer**, the same
   cross-transaction shape as finding 3. It is safer because the gate is a
   durable row read on every tick rather than a wake that can be overwritten, but
   it is the same structure and deserves a test.
