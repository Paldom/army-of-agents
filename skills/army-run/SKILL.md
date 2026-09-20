---
name: army-run
description: Starts and operates a continuously running agent fleet - supervisor loop plus web workspace - and diagnoses a loop that is not dispatching or an agent that stopped waking. Use for "start the agent army", "bring up army-of-agents", "launch the continuous agent system", "the supervisor isn't dispatching". Not for contracts, the ask protocol, adapting a project, or merging output.
license: MIT
---

# army-run

Two processes and one database. The **supervisor** owns the loop; the
**workspace** is how a human sees and steers it. Both read the same SQLite file,
and that file is the system — restart either process and nothing is lost,
because nothing consequential ever lived in memory.

## Start it

```bash
cd app && npm install                       # once

AOA_DB=./aoa.db AOA_PROJECT_ROOT=/path/to/project make -C .. supervisor &
AOA_DB=./aoa.db AOA_PROJECT_ROOT=/path/to/project make -C .. serve
```

The workspace prints its URL and an auth token. Open
`http://127.0.0.1:8787/?token=…`.

| Variable | Meaning |
| --- | --- |
| `AOA_DB` | The store. One file. Back this up and you have backed up the fleet. |
| `AOA_PROJECT_ROOT` | The project being orchestrated; the file browser is rooted here. |
| `AOA_PORT` | Workspace port (default 8787). |
| `AOA_TICK_MS` | Supervisor interval (default 15000). |
| `AOA_TOKEN` | Fixed auth token; one is generated per boot if unset. |

**An empty fleet is a valid starting state.** Do not invent agents to make the
screen look busy. Create them through the orchestrator, which proposes and waits
(`army-agent-contract`).

**The orchestrator is never missing.** Both processes create its row on start
if the store has none: active, woken by messages, on the harness named by
`AOA_ORCHESTRATOR_HARNESS` (default `claude`). It is considered before every
other agent and keeps one dispatch slot beyond `AOA_MAX_IN_FLIGHT`, so a busy
fleet cannot make it unreachable. It cannot be retired; pause it instead.

## Read the doctor first

`./scripts/aoa doctor <project>` (or Status in the workspace) runs the LLM-free
checks: node, acpx, each harness CLI on PATH, tmux, node-pty, git, the state
directory, the browser toolchain, voice, the event hook, and whether the
orchestrator's harness matches the environment. Optional pieces show as `off`
with what turning them on changes. A turn that cannot start usually fails one
of these, and none of them is an agent's fault.

## What the loop actually does each tick

```
for each ACTIVE agent whose next_due_at has passed and has no live run:
  cheap LLM-FREE precondition   -> false: end the tick, no run, no cost
  vendor lane free?             -> no:    WAITING_RESOURCE
  budget available?             -> no:    PAUSE and file a refill card
  reserve budget, open a run, assemble the capsule
  drive a named acpx session, stream NDJSON into the thread
  classify the outcome -> compute the next wake, in ONE transaction
```

The outcome vocabulary is the whole scheduler:

| Outcome | Next wake |
| --- | --- |
| `WORK_DONE` | the floor interval; idle streak resets |
| `NO_WORK` | exponential backoff with jitter, capped |
| `RATE_LIMITED` | none — the **vendor lane** backs off, durably, for every agent on it |
| `BLOCKED` | **none at all** — only an insert (a verdict) moves it |
| `RETRYABLE_ERROR` | short bounded retry against `error_streak` |

## Diagnosing "nothing is happening"

Work down this list. Most of it is not a fault.

0. **Is the loop ticking?** Status shows the supervisor's last tick and a red
   banner when it is stale. The workspace records answers and messages
   without it, but nothing wakes until it runs.
1. **Is anything due?** An agent with `next_due_at` in the future is scheduled,
   not stuck. An agent with `next_due_at` NULL is one of four different things —
   read `wake_reason` to tell them apart. `human` means blocked on you;
   `manual` and `event` mean it is waiting correctly.
2. **Is the lane capped?** Check the Accounts screen. Several vendors being
   exhausted at once is the ordinary state of this system, not an incident. The
   agents on those lanes read `WAITING_RESOURCE` and none of them is broken.
3. **Did the precondition return false?** That is an idle tick working as
   designed: no run row, no vendor turn, and the backoff advances. Ten
   continuous agents doing nothing should cost nothing.
4. **Is the budget exhausted?** An agent that always reports `WORK_DONE` has no
   idle streak to back it off; the ledger is the only backstop, and it pauses
   the agent rather than letting it spin.
5. **Is the lost-wake alarm lit?** The Status screen lists active agents with no
   live run and no next wake. That is a real fault — a bump that went missing —
   and it is surfaced rather than left silent.
