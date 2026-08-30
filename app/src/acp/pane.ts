import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { interpret } from './events.ts';

/**
 * The wrapper that runs INSIDE an agent's tmux pane.
 *
 * acpx has one output format at a time: `--format json` gives the supervisor
 * parseable NDJSON, `--format text` gives a human something readable. The
 * workspace needs both — the loop classifies the outcome from events, and the
 * terminal tab has to show a person the real session rather than a wall of
 * JSON. So this process takes the JSON stream and splits it: raw lines to the
 * capture file the supervisor reads, a readable rendering to its own stdout,
 * which is the pane.
 *
 * It is a separate entry point precisely so the pane runs ONE well-quoted
 * command. Everything else moves through files in the job directory, so no
 * prompt text is ever interpolated into a shell line.
 *
 * It is also the LIVENESS AUTHORITY. The supervisor cannot tell "the model is
 * thinking" from "this prompt is queued behind an orphan" from "the wrapper is
 * dead" by watching the capture file — all three produce zero bytes. So the
 * wrapper publishes what only it knows: which phase it is in, and that it is
 * still alive. Without that the only signal left is the hard deadline, which
 * is how a stall became a 30-minute silence.
 */

const jobDir: string = process.argv[2] ?? '';
if (!jobDir) {
  process.stderr.write('usage: pane.ts <jobdir>\n');
  process.exit(2);
}

const argv = JSON.parse(readFileSync(join(jobDir, 'argv.json'), 'utf8')) as string[];
const input = readFileSync(join(jobDir, 'input.txt'), 'utf8');
const capture = createWriteStream(join(jobDir, 'stdout.ndjson'));

/**
 * Phases, in order. `submitted` with no bytes means acpx accepted the prompt
 * but nothing has come back — which is exactly the queued-behind-an-orphan
 * state, and is why it is a phase of its own rather than part of `streaming`.
 */
type Phase = 'spawning' | 'submitted' | 'streaming' | 'done';
let phase: Phase = 'spawning';
let bytes = 0;

/**
 * Written atomically. A half-written heartbeat read by the supervisor would be
 * indistinguishable from a corrupt one, and the supervisor kills on corrupt.
 */
function beat(): void {
  const tmp = join(jobDir, 'heartbeat.tmp');
  try {
    writeFileSync(tmp, JSON.stringify({ phase, bytes, ts: Date.now(), pid: process.pid }));
    renameSync(tmp, join(jobDir, 'heartbeat'));
  } catch {
    /* the supervisor may have reaped this job dir; the exit path notices */
  }
}

const dim = '[2m';
const bold = '[1m';
const red = '[31m';
const off = '[0m';

const out = (s: string): void => void process.stdout.write(s);

out(`${dim}${'─'.repeat(72)}${off}\n`);
// Drop --system-prompt AND its value: skipping only the flag printed the
// entire persona into the pane on every single turn.
const headline: string[] = [];
for (let i = 0; i < argv.length && headline.length < 10; i++) {
  if (argv[i] === '--system-prompt' || argv[i] === '--append-system-prompt') { i++; continue; }
  headline.push(argv[i]!);
}
out(`${bold}acpx ${headline.join(' ')}${off}\n`);
out(`${dim}${input.split('\n').slice(0, 3).join(' ').slice(0, 160)}…${off}\n\n`);

/** Render one frame. Anything unrecognised stays silent — an unknown frame
 * printed raw would put back exactly the JSON wall this exists to remove. */
function render(frame: Record<string, unknown>): void {
  const u = interpret(frame);
  if (u.kind === 'text') out(u.text);
  else if (u.kind === 'thought') out(`${dim}${u.text}${off}`);
  else if (u.kind === 'tool' && u.status !== 'pending') {
    out(`\n${dim}· ${u.toolName}${u.command ? ` ${u.command.split('\n')[0]!.slice(0, 60)}` : ''}${off}\n`);
  } else if (u.kind === 'usage' && u.size) {
    out(`\n${dim}[context ${Math.round((u.used / u.size) * 100)}%]${off}\n`);
  } else if (u.kind === 'permission') {
    out(`\n${red}! permission escalation — acpx answers these with the reject option${off}\n`);
  } else if (u.kind === 'error') out(`\n${red}! ${u.text}${off}\n`);
}

// `detached` makes the child a process-group leader, so one kill takes acpx
// AND the harness it spawned. Killing only the acpx pid leaves the real
// `claude-agent-acp` running and still holding the session's queue.
const child = spawn('acpx', argv, { stdio: ['pipe', 'pipe', 'inherit'], detached: true });

// Recorded before the first beat so a reconciler always has something to kill,
// even if this process dies in the next millisecond.
writeFileSync(
  join(jobDir, 'started.json'),
  JSON.stringify({ wrapperPid: process.pid, acpxPid: child.pid, pgid: child.pid, startedAt: Date.now() }),
);
phase = 'submitted';
beat();
const beating = setInterval(beat, 2000);

let carry = '';
child.stdout.on('data', (chunk: Buffer) => {
  capture.write(chunk);
  bytes += chunk.length;
  if (phase === 'submitted') {
    phase = 'streaming';
    beat();
  }
  carry += chunk.toString('utf8');
  const lines = carry.split('\n');
  carry = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      render(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* a partial or malformed line is not worth failing the run over */
    }
  }
});

child.stdin.write(input);
child.stdin.end();

child.on('close', (code) => {
  clearInterval(beating);
  phase = 'done';
  beat();
  capture.end();
  out(`\n${dim}${'─'.repeat(72)}\nexit ${code ?? -1}${off}\n`);
  // Written last and in one call: the supervisor polls for this file, so it
  // must not become visible before the capture is flushed.
  capture.on('finish', () => {
    writeFileSync(join(jobDir, 'exit'), String(code ?? -1));
    process.exit(0);
  });
});
