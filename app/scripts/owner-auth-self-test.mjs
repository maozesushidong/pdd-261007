import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = String(process.env.OWNER_SELF_TEST_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const passwordFile = path.resolve(process.env.OWNER_INITIAL_PASSWORD_FILE
  || path.join(root, 'secrets', 'staging', 'OWNER_INITIAL_PASSWORD'));
const username = process.env.OWNER_USERNAME || 'owner';
const password = (await fsp.readFile(passwordFile, 'utf8')).trim();
assert(password, 'owner initial password is empty');

const health = await fetch(`${baseUrl}/healthz`);
assert.equal(health.status, 200, 'API health check failed');

const anonymousAuthorization = await fetch(`${baseUrl}/api/v1/auth/authorize`);
assert.equal(anonymousAuthorization.status, 401, 'anonymous owner gateway authorization must fail');

const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200, 'owner login failed');
const loginBody = await login.json();
assert.equal(loginBody.data?.role, 'system-owner');
assert(loginBody.data?.csrfToken, 'login did not return a CSRF token');
const cookie = String(login.headers.get('set-cookie') || '').split(';', 1)[0];
assert(cookie.startsWith('work_order_owner_session='), 'login did not set the owner session cookie');

const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { cookie } });
assert.equal(me.status, 200);
assert.equal((await me.json()).data?.role, 'system-owner');

const authorization = await fetch(`${baseUrl}/api/v1/auth/authorize`, { headers: { cookie } });
assert.equal(authorization.status, 200, 'authenticated owner gateway authorization failed');
assert.equal((await authorization.json()).data?.authorized, true);

const verify = await fetch(`${baseUrl}/api/v1/auth/verify`, {
  method: 'POST',
  headers: { cookie, 'x-csrf-token': loginBody.data.csrfToken },
});
assert.equal(verify.status, 200, 'owner CSRF verification failed');
assert.equal((await verify.json()).data?.valid, true);

const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
assert.equal(logout.status, 200, 'owner logout failed');
assert.equal((await logout.json()).data?.loggedOut, true);

console.log('owner authentication and CSRF self-test passed');
