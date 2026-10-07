import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.resolve(process.argv[2] || path.join(root, 'secrets', 'staging'));
const requestedPassword = String(process.env.OWNER_NEW_PASSWORD || '');
if (requestedPassword && requestedPassword.length < 8) throw new Error('OWNER_NEW_PASSWORD must contain at least 8 characters');
const password = requestedPassword || crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16).toString('hex');
const digest = crypto.scryptSync(password, salt, 64).toString('hex');

const replaceSecret = async (name, value) => {
  const destination = path.join(targetDir, name);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, destination);
  await fsp.chmod(destination, 0o600).catch(() => {});
};

await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
await replaceSecret('OWNER_INITIAL_PASSWORD', password);
await replaceSecret('OWNER_PASSWORD', `scrypt$${salt}$${digest}`);
console.log(JSON.stringify({ rotated: true, targetDir, passwordFile: 'OWNER_INITIAL_PASSWORD', passwordPrinted: false }));