6. **Open the agent's Terminal tab and look.** Every turn runs inside that
   agent's own tmux session, so the tab is the live process, not a transcript
   assembled afterwards. If the pane is empty the turn never started; if it is
   mid-tool-call the agent is simply slow, which a run row cannot distinguish.

## Watch a turn happen

Dispatch runs acpx inside the agent's tmux session rather than with piped
stdio. That is the difference between a workspace that reports on agents and
one you can watch: the terminal view attaches to a real session, survives a
server restart, and keeps the scrollback a human is halfway through reading.

Attaching replays the scrollback above the visible screen before the live
stream starts — a client that only attaches sees the current frame and nothing
else, which makes reconnecting mid-run look like the agent just started.
Viewers attach read-only and the window size is pinned, so a phone opening the
tab cannot reflow the session someone else is reading.

Worktrees live **beside** the project (`<project>-agents/<slug>`, override with
`AOA_WORKTREE_ROOT`), never inside it. A `.worktrees/` directory in the repo
turns up in the owner's own `git status`, and a fleet that makes your tree noisy
is a fleet you turn off. Each agent gets a branch, `agents/<slug>`, so parallel
work is reconcilable rather than a pile of detached commits.

The path is not the directory: it has to be created before anything is pointed
at it. Computing a worktree path and never making it means the harness is
launched in a directory that does not exist, and every agent fails to start for
a reason that looks nothing like the cause.

## A turn outlives the process that started it

This is the one thing about the loop that is genuinely counter-intuitive.
Killing the supervisor does NOT stop the work: acpx's queue owner and the
harness it spawned keep running. And acpx serialises prompts per named
session, so the next prompt for that agent BLOCKS behind the orphan — no
error, no partial output, nothing at all until the deadline. Running against a
real project, 25 of 81 turns died that way overnight, each one a silent
half-hour.

So every abandoned turn is killed rather than left, by process GROUP: acpx
spawns the real harness, and killing acpx alone leaves that harness holding the
queue. And on startup — before the first tick — each unfinished run is
reconciled against evidence, never against the session name:

| Evidence in the job dir | Decision |
|---|---|
| `exit` sentinel present | **Finalise** from the capture file |
| heartbeat fresh (< 10s) | **Adopt** — real work is in flight |
| heartbeat stale | **Kill** the process group, settle, redispatch |
| no job dir at all | Settle; there is nothing to adopt or kill |

Reconciliation runs on **every tick**, not only at startup. An adopted run has
no poller — the poll loop died with the process that started it — so
reconciling once would leave that run open and its agent wedged behind the
one-live-run index until the next restart.

Finalising goes through the same path as a watched run. A separate, simpler
one would drop the agent's questions for exactly the runs that were
interrupted: the ones most likely to have asked for help.

## Why zero bytes is not a diagnosis

"No output" has at least four causes and they need different responses: the
model is thinking, the prompt is queued behind an orphan, the wrapper died, or
`send-keys` never landed. The capture file cannot tell them apart, which is why
the wrapper publishes a heartbeat carrying `{phase, bytes}` — `spawning →
submitted → streaming → done`. `submitted` with zero bytes for 90 seconds is
queued-behind-something and is failed fast; a stale heartbeat is a dead
wrapper. The hard deadline stays, but as a backstop rather than as the only
signal.

Do not reach for acpx's `--no-wait` here. It converts "blocked behind an
orphan" into "queued behind an orphan" — the same zero bytes, minus the
backpressure that told you the queue was occupied.

**The agent's acpx session name is reserved for the supervisor.** Ownership
cannot be proven from a shared name: a human driving `<slug>` directly has no
job dir and no heartbeat, so reconciliation cannot distinguish their work from
a stale orphan, and would kill it. Attach under a different name.

## Cost, honestly

An idle agent costs nothing, because the precondition is LLM-free and runs
before any session is spawned. A busy agent costs one vendor turn per iteration.
Backoff decays an idle agent from the floor to the ceiling, so the steady state
of a quiet fleet is a handful of turns per day, not hundreds.

That is a shape, not a number. Anyone quoting you a dollar figure for your fleet
without your floor, your ceiling and your outcome mix is guessing.

## What to leave alone

- **Do not shorten the floor to make it feel responsive.** Continuous is not
  zero-delay scheduling; that is a quota feedback loop with extra steps.
- **Do not delete the precondition** to "simplify" the dispatcher. Without it,
  finding out there is nothing to do costs a full turn every time.
- **Do not run two supervisors** against one database expecting speed. The
  partial unique index will refuse the second dispatch, which is correct, and
  you will have bought nothing.

## Related

`army-agent-contract` defines what an agent may do · `army-hitl` is how it asks
you things · `army-workload-adapter` points it at a project · `army-fanin`
reconciles what it produced.
