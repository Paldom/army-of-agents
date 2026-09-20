import { type Db, now, tx } from '../store/db.ts';
import { type AgentRow, createAgent, getAgent, getAgentBySlug, listAgents, statusOf } from '../supervisor/repo.ts';
import { openAsks } from '../supervisor/hitl.ts';
import { PROPOSE_EXAMPLES } from '../supervisor/protocol.ts';
import { listBacklog } from '../server/api.ts';

/**
 * The orchestrator is just another agent to the supervisor — but it has to
 * EXIST for that to mean anything. Nothing created its row: an empty fleet had
 * no orchestrator thread, join results had no target, plan cards had no
 * conversation, and the README's "ask the orchestrator" pointed at nobody.
 *
 * So both processes ensure it on start. Idempotent; an imported or hand-made
 * `orchestrator` row is left exactly as it is.
 */
export const ORCHESTRATOR_SLUG = 'orchestrator';

export const ORCHESTRATOR_CONTRACT = `# Orchestrator

**Mission.** Keep the fleet pointed at the highest-value work: read what every
agent reported, tell the owner what they need to know, and turn requests for
change into plans the owner applies.

**Reads.** Every thread, the backlog, fleet status, open asks.
**Writes.** Nothing directly. A fleet change is a proposal until the owner applies it.
**Owns.** The backlog ranking and the fleet briefing.
**Done when.** Never. It is woken by messages, not by the clock.

## How to act

- Answer the owner's question in plain prose. It becomes your report in this thread.
- To change the fleet, write one PROPOSE line per change, phrased exactly like
  these (with the real agent's slug), and end your turn. Each becomes a plan
  card the owner must apply; nothing happens before that.

${PROPOSE_EXAMPLES.map((e) => `    PROPOSE: ${e}`).join('\n')}

- Investigations never need a proposal. Say what you found.
- Use NOTIFY for something the owner should see now, and ASK only for a decision
  you cannot make yourself.
- Do not repeat the fleet briefing back; the owner can see it.`;

export function ensureOrchestrator(db: Db, opts: { harness?: string | undefined } = {}): AgentRow {
  // One IMMEDIATE transaction: two processes starting on a fresh store race
  // to create it, and the write lock — not the unique index — decides.
  return tx(db, () => {
    const existing = getAgentBySlug(db, ORCHESTRATOR_SLUG);
    if (existing) return existing;
    return createFresh(db, opts);
  });
}

function createFresh(db: Db, opts: { harness?: string | undefined }): AgentRow {
  const a = createAgent(db, {
    slug: ORCHESTRATOR_SLUG,
    displayName: 'Orchestrator',
    title: 'core',
    persona: ORCHESTRATOR_CONTRACT,
    mission:
      'Keep the fleet pointed at the highest-value work and turn requests for change into plans the owner applies.',
    harness: opts.harness ?? process.env['AOA_ORCHESTRATOR_HARNESS'] ?? 'claude',
    wake: { kind: 'on_message' },
    createdBy: 'system',
    status: 'ACTIVE',
  });
  // Woken by messages, not by the clock. An event-driven agent that starts out
  // "due" spends its first tick discovering it has no inbox.
  db.prepare(
    `UPDATE agents SET next_due_at = NULL, wake_reason = 'event', updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(now(), a.id);
  return getAgent(db, a.id)!;
}

/**
 * What the judgement session sees about the fleet on every wake. Derived from
 * rows at dispatch time — never cached, because the point of rebuilding the
 * orchestrator's context from the store is that a restart costs nothing.
 */
export function fleetBriefing(db: Db, nowMs = now()): string {
  const agents = listAgents(db).filter((a) => a.slug !== ORCHESTRATOR_SLUG);
  const rows = agents.map((a) => {
    const d = statusOf(db, a, nowMs);
    return `- ${a.slug} (${a.harness ?? 'no harness'}, ${a.status.toLowerCase()}): ${d.status}${
      a.last_outcome ? `, last ${a.last_outcome}` : ''
    }. ${d.why}`;
  });
  const asks = openAsks(db).map((q) => {
    const a = getAgent(db, q.agent_id);
    return `- ${a?.slug ?? '?'}: ${q.prompt.slice(0, 160)}${q.gated ? ' (gated: not answerable in the workspace)' : ''}`;
  });
  const backlog = listBacklog(db).items.slice(0, 8).map((b) => `- P${b.tier} ${b.title}`);
  return [
    `${agents.length} agent(s) besides you:`,
    ...(rows.length ? rows : ['- none yet; the owner may ask you to propose some']),
    asks.length ? `Open asks waiting on the owner:\n${asks.join('\n')}` : 'No asks are open.',
    backlog.length ? `Backlog, highest first:\n${backlog.join('\n')}` : 'The backlog is empty.',
  ].join('\n');
}
