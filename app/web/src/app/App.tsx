import { useWorkspace } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Rail } from '@/app/shell/Rail';
import { Sidebar } from '@/app/shell/Sidebar';
import { ContextPanel } from '@/app/shell/ContextPanel';
import { NeedsYou } from '@/app/routes/NeedsYou';
import { Orchestrator } from '@/app/routes/Orchestrator';
import { Thread } from '@/app/routes/Thread';
import { Backlog } from '@/app/routes/Backlog';
import { Accounts } from '@/app/routes/Accounts';
import { Docs } from '@/app/routes/Docs';
import { Status } from '@/app/routes/Status';
import { VoiceOverlay } from '@/app/voice/VoiceOverlay';
import { Empty } from '@/components/ui/primitives';

export function App() {
  const view = useUi((s) => s.view);
  const { data, isLoading, error } = useWorkspace();

  if (error) {
    return (
      <div className="grid h-dvh place-items-center p-8">
        <Empty title={String((error as Error).message)} hint="Open this page with ?token=…" />
      </div>
    );
  }

  const Main = { needs: NeedsYou, orchestrator: Orchestrator, backlog: Backlog,
    accounts: Accounts, docs: Docs, status: Status, thread: Thread }[view];

  return (
    <div className="grid h-dvh grid-cols-[76px_1fr] overflow-hidden lg:grid-cols-[76px_300px_1fr] xl:grid-cols-[76px_300px_1fr_340px]">
      <Rail />
      <div className="hidden overflow-y-auto border-r border-border bg-surface lg:block">
        <Sidebar />
      </div>
      <main className="min-w-0 overflow-y-auto px-7 pb-24 pt-7">
        {isLoading && !data ? <Empty title="Loading…" /> : <Main />}
      </main>
      <aside className="hidden overflow-y-auto border-l border-border bg-surface xl:block">
        <ContextPanel />
      </aside>
      <VoiceOverlay />
    </div>
  );
}
