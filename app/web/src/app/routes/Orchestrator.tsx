import { useState } from 'react';
import { useOrchestrator, usePlans, useWorkspace } from '@/shared/api/queries';
import type { Plan } from '@/shared/api/types';
import { Button, Card, CardBody, CardFoot, CardHead, Chip, Empty, Mono, Note } from '@/components/ui/primitives';

export function Orchestrator() {
  const [text, setText] = useState('');
  const { data: plans } = usePlans();
  const { data: state } = useWorkspace();
  const { ask, apply, reject } = useOrchestrator();
  const orch = state?.agents.find((a) => a.slug === (state.orchestrator ?? 'orchestrator'));

  const send = () => {
    const t = text.trim();
    if (!t) return;
    ask.mutate(t);
    setText('');
  };

  return (
    <>
      <h1>Orchestrator</h1>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        Talk to the whole fleet here. It investigates immediately; before it changes agents,
        contracts or capacity it writes the exact plan and waits for <b className="text-fg">Apply</b>.
      </p>

      {orch && (
        <Card className="mb-4">
          <CardBody className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            <span><Mono>doing now</Mono>{' '}{orch.liveRun ? `run in ${orch.liveRun.state}` : orch.why}</span>
            {orch.latestReport && (
              <span><Mono>last report</Mono>{' '}{orch.latestReport.body.slice(0, 90)}</span>
            )}
          </CardBody>
        </Card>
      )}

      <Card className="mb-5">
        <CardBody>
          <textarea
            data-testid="orc-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            placeholder="Ask anything about the fleet — pause a channel, create an agent, add a backlog item, re-rank the queue…"
            className="min-h-[76px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 text-[14px] outline-none focus:border-muted-fg/50"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <Button variant="primary" data-testid="orc-send" onClick={send} disabled={ask.isPending || !text.trim()}>
              {ask.isPending ? 'Thinking…' : 'Send'}
            </Button>
            <Note>Investigations start immediately. Fleet changes always return as a plan with Apply / Cancel.</Note>
          </div>
        </CardBody>
      </Card>

      {!plans?.length ? <Empty title="No requests yet." /> : (
        <div className="space-y-3.5">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p}
              onApply={() => apply.mutate(p.id)} onReject={() => reject.mutate(p.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function PlanCard({ plan, onApply, onReject }: { plan: Plan; onApply: () => void; onReject: () => void }) {
  if (plan.effects.length === 0) {
    return (
      <Card>
        <CardBody>
          <Mono className="mb-2 block">you · {plan.request}</Mono>
          <p className="text-[14px]">{plan.investigation}</p>
        </CardBody>
      </Card>
    );
  }
  const pending = plan.state === 'PENDING';
  return (
    <Card tone={pending ? 'blocker' : undefined} data-testid="plan-card">
      <CardHead>
        <b className="text-[15px]">Plan · {plan.summary}</b>
        <span className="ml-auto">
          <Chip tone={plan.state === 'APPLIED' ? 'working' : pending ? 'blocker' : 'quiet'}>
            {plan.state === 'APPLIED' ? 'applied' : pending ? 'awaiting you' : 'cancelled'}
          </Chip>
        </span>
      </CardHead>
      <CardBody>
        <Mono className="mb-2.5 block">you · {plan.request}</Mono>
        <table className="w-full text-[13px]">
          <tbody>
            {plan.effects.map((e, i) => (
              <tr key={i} className="align-top">
                <td className="w-[150px] py-1 pr-3 font-mono text-[12px] text-muted-fg">
                  {e.kind.replace(/_/g, ' ')}
                </td>
                <td className="py-1">{e.describe}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
      {pending && (
        <CardFoot>
          <Button variant="primary" data-testid="plan-apply" onClick={onApply}>Apply</Button>
          <Button onClick={onReject}>Cancel</Button>
          <Note className="ml-1">Nothing changes until you apply it.</Note>
        </CardFoot>
      )}
    </Card>
  );
}
