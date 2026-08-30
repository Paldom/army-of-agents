/** Client-only state. Never mirror server data here — that is Query's job. */
import { create } from 'zustand';

/**
 * 'thread' is where a selected agent or channel lands. It is deliberately not
 * one of the rail destinations: selecting an agent used to reuse 'status', so
 * the rail highlighted Status while showing something else.
 */
export type View = 'needs' | 'orchestrator' | 'backlog' | 'accounts' | 'docs' | 'status' | 'thread';

interface UiState {
  view: View;
  /** An agent slug, or null. */
  agent: string | null;
  /** A channel name, or null. Channels are selectable and have their own overview. */
  channel: string | null;
  filePath: string | null;
  voiceOpen: boolean;
  setView: (v: View) => void;
  openAgent: (slug: string) => void;
  openChannel: (name: string) => void;
  openFile: (path: string) => void;
  setVoice: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  view: 'needs',
  agent: null,
  channel: null,
  filePath: null,
  voiceOpen: false,
  setView: (view) => set({ view }),
  openAgent: (agent) => set({ agent, channel: null, view: 'thread' }),
  openChannel: (channel) => set({ channel, agent: null, view: 'thread' }),
  openFile: (filePath) => set({ filePath, view: 'docs' }),
  setVoice: (voiceOpen) => set({ voiceOpen }),
}));
