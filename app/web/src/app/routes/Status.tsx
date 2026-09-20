import { useDoctor, useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Button, Card, CardBody, Chip, StatusChip, Empty, Mono, Note } from '@/components/ui/primitives';
import { ago } from '@/shared/format';

export function Status() {
  const { data } = useWorkspace();
  const { openAgent } = useUi();

  const { data: doc } = useDoctor();
  const f = data?.fleet;
  if (!f) return <Empty title="No fleet yet." />;
  const pulse = f.supervisor;

  return (
    <>
      <h1>Status</h1>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        <b className="text-fg">{f.counts.blocksHuman}</b> blocked on you ·{' '}
        <b className="text-fg">{f.counts.running}</b> running ·{' '}
        <b className="text-fg">{f.counts.fine}</b> fine. Nothing in the last group is broken.
      </p>

      {!pulse.alive && (
        <Card tone="blocker" className="mb-5" data-testid="supervisor-down">
          <CardBody>
            <b>The supervisor is not running.</b>
            <Note className="mt-0.5">
              {pulse.lastTickAt ? `Last tick ${ago(Date.now() - pulse.lastTickAt)} ago.` : 'It has never ticked against this store.'}{' '}
              The workspace can record answers and messages, but nothing wakes until the loop is started
              (<Mono>./scripts/aoa up</Mono>).
            </Note>
          </CardBody>
        </Card>
      )}

      {f.lostWake.length > 0 && (
        <Card tone="blocker" className="mb-5">
          <CardBody>
            <b>Lost-wake alarm</b>
            <Note className="mt-0.5">
              Active with no live run and no next wake: <Mono>{f.lostWake.join(', ')}</Mono>.
              A lost bump is visible here rather than silent.
            </Note>
          </CardBody>
        </Card>
      )}

      {doc && (
        <Card className="mb-5" data-testid="doctor">
          <CardBody>
            <b>Doctor</b>
            <Note className="mb-2 mt-0.5">
              What is installed and configured on this host. Optional pieces degrade on purpose; this says which did.
            </Note>
            <ul className="divide-y divide-border">
              {doc.checks.map((c) => (
                <li key={c.id} className="flex items-baseline gap-3 py-1.5 text-[13px]">
                  <Chip tone={c.ok ? 'working' : c.optional ? 'quiet' : 'blocker'}>{c.ok ? 'ok' : c.optional ? 'off' : 'missing'}</Chip>
                  <Mono className="w-[150px] shrink-0">{c.id}</Mono>
                  <span className={c.ok ? '' : 'text-muted-fg'}>{c.detail}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-muted-fg">
              <th className="px-3 py-2.5">Agent</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Why</th>
              <th className="px-3 py-2.5">Latest report</th>
            </tr>
          </thead>
          <tbody>
            {f.agents.map((a) => (
              <tr key={a.slug} className="border-b border-border last:border-0">
                {/* Slugs are identifiers: wrapping one across two lines makes
                    it read as two things. */}
                <td className="whitespace-nowrap px-3 py-2.5">
                  <Button variant="ghost" size="sm" className="justify-start px-0" onClick={() => openAgent(a.slug)}>
                    <b>{a.slug}</b>
                  </Button>
                </td>
                <td className="px-3 py-2.5"><StatusChip status={a.status} /></td>
                <td className="max-w-[38ch] px-3 py-2.5">{a.why}</td>
                <td className="px-3 py-2.5">
                  {a.latestReport ? a.latestReport.body.slice(0, 60) : <Note>No report yet</Note>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
