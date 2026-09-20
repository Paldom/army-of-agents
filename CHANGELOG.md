# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-09-20

The first public release. Everything under the 0.1.0 heading is the initial
build it grew from.

### Added

- **The orchestrator is always there.** Both processes create the
  `orchestrator` row on start if the store has none: active, woken by
  messages, on `AOA_ORCHESTRATOR_HARNESS`. It is considered before every other
  agent, keeps one dispatch slot beyond `AOA_MAX_IN_FLIGHT`, cannot be retired,
  and its capsule carries a fleet briefing derived from rows. Its `PROPOSE:`
  lines become plan cards through the same deterministic vocabulary the
  Orchestrator screen uses; a question typed there reaches its session.
- **Continuous reporting.** `REPORT:` lines land in the agent's thread the
  moment they are complete, mid-turn: the tmux runner tails the capture file
  and the piped runner streams stdout. `NOTIFY:` is a notice on Needs you and
  an event; `SEND: @slug` delivers to another agent. The rest of a turn is
  filed as its report when it ends. Ingest is idempotent per run, fence-aware,
  ignores the protocol's own examples, and caps at 50 markers a turn.
- **Deliveries are wired.** A human message in a thread is delivered and wakes
  an active agent in one transaction; a turn leases its inbox into the capsule
  under a data delimiter; settling acks what a completed turn read, releases
  what a failed one did not, parks a message after three failed deliveries, and
  gives one more wake for mail that arrived mid-turn.
- **Doctor.** `GET /api/doctor`, `./scripts/aoa doctor`, and a panel on Status:
  node, acpx, each harness CLI, tmux, node-pty, git, the state directory, the
  browser toolchain, voice, the event hook, the orchestrator's harness. The
  supervisor leaves a pulse each tick and the workspace shows red when it stops.
- **Outbound event hook.** `AOA_EVENT_HOOK` receives selected events as JSON on
  stdin — the seam for push, e-mail or agents-connect's `aconn notify`.
  `ask.opened` carries the binding an answer must echo back.
- **Browser tab over CDP.** Frames and take-the-wheel clicks through the
  DevTools protocol on the existing `ws` dependency; the endpoint comes from
  `AOA_BROWSER_CDP`, a published `.stealth/<identity>/cdp.json`, or Chromium's
  `DevToolsActivePort`. The tab names the missing piece otherwise.
- **Harness rows from a file.** `harnesses.json` beside the store adds an acpx
  adapter or corrects a capability; unstated capabilities default to false.
- **Effects are a registry.** `registerEffect()` adds a plan verb; an
  unregistered effect refuses the plan rather than applying less than its card.
- **Thread view.** Every agent's messages in order with author and kind, a
  composer that delivers to its inbox, a Reports tab, a Conversation on the
  Orchestrator screen, and Notices on Needs you.
- **Proofs.** Streaming reassembly across chunk boundaries, marker ingest
  idempotency, SEND wake asymmetry and relay kill, PROPOSE provenance, delivery
  lifecycle across completed and failed turns, the reserved orchestrator slot,
  the doctor, CDP discovery, the hook, harness overrides, and two proofs that
  run a turn inside a real tmux pane (skipped where tmux is absent).
- `docs/agent-protocol.md`: the marker vocabulary, delivery rules, the
  agents-connect mapping, the browser configuration and the doctor.

### Fixed

- The `stealthAvailable` check used `require` inside an ES module and so always
  reported the toolchain missing; the module also described the stealth
  browser as Firefox when playwright-stealth ships CloakBrowser, a Chromium
  fork.
- Agents in no channel — the orchestrator, or one created by a plan — fell off
  the sidebar; every unfiled agent now gets its own room.
- The pane's shell did not inherit the supervisor's `PATH`; the runner now
  writes the turn's environment into the job directory.
- The eval scorer scored gitignored third-party skills installed for authoring;
  it now asks git and skips them. Five descriptions sharpened so their own
  trigger prompts rank.
- `make check` launched the workspace and the supervisor as its last two steps
  and could never exit green; the gate now stops at the proofs.
- WebSocket upgrades from another origin are refused before the token is
  checked: a page in an agent's browser must not reach the terminal socket.
- The ask-expiry pause no longer applies to the orchestrator.
- From the cross-review (Codex GPT-6 Astra): leases are bound to the run that
  took them and settled by that run only; a failed turn releases its mail but
  keeps its error backoff instead of retrying at once; a verdict is owed until
  a completed run has carried it (`consumed_at`), so a failed attempt after an
  answer no longer loses it; `SEND` and `PROPOSE` act only at the end of the
  turn, after the vendor-policy checks, while `REPORT` and `NOTIFY` still
  stream; the orchestrator's contract examples are recognised and never filed;
  `~~~` fences count as fences and quoted text stays in the turn report; an
  unparsed `PROPOSE` is refused once, not once per streamed line; asks are
  capped at ten a turn; `proposePlan` persists and announces in one
  transaction; `applyPlan` validates every effect before applying any and the
  retire applier itself refuses the orchestrator; `ensureOrchestrator` runs in
  one immediate transaction; the piped runner decodes stdout once, whole; the
  reserved orchestrator slot no longer counts against the workers' capacity;
  the thread endpoint returns the last page without a cursor; the browser
  socket registers cleanup before attaching, every CDP call has a deadline,
  and an identity named after the agent wins over a neighbour's; the origin
  check compares the whole origin and admits originless clients only on the
  token; hooks start after the emitting transaction, at most four at a time,
  killed after ten seconds; a malformed `harnesses.json` is reported instead
  of crashing startup; `registerEffect` refuses duplicates; a joined result is
  delivered to the target's inbox; the doctor runs its checks in parallel and
  probes the Python `cloakbrowser` package; `AOA_ACPX_BIN` names the binary
  for the piped runner, the pane and the doctor alike.
- From the cross-review (Grok 4.6, reading the tree directly): a `BLOCKED`
  turn's `waiting_human` run is released by the answer, a withdrawal or an
  expiry, so the woken agent can be dispatched — before this an answered
  agent sat WAITING_HUMAN forever (pre-existing; the proof now drives ask →
  answer → resume through the real tick); a rate-limited agent is due when
  its lane reopens instead of never; a turn that exits non-zero informs but
  does not act, so a retry cannot repeat its SEND or PROPOSE; a human message
  is never parked as a dead letter and dead letters are said in the thread and
  counted per agent; an adopted run keeps reporting across a supervisor
  restart; `parseOutcome` reads markers like everything else, so a fenced
  outcome is quoted; informational and acting markers are capped separately;
  a refused "retire orchestrator" is refused rather than forwarded as a
  question; a joined result wakes its target; the wake decision re-reads the
  agent's status inside the transaction; harness rows load from the entry
  points rather than at import; the stealth check no longer counts an npm
  `playwright` package as a browser; per-agent `AOA_BROWSER_CDP_<SLUG>`,
  IPv6-safe parsing, a real page over a new-tab, `Page.enable` and a move
  before a click; `AOA_PUBLIC_ORIGIN` for TLS terminators; browser control is
  persisted so the agent's next capsule says a human has the wheel; the hook
  defaults gain `ask.answered`, `ask.cancelled` and `message.dead`; and
  `POST /api/asks/:id/cancel` withdraws a question without approving it.

## [0.1.0] - 2026-08-31

The initial build, never published on its own.

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
