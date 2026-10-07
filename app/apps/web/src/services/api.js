export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(payload?.error || `请求失败 (${response.status})`, response.status, payload);
  return payload;
}

export const toQuery = (values) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== '' && value != null) query.set(key, String(value));
  }
  return query.toString();
};

export const ownerRequest = (path, csrfToken, options = {}) => api(path, {
  ...options,
  headers: { ...(options.headers || {}), 'x-csrf-token': csrfToken },
});
