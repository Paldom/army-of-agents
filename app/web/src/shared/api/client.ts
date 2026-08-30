/**
 * The one place that talks to the server.
 *
 * `shared` may not import from `app` or `components` — the dependency runs one
 * way only, so the data layer stays testable without mounting a tree.
 */
import type {
  AccountsView, AnswerResult, FileContent, FileEntry, Plan, WorkspaceState,
} from './types';

const TOKEN_KEY = 'aoa_token';

export function readToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) localStorage.setItem(TOKEN_KEY, fromUrl);
  return fromUrl ?? localStorage.getItem(TOKEN_KEY) ?? '';
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new ApiError(401, 'Not authorized — open the URL with ?token=…');
  if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed`);
  return (await res.json()) as T;
}

const post = <T>(p: string, body: unknown) =>
  req<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  state: () => req<WorkspaceState>('/state'),
  plans: () => req<Plan[]>('/plans'),
  accounts: (q?: { search?: string }) =>
    req<AccountsView>(`/accounts${q?.search ? `?search=${encodeURIComponent(q.search)}` : ''}`),
  files: () => req<{ root: string; entries: FileEntry[] }>('/files'),
  file: (path: string) => req<FileContent>(`/file?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string) =>
    req<{ ok: boolean; error?: string }>('/file', { method: 'PUT', body: JSON.stringify({ path, content }) }),
  agentDocs: (slug: string) => req<{ relevant: FileEntry[] }>(`/agents/${encodeURIComponent(slug)}/docs`),

  answer: (askId: string, body: { optionId?: string; text?: string; actionHash?: string; policyVersion?: string }) =>
    post<AnswerResult>(`/asks/${askId}/answer`, body),

  askOrchestrator: (text: string) => post<Plan>('/orchestrator/ask', { text }),
  applyPlan: (id: string) => post<{ ok: boolean; error?: string }>(`/plans/${id}/apply`, {}),
  rejectPlan: (id: string) => post<{ ok: boolean; error?: string }>(`/plans/${id}/reject`, {}),

  addBacklog: (b: { title: string; question: string }) => post('/backlog', b),
  promoteBacklog: (id: string, agent: string) => post(`/backlog/${id}/promote`, { agent }),
  addDictionary: (b: { name: string; location: string }) => post('/accounts/dictionaries', b),

  voiceToken: () => post<{ signedUrl?: string; error?: string }>('/voice/token', {}),
};
