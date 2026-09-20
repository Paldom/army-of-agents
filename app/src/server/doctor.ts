import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { HARNESSES } from '../acp/capabilities.ts';
import { acpxBin } from '../acp/session.ts';
import { stealthAvailable } from './browser.ts';
import { tmuxAvailable } from './terminal.ts';

/**
 * Health checks a human can act on, LLM-free and cheap.
 *
 * Every optional integration degrades silently by design — no tmux means
 * piped stdio, no stealth means an empty browser tab — which is right for the
 * loop and wrong for the person wondering why a tab is blank. This says which
 * it is.
 *
 * Asynchronous and parallel: eight subprocesses in series on a slow host held
 * the server's single thread for the whole of it, and every other request
 * with it.
 */
export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  /** False for the things the loop cannot run without. */
  optional: boolean;
}

const exec = promisify(execFile);

async function version(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, args, { encoding: 'utf8', timeout: 8000 });
    return stdout.trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(existsSync(dir) ? dir : dirname(dir), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorInput {
  projectRoot: string;
  stateDir: string;
  /** The harness the orchestrator row actually has, so a changed env var is reported rather than ignored. */
  orchestratorHarness?: string | null;
  env?: NodeJS.ProcessEnv;
}

export async function doctor(input: DoctorInput): Promise<Check[]> {
  const env = input.env ?? process.env;
  const major = Number(process.versions.node.split('.')[0]);
  const bin = acpxBin();

  const [acpx, harnesses, tmuxVersion, git, cloak] = await Promise.all([
    version(bin),
    Promise.all(
      Object.values(HARNESSES).map(async (h) => ({ h, bin: h.cli ?? h.acpxAgent, v: await version(h.cli ?? h.acpxAgent) })),
    ),
    tmuxAvailable() ? version('tmux', ['-V']) : Promise.resolve(null),
    version('git', ['-C', input.projectRoot, 'rev-parse', '--is-inside-work-tree']),
    // The stealth browser is a Python package, not an npm one: this is the
    // preflight the playwright-stealth skill itself runs.
    version('python3', ['-c', 'import cloakbrowser; print("cloakbrowser importable")']),
  ]);

  const checks: Check[] = [];
  checks.push({ id: 'node', ok: major >= 22, detail: `node ${process.versions.node}`, optional: false });
  checks.push({
    id: 'acpx', ok: acpx !== null, optional: false,
    detail: acpx !== null ? `${bin} ${acpx}` : `${bin} not found: npm i -g acpx (or set AOA_ACPX_BIN)`,
  });
  for (const { h, bin: b, v } of harnesses) {
    checks.push({
      id: `harness:${h.id}`, ok: v !== null, optional: true,
      detail: v !== null ? `${b} ${v}` : `${b} not on PATH; agents on the ${h.vendor} lane cannot run`,
    });
  }
  const tmux = tmuxAvailable();
  checks.push({
    id: 'tmux', ok: tmux, optional: true,
    detail: tmux ? tmuxVersion ?? 'tmux' : 'tmux not found: turns fall back to piped stdio and the Terminal tab stays empty',
  });
  let ptyOk = false;
  try {
    createRequire(import.meta.url).resolve('node-pty');
    ptyOk = true;
  } catch {
    /* reported below */
  }
  checks.push({
    id: 'node-pty', ok: ptyOk, optional: true,
    detail: ptyOk ? 'node-pty present' : 'node-pty missing: the Terminal tab cannot attach',
  });
  checks.push({
    id: 'git', ok: git === 'true', optional: true,
    detail: git === 'true' ? 'project is a git repo; one worktree per agent' : 'not a git repo: agents share the project root, writes are not isolated',
  });
  const w = writable(input.stateDir);
  checks.push({
    id: 'state', ok: w, optional: false,
    detail: w ? `state in ${input.stateDir}` : `${input.stateDir} is not writable`,
  });

  const stealth = stealthAvailable(input.projectRoot);
  const browserOk = stealth.ok && cloak !== null;
  checks.push({
    id: 'browser', ok: browserOk, optional: true,
    detail: browserOk
      ? `${stealth.detail}; ${cloak}`
      : !stealth.ok
        ? stealth.detail
        : `${stealth.detail}, but python3 cannot import cloakbrowser: run the playwright-stealth-setup skill`,
  });
  const voice = !!(env['ELEVENLABS_API_KEY'] && env['ELEVENLABS_AGENT_ID']);
  checks.push({
    id: 'voice', ok: voice, optional: true,
    detail: voice ? 'hosted voice edge configured' : 'not configured: the browser speech API is used instead',
  });
  const wanted = env['AOA_ORCHESTRATOR_HARNESS'];
  if (input.orchestratorHarness !== undefined) {
    const have = input.orchestratorHarness;
    const mismatch = !!wanted && wanted !== have;
    checks.push({
      id: 'orchestrator', ok: !!have && !mismatch, optional: false,
      detail: !have
        ? 'the orchestrator has no harness; it cannot run'
        : mismatch
          ? `orchestrator runs on ${have}; AOA_ORCHESTRATOR_HARNESS=${wanted} only applies to a fresh store`
          : `orchestrator on ${have}`,
    });
  }
  const hook = !!env['AOA_EVENT_HOOK'];
  checks.push({
    id: 'event-hook', ok: hook, optional: true,
    detail: hook ? `AOA_EVENT_HOOK set: ${env['AOA_EVENT_HOOK']}` : 'AOA_EVENT_HOOK unset: asks are visible only in the workspace',
  });
  return checks;
}

let cached: { at: number; checks: Check[] } | null = null;
let inFlight: Promise<Check[]> | null = null;

/** Subprocess checks cost real time; the page polls, so answer from a short cache and never run two at once. */
export async function doctorCached(input: DoctorInput, ttlMs = 60_000): Promise<Check[]> {
  if (cached && Date.now() - cached.at < ttlMs) return cached.checks;
  if (!inFlight) {
    inFlight = doctor(input)
      .then((checks) => {
        cached = { at: Date.now(), checks };
        return checks;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
