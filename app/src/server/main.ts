import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { open } from '../store/db.ts';
import * as api from './api.ts';
import * as files from './files.ts';
import { thread } from '../supervisor/messages.ts';
import { proposePlan, applyPlan, listPlans, rejectPlan } from '../orchestrator/plan.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import * as term from './terminal.ts';
import { dbPathFor, paneName } from '../supervisor/workspace.ts';
import * as browser from './browser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// The built UI. `npm run build` in web/ produces it; dev uses Vite's own server.
const WEB = join(HERE, '..', '..', 'web', 'dist');

const projectRoot = process.env['AOA_PROJECT_ROOT'] ?? process.cwd();
// Beside the project, never inside the skill: an upgrade must not be able to
// delete a fleet's memory, and one checkout has to drive any number of projects.
const dbPath = dbPathFor(projectRoot);
const port = Number(process.env['AOA_PORT'] ?? 8787);

/**
 * Workspace auth is the ENTIRE security boundary.
 *
 * The workspace carries owner authority and (in M3) a real shell, so a
 * logged-in browser is the machine. A network control such as a private mesh is
 * not authentication and does not survive a stolen device or a browser left
 * open. A token is the floor, not the ceiling.
 */
const TOKEN = process.env['AOA_TOKEN'] ?? randomBytes(24).toString('base64url');
const REQUIRE_AUTH = process.env['AOA_NO_AUTH'] !== '1';

