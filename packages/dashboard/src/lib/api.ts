import { capabilitiesSchema, type Capabilities } from '@cerberus/protocol';

function authHeaders(): HeadersInit {
  const token = new URLSearchParams(location.search).get('token');
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  getCapabilities: (threadKey: string) =>
    request<Capabilities>(`/api/threads/${encodeURIComponent(threadKey)}/capabilities`),
  putCapabilities: (threadKey: string, caps: Capabilities) =>
    request<Capabilities>(`/api/threads/${encodeURIComponent(threadKey)}/capabilities`, {
      method: 'PUT',
      body: JSON.stringify(capabilitiesSchema.parse(caps)),
    }),
  stopAgent: (threadKey: string) =>
    request<{ stopped: boolean }>(`/api/threads/${encodeURIComponent(threadKey)}/stop`, { method: 'POST' }),
  restartAgent: (threadKey: string) =>
    request<{ outcome: string }>(`/api/threads/${encodeURIComponent(threadKey)}/restart`, { method: 'POST' }),
};
