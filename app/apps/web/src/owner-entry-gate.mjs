import crypto from 'node:crypto';

// Each revealed document has its own one-use entry and upstream cookie jar.
// Browser-wide cookies never unlock a new document or authenticate a new visit.
// The API still validates the owner's password, signed session and CSRF token.
export const createOwnerEntryGate = () => {
  const entries = new Map();
  const originFor = request => `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
  const referencedEntry = request => {
    try {
      const referrer = new URL(request.headers.referer || '');
      if (referrer.origin !== originFor(request)) return null;
      const entry = entries.get(referrer.searchParams.get('entry'));
      return entry?.entered && entry.expiresAt > Date.now() ? entry : null;
    } catch { return null; }
  };
  const bind = (request, entry) => {
    request.ownerEntry = entry;
    request.headers.cookie = [...entry.cookies].map(([name,value]) => `${name}=${value}`).join('; ');
  };
  const allowed = request => {
    const entry = referencedEntry(request);
    if (!entry) return false;
    bind(request, entry);
    return true;
  };
  const captureResponseHeaders = (request, headers) => {
    if (!request.ownerEntry) return headers;
    const result = { ...headers };
    for (const cookie of [headers['set-cookie'] || []].flat()) {
      const first = cookie.split(';',1)[0];
      const separator = first.indexOf('=');
      if (separator < 1) continue;
      const name = first.slice(0,separator), value = first.slice(separator+1);
      if (!value || /;\s*Max-Age=0(?:;|$)/iu.test(cookie)) request.ownerEntry.cookies.delete(name);
      else request.ownerEntry.cookies.set(name,value);
    }
    delete result['set-cookie'];
    result['cache-control'] = 'private, no-store, max-age=0';
    return result;
  };
  const handle = (request,response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/_entry/reveal' && request.method === 'POST') {
      if (request.headers.origin === originFor(request) && request.headers['x-owner-entry'] === 'keyboard') {
        for (const [id,entry] of entries) {
          if (entry.expiresAt <= Date.now() || (!entry.entered && entry.createdAt < Date.now()-90_000)) entries.delete(id);
        }
        if (entries.size >= 1000) {
          response.writeHead(503, {'Cache-Control':'no-store'}); response.end(); return true;
        }
        const id = crypto.randomBytes(32).toString('base64url');
        entries.set(id, {entered:false,createdAt:Date.now(),expiresAt:Date.now()+8*60*60_000,cookies:new Map()});
        response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(JSON.stringify({location:`/owner/?owner=login&entry=${id}`}));
        return true;
      }
    } else {
      const isApi = /^\/(?:api|remote-desktop)(?:\/|$)/u.test(pathname);
      const isAsset = /^\/assets\//u.test(pathname) || /^\/(?:mascot\.png|favicon\.ico)$/u.test(pathname);
      if (!isApi && !isAsset) {
        const entry = entries.get(new URL(request.url,'http://localhost').searchParams.get('entry'));
        if (request.method === 'GET' && pathname === '/owner/' && entry && !entry.entered
          && Date.now()-entry.createdAt < 90_000 && entry.expiresAt > Date.now()) {
          entry.entered = true;
          bind(request,entry);
          response.setHeader('Referrer-Policy','same-origin');
          return false;
        }
      } else if (isAsset && ['GET','HEAD'].includes(request.method)) {
        // Bundled JS/CSS contain no authentication state; protected API calls
        // still require the particular revealed document as their referrer.
        return false;
      } else if (allowed(request)) return false;
    }
    const nonce = crypto.randomBytes(18).toString('base64');
    response.writeHead(404, {
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'private, no-store, max-age=0',
      'X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    });
    response.end(`<!doctype html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center><script nonce="${nonce}">let opening=false;addEventListener('keydown',async e=>{if(e.ctrlKey&&e.shiftKey&&!e.altKey&&e.code==='KeyH'){e.preventDefault();if(opening)return;opening=true;try{const r=await fetch('/_entry/reveal',{method:'POST',headers:{'X-Owner-Entry':'keyboard'}});if(r.ok)location.replace((await r.json()).location);else opening=false}catch{opening=false}}});</script></body></html>`);
    return true;
  };
  return {allowed,handle,captureResponseHeaders};
};
