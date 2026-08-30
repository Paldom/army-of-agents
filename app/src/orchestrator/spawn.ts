import { type Db, emit, id, now, tx } from '../store/db.ts';
import { type AgentRow, createAgent, getAgent, listAgents } from '../supervisor/repo.ts';
import { ensureAccount, remaining } from '../supervisor/budget.ts';
import { DEFAULT_CONTINUOUS } from '../supervisor/wake.ts';

/**
 * M5 — agent-creates-agent, with the guardrails as part of the design rather
 * than a later hardening pass.
 *
 * v1 rule: PROPOSE, DON'T ACTIVATE. An agent may define an agent and request
 * its activation; a human enables it. That makes runaway self-replication
 * structurally impossible rather than merely discouraged.
 *
 * Budget is RESERVED FROM THE PARENT'S REMAINING, so creating an agent cannot
 * conjure capacity and self-replication starves itself.
 */

/**
 * `maxSpawnDepth` is how many levels BELOW a root a spawned agent may sit.
 * 1 means: a root may create children; a child may not create grandchildren.
 * Naming it as a depth cap ("2") invites an off-by-one that quietly permits the
 * exact generation this is meant to forbid.
 */
export const LIMITS = { maxSpawnDepth: 1, maxChildrenPerParent: 3, maxActiveAgents: 10 };

export interface SpawnProposal {
  id: string;
  parentSlug: string;
  slug: string;
  mission: string;
  budgetFromParent: number;
  ttlMs: number;
  state: 'PENDING' | 'ACTIVATED' | 'REJECTED';
  createdAt: number;
}

const KEY = 'spawn_proposals';

function load(db: Db): SpawnProposal[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as SpawnProposal[]) : [];
}
function save(db: Db, list: SpawnProposal[]): void {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(KEY, JSON.stringify(list));
}

export function listProposals(db: Db): SpawnProposal[] {
  return load(db);
}

export type ProposeResult =
  | { ok: true; proposal: SpawnProposal }
  | { ok: false; reason: string };

export function propose(
  db: Db,
  p: { parent: AgentRow; slug: string; mission: string; budget: number; ttlMs?: number },
): ProposeResult {
  if (p.parent.depth + 1 > LIMITS.maxSpawnDepth) {
    return { ok: false, reason: `depth cap reached; a child may not create grandchildren` };
  }
  const children = listAgents(db).filter((a) => a.parent_agent_id === p.parent.id);
  if (children.length >= LIMITS.maxChildrenPerParent) {
    return { ok: false, reason: `fan-out cap ${LIMITS.maxChildrenPerParent} reached for ${p.parent.slug}` };
  }
  const active = listAgents(db).filter((a) => a.status === 'ACTIVE').length;
  if (active >= LIMITS.maxActiveAgents) {
    return { ok: false, reason: `fleet cap ${LIMITS.maxActiveAgents} active agents reached` };
  }
  const left = remaining(db, p.parent.id);
  if (left !== null && p.budget > left) {
    return {
      ok: false,
      reason: `parent has ${left} remaining; creating an agent cannot conjure capacity`,
    };
  }

  const proposal: SpawnProposal = {
    id: id(),
    parentSlug: p.parent.slug,
    slug: p.slug,
    mission: p.mission,
    budgetFromParent: p.budget,
    ttlMs: p.ttlMs ?? 48 * 3_600_000,
    state: 'PENDING',
    createdAt: now(),
  };
  const list = load(db);
  list.push(proposal);
  save(db, list);
  emit(db, 'spawn.proposed', `agent:${p.parent.slug}`, { slug: p.slug }, p.parent.id);
  return { ok: true, proposal };
}

/** Only a human activates. Anything that gets an agent row needs this. */
export function activate(db: Db, proposalId: string, by: string): { ok: boolean; reason?: string } {
  return tx(db, () => {
    const list = load(db);
    const prop = list.find((x) => x.id === proposalId);
    if (!prop) return { ok: false, reason: 'no such proposal' };
    if (prop.state !== 'PENDING') return { ok: false, reason: `already ${prop.state}` };

    const parent = listAgents(db).find((a) => a.slug === prop.parentSlug);
    if (!parent) return { ok: false, reason: 'parent is gone' };

    // Atomically carve the child's allowance out of the parent's remaining.
    const parentAcct = db
      .prepare(`SELECT * FROM budget_accounts WHERE agent_id = ? AND window = 'day'`)
      .get(parent.id) as { id: string; allowance: number; reserved: number; spent: number } | undefined;
    if (parentAcct) {
      const left = parentAcct.allowance - parentAcct.reserved - parentAcct.spent;
      if (prop.budgetFromParent > left) return { ok: false, reason: 'parent capacity moved; re-propose' };
      db.prepare('UPDATE budget_accounts SET allowance = allowance - ?, version = version + 1 WHERE id = ?')
        .run(prop.budgetFromParent, parentAcct.id);
    }

    const child = createAgent(db, {
      slug: prop.slug,
      displayName: prop.slug,
      mission: prop.mission,
      wake: DEFAULT_CONTINUOUS,
      createdBy: `agent:${prop.parentSlug}`,
      parentAgentId: parent.id,
      status: 'ACTIVE',
    });
    db.prepare('UPDATE agents SET expires_at = ? WHERE id = ?').run(now() + prop.ttlMs, child.id);
    ensureAccount(db, child.id, prop.budgetFromParent);

    prop.state = 'ACTIVATED';
    save(db, list);
    emit(db, 'spawn.activated', by, { slug: prop.slug }, child.id);
    return { ok: true };
  });
}

export function reject(db: Db, proposalId: string, by: string): void {
  const list = load(db);
  const p = list.find((x) => x.id === proposalId);
  if (p && p.state === 'PENDING') {
    p.state = 'REJECTED';
    save(db, list);
    emit(db, 'spawn.rejected', by, { slug: p.slug });
  }
}

/** A child with an elapsed TTL is retired, along with its descendants. */
export function reapExpired(db: Db, nowMs = now()): string[] {
  const expired = db
    .prepare(`SELECT * FROM agents WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'RETIRED'`)
    .all(nowMs) as AgentRow[];
  for (const a of expired) {
    db.prepare(`UPDATE agents SET status='RETIRED', next_due_at=NULL WHERE id = ? OR parent_agent_id = ?`)
      .run(a.id, a.id);
    emit(db, 'agent.reaped', 'system', { reason: 'ttl elapsed' }, a.id);
  }
  return expired.map((a) => a.slug);
}

export { getAgent };
