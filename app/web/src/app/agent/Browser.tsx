import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib';
import { Button, Chip, Note } from '@/components/ui/primitives';
import { readToken } from '@/shared/api/client';

type Control = 'agent_driving' | 'help_requested' | 'control_taken';

/**
 * The agent's stealth browser, forwarded into the thread.
 *
 * Frames arrive over a websocket; input events go back the same way. The
 * take-the-wheel protocol has three states, and the one everyone gets wrong is
 * the third: while a human drives, agent actions are REFUSED, not queued.
 */
export function BrowserView({ slug }: { slug: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [control, setControl] = useState<Control>('agent_driving');
  const [reason, setReason] = useState<string | null>(null);
  const [url, setUrl] = useState<string>('');
  const [framed, setFramed] = useState(false);
  const [live, setLive] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(
      `${proto}://${location.host}/ws/browser?agent=${encodeURIComponent(slug)}&token=${encodeURIComponent(readToken())}`,
    );
    ws.current = sock;
    sock.onopen = () => setLive(true);
    sock.onclose = () => setLive(false);
    sock.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as
        | { type: 'frame'; data: string; url?: string }
        | { type: 'control'; state: Control; reason?: string }
        | { type: 'unavailable'; reason: string };
      if (msg.type === 'frame') {
        if (img.current) img.current.src = `data:image/jpeg;base64,${msg.data}`;
        setFramed(true);
        if (msg.url) setUrl(msg.url);
      } else if (msg.type === 'control') {
        setControl(msg.state);
        setReason(msg.reason ?? null);
      } else {
        setReason(msg.reason);
      }
    };
    return () => sock.close();
  }, [slug]);

  const send = (m: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (control !== 'control_taken' || !img.current) return;
    const r = img.current.getBoundingClientRect();
    send({ type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };

  const tone = control === 'control_taken' ? 'working' : control === 'help_requested' ? 'blocker' : 'quiet';

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip tone={tone}>{control.replace(/_/g, ' ')}</Chip>
        {reason && <span className="text-[13px] text-blocker">{reason}</span>}
        <Button size="sm" className="ml-auto"
          variant={control === 'control_taken' ? 'primary' : 'default'}
          onClick={() => {
            const next = control === 'control_taken' ? 'agent_driving' : 'control_taken';
            setControl(next);
            send({ type: 'control', state: next });
          }}>
          {control === 'control_taken' ? 'Give it back' : 'Take the wheel'}
        </Button>
      </div>
      <div className="grid min-h-[220px] place-items-center overflow-hidden rounded-lg border border-border bg-muted">
        {/* Only mount the image once a frame has arrived: an <img> with no src
            renders as a broken-image icon, which reads as a bug rather than as
            "nothing is attached yet". */}
        <img ref={img} alt={`${slug} browser viewport`} onClick={onClick}
          className={cn('block w-full cursor-crosshair', framed ? '' : 'hidden')} />
        {!framed && (
          <span className="px-6 py-10 text-center font-mono text-[12px] text-muted-fg">
            {live ? 'waiting for a frame…' : 'no browser attached'}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[12px] text-muted-fg">{url || (live ? 'waiting for a frame…' : 'not connected')}</span>
        <span className="ml-auto font-mono text-[12px] text-muted-fg">profile {slug}</span>
      </div>
      <Note className="mt-2">
        {control === 'control_taken'
          ? 'You are driving. Agent actions are refused for the duration, not queued.'
          : 'Reasons are preserved verbatim — CAPTCHA, sign-in, consent, 2FA — rather than reduced to "blocked".'}
      </Note>
    </div>
  );
}
