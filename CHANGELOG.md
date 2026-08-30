# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Six skills.** `army-run` (operate the fleet), `army-agent-contract` (the five
  contract clauses), `army-hitl` (non-blocking human-in-the-loop),
  `army-workload-adapter` (point it at an existing project), `army-join`
  (cross-harness participation), `army-fanin` (reconcile parallel worktrees).
- **The bundled app** under `app/`: a deterministic supervisor loop, an HTTP/WS
  server whose API is the full product surface, and a workspace rendered entirely
  from that API.
- **Store.** SQLite in WAL mode with an append-only `events` table as the
  authority; every other table is a rebuildable projection.
- **Wake policy.** Structured run outcomes drive exponential backoff, so an idle
  agent costs nothing and a continuous agent cannot become a quota feedback loop.
- **Atomic succession.** Terminalising a run, consuming its command and writing
  the successor wake happen in one transaction, so an answered agent can never be
  left asleep with its work done.
- **Bound approvals.** Every verdict binds an action hash, a policy version and a
  run version; drift re-asks rather than honouring a stale yes.
- **Durable vendor gates.** A rate-limited vendor backs off the whole lane across
  restarts, instead of every agent retrying into an exhausted subscription.
- **Budget ledger.** CAS-debited in the run's own transaction; the only backstop
  against a mission that always reports progress and never finishes.
- **Isolation.** Per-agent worktree, browser profile and sandbox read paths, with
  the degradations that remain (shared network, shared per-vendor credentials)
  stated in the UI rather than hidden.
- **Memory continuity.** A bounded capsule per run, and promotion into durable
  memory as copy-on-write with a human-reviewed diff.
- **Spawning.** Propose-don't-activate, with depth and fan-out caps, a TTL, and
  budget carved from the parent's remaining allowance.
- **Fan-in.** Per-change provenance (agent, harness, cost, test result), an
  explicit merge plan, archived losers and reaped worktrees.
- **Workspace front end** in React 19 + Vite + Tailwind v4, with TanStack Query
  for server state and Zustand for the little that is genuinely local. Layered
  so `shared/` cannot import from `app/` or `components/`. Terminal and browser
  views are lazy-loaded, which is most of the difference between a 638 kB and a
  302 kB entry chunk.
- **Live terminals.** Each turn runs inside the agent's own tmux session, so the
  terminal tab is the real process rather than a transcript replayed afterwards.
  Attaching replays the scrollback above the visible screen first, viewers are
  read-only, and the window size is pinned so one viewer cannot reflow another's.
- **The loop protocol ships in the prompt.** The `OUTCOME:` and `ASK:` markers
  are stated in the capsule the agent reads, so an agent can classify its own
  iteration and reach a human without a tool call the harness may not have.
- **Walkthrough video** in the README, recorded from the running app.

### Fixed

- **The ACP wire format was never parsed.** `acpx --format json` emits raw ACP
  JSON-RPC — the discriminator is at `params.update.sessionUpdate` and assistant
  text arrives in chunks. Three readers each assumed a flatter shape and each
  silently matched nothing: every run classified `NO_WORK`, the cross-vendor
  guard never inspected a command, and the terminal pane stayed blank while an
  agent worked. One parser now serves all three, pinned by a fixture.
- **Worktrees were computed but never created**, so the harness was launched in
  a directory that did not exist and no agent could start. They are also now
  created beside the project rather than inside it, to keep the owner's own
  `git status` clean.
- **`OUTCOME:` was parsed but never requested**, and `ask()` had no caller but
  the importer — a contract asserted on one side only.
- Agent and channel rows show what they are responsible for, skipping the
  charter preamble that had been filling that slot with `Authority: HIGH.`
- **Opening a terminal could take the whole workspace down.** node-pty's
  prebuilt `spawn-helper` ships without the executable bit, so every pty spawn
  failed with `posix_spawnp failed` — a message naming neither the file nor the
  permission — and the throw went through the websocket handler and killed the
  server for every other viewer. The bit is repaired on first attach, and a
  terminal that cannot open now reports itself instead of crashing.
