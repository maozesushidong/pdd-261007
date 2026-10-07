import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeExtensionUpdateServer } from './native-extension-update-server.mjs';

const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-native-extension-'));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const packageBytes = Buffer.from('test-crx-package');

try {
  await Promise.all([
    fsp.writeFile(path.join(temporaryRoot, 'metadata.json'), JSON.stringify({
      extensionId,
      version: '3.0.0.1',
      fileName: 'extension.crx',
    })),
    fsp.writeFile(path.join(temporaryRoot, 'extension.crx'), packageBytes),
  ]);
  const instance = await createNativeExtensionUpdateServer({ policyRoot: temporaryRoot, port: 0 });
  try {
    const baseUrl = `http://127.0.0.1:${instance.port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health, {
      status: 'ok',
      extensionId,
      version: '3.0.0.1',
      requests: { updateChecks: 0, packageDownloads: 0, lastRequestAt: null },
    });
    const updateXml = await (await fetch(`${baseUrl}/updates.xml`)).text();
    assert.match(updateXml, new RegExp(`appid="${extensionId}"`));
    assert.match(updateXml, /extension\.crx/);
    const downloadedPackage = Buffer.from(await (await fetch(`${baseUrl}/extension.crx`)).arrayBuffer());
    assert.deepEqual(downloadedPackage, packageBytes);
    const finalHealth = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(finalHealth.requests.updateChecks, 1);
    assert.equal(finalHealth.requests.packageDownloads, 1);
  } finally {
    await instance.close();
  }
  console.log('Native extension update server self-test passed');
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
