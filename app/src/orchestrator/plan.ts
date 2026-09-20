import { type Db, appendMessage, emit, id, now, tx } from '../store/db.ts';
import { type AgentRow, createAgent, getAgentBySlug, listAgents } from '../supervisor/repo.ts';
import { addBacklogItem, channels, rerankBacklog } from '../server/api.ts';
import { deliverAndWake } from '../supervisor/messages.ts';
import { DEFAULT_CONTINUOUS } from '../supervisor/wake.ts';

/**
 * The orchestrator is a conversation with a command surface.
 *
 * The owner can ask it anything that changes the whole fleet. Because those
 * changes restructure the system, it does NOT act on a sentence: it states the
 * concrete effects — which agents, which contracts, what budget — and waits.
 *
 * Investigations run immediately. Changes never do. That asymmetry is the
 * entire safety property of this surface.
 */

export type EffectKind =
  | 'pause_agent'
  | 'resume_agent'
  | 'retire_agent'
  | 'create_agent'
  | 'add_backlog_item'
  | 'rerank_backlog'
  | (string & {});

export interface Effect {
  kind: EffectKind;
  /** Rendered verbatim on the plan card. If a human cannot check it, it is not a plan. */
  describe: string;
  args: Record<string, unknown>;
}

export interface Plan {
  id: string;
  request: string;
  summary: string;
  effects: Effect[];
  /** Non-mutating findings the orchestrator produced immediately. */
  investigation: string | null;
  state: 'PENDING' | 'APPLIED' | 'REJECTED';
  createdAt: number;
  appliedAt?: number;
  appliedBy?: string;
}

const PLANS_KEY = 'orchestrator_plans';

function loadPlans(db: Db): Plan[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(PLANS_KEY) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Plan[]) : [];
}

function savePlans(db: Db, plans: Plan[]): void {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(
    PLANS_KEY,
    JSON.stringify(plans.slice(-100)),
  );
}

export function listPlans(db: Db): Plan[] {
  return loadPlans(db).slice().reverse();
}

export interface ParsedRequest {
  summary: string;
  effects: Effect[];
  investigation: string | null;
  /** True when the request named a change this vocabulary refuses outright. */
  refused?: boolean;
}

/**
 * Turn a request into effects, without persisting anything.
 *
 * This is a deterministic intent parser, not a model call. That is deliberate:
 * the supervisor must be able to state effects without a live LLM context, and
 * a plan the owner approves has to mean exactly what it says. The judgement
 * session composes plans by writing PROPOSE lines in this same vocabulary.
 */
