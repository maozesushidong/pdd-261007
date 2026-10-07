import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic, writeTextAtomicSync } from '../packages/adapters/src/atomic-file.mjs';

const iterations = 100;
const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[2] === '--child') {
  const target = process.argv[3];
  const writer = process.argv[4];
  for (let index = 0; index < iterations; index += 1) {
    const payload = `${JSON.stringify({ writer, index, body: 'x'.repeat(8_192) })}\n`;
    if (index % 2 === 0) writeTextAtomicSync(target, payload);
    else await writeTextAtomic(target, payload);
  }
  process.exit(0);
}

const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-atomic-file-'));
const target = path.join(temporaryDirectory, 'workflow-progress.json');

const runWriter = (writer) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [scriptPath, '--child', target, writer], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`writer ${writer} exited ${code}: ${stderr}`));
  });
});

try {
  await Promise.all([runWriter('a'), runWriter('b')]);
  const finalValue = JSON.parse(await fsp.readFile(target, 'utf8'));
  assert.ok(['a', 'b'].includes(finalValue.writer));
  assert.equal(finalValue.index, iterations - 1);
  assert.equal(finalValue.body.length, 8_192);
  const leftovers = (await fsp.readdir(temporaryDirectory)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  console.log('atomic file self-test passed');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
