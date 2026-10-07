import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const defaultPolicyRoot = path.resolve(projectRoot, '..', 'extensions', 'policy', 'shizai-rpa-v3');

const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const loadPolicyMetadata = async (policyRoot) => {
  const metadata = JSON.parse(await fsp.readFile(path.join(policyRoot, 'metadata.json'), 'utf8'));
  const extensionId = String(metadata.extensionId || '').trim();
  const version = String(metadata.version || '').trim();
  const fileName = path.basename(String(metadata.fileName || '').trim());
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Native extension metadata has an invalid extensionId');
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error('Native extension metadata has an invalid version');
  if (!fileName.toLowerCase().endsWith('.crx')) throw new Error('Native extension metadata has an invalid fileName');
  const packagePath = path.join(policyRoot, fileName);
  const packageStat = await fsp.stat(packagePath);
  if (!packageStat.isFile()) throw new Error('Native extension CRX package is missing');
  return Object.freeze({ extensionId, version, fileName, packagePath, packageBytes: packageStat.size });
};

export async function createNativeExtensionUpdateServer({
  policyRoot = process.env.NATIVE_EXTENSION_POLICY_ROOT || defaultPolicyRoot,
  host = process.env.NATIVE_EXTENSION_HOST || '127.0.0.1',
  port = Number(process.env.NATIVE_EXTENSION_PORT || 8765),
} = {}) {
  const policy = await loadPolicyMetadata(path.resolve(policyRoot));
  let updateXml = '';
  const requests = {
    updateChecks: 0,
    packageDownloads: 0,
    lastRequestAt: null,
  };
  const recordRequest = (kind) => {
    requests[kind] += 1;
    requests.lastRequestAt = new Date().toISOString();
    console.log(`[native-extension] ${kind} ${requests.lastRequestAt}`);
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}`);
    const sendHeaders = (statusCode, headers = {}) => {
      response.writeHead(statusCode, {
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
    };
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      sendHeaders(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (requestUrl.pathname === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        extensionId: policy.extensionId,
        version: policy.version,
        requests,
      });
      sendHeaders(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (requestUrl.pathname === '/updates.xml') {
      recordRequest('updateChecks');
      sendHeaders(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(updateXml),
      });
      response.end(request.method === 'HEAD' ? undefined : updateXml);
      return;
    }
    if (decodeURIComponent(requestUrl.pathname.slice(1)) === policy.fileName) {
      recordRequest('packageDownloads');
      sendHeaders(200, {
        'Content-Type': 'application/x-chrome-extension',
        'Content-Length': policy.packageBytes,
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(policy.packagePath).pipe(response);
      return;
    }
    sendHeaders(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  const packageUrl = `http://${host}:${listeningPort}/${encodeURIComponent(policy.fileName)}`;
  updateXml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">`
    + `<app appid="${escapeXml(policy.extensionId)}"><updatecheck codebase="${escapeXml(packageUrl)}" version="${escapeXml(policy.version)}" /></app>`
    + `</gupdate>\n`;

  return Object.freeze({
    server,
    policy,
    host,
    port: listeningPort,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  });
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (mainFile === fileURLToPath(import.meta.url)) {
  const instance = await createNativeExtensionUpdateServer();
  console.log(`Native extension update server listening on http://${instance.host}:${instance.port} for ${instance.policy.extensionId}`);
  const stop = async () => {
    await instance.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
