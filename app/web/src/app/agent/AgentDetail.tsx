import { useState } from 'react';
import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Suspense, lazy } from 'react';

// xterm is ~400 KB and only one tab needs it. Loading it with the shell makes
// every other screen pay for a terminal nobody opened.
const TerminalView = lazy(() => import('@/app/agent/Terminal').then((m) => ({ default: m.TerminalView })));
const BrowserView = lazy(() => import('@/app/agent/Browser').then((m) => ({ default: m.BrowserView })));
import { Button, Card, CardBody, Empty, Mono, Note, StatusChip } from '@/components/ui/primitives';
import { when } from '@/shared/format';
import { cn } from '@/lib';

const TABS = ['Thread', 'Terminal', 'Browser', 'Contract', 'Reports'] as const;
type Tab = (typeof TABS)[number];

export function AgentDetail({ slug }: { slug: string }) {
  const [tab, setTab] = useState<Tab>('Thread');
  const { data } = useWorkspace();
  const { openFile, setView } = useUi();
  const a = data?.agents.find((x) => x.slug === slug);
  if (!a) return <Empty title={`No agent ${slug}.`} />;

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1>{a.slug}</h1>
        {a.title && <Mono className="text-[13px]">{a.title}</Mono>}
        <span className="ml-auto"><StatusChip status={a.status} /></span>
      </div>
      {a.responsibility && <p className="mt-1.5 max-w-[72ch] text-muted-fg">{a.responsibility}</p>}
      <Note className="mt-1">{a.why}</Note>

      <div className="mb-5 mt-4 flex gap-1 border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t} role="tab" aria-selected={tab === t}
            data-testid={`agent-tab-${t.toLowerCase()}`}
            onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === t ? 'border-fg text-fg' : 'border-transparent text-muted-fg hover:text-fg')}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Thread' && (
        <Card><CardBody>
          {a.latestReport ? (
            <>
              <Mono>latest report · {when(a.latestReport.at)}</Mono>
              <p className="mt-1 text-[14px]">{a.latestReport.body}</p>
            </>
          ) : <Note>No report yet. This agent has not produced work since it was imported.</Note>}
        </CardBody></Card>
      )}
      {tab === 'Terminal' && (
        <Suspense fallback={<Note>Loading terminal…</Note>}>
          <TerminalView session={a.sessionName} />
        </Suspense>
      )}
      {tab === 'Browser' && (
        <Suspense fallback={<Note>Loading viewport…</Note>}>
          <BrowserView slug={a.slug} />
        </Suspense>
      )}
      {tab === 'Contract' && (
        <Card><CardBody>
          <Note className="mb-3">
            The contract is this agent's persisted system prompt. It is not documentation about the
            agent — it is the agent.
          </Note>
          {a.docsRef && (
            <Button size="sm" onClick={() => { openFile(a.docsRef!); setView('docs'); }}>
              Open {a.docsRef}
            </Button>
          )}
        </CardBody></Card>
      )}
      {tab === 'Reports' && (
        <Card><CardBody>
          {a.latestReport
            ? <p className="text-[14px]">{a.latestReport.body}</p>
            : <Note>No reports yet.</Note>}
        </CardBody></Card>
      )}
    </>
  );
}
