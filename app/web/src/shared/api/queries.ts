/** TanStack Query hooks. Server state lives here; nothing else caches it. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const keys = {
  state: ['state'] as const,
  plans: ['plans'] as const,
  accounts: (search: string) => ['accounts', search] as const,
  files: ['files'] as const,
  file: (path: string) => ['file', path] as const,
  agentDocs: (slug: string) => ['agent-docs', slug] as const,
  thread: (slug: string) => ['thread', slug] as const,
  doctor: ['doctor'] as const,
};

/** The workspace polls: the supervisor moves without asking the browser. */
export const useWorkspace = () =>
  useQuery({ queryKey: keys.state, queryFn: api.state, refetchInterval: 5000 });

export const usePlans = () =>
  useQuery({ queryKey: keys.plans, queryFn: api.plans, refetchInterval: 5000 });

export const useAccounts = (search: string) =>
  useQuery({ queryKey: keys.accounts(search), queryFn: () => api.accounts({ search }) });

export const useFiles = () => useQuery({ queryKey: keys.files, queryFn: api.files });

export const useFile = (path: string | null) =>
  useQuery({ queryKey: keys.file(path ?? ''), queryFn: () => api.file(path!), enabled: !!path });

export const useAgentDocs = (slug: string | null) =>
  useQuery({ queryKey: keys.agentDocs(slug ?? ''), queryFn: () => api.agentDocs(slug!), enabled: !!slug });

/** A thread is live: REPORT lines land while the turn runs, so it polls faster than the fleet. */
export const useThread = (slug: string | null) =>
  useQuery({ queryKey: keys.thread(slug ?? ''), queryFn: () => api.thread(slug!), enabled: !!slug, refetchInterval: 3000 });

/** Subprocess checks on the server side; once a minute is plenty. */
export const useDoctor = () => useQuery({ queryKey: keys.doctor, queryFn: api.doctor, refetchInterval: 60_000 });

export function useSendMessage(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.sendMessage(slug, text),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.thread(slug) });
      void qc.invalidateQueries({ queryKey: keys.state });
    },
  });
}

export function useAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: Parameters<typeof api.answer>[1] & { askId: string }) =>
      api.answer(v.askId, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.state }),
  });
}

export function useOrchestrator() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.plans });
    void qc.invalidateQueries({ queryKey: keys.state });
  };
  return {
    ask: useMutation({ mutationFn: api.askOrchestrator, onSuccess: invalidate }),
    apply: useMutation({ mutationFn: api.applyPlan, onSuccess: invalidate }),
    reject: useMutation({ mutationFn: api.rejectPlan, onSuccess: invalidate }),
  };
}

export function useBacklogMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: keys.state });
  return {
    add: useMutation({ mutationFn: api.addBacklog, onSuccess: invalidate }),
    promote: useMutation({
      mutationFn: (v: { id: string; agent: string }) => api.promoteBacklog(v.id, v.agent),
      onSuccess: invalidate,
    }),
  };
}

export function useSaveFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; content: string }) => api.saveFile(v.path, v.content),
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: keys.file(v.path) }),
  });
}
