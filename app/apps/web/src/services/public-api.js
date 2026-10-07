const publicPathPrefix = import.meta.env.VITE_PUBLIC_API_PREFIX
  ?? (window.location.pathname.startsWith('/public') ? '/public-api' : '');

export const publicResourceUrl = (path) => path && publicPathPrefix
  ? `${publicPathPrefix}${path}`
  : path;

export async function publicApi(path, options = {}) {
  const response = await fetch(publicResourceUrl(path), { credentials: 'omit', ...options });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || `请求失败 (${response.status})`);
  return payload;
}
