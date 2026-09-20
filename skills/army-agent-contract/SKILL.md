---
name: army-agent-contract
description: Writes the session contract for a fleet agent - what it may read, what it may write, what it owns, what it produces, and when it is done - and fixes agents that collide on files or widen their scope. Use for "write a contract for this subagent", "give this agent a proper charter", "two agents keep touching the same files". Not for starting the fleet, the ask protocol, or merging output.
license: MIT
---

# army-agent-contract

An agent is data. Its contract is the persisted system prompt of a named session
— which means the contract is not documentation about the agent, it *is* the
agent. Everything else about it (wake policy, budget, docs pointer) is config
around that.

## The five clauses

Every contract answers exactly these, and a contract missing one is not a
contract:

```yaml
name: release-watch
reads:                                  # allowlist
  - registry/sources.yaml
  - docs/**
writes:                                 # allowlist, DISJOINT from other live agents
  - reports/release-watch/**
owns: "tracking upstream releases for the pinned dependency set"
produces: "one report per new release, conforming to reports/schema.json"
done_when:
  - "every pinned dependency has been checked against its upstream feed"
  - "each new release has a report with a version, a date and a link"
  - "nothing is reported twice"
```

**`done_when` is the clause people get wrong.** It must be checkable by
something other than the agent's own opinion. "Researched thoroughly" is not a
completion criterion; "every pinned dependency has been checked" is.

## Disjoint write allowlists are the isolation mechanism

Two agents writing one tree is the most common failure, and coordination is the
wrong fix. Ownership rules are assigned before the code exists, and the moment
an agent discovers it needs a file it does not own it stalls, violates the rule,
or quietly duplicates the helper.

**Prefer isolation, then converge.** Give each agent a disjoint write allowlist;
where the work genuinely overlaps, give it its own git worktree and let the
conflict surface at merge time, where git already solves it and a human can see
it. Then reconcile with `army-fanin`.

The check is mechanical: if two agents that can run at the same time share a
write path, one of the two contracts is wrong.

## Named versus disposable

| | Named session | Disposable session |
| --- | --- | --- |
| Addressable | yes — humans and agents can message it | no |
| Memory | continuity capsule across runs | none |
| Use for | a standing mission | review, cross-check, alternative generation |

A reviewer is **always** disposable and **never** has write access to what it
reviews. That is not tidiness — it is the one architectural commandment this
system has: *grade the agent by something it cannot edit.* A reviewer that can
edit its own criteria is not a reviewer.

```
acpx exec        # one prompt, temporary session, no saved state
acpx compare     # the same prompt across several harnesses
```

Use `compare` for a genuinely irreversible design call, not as a default:
fan-out converts a cheap generation problem into an expensive serial review
problem and discards (N−1)/N of the work.

## Persona and mission are prompt text

They are injected per run, not baked into a process. That is precisely why an
agent can be created at runtime as pure data, and why editing one is a data
edit rather than a deployment.

Every run pins the revision it ran under, so changing a contract never rewrites
the meaning of that agent's own history.

## Scope creep is a contract bug

An agent that widens its scope is usually one whose `owns` clause is a topic
rather than a task. "Owns research" invites everything; "owns source discovery
and reliability scoring for the registry" does not.

If an agent needs to do something outside its contract, the correct behaviour is
to **stop and report**, not to proceed. That belongs in the contract explicitly.

## What an agent may never write

Regardless of its allowlist: policies, evals, gates, signed files, and CI
workflow definitions. An agent may improve its memory, its skills, its docs and
its research. It may never edit the criteria it is judged against.

## Related

`army-run` operates the fleet · `army-hitl` is how an agent asks when its
contract does not cover something · `army-join` scopes an outside reviewer.
