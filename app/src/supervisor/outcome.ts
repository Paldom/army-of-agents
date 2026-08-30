import { type Db, emit } from '../store/db.ts';
import { type PromptResult, detectRateLimit } from '../acp/session.ts';
import { scanEvents } from '../policy/vendor-guard.ts';
import { type AgentRow } from './repo.ts';
import { type Outcome } from './state.ts';
import { ask } from './hitl.ts';
import { parseAsks, parseOutcome } from './protocol.ts';
import { settle } from './budget.ts';
import { gateVendor } from './tick.ts';

/**
 * Turn a finished prompt into an outcome, and into whatever it owes the store.
 *
 * Shared because a turn can outlive the process that launched it. When a
 * supervisor restarts, an adopted run finishes with nobody polling it; the
 * next tick finalises it from its capture file, and that MUST do everything
 * the original path did — file the agent's questions, settle the budget,
 * police cross-vendor shell-outs. A second, simpler finalise path would
 * quietly drop asks for exactly the runs that were interrupted.
 */
export function applyResult(
  db: Db,
  agent: AgentRow,
  runId: string,
  res: PromptResult,
): Outcome {
  // A vendor refusal backs off the LANE, not this agent alone.
  const rl = detectRateLimit(res);
  if (rl.limited) {
    if (agent.harness) {
      gateVendor(db, agent.harness, Date.now() + (rl.retryAfterMs ?? 3_600_000), 'vendor refused');
    }
    return 'RATE_LIMITED';
  }

  // Stage-1 cross-vendor policing: a confused agent shelling out to another
  // vendor bypasses the lane, the ledger and the router. Halt and surface it.
  const violations = scanEvents(res.events);
  if (violations.length > 0) {
    emit(db, 'policy.vendor_bypass', `agent:${agent.slug}`, { violations }, agent.id);
    return 'RETRYABLE_ERROR';
  }

  if (res.tokens) settle(db, agent.id, 1, runId);
  if (!res.ok) return 'RETRYABLE_ERROR';

  // Questions the agent filed this turn become real asks in its thread. This
  // is the whole point of the system: the agent ends its turn, and the owner
  // answers in the workspace rather than in a markdown file.
  for (const a of parseAsks(res.text)) {
    ask(db, {
      agentId: agent.id,
      runId,
      prompt: a.prompt,
      // Options carry a stable id because a verdict binds to the id, not to
      // the label a human happened to read.
      ...(a.options ? { options: a.options.map((label, i) => ({ id: `opt${i + 1}`, label })) } : {}),
    });
  }

  // The agent classifies its own iteration; an unclassified run defaults to
  // NO_WORK so it backs off rather than spinning at the floor.
  return parseOutcome(res.text);
}
