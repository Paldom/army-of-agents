---
name: army-hitl
description: Implements non-blocking human-in-the-loop for a running agent fleet - agents ask in-thread and release their session, verdicts bind the exact action, and expiry pauses rather than approves. Use for "my agent blocks waiting for approval", "an agent acted on a stale approval". Not for writing contracts, starting the fleet, or merging output.
license: MIT
---

# army-hitl

The agent asks, **releases its session**, and ends its turn. The human answers
minutes or hours later. The next dispatch carries the verdict.

Nothing is parked in memory, no callback waits, no watchdog can trip, and a
reboot between the question and the answer costs exactly nothing.

## Why it cannot work any other way

The obvious design — the agent asks mid-turn and blocks until a human replies —
does not survive contact with the transport. Verified by reading acpx's
`src/permissions.ts`: when a permission policy says `escalate` and there is no
TTY, which is always true for a headless supervisor,
`resolveEscalatingPermissionRequest` emits a `permission_escalation` event and
**immediately answers with the reject option**.

Escalation is "deny now, loudly" — not "ask and wait". Build a HITL flow on it
and every question becomes a silent denial.

So: **HITL is agent-initiated, never permission-initiated.** ACP permissions are
used only as a fail-closed tool boundary (`autoApprove` / `autoDeny`). Questions
are rows.

## The cycle

```
agent reaches something its contract does not cover
  └─ writes an ask row + a channel message, then ENDS ITS TURN
       (session released — zero quota, zero processes held)
              …hours pass. a reboot here costs nothing…
  └─ human answers in the thread
  └─ SAME TRANSACTION: record the verdict AND bump the agent's wake
  └─ next tick dispatches a fresh body with the verdict in its capsule
```

That "same transaction" is not a detail. With the wake bump on a separate path,
an agent whose question was answered goes terminal, leaves `next_due_at` NULL,
and **sleeps forever with its work done**.

There is a second, subtler version of the same bug, and it is worth naming
because atomicity alone does not prevent it. The agent writes its ask *during*
dispatch, so the workspace shows the question while the run is still settling. A
fast human answers, the wake is bumped — and then dispatch returns `BLOCKED` and
the settle path writes `next_due_at = NULL` straight over it. Two correct
transactions, no ordering between them, and the verdict is gone.

**A human bump outranks a scheduler-computed wake, always.** The settle path
checks for a verdict answered since the run started and leaves it alone.

## The agent has to be told how to ask

The cycle above only starts if the agent knows the marker. Dispatch matched an
`OUTCOME:` line for a while that no prompt ever requested — so every run parsed
as unclassified, fell through to `NO_WORK`, and backed off as though the fleet
were idle while it was working. In the same period `ask()` had no caller except
the importer, so a running agent had no route to a human at all.

A contract asserted on one side is not a contract. Both markers ship in the
capsule itself, last, so they are the freshest thing in context when the agent
writes its closing lines:

```
OUTCOME: WORK_DONE | NO_WORK | BLOCKED | RATE_LIMITED | RETRYABLE_ERROR

ASK: Should the report include last quarter's figures?
OPTIONS: yes | no | only if the source is cited
```

Plain text, not a tool call, because it must behave identically on every harness
acpx can drive. `OPTIONS` is optional — without it the owner types a reply, with
it they pick one, and each option carries a stable id so a verdict binds to the
id rather than to the label a human happened to read. An omitted `OUTCOME` is
read as `NO_WORK`: an agent that did not say it made progress is not assumed to
have made any.

The agent **ends its turn** after asking. Nothing in a headless environment can
deliver an answer mid-turn, and acpx auto-answers a permission escalation with
the reject option — so waiting is not patience, it is a hang.

## A verdict binds the exact action

A free-text "yes" never authorizes an effect. Every approval binds three things:

- the **action hash** — a digest of the operation *and its parameters*
- the **policy version** in force when it was asked
- the **run version** it was asked at

If any drifted while the ask sat, it is **re-asked, not honoured**. This matters
because a re-dispatched run is a fresh plan, not a replay: the agent may take a
different route to the same intent, and a verdict that only meant "permission to
proceed" would slide straight through. Pin the operation, not the intent.

An option that was never offered is not an answer either.

## Five refusals, all deliberate

| Refusal | Why |
| --- | --- |
| **Gated** | Money-critical verbs are not answerable in the workspace. It renders the card and says so, showing that no grant was minted. The workspace holds owner authority for everything else; it holds no mint for verbs that move value. |
| **Stale** | The world moved while the ask sat. Re-ask. |
| **Unbindable** | The ask is bound, and the answer did not carry the binding. **Fail closed**: a guard that is optional for its caller is not a guard, and omitting the binding must never be the easy path to approval. |
| **Empty** | A blank submit is not an answer. An options ask needs a chosen option; a free-text ask needs non-whitespace. |
| **Unknown option** | Answers come from the offered set. |

The client echoes back the binding it was shown. If the action or the policy
moved while the ask sat, the echo no longer matches and the server re-asks.

The gated refusal is a **guardrail against agent-obtained approval, not a wall
around the owner** — an owner with a shell can always run the command. Its
purpose is that no agent can ever acquire authority by getting a "yes" typed
into a thread. Say that in your docs rather than implying it is airtight.

## Expiry never approves

An unanswered ask expires by **pausing the agent and filing a report**. It never
auto-approves, not even with a "safe default" flag. The unresolved decision
returns to the backlog rather than vanishing.

## The status distinction the UI must preserve

`WAITING_HUMAN` and `BLOCKED` mean *you are the blocker*. `WAITING_RESOURCE`,
`BACKING_OFF`, `SCHEDULED`, `WAITING_EVENT` and `MANUAL` mean *nothing is
wrong*. Only the first group may badge, count or notify.

Collapse those two groups into one grey "idle" and you have rebuilt the problem
this system exists to solve.

## Replacing markdown approval files

Run both, with a stated split. The workspace becomes the day-to-day owner
channel; a signed file-based channel stays the sole authority for money-critical
verbs. The workspace may *display* the signed channel; it writes to it never.

If the existing channel derives its authenticity from git authorship, the
workspace cannot borrow that — so it needs authentication of its own, of equal
strength. Never forge owner authorship to make a migration tidy.

## Related

`army-run` operates the loop · `army-agent-contract` decides what needs asking in
the first place · `army-workload-adapter` migrates an existing approval channel.
