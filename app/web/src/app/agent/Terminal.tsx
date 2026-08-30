import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button, Note } from '@/components/ui/primitives';
import { readToken } from '@/shared/api/client';

/**
 * A view onto the agent's real tmux session.
 *
 * The session outlives this browser tab, which is the entire reason it is tmux
 * and not a bare pty: reconnecting reattaches and the scrollback is still there.
 *
 * Read-only until you take control, and that is a CORRECTNESS rule rather than
 * a security one — two writers on one pty interleave, so while you drive, the
 * agent's input is refused rather than queued.
 */
export function TerminalView({ session }: { session: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const [driving, setDriving] = useState(false);
  const [state, setState] = useState<'connecting' | 'attached' | 'closed'>('connecting');

  useEffect(() => {
    if (!session || !host.current) return;
    const term = new Xterm({
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 12, convertEol: true, scrollback: 5000, cursorBlink: false,
      theme: { background: '#0b0d11', foreground: '#e8ecf4' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(
      `${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session)}&token=${encodeURIComponent(readToken())}`,
    );
    ws.current = sock;
    sock.onopen = () => setState('attached');
    sock.onclose = () => setState('closed');
    sock.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '');

    const onData = term.onData((d) => {
      if (!driving) return; // refused, not queued
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'input', data: d }));
    });
    const onResize = () => {
      fit.fit();
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      onData.dispose();
      sock.close();
      term.dispose();
    };
  }, [session, driving]);

  if (!session) {
    return <Note>This agent has no tmux session yet. One is created when the supervisor first dispatches it.</Note>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[12px] text-muted-fg">session {session}</span>
        <span className="font-mono text-[12px] text-muted-fg">· {state}</span>
        <Button size="sm" className="ml-auto" variant={driving ? 'primary' : 'default'}
          onClick={() => setDriving((d) => !d)}>
          {driving ? 'Release control' : 'Take control'}
        </Button>
      </div>
      <div ref={host} className="h-[460px] overflow-hidden rounded-lg border border-border bg-[#0b0d11] p-2" />
      <Note className="mt-2">
        {driving
          ? 'You are driving. Agent input is refused for the duration, not queued — a queued action would resume into a shell that has moved.'
          : 'Read-only. Click Take control to type. Every human command is attributed in the audit trail.'}
      </Note>
    </div>
  );
}