- Selecting an agent or channel used to reuse the `status` view, so the rail
  highlighted Status while showing something else; they have their own view now.
- The browser tab rendered an `<img>` with no source, which draws as a broken
  image rather than as "nothing attached yet".
- **An abandoned turn silenced every turn after it.** Killing the supervisor,
  or hitting the deadline, left acpx's queue owner and the harness it spawned
  running. acpx serialises prompts per named session, so the next prompt for
  that agent blocked behind the orphan with no error and no output — 25 of 81
  turns died that way in one overnight run. Abandoned turns are now killed by
  process group, and unfinished runs are reconciled against evidence on startup
  and on every tick: finalise if the exit sentinel is there, adopt if the
  heartbeat is fresh, kill if it is stale.
- **Zero bytes was not a diagnosis.** The wrapper now publishes a heartbeat
  (`spawning → submitted → streaming → done`, with a byte count), so "the model
  is thinking", "queued behind an orphan" and "the wrapper is dead" are
  distinguishable in seconds rather than at the 30-minute deadline.
- The job directory is no longer deleted while its wrapper is still running —
  that removed the capture, heartbeat and exit sentinel out from under a live
  process, turning a recoverable turn into one that could never report.
- **`maxDispatch` serialised the fleet instead of parallelising it.** Each turn
  was awaited inside the selection loop, so the documented "concurrency cap"
  gave the whole fleet a single slot: with turns running ten to thirty minutes,
  twenty-two agents shared it and most never got a turn. Dispatch is now
  concurrent, with `AOA_MAX_IN_FLIGHT` capping turns in flight ACROSS ticks —
  the cap that actually protects a subscription, since ticks are seconds apart
  and turns are tens of minutes.
- **Continuous agents could never start.** The precondition admitted only
  `schedule` and `manual`, so a continuous agent — which has no other way to
  begin — was skipped forever. Live, four sat at `NO_WORK` with a growing idle
  streak having run exactly zero turns. Cost control is the backoff's job, and
  it already decays an idle continuous agent to its one-hour ceiling.
- **A precondition-false tick could stall an agent permanently.** The backoff
  skipped human-bumped agents by analogy with `succeed()`, but there is no run
  here and no unconsumed verdict, so `next_due_at` never advanced: the agent was
  reconsidered every tick, never dispatched, and invisible to the lost-wake
  alarm because its wake was not NULL. Two agents sat 28 hours overdue having
  never run.
- `scripts/aoa` passes configuration into its tmux windows explicitly. tmux
  windows inherit the tmux SERVER's environment, and that server is already
  running for the agent terminals, so exported variables silently did not
  arrive — the workspace came up on a default port with a random token.
- **A fleet's state no longer lives in the skill.** The store, config and
  worktrees for a project now sit beside that project in `<project>-agents/`,
  so one checkout drives any number of projects, the skill directory stays
  generic, and upgrading or reinstalling it cannot delete a fleet's memory.
  Agent tmux sessions are namespaced per project for the same reason — tmux
  names are global per user, so two fleets each with an `orchestrator` would
  have shared one terminal.
- Additive migrations run on open. `CREATE TABLE IF NOT EXISTS` never adds a
  column to an existing table, so a new field reached only fresh databases and
  the first write failed with `no such column` on a running fleet.
- Descriptions are trimmed on a word boundary, and the digest importer requires
  a dated filename — `L0-TEMPLATE.md` sorted last and became the newest
  "report" shown for the whole fleet.

### Notes

- The workspace holds owner authority for ordinary decisions but no mint for
  value-moving verbs; those render as not-answerable-here.
- Credential values never enter the API, the database or the UI. A row names its
  OS keychain item.
- `acpx` permission escalation does not wait for a human without a TTY, so
  human-in-the-loop here is agent-initiated by design.
