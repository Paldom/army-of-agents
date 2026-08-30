import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Button, Card, CardBody, StatusChip, Empty, Mono, Note } from '@/components/ui/primitives';

export function Status() {
  const { data } = useWorkspace();
  const { openAgent } = useUi();

  const f = data?.fleet;
  if (!f) return <Empty title="No fleet yet." />;

  return (
    <>
      <h1>Status</h1>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        <b className="text-fg">{f.counts.blocksHuman}</b> blocked on you ·{' '}
        <b className="text-fg">{f.counts.running}</b> running ·{' '}
        <b className="text-fg">{f.counts.fine}</b> fine. Nothing in the last group is broken.
      </p>

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