export function parseRequest(db: Db, request: string): ParsedRequest {
  const text = request.trim();
  const lower = text.toLowerCase();
  const effects: Effect[] = [];
  let investigation: string | null = null;
  let summary = 'No fleet change required.';
  let refused = false;

  const agents = listAgents(db);
  const named = agents.filter((a) => new RegExp(`\\b${a.slug}\\b`, 'i').test(text));

  const pauseMatch = /\b(pause|stop|halt)\b/.test(lower);
  const resumeMatch = /\b(resume|unpause|restart)\b/.test(lower);
  const retireMatch = /\b(retire|remove|delete)\b/.test(lower);
  const createMatch = /\b(create|add|spawn)\s+(an?\s+)?agent\b/.test(lower);
  const backlogMatch = /\bbacklog\b/.test(lower);
  const rerankMatch = /\bre-?rank\b/.test(lower);

  // "pause every research agent" — a channel-scoped selector. Channel names come
  // from the store, never from a hardcoded vocabulary: the orchestrator must
  // resolve whatever channels this fleet actually has, including ones created
  // after this code shipped.
  let scoped: AgentRow[] = [];
  for (const c of channels(db)) {
    if (new RegExp(`#?\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      const members = new Set(c.members);
      scoped = agents.filter((a) => members.has(a.slug));
      break;
    }
  }

  const targets = named.length > 0 ? named : scoped;

  if (pauseMatch && targets.length > 0) {
    summary = `Pause ${targets.length} agent(s).`;
    for (const a of targets) {
      effects.push({
        kind: 'pause_agent',
        describe: `${a.slug} stops after its current run. Its session, reports and reserved capacity are preserved.`,
        args: { slug: a.slug },
      });
    }
  } else if (resumeMatch && targets.length > 0) {
    summary = `Resume ${targets.length} agent(s).`;
    for (const a of targets) {
      effects.push({
        kind: 'resume_agent',
        describe: `${a.slug} becomes due immediately and resumes on the next tick.`,
        args: { slug: a.slug },
      });
    }
  } else if (retireMatch && targets.length > 0) {
    // The orchestrator is the one agent the fleet cannot do without: retiring
    // it would leave nobody to ask for the next change. Pause it if you must.
    const retirable = targets.filter((a) => a.slug !== 'orchestrator');
    summary = `Retire ${retirable.length} agent(s).${
      retirable.length < targets.length ? ' The orchestrator cannot be retired; pause it instead.' : ''
    }`;
    if (retirable.length === 0) {
      refused = true;
      summary = 'The orchestrator cannot be retired; pause it instead.';
      investigation = summary;
    }
    for (const a of retirable) {
      effects.push({
        kind: 'retire_agent',
        describe: `${a.slug} is retired. Its history and reports remain readable; it will never run again.`,
        args: { slug: a.slug },
      });
    }
  } else if (createMatch) {
    const slug = (/\bcalled\s+([a-z0-9-]+)/i.exec(text)?.[1] ?? 'new-agent').toLowerCase();
    summary = `Create one agent (${slug}), inactive until you activate it.`;
    effects.push({
      kind: 'create_agent',
      describe:
        `A new agent '${slug}' is defined as DRAFT with a continuous wake policy. ` +
        `It does not run until you activate it — proposing an agent never starts one.`,
      args: { slug, mission: text },
    });
  } else if (backlogMatch && !rerankMatch) {
    const title = text.replace(/^.*backlog[:\s]*/i, '').slice(0, 80) || text.slice(0, 80);
    summary = 'Add one standing decision to the backlog.';
    effects.push({
      kind: 'add_backlog_item',
      describe: `A backlog item "${title}" is filed. Nothing is stopped; the orchestrator ranks it on the next cycle.`,
      args: { title, question: text },
    });
  } else if (rerankMatch) {
    summary = 'Re-rank the standing queue.';
    effects.push({
      kind: 'rerank_backlog',
      describe:
        'Every open backlog item is re-scored by expected value ÷ time-to-unblock. No agent changes state.',
      args: {},
    });
  } else {
    // No mutation recognised: answer immediately. This is the common case and
    // it must not require approval.
    investigation = investigate(db, text);
  }
  return { summary, effects, investigation, ...(refused ? { refused: true } : {}) };
}

export function proposePlan(
  db: Db,
  request: string,
  by: string,
  opts: { runId?: string } = {},
): Plan {
  // One transaction: the plan and the thread messages that make a replay
  // recognise it land together, and two processes proposing at once cannot
  // lose each other's plan in the shared list.
  return tx(db, () => proposeInTx(db, request, by, opts));
}

function proposeInTx(db: Db, request: string, by: string, opts: { runId?: string }): Plan {
  const text = request.trim();
  const { summary, effects, investigation, refused } = parseRequest(db, text);

  const plan: Plan = {
    id: id(),
    request: text,
    summary,
    effects,
    investigation,
    state: 'PENDING',
    createdAt: now(),
  };

  const plans = loadPlans(db);
  plans.push(plan);
  savePlans(db, plans);

  const orch = getAgentBySlug(db, 'orchestrator');
  if (orch) {
    if (by.startsWith('agent:')) {
      // The judgement session proposed. Its line and the resulting card, in
      // its own thread, so the owner sees the reasoning next to the plan.
      appendMessage(db, {
        agentId: orch.id, kind: 'agent', author: by, body: text,
        ...(opts.runId ? { runId: opts.runId } : {}), meta: { planId: plan.id },
      });
      appendMessage(db, {
        agentId: orch.id, kind: 'event', author: 'system',
        body: `${summary} Awaiting Apply.`, meta: { planId: plan.id, effects: effects.length },
      });
    } else if (refused) {
      // A command this vocabulary refuses. Said back; not forwarded to the
      // judgement session as if it were a question.
      appendMessage(db, { agentId: orch.id, kind: 'human', author: by, body: text, meta: { planId: plan.id } });
      appendMessage(db, {
        agentId: orch.id, kind: 'event', author: 'system', body: summary, meta: { planId: plan.id, refused: true },
      });
    } else if (effects.length === 0) {
      // A question, not a command. The canned readout goes out at once, and
      // the same words reach the judgement session as its next inbox message,
      // so the answer that matters arrives in this thread on its next wake.
      deliverAndWake(db, {
        to: orch, kind: 'human', author: by, body: text, meta: { planId: plan.id }, wakeReason: 'human',
      });
      appendMessage(db, {
        agentId: orch.id, kind: 'event', author: 'system', body: investigation ?? summary,
        meta: { planId: plan.id },
      });
    } else {
      appendMessage(db, {
        agentId: orch.id, kind: 'human', author: by, body: text, meta: { planId: plan.id },
      });
      appendMessage(db, {
        agentId: orch.id, kind: 'agent', author: 'agent:orchestrator', body: summary,
        meta: { planId: plan.id, effects: effects.length },
      });
    }
  }
  emit(db, 'plan.proposed', by, { planId: plan.id, effects: effects.length });
  return plan;
}

/** Read-only answers, produced without changing anything. */
function investigate(db: Db, text: string): string {
  const agents = listAgents(db);
  const lower = text.toLowerCase();
  const named = agents.find((a) => lower.includes(a.slug));
  if (named) {
    const last = named.last_outcome ?? 'no runs yet';
    return (
      `${named.slug} is ${named.status.toLowerCase()}; last outcome ${last}, idle streak ${named.idle_streak}. ` +
      `${named.next_due_at === null ? 'It has no next wake — only an insert moves it.' : `Next wake at ${new Date(named.next_due_at).toISOString()}.`}`
    );
  }
  return (
    `${agents.length} agent(s) registered. ` +
    `Ask me to pause, resume, retire or create an agent, add a backlog item, or re-rank the queue — ` +
    `anything that changes the fleet comes back as a plan you approve first. ` +
    `Your message has been passed to the orchestrator session; its answer lands in its thread.`
  );
}

/**
 * What each effect does when applied. A registry rather than a switch so a
 * new verb is one `registerEffect` call — from another module, or from a
 * workload adapter — without editing this file.
 */
export type EffectApplier = (db: Db, args: Record<string, unknown>, by: string) => void;

const EFFECTS = new Map<EffectKind, EffectApplier>();

export function registerEffect(kind: EffectKind, apply: EffectApplier): void {
  // Replacing silently is how a workload adapter would change what "pause"
  // means without anyone noticing.
  if (EFFECTS.has(kind)) throw new Error(`effect '${kind}' is already registered`);
  EFFECTS.set(kind, apply);
}

registerEffect('pause_agent', (db, args) => {
  const a = getAgentBySlug(db, String(args['slug']));
  if (a) {
    db.prepare(
      `UPDATE agents SET status='PAUSED', next_due_at=NULL, updated_at=?, version=version+1 WHERE id=?`,
    ).run(now(), a.id);
  }
});
registerEffect('resume_agent', (db, args) => {
  const a = getAgentBySlug(db, String(args['slug']));
  if (a) {
    db.prepare(
      `UPDATE agents SET status='ACTIVE', next_due_at=?, wake_reason='human', updated_at=?, version=version+1 WHERE id=?`,
    ).run(now(), now(), a.id);
  }
});
registerEffect('retire_agent', (db, args) => {
  const a = getAgentBySlug(db, String(args['slug']));
  // Enforced here, not only when parsing: a plan written by hand or before
  // this rule existed must not be able to retire the fleet's judge.
  if (a && a.slug !== 'orchestrator') {
    db.prepare(
      `UPDATE agents SET status='RETIRED', next_due_at=NULL, updated_at=?, version=version+1 WHERE id=?`,
    ).run(now(), a.id);
    // Cascade: a retired parent retires its descendants.
    db.prepare(`UPDATE agents SET status='RETIRED', next_due_at=NULL WHERE parent_agent_id=?`).run(a.id);
  }
});
registerEffect('create_agent', (db, args) => {
  const slug = String(args['slug']);
  if (!getAgentBySlug(db, slug)) {
    createAgent(db, {
      slug,
      displayName: slug,
      mission: String(args['mission'] ?? ''),
      wake: DEFAULT_CONTINUOUS,
      createdBy: 'agent:orchestrator',
      // Propose, don't activate. A human enables every agent that gets a row.
      status: 'DRAFT',
    });
  }
});
registerEffect('add_backlog_item', (db, args) => {
  addBacklogItem(db, {
    title: String(args['title']),
    question: String(args['question']),
    raisedBy: 'agent:orchestrator',
  });
});
registerEffect('rerank_backlog', (db) => {
  const rows = db.prepare(`SELECT id, created_at FROM backlog_items WHERE state='OPEN'`).all() as Array<{
    id: string; created_at: number;
  }>;
  const scores: Record<string, number> = {};
  for (const r of rows) scores[r.id] = (now() - r.created_at) / 3_600_000;
  rerankBacklog(db, scores);
});

export function applyPlan(db: Db, planId: string, by: string): { ok: boolean; error?: string; plan?: Plan } {
  return tx(db, () => {
    const plans = loadPlans(db);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return { ok: false, error: 'no such plan' };
    if (plan.state !== 'PENDING') return { ok: false, error: `already ${plan.state}` };

    // Validated before anything mutates: an effect nobody registered refuses
    // the whole plan, and refuses it BEFORE the first effect ran, so a plan
    // never half-applies and stays pending.
    const missing = plan.effects.find((e) => !EFFECTS.has(e.kind));
    if (missing) return { ok: false, error: `no applier registered for effect '${missing.kind}'` };
    for (const e of plan.effects) EFFECTS.get(e.kind)!(db, e.args, by);

    plan.state = 'APPLIED';
    plan.appliedAt = now();
    plan.appliedBy = by;
    savePlans(db, plans);
    emit(db, 'plan.applied', by, { planId, effects: plan.effects.length });

    const orch = getAgentBySlug(db, 'orchestrator');
    if (orch) {
      appendMessage(db, {
        agentId: orch.id, kind: 'event', author: 'system',
        body: `Plan applied by ${by}: ${plan.summary}`, meta: { planId },
      });
    }
    return { ok: true, plan };
  });
}

export function rejectPlan(db: Db, planId: string, by: string): { ok: boolean; error?: string } {
  const plans = loadPlans(db);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return { ok: false, error: 'no such plan' };
  if (plan.state !== 'PENDING') return { ok: false, error: `already ${plan.state}` };
  plan.state = 'REJECTED';
  savePlans(db, plans);
  emit(db, 'plan.rejected', by, { planId });
  return { ok: true };
}
