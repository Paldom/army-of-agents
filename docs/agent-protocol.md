# The agent protocol

What an agent can say to the fleet, and what the fleet does with it. All of it
is plain text in the agent's final output, so it works identically on every
harness acpx can drive. The loop appends this vocabulary to every prompt
(`app/src/supervisor/protocol.ts`); this page is the human-readable copy.

## Markers

| Line | Read when | Becomes |
| --- | --- | --- |
| `REPORT: <one line>` | the moment the line is complete, mid-turn | a `report` message in the agent's thread |
| `NOTIFY: <one line>` | mid-turn | a `notify` message, an `agent.notify` event, a row under **Notices** on Needs you |
| `SEND: @<slug> <text>` | when the turn ends, after the vendor-policy checks | an `agent_to_agent` message delivered to that agent's inbox; wakes it because it was named |
| `ASK: <question>` + optional `OPTIONS: a \| b \| c` | when the turn ends | an ask on Needs you (at most 10 a turn); the agent must end its turn and is woken by the verdict |
| `OUTCOME: WORK_DONE \| NO_WORK \| BLOCKED \| RETRYABLE_ERROR` | when the turn ends | the next wake |
| `PROPOSE: <request>` | when the turn ends, **orchestrator only** | a plan card awaiting Apply, parsed by the same deterministic vocabulary as the Orchestrator screen |

Informing streams; acting waits. A turn the vendor guard rejects at the end
must not already have woken another agent or filed a plan.

Everything that is not a marker is filed once, when the turn ends, as the
turn's report. Rules the parser enforces:

