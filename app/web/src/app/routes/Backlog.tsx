import { useBacklogMutations, useWorkspace } from '@/shared/api/queries';
import { ago } from '@/shared/format';
import { Button, Card, CardBody, CardFoot, CardHead, Chip, Empty, Mono, Note } from '@/components/ui/primitives';

export function Backlog() {
  const { data } = useWorkspace();
  const { add, promote } = useBacklogMutations();
  const b = data?.backlog;
  const tiers = [...new Set((b?.items ?? []).map((i) => i.tier))].sort();

  const onAdd = () => {
    const title = window.prompt('Title');
    if (!title) return;
    add.mutate({ title, question: window.prompt('The decision you owe') ?? title });
  };

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <h1>Backlog</h1>
        <Button variant="primary" onClick={onAdd}>Add item</Button>
      </div>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        Nobody is stopped here, but you owe a decision. The orchestrator re-ranks this queue every
        cycle by expected value ÷ time-to-unblock; you do not sort it by hand.{' '}
        <Mono>{b?.rankedAt ? `Machine-ranked ${ago(Date.now() - b.rankedAt)} ago.` : 'Not yet ranked.'}</Mono>
      </p>

      <Card className="mb-6">
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <div>
            <b>Needs you</b>
            <Note className="mt-0.5">An agent is stopped until you answer. It badges and notifies.</Note>
          </div>
          <div>
            <b>Backlog</b>
            <Note className="mt-0.5">Nobody is stopped. It stays visible and machine-ranked until it earns escalation.</Note>
          </div>
        </CardBody>
      </Card>

      {!b?.items.length ? <Empty title="Nothing standing." /> : tiers.map((tier) => (
        <section key={tier} className="mb-7">
          <h2 className="mb-3">Priority {tier}</h2>
          <div className="space-y-3.5">
            {b.items.filter((i) => i.tier === tier).map((i) => (
              <Card key={i.id}>
                <CardHead>
                  <b className="text-[15px]">{i.title}</b>
                  <span className="ml-auto"><Chip>sitting {ago(i.sittingMs)}</Chip></span>
                </CardHead>
                <CardBody>
                  <p className="text-[14px]">{i.question}</p>
                  {i.rationale && <Note className="mt-2">{i.rationale}</Note>}
                  <Mono className="mt-2.5 block">raised by {i.raisedBy}{i.agent ? ` · ${i.agent}` : ''}</Mono>
                </CardBody>
                <CardFoot>
                  <Button onClick={() => {
                    const agent = window.prompt('Promote to which agent? (slug)');
                    if (agent) promote.mutate({ id: i.id, agent });
                  }}>Promote to Needs you</Button>
                  <Note className="ml-1">Promotion creates a durable ask and stops that agent.</Note>
                </CardFoot>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
