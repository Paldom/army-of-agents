/**
 * The API surface, typed by hand.
 *
 * The reference starter generates this from an OpenAPI spec with Orval. That is
 * the right call when a separate team owns the backend and the contract drifts;
 * here the server and client ship in one repo and change in one commit, so
 * codegen would add a build step, a CI staleness check and a spec to keep true,
 * to protect against drift that a single typecheck already catches.
 *
 * If this API is ever consumed by something outside this repo, generate it.
 */

export type DerivedStatus =
  | 'RUNNING' | 'WAITING_HUMAN' | 'BLOCKED' | 'WAITING_RESOURCE' | 'BACKING_OFF'
  | 'SCHEDULED' | 'DUE' | 'WAITING_EVENT' | 'MANUAL' | 'PAUSED' | 'RETIRED' | 'DRAFT';

/** Amber is the only tone that badges, counts or notifies. */
export type Tone = 'blocker' | 'working' | 'quiet' | 'fail';

export function toneOf(s: DerivedStatus): Tone {
  if (s === 'WAITING_HUMAN' || s === 'BLOCKED') return 'blocker';
  if (s === 'RUNNING' || s === 'DUE') return 'working';
  return 'quiet';
}

export function blocksHuman(s: DerivedStatus): boolean {
  return toneOf(s) === 'blocker';
}

export interface LatestReport {
  body: string;
  at: number;
  runId: string | null;
  seq: number;
}

export interface Agent {
  id: string;
  slug: string;
  displayName: string;
  title: string | null;
  /** One line: what this agent is responsible for. */
  responsibility: string | null;
  /** Where its deeper documentation starts, for breadth-first reading. */
  docsRef: string | null;
  harness: string | null;
  lifecycle: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'RETIRED';
  status: DerivedStatus;
  why: string;
  blocksHuman: boolean;
  nextDueAt: number | null;
  wakeReason: string | null;
  idleStreak: number;
  lastOutcome: string | null;
  parentAgentId: string | null;
  depth: number;
  liveRun: { id: string; state: string; startedAt: number } | null;
  /** Messages delivered and not yet read by a turn. */
  unread: number;
  /** Agent mail that failed delivery three times. Non-zero is worth a look. */
  dead: number;
  latestReport: LatestReport | null;
  createdBy: string;
  /** tmux session name, when one exists. */
  sessionName: string | null;
}

export interface Channel {
  name: string;
  members: string[];
  /** One line: what this group of agents is collectively responsible for. */
  responsibility: string | null;
  docsRef: string | null;
}

export interface AskOption {
  id: string;
  label: string;
  detail?: string;
}

export interface Ask {
  askId: string;
  agent: string;
  agentTitle: string | null;
  prompt: string;
  options: AskOption[];
  evidence: Array<{ source: string; quote?: string }>;
  gated: boolean;
  actionHash: string | null;
  policyVersion: string | null;
  blockedForMs: number | null;
  /** True when the age is unknown, e.g. imported from a file with no timestamps. */
  ageUnknown: boolean;
  createdAt: number;
}

export interface Lane {
  vendor: string;
  blockedUntil: number;
  exhausted: boolean;
  reason: string | null;
  inUse: number;
  maxLanes: number;
  waiting: number;
}

export interface Fleet {
  agents: Agent[];
  lanes: Lane[];
  lostWake: string[];
  counts: { blocksHuman: number; running: number; fine: number };
  /** The loop's pulse. When it is not alive, nothing on this screen can move. */
  supervisor: { lastTickAt: number | null; alive: boolean };
}

/** One row of an agent's thread. `kind` is data: human, agent, report, notify, ask, verdict, event, agent_to_agent. */
export interface Message {
  id: string;
  agent_id: string;
  kind: string;
  author: string;
  body: string;
  seq: number;
  meta: string | null;
  run_id: string | null;
  created_at: number;
}

/** A NOTIFY line: something an agent wanted seen, needing no answer. */
export interface Notice {
  id: string;
  agent: string;
  body: string;
  at: number;
  runId: string | null;
}

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  optional: boolean;
}

export interface BacklogItem {
  id: string;
  title: string;
  question: string;
  rationale: string | null;
  tier: number;
  rank: number;
  raisedBy: string;
  agent: string | null;
  runId: string | null;
  sittingMs: number;
  createdAt: number;
}

export interface PlanEffect {
  kind: string;
  describe: string;
  args: Record<string, unknown>;
}

export interface Plan {
  id: string;
  request: string;
  summary: string;
  effects: PlanEffect[];
  investigation: string | null;
  state: 'PENDING' | 'APPLIED' | 'REJECTED';
  createdAt: number;
  appliedBy?: string;
}

export interface WorkspaceState {
  agents: Agent[];
  channels: Channel[];
  needsYou: Ask[];
  fleet: Fleet;
  backlog: { rankedAt: number | null; items: BacklogItem[] };
  notices: Notice[];
  orchestrator: string | null;
}

export interface FileEntry {
  path: string;
  name: string;
  dir: boolean;
  size?: number;
  modified?: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  modified: number;
  language: string;
  readOnly: string | null;
}

export interface AccountsView {
  dictionaries: Array<{ id: string; name: string; location: string; registeredBy: string; rows: number }>;
  accounts: Array<{
    platform: string; handle: string; status: string; allowedAgents: string[];
    lastUsedAt: number | null; dictionary: string;
    /** The keychain item name. Never a value; there is no value field by design. */
    keychainRef: string | null; hasCredential: boolean;
  }>;
}

export interface AnswerResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}