- A marker inside a ``` or ~~~ fence is quoted text, not a marker, and it
  stays in the turn report as written.
- The protocol's own example lines, and the orchestrator contract's, echoed
  back, are ignored. The contract's examples name `example-agent`; do not name
  a real agent that.
- Each marker lands once per run, however many times the text is read: while
  streaming, at the end, and again by the reconciler after a restart.
- More than 50 markers in one turn is a loop; the rest are dropped and an
  event says so.
- A `SEND` to yourself or to nobody is dropped. A reply that would be the
  fifth hop of a relay chain is killed, not delivered.

## Threads and delivery

An agent's thread is the list of `messages` rows for it, in `seq` order:
`human`, `agent`, `report`, `notify`, `ask`, `verdict`, `event`,
`agent_to_agent`. `GET /api/agents/<slug>/thread?after=<seq>` is a cursor;
poll it to follow a turn as it runs. Without a cursor it returns the last
page, so a long thread opens on what happened most recently.

A message to an agent is **delivered**, not merely appended: a
`message_deliveries` row per recipient, `QUEUED` until a turn leases it. The
loop's LLM-free precondition counts queued mail, so mail is work. A lease is
bound to the run that took it. Settling that run acks the mail it was
dispatched with, in the same transaction; a turn that died releases it for
the next wake but keeps its error backoff, and the third failed delivery parks
it (`DEAD`) rather than retrying forever. Mail that arrives during a completed
turn wakes the agent once more after the settle.

A verdict works the same way: it is owed until a completed run has carried
it, so a failed attempt after an answer does not make the answer vanish. An
answer, a withdrawal (`POST /api/asks/<id>/cancel`) or an expiry also
releases the run that stopped to wait, so the woken agent can actually be
dispatched. A human message is never parked as a dead letter; only agent mail
is, after three failed deliveries, and the thread says so.

A rate-limited agent is due again the moment its vendor lane reopens. A
joined session's result (`army-join`) is delivered to the target's inbox
addressed to it, so it wakes; it stays untrusted and satisfies no gate.

Wake rules are asymmetric on purpose: a human message wakes an active agent;
an agent's message wakes only the agent it names.

## The orchestrator

Exists on every store: both the workspace and the supervisor create the
`orchestrator` row on start if it is missing (`AOA_ORCHESTRATOR_HARNESS`
picks its harness for a fresh store; the Doctor reports a later change rather
than applying it). It is woken by messages, considered before every other
agent, and keeps one dispatch slot beyond `AOA_MAX_IN_FLIGHT`, so a busy fleet
cannot make it unreachable. It cannot be retired; it can be paused.

Its capsule carries, besides the usual, the mail it was woken for and a fleet
briefing derived from rows: every agent's status and why, open asks, the top of
the backlog. Its PROPOSE lines become plan cards; nothing changes until Apply.

## The outbound seam

`AOA_EVENT_HOOK=<shell command>` receives one JSON event on stdin for every
event whose kind is in `AOA_EVENT_HOOK_KINDS` (default: `ask.opened`,
`ask.expired`, `agent.notify`, `alarm.lost_wake`, `lane.gated`,
`plan.proposed`, plus `ask.answered`, `ask.cancelled` and `message.dead`).
Fire-and-forget, at-most-once, started after the emitting transaction, at
most four at a time, killed after ten seconds. Each event is emitted by
exactly one process, so installing the hook in both does not double it.
An `ask.opened` payload carries the ask id, the agent, the prompt, the options,
whether it is gated, and the action hash and policy version — enough for a
phone to render it and to `POST /api/asks/<id>/answer` with the binding it was
shown. Gated asks are flagged and cannot be answered from anywhere.

For durable delivery, tail the `events` table instead; it is the authority.

## agents-connect, mapped

[agents-connect](https://github.com/Paldom/agents-connect) is an agent event
bus and human notification hub. Its verbs have these counterparts here:

| agents-connect | here |
| --- | --- |
| `aconn send` / `send_event` | `SEND: @slug …` → `deliver()`; one delivery per (recipient, run, body) |
| `aconn notify` / `notify_human` | `NOTIFY: …` → Notices, plus the `agent.notify` event for the hook |
| `aconn ask --choices` / `--text` / `--confirm` | `ASK:` with or without `OPTIONS:`; the agent ends its turn instead of waiting |
| `aconn reply` | the owner writes in the thread; agents reply with REPORT lines |
| `aconn read --follow` | `GET /api/agents/<slug>/thread?after=` and the capsule's **New messages for you** |
| `aconn status` | Needs you: open asks first, then notices |
| push and e-mail | `AOA_EVENT_HOOK` → `aconn notify` or `aconn ask`, or anything else |
| `wait_answer` | deliberately absent: an agent never blocks on a human here |
| permission relay | deliberately absent: HITL is agent-initiated, never permission-initiated |
| scopes and channels | one project per store; channels are agent groups |

## The browser tab

The agent's stealth browser (playwright-stealth, CloakBrowser) is Chromium,
so the Browser tab attaches over the DevTools protocol. It is live when one of
these exists, checked in this order: `AOA_BROWSER_CDP_<SLUG>=host:port` for
one agent, then `AOA_BROWSER_CDP=host:port` for all; `.stealth/<identity>/cdp.json` (`{"host","port"}`) published by whatever
launched the browser with remote debugging on; Chromium's own
`DevToolsActivePort` in `.stealth/<identity>/user-data/`. An identity named
after the agent wins, in its worktree or in the project; a shared root's
other identities are another agent's browser and come last. Every call to the
browser has a five-second deadline. Otherwise the tab says which of those is
missing.

Frames are polled screenshots. Clicks are forwarded only while **Take the
wheel** is on. The control state is persisted, so the agent's next turn is
told in its capsule not to drive; the turn already in flight is the stealth
skill's to stop, which this workspace cannot reach into. Behind a TLS
terminator set `AOA_PUBLIC_ORIGIN` to the browser-facing origin, or the
WebSocket upgrades are refused as cross-origin.

## The doctor

`GET /api/doctor`, rendered on Status: node, acpx, each harness CLI on PATH,
tmux, node-pty, git, the state directory, the browser toolchain, voice, the
event hook, and whether the orchestrator's harness matches the environment.
Optional pieces show as `off` with what turning them on would change.
