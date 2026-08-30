import { useUi } from '@/shared/store/ui';
import { ChannelOverview } from '@/app/routes/ChannelOverview';
import { AgentDetail } from '@/app/agent/AgentDetail';
import { Empty } from '@/components/ui/primitives';

/** Whatever is selected: a channel's overview, or one agent's thread. */
export function Thread() {
  const { agent, channel } = useUi();
  if (channel) return <ChannelOverview name={channel} />;
  if (agent) return <AgentDetail slug={agent} />;
  return <Empty title="Nothing selected." hint="Pick an agent or a channel on the left." />;
}
