---
name: army-fanin
description: Reconciles parallel agent worktrees into one repository with per-change provenance - which agent, which harness, what cost, tests passed - then archives losers and reaps worktrees. Use for "merge the worktrees my agents produced", "which agent wrote this change". Not for ordinary git conflicts, rebasing, or starting the fleet.
license: MIT
---

# army-fanin

Fan-out is easy and increasingly commoditised. Every multi-agent flow ends at N
worktrees, N diffs, one repository, and a human reconciling them in a terminal.
**Fan-in is where the work actually is.**

## What this adds that git cannot

Git supplies the diffs. It cannot tell you, for any given change:

- **which agent** produced it
- **on which harness**
- **at what cost**
- **whether its tests passed**

Without that provenance a fan-in view is git with a UI. Ship the provenance or
do not ship the view.

```
| path        | agent     | harness | cost      | tests     |
| ----------- | --------- | ------- | --------- | --------- |
| src/a.ts    | mechanic  | codex   | 12480 tok | passed    |
| src/b.ts    | archivist | claude  | 21104 tok | passed    |
| docs/c.md   | scribe    | gemini  | $0.03     | 1 failed  |
```

## Evidence, not "trust me"

A change is **not selectable** when:

- its agent or harness is unknown — refusing an anonymous change is the point
- its test result is unknown — "probably fine" is not a result
- its tests failed

This is not strictness for its own sake. The reason to run agents in parallel is
that you cannot review everything by hand; if the gate is "a human squints at
it", you have bought nothing.

## The merge plan is explicit

```
1. Apply the selected changes to an integration worktree
2. Run the repository gate                                  ← the gate step
3. Fast-forward the target and write the provenance manifest
```

Conflict order and test gates are stated, not implied. The manifest is written
**as part of the merge**, so "where did this line come from?" has a durable
answer six months later.

## Never ship fan-out without fan-in

Worktrees accumulate. Disk fills, `git worktree list` becomes noise, and nobody
remembers which branch was the good one. Every fan-in therefore ends with:

- **losers archived**, as inspectable bundles — not deleted, because the reason
  a branch lost is sometimes wrong
- **merged worktrees reaped**, because that is the only way the directory stays
  meaningful

An integration step that archives the losers is what closes the loop. Without
it, fan-out is a mess generator with a nice progress bar.

## When not to fan out at all

Most of the time. The pattern only pays when:

| Situation | Pattern |
| --- | --- |
| Separable work — different services, packages, docs vs code | fan out, then fan in |
| One feature, several stages | pipeline; no fan-in needed |
| One agent needs a detail from another | peer relay |
| An irreversible design call | fan out deliberately, once |
| A cheap objective scorer exists | race with a judge |
| **Anything else** | **one agent** |

Fan-out on one feature inside one codebase collides on exactly the files that
matter — route tables, schemas, manifests, lockfiles, barrel indexes, shared
fixtures, migrations — because tasks partition by feature and features cut
across files.

The cost nobody prices is **review**. Machine time is cheap and parallel; the
human reading diffs is neither. A multi-agent design that does not reduce review
time is a cost with extra steps.

## Related

`army-agent-contract` gives each agent a disjoint write allowlist so isolation
is structural · `army-run` operates the fleet that produced the branches ·
`army-join` brings in an outside reviewer for a contested change.
