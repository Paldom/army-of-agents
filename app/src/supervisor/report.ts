import { type Db, appendMessage, emit } from '../store/db.ts';
import { type AgentRow, getAgentBySlug } from './repo.ts';
import { MAX_RELAY_HOPS, deliverAndWake } from './messages.ts';
import { parseMarkers, stripMarkers } from './protocol.ts';
import { parseRequest, proposePlan } from '../orchestrator/plan.ts';
import { ORCHESTRATOR_SLUG } from '../orchestrator/bootstrap.ts';

/**
 * File what an agent says, while it is saying it.
 *
 * An agent's words used to vanish: only ASK lines and the OUTCOME were read,
 * and the turn's text went nowhere. The thread of a working agent was empty
 * for as long as it worked. Now every REPORT line lands the moment it is
 * complete, and the rest of the turn is kept as its report at the end.
 *
 * IDEMPOTENT by (thread, run, kind, body). The same text is ingested many
 * times: on every streamed line, again when the turn ends, and again by the
 * reconciler if the supervisor restarted mid-turn. Each marker lands once.
 */
export interface Ingested {
  reports: number;
  notifies: number;
  sends: number;
  proposals: number;
}

/** A turn that emits more markers than this is looping, not reporting. */
export const MAX_MARKERS_PER_TURN = 50;
/** Fewer for the ones that act on someone else. */
export const MAX_ACTIONS_PER_TURN = 20;

function already(db: Db, agentId: string, runId: string, kind: string, body: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM messages WHERE agent_id = ? AND run_id = ? AND kind = ? AND body = ? LIMIT 1')
    .get(agentId, runId, kind, body);
}

/**
 * How deep in a relay chain this agent currently sits: the deepest hop count
 * among the messages it is holding leases on. A reply to a hop-3 message is
 * hop 4, and the chain is killed rather than degraded past the limit.
 */
function inboundHops(db: Db, slug: string): number {
  const row = db
    .prepare(
      `SELECT MAX(COALESCE(json_extract(m.meta, '$.hops'), 0)) AS hops
       FROM messages m JOIN message_deliveries d ON d.message_id = m.id
       WHERE d.recipient = ? AND d.state = 'LEASED'`,
    )
    .get(`agent:${slug}`) as { hops: number | null } | undefined;
  return row?.hops ?? 0;
}

export function ingestMarkers(
  db: Db,
  agent: AgentRow,
  runId: string,
  text: string,
  opts: {
    /** The text is still arriving: only complete lines, and only informational markers. */
    partial?: boolean;
    /** Whether SEND and PROPOSE act. Defaults to true for a finished turn, false mid-turn. */
    actions?: boolean;
  } = {},
): Ingested {
  const out: Ingested = { reports: 0, notifies: 0, sends: 0, proposals: 0 };
  // Mid-turn, the last line may still be arriving. Only a newline makes it a line.
  const complete =
    opts.partial && !text.endsWith('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  const author = `agent:${agent.slug}`;

  // Mid-turn only REPORT and NOTIFY land: they inform. SEND and PROPOSE act
  // on other agents and on the fleet, and a turn that the vendor guard later
  // rejects, or that exits non-zero, must not already have woken someone or
  // filed a plan. Capped separately, so a chatty turn cannot crowd out the
  // one SEND that mattered.
  const act = opts.actions ?? !opts.partial;
  const all = parseMarkers(complete);
  const informational = all.filter((m) => m.marker === 'REPORT' || m.marker === 'NOTIFY');
  const actions = act ? all.filter((m) => m.marker === 'SEND' || m.marker === 'PROPOSE') : [];
  if (informational.length > MAX_MARKERS_PER_TURN || actions.length > MAX_ACTIONS_PER_TURN) {
    emit(db, 'markers.capped', author, {
      runId, informational: informational.length, actions: actions.length,
    }, agent.id);
  }
  const lines = [...informational.slice(0, MAX_MARKERS_PER_TURN), ...actions.slice(0, MAX_ACTIONS_PER_TURN)]
    .sort((a, b) => a.line - b.line);
  for (const m of lines) {
    switch (m.marker) {
      case 'REPORT':
      case 'NOTIFY': {
        const kind = m.marker === 'REPORT' ? 'report' : 'notify';
        if (already(db, agent.id, runId, kind, m.text)) break;
        appendMessage(db, { agentId: agent.id, kind, author, body: m.text, runId });
        if (kind === 'notify') {
          emit(db, 'agent.notify', author, { text: m.text, runId }, agent.id);
          out.notifies++;
        } else out.reports++;
        break;
      }
      case 'SEND': {
        const mm = /^@([a-z0-9-]+)\s+(.+)$/i.exec(m.text);
        if (!mm) break;
        const to = getAgentBySlug(db, mm[1]!.toLowerCase());
        if (!to || to.id === agent.id) {
          emit(db, 'message.undeliverable', author, { to: mm[1], runId }, agent.id);
          break;
        }
        const body = `@${to.slug} ${mm[2]}`;
        if (already(db, to.id, runId, 'agent_to_agent', body)) break;
        const hops = inboundHops(db, agent.slug) + 1;
        if (hops > MAX_RELAY_HOPS) {
          emit(db, 'message.relay_killed', author, { to: to.slug, hops, runId }, agent.id);
          break;
        }
        // Asymmetric on purpose: an agent→agent message wakes only a named
        // agent, and this one is named. Delivered and woken in one transaction.
        deliverAndWake(db, {
          to, kind: 'agent_to_agent', author, body, runId, meta: { hops }, wakeReason: 'event',
        });
        out.sends++;
        break;
      }
      case 'PROPOSE': {
        if (agent.slug !== ORCHESTRATOR_SLUG) {
          emit(db, 'plan.refused', author, { text: m.text, reason: 'only the orchestrator proposes' }, agent.id);
          break;
        }
        if (already(db, agent.id, runId, 'agent', m.text)) break;
        if (parseRequest(db, m.text).effects.length === 0) {
          // Not in the plan vocabulary. Said back in the thread, once, so the
          // next wake can rephrase, rather than silently dropped.
          const body = `PROPOSE not understood, no plan filed: "${m.text}"`;
          if (!already(db, agent.id, runId, 'event', body)) {
            appendMessage(db, { agentId: agent.id, kind: 'event', author: 'system', runId, body });
          }
          break;
        }
        proposePlan(db, m.text, author, { runId });
        out.proposals++;
        break;
      }
      default:
        break; // ASK, OPTIONS and OUTCOME are read once, at the end, by applyResult
    }
  }
  return out;
}

/**
 * The turn's own report: everything that was not a marker, kept once the turn
 * is over. A turn that produced only markers leaves nothing extra.
 */
export function fileTurnReport(db: Db, agent: AgentRow, runId: string, text: string): boolean {
  const body = stripMarkers(text).slice(0, 4000);
  if (!body) return false;
  if (already(db, agent.id, runId, 'report', body)) return false;
  appendMessage(db, {
    agentId: agent.id, kind: 'report', author: `agent:${agent.slug}`, body, runId, meta: { turn: true },
  });
  return true;
}
