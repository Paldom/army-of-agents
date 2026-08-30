import { type Db, appendMessage, emit, id, now, tx } from '../store/db.ts';
import { type AgentRow, createAgent, getAgentBySlug, listAgents } from '../supervisor/repo.ts';
import { addBacklogItem, channels, rerankBacklog } from '../server/api.ts';
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
  | 'rerank_backlog';

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

/**
 * Turn a request into a plan.
 *
 * This is a deterministic intent parser, not a model call. That is deliberate:
 * the supervisor must be able to state effects without a live LLM context, and
 * a plan the owner approves has to mean exactly what it says. The judgement
 * session composes richer plans by calling the same effect vocabulary.
 */
export function proposePlan(db: Db, request: string, by: string): Plan {
  const text = request.trim();
  const lower = text.toLowerCase();
  const effects: Effect[] = [];
  let investigation: string | null = null;
  let summary = 'No fleet change required.';

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
    summary = `Retire ${targets.length} agent(s).`;
    for (const a of targets) {
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
    appendMessage(db, {
      agentId: orch.id, kind: 'human', author: by, body: text,
    });
    appendMessage(db, {
      agentId: orch.id,
      kind: 'agent',
      author: 'agent:orchestrator',
      body: investigation ?? summary,
      meta: { planId: plan.id, effects: plan.effects.length },
    });
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
    `anything that changes the fleet comes back as a plan you approve first.`
  );
}

export function applyPlan(db: Db, planId: string, by: string): { ok: boolean; error?: string; plan?: Plan } {
  return tx(db, () => {
    const plans = loadPlans(db);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return { ok: false, error: 'no such plan' };
    if (plan.state !== 'PENDING') return { ok: false, error: `already ${plan.state}` };

    for (const e of plan.effects) {
      switch (e.kind) {
        case 'pause_agent': {
          const a = getAgentBySlug(db, String(e.args['slug']));
          if (a) {
            db.prepare(
              `UPDATE agents SET status='PAUSED', next_due_at=NULL, updated_at=?, version=version+1 WHERE id=?`,
            ).run(now(), a.id);
          }
          break;
        }
        case 'resume_agent': {
          const a = getAgentBySlug(db, String(e.args['slug']));
          if (a) {
            db.prepare(
              `UPDATE agents SET status='ACTIVE', next_due_at=?, wake_reason='human', updated_at=?, version=version+1 WHERE id=?`,
            ).run(now(), now(), a.id);
          }
          break;
        }
        case 'retire_agent': {
          const a = getAgentBySlug(db, String(e.args['slug']));
          if (a) {
            db.prepare(
              `UPDATE agents SET status='RETIRED', next_due_at=NULL, updated_at=?, version=version+1 WHERE id=?`,
            ).run(now(), a.id);
            // Cascade: a retired parent retires its descendants.
            db.prepare(
              `UPDATE agents SET status='RETIRED', next_due_at=NULL WHERE parent_agent_id=?`,
            ).run(a.id);
          }
          break;
        }
        case 'create_agent': {
          const slug = String(e.args['slug']);
          if (!getAgentBySlug(db, slug)) {
            createAgent(db, {
              slug,
              displayName: slug,
              mission: String(e.args['mission'] ?? ''),
              wake: DEFAULT_CONTINUOUS,
              createdBy: 'agent:orchestrator',
              // Propose, don't activate. A human enables every agent that gets a row.
              status: 'DRAFT',
            });
          }
          break;
        }
        case 'add_backlog_item':
          addBacklogItem(db, {
            title: String(e.args['title']),
            question: String(e.args['question']),
            raisedBy: 'agent:orchestrator',
          });
          break;
        case 'rerank_backlog': {
          const rows = db.prepare(`SELECT id, created_at FROM backlog_items WHERE state='OPEN'`).all() as Array<{
            id: string; created_at: number;
          }>;
          const scores: Record<string, number> = {};
          for (const r of rows) scores[r.id] = (now() - r.created_at) / 3_600_000;
          rerankBacklog(db, scores);
          break;
        }
      }
    }

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
