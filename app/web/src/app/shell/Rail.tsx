import { AudioLines, Boxes, FileText, Inbox, ListTodo, Radio, Activity } from 'lucide-react';
import { cn } from '@/lib';
import { useWorkspace } from '@/shared/api/queries';
import { useUi, type View } from '@/shared/store/ui';

const ITEMS: Array<{ id: View; label: string; Icon: typeof Inbox }> = [
  { id: 'needs', label: 'Needs you', Icon: Inbox },
  { id: 'orchestrator', label: 'Orchestrator', Icon: Radio },
  { id: 'backlog', label: 'Backlog', Icon: ListTodo },
  { id: 'accounts', label: 'Accounts', Icon: Boxes },
  { id: 'docs', label: 'Docs', Icon: FileText },
  { id: 'status', label: 'Status', Icon: Activity },
];

export function Rail() {
  const { view, setView, setVoice } = useUi();
  const { data } = useWorkspace();
  const blocked = data?.needsYou.length ?? 0;

  return (
    <nav className="flex flex-col items-center gap-1 border-r border-border bg-surface py-3.5" aria-label="Destinations">
      {ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          data-testid={`nav-${id}`}
          onClick={() => setView(id)}
          aria-current={view === id ? 'page' : undefined}
          className={cn(
            'relative flex w-[76px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] transition-colors',
            view === id ? 'bg-muted font-semibold text-fg' : 'text-muted-fg hover:bg-muted/60',
          )}
        >
          <Icon size={17} strokeWidth={1.9} aria-hidden />
          {/* Only the blocker count ever badges. */}
          {id === 'needs' && blocked > 0 && (
            <span className="absolute right-2 top-1 rounded-full bg-blocker px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
              {blocked}
            </span>
          )}
          <span className="leading-tight">{label}</span>
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={() => setVoice(true)}
        className="flex w-[76px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] text-muted-fg hover:bg-muted/60"
        data-testid="nav-voice"
      >
        <AudioLines size={17} strokeWidth={1.9} aria-hidden />
        Voice
      </button>
    </nav>
  );
}