function authorized(req: { headers: Record<string, unknown> }): boolean {
  if (!REQUIRE_AUTH) return true;
  const raw = String(req.headers['authorization'] ?? '');
  const got = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (got.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

const db = open(dbPath);

type Handler = (
  body: unknown,
  q: URLSearchParams,
  params: string[],
) => unknown;

const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/state$/, () => ({
    agents: api.listAgents(db).map((a) => api.agentView(db, a)),
    channels: api.channels(db),
    needsYou: api.needsYou(db),
    fleet: api.fleetStatus(db),
    backlog: api.listBacklog(db),
    orchestrator: api.getAgentBySlug(db, 'orchestrator')?.slug ?? null,
  })],
  ['GET', /^\/api\/agents$/, () => api.listAgents(db).map((a) => api.agentView(db, a))],
  ['GET', /^\/api\/agents\/([^/]+)$/, (_b, _q, p) => {
    const a = api.getAgentBySlug(db, p[0]!);
    return a ? api.agentView(db, a) : null;
  }],
  ['GET', /^\/api\/agents\/([^/]+)\/thread$/, (_b, q, p) => {
    const a = api.getAgentBySlug(db, p[0]!);
    if (!a) return null;
    return thread(db, a.id, Number(q.get('after') ?? 0));
  }],
  ['POST', /^\/api\/agents\/([^/]+)\/message$/, (b, _q, p) => {
    const a = api.getAgentBySlug(db, p[0]!);
    if (!a) return null;
    const body = b as { text: string; author?: string };
    return api.appendMessage(db, {
      agentId: a.id, kind: 'human', author: body.author ?? 'human:owner', body: body.text,
    });
  }],
  ['GET', /^\/api\/agents\/([^/]+)\/docs$/, (_b, _q, p) => {
    const a = api.getAgentBySlug(db, p[0]!);
    if (!a) return null;
    return { relevant: files.relevantTo(projectRoot, a.slug, a.docs_ref) };
  }],

  ['GET', /^\/api\/needs-you$/, () => api.needsYou(db)],
  ['POST', /^\/api\/asks\/([^/]+)\/answer$/, (b, _q, p) => {
    const body = b as {
      optionId?: string; text?: string; by?: string;
      actionHash?: string; policyVersion?: string;
    };
    // The client echoes back the binding it was shown. If the ask moved
    // underneath it, that echo no longer matches and the answer is refused.
    return api.answer(db, p[0]!, {
      by: body.by ?? 'human:owner',
      ...(body.optionId !== undefined ? { optionId: body.optionId } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.actionHash !== undefined ? { currentActionHash: body.actionHash } : {}),
      ...(body.policyVersion !== undefined ? { currentPolicyVersion: body.policyVersion } : {}),
    });
  }],

  ['GET', /^\/api\/fleet$/, () => api.fleetStatus(db)],
  ['POST', /^\/api\/agents\/([^/]+)\/activate$/, (_b, _q, p) => {
    const a = api.getAgentBySlug(db, p[0]!);
    if (!a) return null;
    db.prepare(
      `UPDATE agents SET status='ACTIVE', next_due_at=?, wake_reason='human', updated_at=?, version=version+1 WHERE id=?`,
    ).run(Date.now(), Date.now(), a.id);
    return { ok: true, slug: a.slug };
  }],

  /**
   * A short-lived credential for the hosted voice edge. The API key stays on
   * this side; the browser never sees it.
   */
  ['POST', /^\/api\/voice\/token$/, () => {
    const key = process.env['ELEVENLABS_API_KEY'];
    const agentId = process.env['ELEVENLABS_AGENT_ID'];
    if (!key || !agentId) {
      return {
        error:
          'Voice edge not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to enable it; ' +
          'the browser speech API is used as a local fallback until then.',
      };
    }
    return { signedUrl: `https://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}` };
  }],

  ['GET', /^\/api\/backlog$/, () => api.listBacklog(db)],
  ['POST', /^\/api\/backlog$/, (b) => {
    const body = b as { title: string; question: string; rationale?: string; tier?: number };
    return api.addBacklogItem(db, { ...body, raisedBy: 'human:owner' });
  }],
  ['POST', /^\/api\/backlog\/([^/]+)\/promote$/, (b, _q, p) => {
    const body = b as { agent: string };
    const a = api.getAgentBySlug(db, body.agent);
    if (!a) return null;
    return { askId: api.promoteBacklogItem(db, p[0]!, a.id) };
  }],

  ['GET', /^\/api\/accounts$/, (_b, q) => api.listAccounts(db, {
    ...(q.get('search') ? { search: q.get('search')! } : {}),
    ...(q.get('status') ? { status: q.get('status')! } : {}),
    ...(q.get('dictionary') ? { dictionary: q.get('dictionary')! } : {}),
  })],
  ['POST', /^\/api\/accounts\/dictionaries$/, (b) => {
    const body = b as { name: string; location: string; registeredBy?: string };
    return { id: api.registerDictionary(db, { ...body, registeredBy: body.registeredBy ?? 'human:owner' }) };
  }],

  // ── the orchestrator command surface ─────────────────────────────────────
  ['GET', /^\/api\/plans$/, () => listPlans(db)],
  ['POST', /^\/api\/orchestrator\/ask$/, (b) => {
    const body = b as { text: string };
    return proposePlan(db, body.text, 'human:owner');
  }],
  ['POST', /^\/api\/plans\/([^/]+)\/apply$/, (_b, _q, p) => applyPlan(db, p[0]!, 'human:owner')],
  ['POST', /^\/api\/plans\/([^/]+)\/reject$/, (_b, _q, p) => rejectPlan(db, p[0]!, 'human:owner')],

  // ── docs: a project file browser ─────────────────────────────────────────
  ['GET', /^\/api\/files$/, () => ({ root: projectRoot, entries: files.tree(projectRoot) })],
  ['GET', /^\/api\/file$/, (_b, q) => files.readFile(projectRoot, q.get('path') ?? '')],
  ['PUT', /^\/api\/file$/, (b) => {
    const body = b as { path: string; content: string };
    return files.writeFile(projectRoot, body.path, body.content);
  }],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const send = (code: number, payload: unknown, type = 'application/json') => {
    const body = type === 'application/json' ? JSON.stringify(payload) : String(payload);
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req as never)) return send(401, { error: 'unauthorized' });
    let body: unknown;
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: 'bad json' });
      }
    }
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        const out = handler(body, url.searchParams, m.slice(1) as string[]);
        return send(out === null ? 404 : 200, out ?? { error: 'not found' });
      } catch (err) {
        return send(500, { error: String(err) });
      }
    }
    return send(404, { error: 'no route' });
  }

  // static web app; unknown paths fall back to index.html so the client owns routing
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    let abs = files.safeJoin(WEB, requested);
    if (!abs) return send(400, 'bad path', 'text/plain');
    if (!existsSync(abs)) abs = join(WEB, 'index.html');
    const file = abs;
    const data = readFileSync(abs);
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/html';
    res.writeHead(200, { 'content-type': type });
    return res.end(data);
  } catch {
    return send(404, 'not found', 'text/plain');
  }
});

