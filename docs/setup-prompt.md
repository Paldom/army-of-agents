# Setup prompt

Paste this into a fresh agent session inside a project you want orchestrated.
It runs the skills in dependency order and stops at the first thing only you can
decide.

```
/goal Stand up an army-of-agents fleet against this project and leave it running with at least one agent doing real work. NEVER git commit or push; leave changes in the working tree for me.

ORDER — each step depends on the one before it:

1. army-workload-adapter. Read this project first. Import any existing agent roster and per-agent charters; if there is none, say so rather than inventing agents. Tail any existing human-facing files (an outbox, a standing backlog, a decisions log) READ-ONLY into the workspace. Change nothing inside the project in this step.

2. STOP and ask me one question before any write path opens: how should an answer I type in the workspace be attributed? If this project has an owner channel whose authenticity comes from git authorship, you may not borrow it. Offer the three options (peer channel and never write it; write but mark unverified; a new mechanism of equal strength) and wait for my answer.

3. army-agent-contract. Write a contract for each agent: reads, writes, owns, produces, done_when. Write allowlists MUST be disjoint across agents that can run at the same time — check this mechanically and fix the contract, not the schedule. Make done_when checkable by something other than the agent's own opinion.

4. army-run. Start the supervisor and the workspace. Read the Doctor on the Status screen (or `./scripts/aoa doctor`) before anything else: a turn that cannot start usually fails one of its checks. Then verify by watching one agent go through a full cycle: due, precondition, dispatch, outcome, next wake. If the precondition returns false, that is a correct idle tick, not a fault. Confirm a REPORT line the agent writes mid-turn appears in its thread before the turn ends.

5. army-hitl. Make one agent ask me a real question and confirm the whole path: it releases its session, I answer later, and the next dispatch carries the verdict. Confirm that answering bumps the wake in the same transaction.

6. army-join, only if I have a second harness logged in. Grant a reviewer join for one agent and confirm the joiner's output lands marked untrusted and cannot resolve an ask.

7. army-fanin, only once two or more agents have produced worktrees. Do not fabricate branches to demonstrate it.

RULES:
- Investigations may run immediately. Anything that changes the fleet goes through a plan I apply.
- Never invent agents, channels or accounts to make a screen look populated. An empty fleet is a valid state.
- Never write to policies, evals, gates or signed files, whatever an agent's allowlist says.
- Never show a credential value. Name its keychain item.
- If a vendor lane is exhausted, that is normal. Back off the lane, do not retry the agent.

DONE WHEN:
- The supervisor and workspace are both running against this project.
- At least one agent has completed a full ask -> answer -> resume cycle across a restart.
- Every contract has five clauses and disjoint write allowlists.
- You have told me exactly what you changed and what you left alone.
```

## What to expect

The first run is mostly reading. Step 2 is a real stop: attribution is a decision
about trust in your project, and guessing it wrong is worse than waiting.

Steps 6 and 7 are conditional on purpose. A reviewer with nothing to review and a
fan-in with one branch are demos, not verifications.
