import { useState } from 'react';
import { useSendMessage, useThread } from '@/shared/api/queries';
import type { Message } from '@/shared/api/types';
import { Button, Card, CardBody, Chip, Mono, Note } from '@/components/ui/primitives';
import { when } from '@/shared/format';
import { cn } from '@/lib';

/**
 * An agent's thread, as rows. Everything the agent said (REPORT lines while
 * it worked, its turn report after), what it asked, what the owner answered,
 * what other agents sent it, and what the loop did to it — one list, in
 * order, each row saying who wrote it.
 */
const KIND_TONE: Record<string, 'blocker' | 'working' | 'quiet' | 'fail'> = {
  ask: 'blocker', notify: 'working', human: 'working', verdict: 'working',
};

export function kindLabel(m: Message): string {
  if (m.kind === 'report') {
    try {
      if (m.meta && (JSON.parse(m.meta) as { turn?: boolean }).turn) return 'turn report';
    } catch { /* plain report */ }
  }
  return m.kind.replace(/_/g, ' ');
}

export function MessageRow({ m }: { m: Message }) {
  const system = m.author === 'system' || m.kind === 'event';
  return (
    <li className={cn('flex gap-3 py-2.5', system ? 'text-muted-fg' : '')} data-testid={`msg-${m.kind}`}>
      <div className="w-[128px] shrink-0">
        <Mono className="block truncate text-[12px]">{m.author.replace(/^(agent|human):/, '')}</Mono>
        <Mono className="block text-[11px] text-muted-fg">{when(m.created_at)}</Mono>
      </div>
      <div className="min-w-0 flex-1">
        <Chip tone={KIND_TONE[m.kind] ?? 'quiet'} className="mb-1">{kindLabel(m)}</Chip>
        <p className={cn('whitespace-pre-wrap text-[14px]', system && 'text-[13px]')}>{m.body}</p>
      </div>
    </li>
  );
}

export function ThreadView({ slug, filter, composer = true }: { slug: string; filter?: (m: Message) => boolean; composer?: boolean }) {
  const { data, isLoading } = useThread(slug);
  const [text, setText] = useState('');
  const send = useSendMessage(slug);
  const rows = (data ?? []).filter(filter ?? (() => true));

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send.mutate(t);
    setText('');
  };

  return (
    <Card>
      <CardBody>
        {isLoading ? <Note>Loading thread…</Note> : rows.length === 0 ? (
          <Note>Nothing here yet. REPORT lines appear the moment the agent writes them; the rest of a turn is filed when it ends.</Note>
        ) : (
          <ul className="divide-y divide-border">{rows.map((m) => <MessageRow key={m.id} m={m} />)}</ul>
        )}
        {composer && (
          <div className="mt-4 border-t border-border pt-3">
            <textarea
              data-testid="thread-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
              placeholder={`Message ${slug} — delivered to its inbox and read on its next turn`}
              className="min-h-[60px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[14px] outline-none focus:border-muted-fg/50"
            />
            <div className="mt-2 flex items-center gap-3">
              <Button variant="primary" size="sm" data-testid="thread-send" onClick={submit} disabled={send.isPending || !text.trim()}>Send</Button>
              <Note>
                {send.data
                  ? send.data.woke ? 'Delivered; the agent wakes on the next tick.' : 'Delivered; it is read on the next turn.'
                  : 'A human message wakes an active agent. It never answers mid-turn; the reply lands here.'}
              </Note>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
