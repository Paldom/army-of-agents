import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { StatusChip, Note, Mono, Button } from '@/components/ui/primitives';
import { when } from '@/shared/format';

/**
 * Identity and current state for the selected agent.
 *
 * No budget block: metered spend is not what an owner steers this fleet by, and
 * a number nobody acts on is noise. Capacity lives on Accounts, where the vendor
 * lane it actually belongs to lives.
 */
export function ContextPanel() {
  const { data } = useWorkspace();
  const { agent: slug, setView, openFile } = useUi();
  const agent = data?.agents.find((a) => a.slug === slug);

  if (!agent) {
    return <div className="p-4"><Note>Select an agent to see its contract, status and docs.</Note></div>;
  }

  return (
    <div className="space-y-5 p-4">
      <section>
        <h3 className="mb-1">{agent.slug}</h3>
        {agent.title && <Mono>{agent.title}</Mono>}
        {agent.responsibility && <Note className="mt-2">{agent.responsibility}</Note>}
      </section>

      <section>
        <Label>Status</Label>
        <StatusChip status={agent.status} />
        <Note className="mt-1.5">{agent.why}</Note>
      </section>

      <section>
        <Label>Identity</Label>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
          <dt className="text-muted-fg">harness</dt>
          {/* An agent with no harness is routed at dispatch; say that, do not
              print a phrase the reader has to decode. */}
          <dd className="text-right">{agent.harness ?? 'chosen at dispatch'}</dd>
          <dt className="text-muted-fg">lifecycle</dt><dd className="text-right">{agent.lifecycle}</dd>
          <dt className="text-muted-fg">created by</dt><dd className="text-right">{agent.createdBy}</dd>
        </dl>
      </section>

      <section>
        <Label>Latest report</Label>
        {agent.latestReport ? (
          <>
            <p className="text-[13px]">{agent.latestReport.body.slice(0, 240)}</p>
            <Mono className="mt-1 block">{when(agent.latestReport.at)}</Mono>
          </>
        ) : <Note>No report yet.</Note>}
      </section>

      {agent.docsRef && (
        <section>
          <Label>Documentation</Label>
          <Note className="mb-2">Starts broad, then goes deeper. Its own docs first, the whole project below.</Note>
          <Button size="sm" onClick={() => { openFile(agent.docsRef!); setView('docs'); }}>
            Open {agent.docsRef}
          </Button>
        </section>
      )}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-fg">{children}</h4>
);
