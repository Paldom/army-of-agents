import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Button, Card, CardBody, CardHead, Empty, Mono, Note, StatusChip } from '@/components/ui/primitives';
import { when } from '@/shared/format';

/**
 * A channel is a group of agents with a shared responsibility, and it is worth
 * a page: what this group is for, who is in it, what each one is doing right
 * now, and where its documentation starts.
 */
export function ChannelOverview({ name }: { name: string }) {
  const { data } = useWorkspace();
  const { openAgent, openFile, setView } = useUi();
  const channel = data?.channels.find((c) => c.name === name);
  if (!channel || !data) return <Empty title={`No channel #${name}.`} />;

  const members = channel.members
    .map((s) => data.agents.find((a) => a.slug === s))
    .filter((a): a is NonNullable<typeof a> => !!a);
  const blocked = members.filter((m) => m.blocksHuman).length;

  return (
    <>
      <h1>#{name}</h1>
      {channel.responsibility && (
        <p className="mb-1.5 mt-1.5 max-w-[72ch] text-muted-fg">{channel.responsibility}</p>
      )}
      <p className="mb-5 max-w-[72ch] text-muted-fg">
        <b className="text-fg">{members.length}</b> agent{members.length === 1 ? '' : 's'}
        {blocked > 0
          ? <>, <b className="text-blocker">{blocked}</b> waiting on you.</>
          : <>. None waiting on you.</>}
      </p>

      {channel.docsRef && (
        <Card className="mb-5">
          <CardBody className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <b>Documentation</b>
              <Note className="mt-0.5">
                Start here for this area, then go deeper into individual agents below.
              </Note>
            </div>
            <Button className="ml-auto" onClick={() => { openFile(channel.docsRef!); setView('docs'); }}>
              Open {channel.docsRef}
            </Button>
          </CardBody>
        </Card>
      )}

      <div className="space-y-3.5">
        {members.map((m) => (
          <Card key={m.slug} tone={m.blocksHuman ? 'blocker' : undefined}>
            <CardHead>
              <button className="text-left" onClick={() => openAgent(m.slug)}>
                <b className="text-[15px]">{m.slug}</b>{' '}
                {m.title && <Mono>{m.title}</Mono>}
              </button>
              <span className="ml-auto"><StatusChip status={m.status} /></span>
            </CardHead>
            <CardBody>
              {m.responsibility && <p className="text-[14px]">{m.responsibility}</p>}
              <Note className="mt-1.5">{m.why}</Note>
              {m.latestReport && (
                <div className="mt-2.5 border-t border-border pt-2.5">
                  <Mono>latest report · {when(m.latestReport.at)}</Mono>
                  <p className="mt-0.5 text-[13px]">{m.latestReport.body.slice(0, 180)}</p>
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
