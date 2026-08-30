import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Forward an agent's browser into its thread.
 *
 * The agent's browser is a stealth build driven through `playwright-stealth`
 * (camoufox — a Firefox derivative), NOT Chromium. That rules out CDP
 * screencast, which is a Chrome DevTools Protocol feature: there is no
 * `Page.startScreencast` to subscribe to. Playwright's own screenshot API works
 * across engines, so frames are periodic screenshots rather than a push stream.
 *
 * The honest cost: this is polled, not event-driven, so it is a few frames per
 * second rather than smooth video. It is enough to see a CAPTCHA and take the
 * wheel, which is the actual job. Anything claiming a real screencast here on a
 * Firefox build is claiming something the engine does not offer.
 */

export type ControlState = 'agent_driving' | 'help_requested' | 'control_taken';

export interface BrowserSession {
  agentSlug: string;
  control: ControlState;
  reason: string | null;
  /** Where this agent's persistent stealth profile lives. */
  profileDir: string;
}

const sessions = new Map<string, BrowserSession>();

export function sessionFor(agentSlug: string, root: string): BrowserSession {
  let s = sessions.get(agentSlug);
  if (!s) {
    s = {
      agentSlug,
      control: 'agent_driving',
      reason: null,
      profileDir: join(root, '.browser-profiles', agentSlug),
    };
    sessions.set(agentSlug, s);
  }
  return s;
}

export function setControl(agentSlug: string, state: ControlState, reason?: string): BrowserSession | undefined {
  const s = sessions.get(agentSlug);
  if (!s) return undefined;
  s.control = state;
  s.reason = reason ?? (state === 'agent_driving' ? null : s.reason);
  return s;
}

/**
 * While a human drives, the agent's actions are REFUSED, not queued. A queued
 * action resumes into a page that has moved, which is worse than refusing.
 */
export function agentMayAct(agentSlug: string): { allowed: boolean; refusal?: string } {
  const s = sessions.get(agentSlug);
  if (!s || s.control === 'agent_driving') return { allowed: true };
  return {
    allowed: false,
    refusal:
      s.control === 'control_taken'
        ? 'A human is driving this browser. Actions are refused rather than queued.'
        : `Paused, waiting for a human: ${s.reason ?? 'unspecified'}`,
  };
}

/** Is the stealth toolchain actually installed? Say so rather than failing opaquely. */
export function stealthAvailable(root: string): { ok: boolean; detail: string } {
  const marker = join(root, '.stealth');
  if (existsSync(marker)) return { ok: true, detail: 'playwright-stealth profiles found' };
  try {
    // Present as a dependency of the host project, not of this app.
    require.resolve('playwright');
    return { ok: true, detail: 'playwright present; no .stealth profiles yet' };
  } catch {
    return {
      ok: false,
      detail:
        'playwright-stealth is not installed. Add it with `npx skills add paldom/playwright-stealth` ' +
        'and create a profile per agent; until then the browser tab shows why it is empty rather than a blank frame.',
    };
  }
}

export interface FramePump {
  stop(): void;
}

/**
 * Poll frames from a live page. Injected so the server does not depend on
 * playwright being installed — with no grabber, the tab reports honestly that
 * nothing is attached rather than showing a dead viewport.
 */
export function pumpFrames(
  grab: () => Promise<{ jpegBase64: string; url: string } | null>,
  send: (msg: unknown) => void,
  intervalMs = 400,
): FramePump {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const f = await grab();
      if (f) send({ type: 'frame', data: f.jpegBase64, url: f.url });
    } catch (err) {
      send({ type: 'unavailable', reason: String(err).slice(0, 200) });
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return { stop() { stopped = true; } };
}
