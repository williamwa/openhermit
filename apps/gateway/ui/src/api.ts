let token = sessionStorage.getItem('adminToken') ?? '';

export function getToken(): string {
  return token;
}

export function setToken(t: string): void {
  token = t;
  if (t) {
    sessionStorage.setItem('adminToken', t);
  } else {
    sessionStorage.removeItem('adminToken');
  }
}

export async function api<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const init: RequestInit = {
    method: options?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
  if (options?.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
