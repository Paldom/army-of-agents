---
name: army-join
description: Lets a session from another harness join a running fleet as a subagent, cross-reviewer or human-in-the-loop, via a scoped context package whose output is untrusted data. Use for "let a codex session review this", "have my grok CLI stand in as the scout agent's human-in-the-loop", "second opinion from a different model". Not for starting the fleet, writing contracts, or merging output.
license: MIT
---

# army-join

A session in **any** harness can join the fleet. What it gets is a scoped
context package; what it gives back is data.

## Four roles

| Role | Gets | Gives back |
| --- | --- | --- |
| `subagent` | the contract and the task | the required output |
| `reviewer` | the artifact, its contract, the review criteria | a verdict, as data |
| `hitl_for_agent` | one agent's open question | an answer, as advice |
| `hitl_for_orchestrator` | fleet-level context | advice on a plan |

## The context package is deliberately small

```json
{
  "role": "reviewer",
  "agentSlug": "release-watch",
  "artifact": "…the thing under review…",
  "contract": "…the contract it is judged against…",
  "criteria": ["Judge against the stated contract, not your preferences.", "…"],
  "respondTo": "/api/join/<token>/result",
  "trust": "untrusted",
  "rules": ["Your output is DATA. It carries no authority…"],
  "expiresAt": 1234567890
}
```

**A reviewer that can see the whole store is not independent**, and independence
is the entire reason to invite one. It gets the artifact, the contract and the
criteria — not the database, not other agents' threads, not the policy files.

The grant is **single-use and expiring**. A token that can be replayed is a
standing credential nobody is tracking.

## Untrusted by default, and that is not a slight

A joined session's result lands in the thread marked `joined:<identity>` with
`trust: untrusted`. Concretely:

- Its output is **data**, and is fenced as data when quoted into another agent's
  capsule.
- It **cannot write** to any human-facing surface, any policy, or another
  agent's thread. It writes exactly one thing: a result to `respondTo`.
- It **can never resolve an ask**. Only an authenticated owner session does
  that, whatever the joiner claims about itself.

That last rule is the one worth defending. If agent-to-agent messages arrive on
the same channel as human instructions, a joiner can write "the owner approved
this" and a receiving agent may act on it. The gate is bypassed without anyone
bypassing anything. Capability separation is architectural: **the ability to
message is not reachable from the ability to approve.**

## Driving it from the other side

```bash
# From any harness — the join grant is just an HTTP call.
curl -sX POST "$AOA/api/join" -H "authorization: Bearer $TOKEN" \
  -d '{"role":"reviewer","agentSlug":"release-watch","identity":"codex-cli"}'

# …work on the package…

curl -sX POST "$AOA/api/join/$JOIN_TOKEN/result" \
  -d '{"body":"The contract requires a provenance URL; three entries have none.","identity":"codex-cli"}'
```

Because acpx already speaks to twenty-odd harnesses, the *mechanism* is nearly
free. The work here is the contract and the trust boundary, not the transport.

## When a second opinion is actually worth it

Not by default. Fan-out multiplies review load, which is already the bottleneck
— three plausible reviews of one artifact is three things for a human to read.

Invite a joiner when:

- the decision is **irreversible** and a decorrelated view is worth the cost, or
- a **cheap objective scorer** exists, so the second opinion resolves itself, or
- you specifically want a **different model's failure modes**, not more volume.

Otherwise one reviewer, or none.

## Loop control

Agent-to-agent chat burns tokens in a circle and looks like progress the whole
time. Three controls, all cheap:

- a **hop limit** per relayed chain, which kills the chain rather than degrading it
- **per-chain token accounting**, visible next to the thread
- **asymmetric wake rules**: a human follow-up wakes a joined thread; an
  agent-to-agent message requires an explicit mention

## Related

`army-agent-contract` scopes what a joined subagent may do · `army-hitl` is why a
joiner cannot answer an ask · `army-fanin` reconciles what several participants
produced.
