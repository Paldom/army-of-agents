import { useState } from 'react';
import { useAnswer, useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { ago } from '@/shared/format';
import type { Ask } from '@/shared/api/types';
import { Button, Card, CardBody, CardFoot, CardHead, Chip, Empty, Mono, Note } from '@/components/ui/primitives';
import { cn } from '@/lib';
import type { Notice } from '@/shared/api/types';

/**
 * NOTIFY lines: seen, not answered. Quiet on purpose — they never badge and
 * never sort above an ask, because nothing is waiting on you.
 */
function Notices({ notices }: { notices: Notice[] }) {
  const openAgent = useUi((s) => s.openAgent);
  if (notices.length === 0) return null;
  return (
    <Card className="mt-6" data-testid="notices">
      <CardBody>
        <b>Notices</b>
        <Note className="mb-2 mt-0.5">Things agents wanted you to see. No answer is needed.</Note>
        <ul className="divide-y divide-border">
          {notices.map((n) => (
            <li key={n.id} className="flex items-baseline gap-3 py-1.5 text-[13px]">
              <Mono className="shrink-0 text-muted-fg">{ago(Date.now() - n.at)}</Mono>
              <Button variant="ghost" size="sm" className="shrink-0 px-0" onClick={() => openAgent(n.agent)}><b>{n.agent}</b></Button>
              <span>{n.body}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function NeedsYou() {
  const { data } = useWorkspace();
  const items = data?.needsYou ?? [];
  const notices = data?.notices ?? [];

  if (items.length === 0) {
    return (
      <>
        <h1>Needs you</h1>
        <Empty title="Nothing is waiting on you."
          hint="Agents that are backing off, scheduled or capped are fine — they never appear here." />
        <Notices notices={notices} />
      </>
    );
  }

  const agents = new Set(items.map((q) => q.agent)).size;
  const longest = items[0]!;

  return (
    <>
      <h1>Needs you</h1>
      <p className="mb-6 mt-1.5 max-w-[72ch] text-muted-fg">
        <b className="text-fg">{items.length}</b> ask{items.length > 1 ? 's' : ''} open across{' '}
        <b className="text-fg">{agents}</b> agent{agents > 1 ? 's' : ''}.{' '}
        {longest.ageUnknown
          ? <>These were imported, so their ages are unknown rather than zero.</>
          : <>The longest, <b className="text-fg">{longest.agent}</b>, has been waiting <b className="text-fg">{ago(longest.blockedForMs)}</b>.</>}{' '}
        Everything not on this screen is running, capped or idle, and none of it is broken.
      </p>
      <div className="space-y-3.5">{items.map((q) => <AskCard key={q.askId} ask={q} />)}</div>
      <Notices notices={notices} />
    </>
  );
}

function AskCard({ ask }: { ask: Ask }) {
  const [picked, setPicked] = useState<string | null>(null);
  const answer = useAnswer();
  const openAgent = useUi((s) => s.openAgent);

  const submit = () => {
    if (!picked) return;
    answer.mutate({
      askId: ask.askId, optionId: picked,
      ...(ask.actionHash ? { actionHash: ask.actionHash } : {}),
      ...(ask.policyVersion ? { policyVersion: ask.policyVersion } : {}),
    });
  };

  return (
    <Card tone="blocker" data-testid="ask-card">
      <CardHead>
        <div className="min-w-[92px] font-mono">
          <div className="text-[19px] font-bold leading-tight text-blocker">
            {ask.ageUnknown ? '—' : ago(ask.blockedForMs)}
          </div>
          <div className="text-[11px] text-muted-fg">{ask.ageUnknown ? 'imported' : 'blocked'}</div>
        </div>
        <div className="min-w-0">
          <span className="font-semibold">{ask.agent}</span>{' '}
          {ask.agentTitle && <Mono>{ask.agentTitle}</Mono>}
          <div className="mt-1">
            <Chip tone="blocker">
              <span className="size-1.5 rounded-full bg-blocker" />
              {ask.gated ? 'BLOCKED · gated' : 'WAITING_HUMAN'}
            </Chip>
          </div>
        </div>
      </CardHead>

      <CardBody>
        <p className="mb-3 text-[15px]">{ask.prompt}</p>

        {ask.gated ? (
          <div className="rounded-lg border border-fail/25 bg-fail-bg px-3.5 py-3 text-[13px] text-fail">
            <b>Not answerable here.</b> Money-critical verbs require the signed owner channel.
            This workspace carries owner authority for everything else, but it holds no mint for
            verbs that move value. <span className="font-mono">grant: none minted</span>
          </div>
        ) : (
          ask.options.map((o) => (
            <button
              key={o.id}
              data-testid="ask-option"
              onClick={() => setPicked(o.id)}
              className={cn(
                'my-1.5 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[14px] transition-colors',
                picked === o.id ? 'border-fg shadow-[inset_0_0_0_1px_var(--color-fg)]' : 'border-border hover:border-muted-fg/40',
              )}
            >
              <span className={cn('size-1.5 rounded-full', picked === o.id ? 'bg-fg' : 'bg-muted-fg/40')} />
              <span>{o.label}</span>
              {o.detail && <Mono className="ml-auto">{o.detail}</Mono>}
            </button>
          ))
        )}

        {ask.evidence.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer font-mono text-[12px] text-muted-fg">
              evidence ({ask.evidence.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {ask.evidence.map((e, i) => (
                <li key={i} className="font-mono text-[12px] text-muted-fg">{e.source}</li>
              ))}
            </ul>
          </details>
        )}
        {ask.actionHash && (
          <details className="mt-1.5">
            <summary className="cursor-pointer font-mono text-[12px] text-muted-fg">binding</summary>
            <Mono className="mt-1 block">action {ask.actionHash} · policy {ask.policyVersion ?? '—'}</Mono>
          </details>
        )}
      </CardBody>

      <CardFoot>
        <Button variant="primary" data-testid="answer" disabled={ask.gated || !picked} onClick={submit}>
          Answer
        </Button>
        <Button onClick={() => openAgent(ask.agent)}>Open thread</Button>
        <Note className="ml-1">
          {answer.data && !answer.data.ok
            ? <span className="text-fail">{answer.data.detail}</span>
            : <>Answering writes a durable verdict — {ask.agent} is not listening right now and reads it on its next wake.</>}
        </Note>
      </CardFoot>
    </Card>
  );
}
