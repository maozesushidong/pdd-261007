import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.resolve(process.argv[2] || path.join(root, 'secrets', 'staging'));

fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

const writeExclusive = (name, value) => {
  const file = path.join(targetDir, name);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return true;
};

const generated = [];
if (writeExclusive('WORKER_INGEST_TOKEN', crypto.randomBytes(32).toString('base64url'))) generated.push('WORKER_INGEST_TOKEN');
if (writeExclusive('OWNER_SESSION_SECRET', crypto.randomBytes(48).toString('base64url'))) generated.push('OWNER_SESSION_SECRET');

const initialPasswordFile = path.join(targetDir, 'OWNER_INITIAL_PASSWORD');
if (!fs.existsSync(initialPasswordFile)) {
  fs.writeFileSync(initialPasswordFile, `${crypto.randomBytes(18).toString('base64url')}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  generated.push('OWNER_INITIAL_PASSWORD');
}

const passwordHashFile = path.join(targetDir, 'OWNER_PASSWORD');
if (!fs.existsSync(passwordHashFile)) {
  const password = fs.readFileSync(initialPasswordFile, 'utf8').trim();
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  fs.writeFileSync(passwordHashFile, `scrypt$${salt}$${digest}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  generated.push('OWNER_PASSWORD');
}

console.log(JSON.stringify({ targetDir, generated, preservedExisting: generated.length < 4 }, null, 2));
