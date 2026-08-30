/**
 * The harness capability record.
 *
 * "Any orchestration layer must read this record rather than assume." A plan
 * that assumes it can interrupt a harness which cannot will hang forever
 * waiting for something that will never happen — so capability is DECLARED,
 * never inferred from optimism.
 *
 * This is data, not code. New harnesses are rows.
 */
export interface HarnessCapability {
  id: string;
  /** acpx agent token, or a raw command for the escape hatch. */
  acpxAgent: string;
  vendor: string;
  /** Can a turn be redirected while in flight? */
  steering: boolean;
  /** Can input be queued during a turn? */
  liveQueue: boolean;
  /** Can a turn be cancelled cooperatively? */
  interrupt: boolean;
  /** Can it spawn its own children? */
  subagents: boolean;
  /** Can a prior conversation be resumed? */
  resume: 'none' | 'warm' | 'cold';
  /** What a fork carries. */
  forkHistory: 'none' | 'rebuild' | 'preamble';
  /** Does it accept a persisted system-prompt override via ACP _meta? */
  systemPromptOverride: boolean;
  /** Does it expose reasoning_effort as an ACP config option? */
  effortConfig: boolean;
  /** How it asks a human for permission. */
  elicitation: 'none' | 'sse-permission' | 'approval-mirror';
  notes?: string;
}

/**
 * Seeded from acpx's own adapter contracts. Deliberately conservative: an
 * unverified capability is declared false, because degrading explicitly is
 * always cheaper than hanging.
 */
export const HARNESSES: Record<string, HarnessCapability> = {
  claude: {
    id: 'claude',
    acpxAgent: 'claude',
    vendor: 'claude',
    steering: false,
    liveQueue: true,
    interrupt: true,
    subagents: true,
    resume: 'warm',
    forkHistory: 'preamble',
    systemPromptOverride: true,
    // Verified against the adapter: `set reasoning_effort` returns Internal
    // error. Effort must be driven from the prompt for this harness.
    effortConfig: false,
    elicitation: 'sse-permission',
    notes: 'Loads project and local settings but not user settings.',
  },
  codex: {
    id: 'codex',
    acpxAgent: 'codex',
    vendor: 'codex',
    steering: false,
    liveQueue: true,
    interrupt: true,
    subagents: false,
    resume: 'warm',
    forkHistory: 'rebuild',
    systemPromptOverride: false,
    effortConfig: true,
    elicitation: 'sse-permission',
  },
  gemini: {
    id: 'gemini', acpxAgent: 'gemini', vendor: 'antigravity',
    steering: false, liveQueue: false, interrupt: true, subagents: false,
    resume: 'cold', forkHistory: 'none', systemPromptOverride: false,
    effortConfig: false, elicitation: 'sse-permission',
  },
  grok: {
    id: 'grok', acpxAgent: 'grok-build', vendor: 'grok',
    steering: false, liveQueue: false, interrupt: true, subagents: false,
    resume: 'cold', forkHistory: 'none', systemPromptOverride: false,
    effortConfig: false, elicitation: 'sse-permission',
  },
  kimi: {
    id: 'kimi', acpxAgent: 'kimi', vendor: 'kimi',
    steering: false, liveQueue: false, interrupt: true, subagents: false,
    resume: 'cold', forkHistory: 'none', systemPromptOverride: false,
    effortConfig: false, elicitation: 'sse-permission',
  },
};

export function capabilityOf(harnessId: string | null): HarnessCapability | undefined {
  return harnessId ? HARNESSES[harnessId] : undefined;
}

/**
 * Ask before planning. Returns a reason string when the plan is impossible, so
 * the caller degrades explicitly instead of waiting on something that cannot
 * happen.
 */
export function refuseIfUnsupported(
  harnessId: string | null,
  needs: Partial<Pick<HarnessCapability, 'steering' | 'liveQueue' | 'interrupt' | 'subagents'>>,
): string | null {
  const cap = capabilityOf(harnessId);
  if (!cap) return `unknown harness ${harnessId ?? '(none)'}`;
  for (const [k, wanted] of Object.entries(needs)) {
    if (wanted && !cap[k as keyof HarnessCapability]) {
      return `${cap.id} cannot ${k}; degrade explicitly rather than waiting`;
    }
  }
  return null;
}
