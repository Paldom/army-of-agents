import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Forward an agent's browser into its thread.
 *
 * The agent's browser is a stealth build driven through `playwright-stealth`
 * (CloakBrowser — a Chromium fork with fingerprint patches at the source
 * level), so the Chrome DevTools Protocol is available. Frames are periodic
 * `Page.captureScreenshot` calls over a raw CDP socket rather than a
 * screencast: a few frames per second, no extra dependency, and enough to see
 * a CAPTCHA and take the wheel, which is the actual job.
 *
 * "Configured" means the browser was launched with remote debugging on, so
 * Chromium wrote `DevToolsActivePort` into the identity's `user-data/`, or
 * `AOA_BROWSER_CDP=host:port` names an endpoint. Without either the tab says
 * exactly that rather than showing a dead viewport.
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
 * Are there stealth identities to attach to? Identities live in `.stealth/`
 * of the directory the agent runs in — its worktree — or of the project
 * itself. An npm `playwright` package is not evidence of anything: the
 * stealth browser is a Python package, and the doctor probes that separately.
 */
export function stealthAvailable(root: string, worktree?: string): { ok: boolean; detail: string } {
  for (const r of worktree ? [worktree, root] : [root]) {
    const dir = join(r, '.stealth');
    if (existsSync(dir)) return { ok: true, detail: `playwright-stealth identities in ${dir}` };
  }
  return {
    ok: false,
    detail:
      'no .stealth identities. Add the skill with `npx skills add paldom/playwright-stealth` ' +
      'and create an identity per agent; until then the Browser tab says why it is empty.',
  };
}

/** `host:port`, including `[::1]:9222`. */
function parseEndpoint(value: string): CdpEndpoint | null {
  try {
    const u = new URL(`http://${value}`);
    const port = Number(u.port);
    return port ? { host: u.hostname, port } : null;
  } catch {
    return null;
  }
}

export interface CdpEndpoint {
  host: string;
  port: number;
}

/**
 * Find a live DevTools endpoint for this agent. `AOA_BROWSER_CDP` wins; then
 * any identity under `.stealth/` with a `cdp.json` (`{"host","port"}`, which
 * is what a launcher that enabled remote debugging should publish — Playwright
 * itself launches over a pipe and leaves no port file); then Chromium's own
 * `DevToolsActivePort`, written when launched with `--remote-debugging-port`.
 */
export function discoverCdp(
  roots: string[],
  env: NodeJS.ProcessEnv = process.env,
  slug?: string,
): CdpEndpoint | null {
  // Per agent first (AOA_BROWSER_CDP_<SLUG>, dashes as underscores), then
  // the one endpoint a single-agent fleet sets for everyone.
  const perAgent = slug ? env[`AOA_BROWSER_CDP_${slug.toUpperCase().replace(/-/g, '_')}`] : undefined;
  for (const value of [perAgent, env['AOA_BROWSER_CDP']]) {
    if (!value) continue;
    const ep = parseEndpoint(value);
    if (ep) return ep;
  }
  // An identity named after the agent, in any root, before any other: a
  // shared root holds every agent's identities, and "the first one" would
  // be another agent's browser.
  const candidates: Array<[string, string]> = [];
  for (const root of roots) {
    let ids: string[];
    try {
      ids = readdirSync(join(root, '.stealth'));
    } catch {
      continue;
    }
    for (const id of ids) candidates.push([root, id]);
  }
  candidates.sort(([, a], [, b]) => Number(b === slug) - Number(a === slug));
  for (const [root, id] of candidates) {
    {
      const published = join(root, '.stealth', id, 'cdp.json');
      if (existsSync(published)) {
        try {
          const j = JSON.parse(readFileSync(published, 'utf8')) as { host?: string; port?: number };
          if (j.port) return { host: j.host ?? '127.0.0.1', port: Number(j.port) };
        } catch {
          /* a malformed file is the same as no file */
        }
      }
      const f = join(root, '.stealth', id, 'user-data', 'DevToolsActivePort');
      if (!existsSync(f)) continue;
      const port = Number(readFileSync(f, 'utf8').split('\n')[0]);
      if (port) return { host: '127.0.0.1', port };
    }
  }
  return null;
}

const CDP_TIMEOUT_MS = 5000;

export interface Grabber {
  grab(): Promise<{ jpegBase64: string; url: string } | null>;
  /** Normalised viewport coordinates, 0..1. */
  click(x: number, y: number): Promise<void>;
  close(): void;
}

/** Attach to the first page target over CDP. Null when nothing answers. */
export async function cdpGrabber(ep: CdpEndpoint): Promise<Grabber | null> {
  type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
  const list = await fetch(`http://${ep.host}:${ep.port}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) })
    .then((r) => r.json() as Promise<unknown>)
    .catch(() => null);
  const targets = Array.isArray(list) ? (list as Target[]) : [];
  const pages = targets.filter((t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  // The page a human would want to see: not a new-tab or a devtools window
  // when a real one is open.
  const page =
    pages.find((t) => !/^(chrome|about|devtools|edge):/.test(t.url)) ?? pages[0];
  if (!page?.webSocketDebuggerUrl) return null;

  const sock = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, handshakeTimeout: CDP_TIMEOUT_MS });
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('open', () => resolve());
      sock.once('error', reject);
    });
  } catch {
    return null;
  }

  let nextId = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  sock.on('message', (raw) => {
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try {
      m = JSON.parse(String(raw)) as typeof m;
    } catch {
      return; // not ours to crash over
    }
    const w = m.id !== undefined ? waiting.get(m.id) : undefined;
    if (!w || m.id === undefined) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error.message));
    else w.resolve(m.result);
  });
  sock.on('close', () => {
    for (const w of waiting.values()) w.reject(new Error('cdp closed'));
    waiting.clear();
  });
  // Every call has a deadline: a browser that stops answering must not hold
  // a frame pump, and through it a websocket handler, open forever.
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, CDP_TIMEOUT_MS);
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sock.send(JSON.stringify({ id, method, params }));
    });

  // Screenshots and input need the page domain; a browser that refuses is
  // reported through the first grab rather than here.
  await call('Page.enable').catch(() => undefined);

  return {
    async grab() {
      const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
      const loc = await call<{ result: { value?: string } }>('Runtime.evaluate', {
        expression: 'location.href', returnByValue: true,
      });
      return { jpegBase64: shot.data, url: loc.result.value ?? page.url };
    },
    async click(x, y) {
      const m = await call<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
        'Page.getLayoutMetrics',
      );
      const px = Math.round(x * m.cssLayoutViewport.clientWidth);
      const py = Math.round(y * m.cssLayoutViewport.clientHeight);
      // Move first: a press with no preceding move lands on whatever the page
      // thought was under a pointer that never arrived.
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', { type, x: px, y: py, button: 'left', clickCount: 1 });
      }
    },
    close() {
      sock.close();
    },
  };
}

export interface FramePump {
  stop(): void;
}

/**
 * Poll frames from a live page. Injected so the server does not depend on a
 * browser being up — with no grabber, the tab reports honestly that nothing
 * is attached rather than showing a dead viewport.
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