/**
 * Two websocket surfaces: a terminal attached to an agent's tmux session, and a
 * browser viewport forwarded from its stealth profile. Both authenticate with
 * the same token as the REST API — the workspace has one boundary, not three.
 */
const wssTerminal = new WebSocketServer({ noServer: true });
const wssBrowser = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const tokenOk =
    !REQUIRE_AUTH || url.searchParams.get('token') === TOKEN;
  if (!tokenOk) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname === '/ws/terminal') {
    wssTerminal.handleUpgrade(req, socket, head, (ws) => {
      wssTerminal.emit('connection', ws, req, url);
    });
  } else if (url.pathname === '/ws/browser') {
    wssBrowser.handleUpgrade(req, socket, head, (ws) => {
      wssBrowser.emit('connection', ws, req, url);
    });
  } else {
    socket.destroy();
  }
});

wssTerminal.on('connection', (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  // The query carries the agent slug; the tmux name is namespaced by project,
  // so two fleets never share a terminal.
  const slug = url.searchParams.get('session') ?? '';
  const agent = api.getAgentBySlug(db, slug);
  const session = agent ? paneName(projectRoot, slug) : slug;
  if (agent) term.ensureSession(session, projectRoot);

  // Replay first, then attach: the live stream must not start before the
  // history it continues from.
  const past = term.history(session);
  if (past.trim() && ws.readyState === ws.OPEN) ws.send(past);

  const att = term.attach(session, (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  if (!att) {
    ws.send(
      term.tmuxAvailable()
        ? `\r\n[no tmux session '${session}' yet — one is created when the supervisor first dispatches this agent]\r\n`
        : '\r\n[tmux is not installed on this host; the terminal view needs it]\r\n',
    );
    return;
  }
  ws.on('message', (raw: unknown) => {
    let m: { type?: string; data?: string; cols?: number; rows?: number; grant?: boolean };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'input' && m.data) att.write(m.data);
    else if (m.type === 'resize') att.resize(m.cols ?? 100, m.rows ?? 30);
    else if (m.type === 'control') att.grantControl(!!m.grant);
  });
  ws.on('close', () => att.close());
});

wssBrowser.on('connection', (ws: WebSocket, _req: IncomingMessage, url: URL) => {
  const slug = url.searchParams.get('agent') ?? '';
  const sess = browser.sessionFor(slug, projectRoot);
  const avail = browser.stealthAvailable(projectRoot);

  ws.send(JSON.stringify({ type: 'control', state: sess.control, reason: sess.reason }));
  if (!avail.ok) {
    // Say why the viewport is empty rather than showing a dead frame.
    ws.send(JSON.stringify({ type: 'unavailable', reason: avail.detail }));
  }

  ws.on('message', (raw: unknown) => {
    let m: { type?: string; state?: browser.ControlState };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'control' && m.state) {
      const s = browser.setControl(slug, m.state);
      ws.send(JSON.stringify({ type: 'control', state: s?.control, reason: s?.reason }));
    }
  });
});

server.listen(port, () => {
  process.stdout.write(`workspace on http://127.0.0.1:${port}\n`);
  if (REQUIRE_AUTH) process.stdout.write(`token: ${TOKEN}\n`);
  process.stdout.write(`project root: ${projectRoot}\n`);
});

export { server, TOKEN };
