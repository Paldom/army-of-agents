import { cn } from '@/lib';
import { ago } from '@/shared/format';
import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { toneOf } from '@/shared/api/types';
import type { Agent, Ask } from '@/shared/api/types';

/**
 * One row per agent, never one row per ask.
 *
 * Running against a real project put sixteen open questions on a single agent
 * and this list became sixteen identical rows — the exact "hunt for the stuck
 * one" failure it exists to prevent.
 */
function groupByAgent(asks: Ask[]) {
  const by = new Map<string, { agent: string; count: number; oldestMs: number | null; gated: boolean }>();
  for (const q of asks) {
    const cur = by.get(q.agent);
    if (!cur) by.set(q.agent, { agent: q.agent, count: 1, oldestMs: q.blockedForMs, gated: q.gated });
    else {
      cur.count += 1;
      cur.oldestMs = Math.max(cur.oldestMs ?? 0, q.blockedForMs ?? 0);
      cur.gated = cur.gated || q.gated;
    }
  }
  return [...by.values()].sort((a, b) => (b.oldestMs ?? 0) - (a.oldestMs ?? 0));
}

export function Sidebar() {
  const { data } = useWorkspace();
  const { agent: selected, channel, openAgent, openChannel, setView } = useUi();
  if (!data) return null;

  const grouped = groupByAgent(data.needsYou);
  const bySlug = new Map(data.agents.map((a) => [a.slug, a]));

  return (
    <div className="p-3">
      <section className="rounded-xl border border-blocker-border bg-blocker-bg p-2" data-testid="needs-panel">
        <header className="flex items-center justify-between px-1.5 pb-2 pt-0.5 text-[12px] font-semibold text-blocker">
          <span>Needs you</span>
          <span className="font-mono">{data.needsYou.length}</span>
        </header>
        {grouped.length === 0 ? (
          <p className="px-1.5 pb-1 text-[13px] text-muted-fg">Nothing is waiting on you.</p>
        ) : (
          grouped.map((g) => (
            <button
              key={g.agent}
              onClick={() => { openAgent(g.agent); setView('needs'); }}
              className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-blocker/5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{g.agent}</span>
                <span className="block font-mono text-[11px] text-muted-fg">
                  {g.gated ? 'BLOCKED · gated' : 'WAITING_HUMAN'}
                  {g.count > 1 && ` · ${g.count} open`}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-fg">{ago(g.oldestMs)}</span>
            </button>
          ))
        )}
      </section>

      {data.channels.map((c) => (
        <section key={c.name} className="mt-4">
          <button
            onClick={() => openChannel(c.name)}
            aria-current={channel === c.name ? 'true' : undefined}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-semibold uppercase tracking-[0.05em] transition-colors',
              channel === c.name ? 'bg-muted text-fg' : 'text-muted-fg hover:bg-muted/60',
            )}
          >
            <span className="text-muted-fg">#</span>
            {c.name}
            <span className="ml-auto font-mono text-[11px] font-normal normal-case">{c.members.length}</span>
          </button>
          {c.responsibility && (
            <p className="line-clamp-2 px-1.5 pb-1 pt-0.5 text-[11px] leading-snug text-muted-fg">
              {c.responsibility}
            </p>
          )}
          {c.members.map((slug) => {
            const a = bySlug.get(slug);
            if (!a) return null;
            return <AgentRow key={slug} agent={a} selected={selected === slug} onClick={() => openAgent(slug)} />;
          })}
        </section>
      ))}
    </div>
  );
}

function AgentRow({ agent, selected, onClick }: { agent: Agent; selected: boolean; onClick: () => void }) {
  const tone = toneOf(agent.status);
  return (
    <button
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={cn('w-full rounded-md px-1.5 py-1.5 text-left transition-colors', selected ? 'bg-muted' : 'hover:bg-muted/60')}
    >
      <span className="block truncate text-[13px] font-semibold">{agent.slug}</span>
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-fg">
        <span className={cn('size-1.5 shrink-0 rounded-full',
          tone === 'blocker' ? 'bg-blocker' : tone === 'working' ? 'bg-working' : 'bg-muted-fg/45')} />
        {agent.status}
      </span>
    </button>
  );
}
