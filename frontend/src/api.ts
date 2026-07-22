export class ApiError extends Error {
  status: number;
  captchaFailed?: boolean;
  constructor(status: number, message: string, captchaFailed?: boolean) {
    super(message);
    this.status = status;
    this.captchaFailed = captchaFailed;
  }
}

// ---- backend selection (Node vs Go) ----
// Hermes ships two interchangeable backends serving the same REST contract.
// The choice is persisted in localStorage and applied as a path prefix that the
// Vite dev server / reverse proxy routes to the right process. Because both
// backends share the JWT secret and database, switching keeps you logged in
// and shows the same data.
export type Backend = 'node' | 'go';

export function getBackend(): Backend {
  return localStorage.getItem('hermes:backend') === 'go' ? 'go' : 'node';
}

export function setBackend(b: Backend): void {
  localStorage.setItem('hermes:backend', b);
}

// Go requests are routed under /_go (stripped by the proxy); Node keeps the
// bare path. Same-origin either way, so the session cookie is always sent.
export function backendPath(path: string): string {
  return getBackend() === 'go' ? '/_go' + path : path;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(backendPath(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('ats:unauthorized'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `${res.status} ${res.statusText}`, data.captchaFailed);
  return data as T;
}

// multipart upload — let the browser set Content-Type (with boundary) itself
async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(backendPath(path), { method: 'POST', body: form, credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('ats:unauthorized'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

// Health ping for a specific backend, independent of the current selection —
// used by the backend switcher to show a live status dot per engine.
export async function pingBackend(b: Backend): Promise<boolean> {
  const prefix = b === 'go' ? '/_go' : '';
  try {
    const res = await fetch(prefix + '/api/health', { credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload,
};
