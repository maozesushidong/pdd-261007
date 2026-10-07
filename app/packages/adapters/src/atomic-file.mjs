import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const transientReplaceCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
const retryDelaysMs = [25, 50, 75, 100, 150, 200, 250, 250, 250, 250, 250, 250];

const temporaryPathFor = (filePath) => (
  `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
);

const isTransientReplaceError = (error) => transientReplaceCodes.has(error?.code);

const sleepSync = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const removeSync = (filePath) => {
  try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
};

const remove = async (filePath) => {
  try { await fsp.rm(filePath, { force: true }); } catch { /* best-effort cleanup */ }
};

const replaceSync = (temporaryPath, filePath) => {
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === retryDelaysMs.length) break;
      sleepSync(retryDelaysMs[attempt]);
    }
  }

  // Windows readers may temporarily deny rename/delete sharing. Copying the
  // complete temp file prevents a transient observer from pausing the order.
  if (process.platform === 'win32' && isTransientReplaceError(lastError)) {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        fs.copyFileSync(temporaryPath, filePath);
        removeSync(temporaryPath);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientReplaceError(error) || attempt === retryDelaysMs.length) break;
        sleepSync(retryDelaysMs[attempt]);
      }
    }
  }
  throw lastError;
};

const replace = async (temporaryPath, filePath) => {
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await fsp.rename(temporaryPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientReplaceError(error) || attempt === retryDelaysMs.length) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }

  if (process.platform === 'win32' && isTransientReplaceError(lastError)) {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        await fsp.copyFile(temporaryPath, filePath);
        await remove(temporaryPath);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientReplaceError(error) || attempt === retryDelaysMs.length) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }
  throw lastError;
};

export const writeTextAtomicSync = (filePath, contents, { mode = 0o600 } = {}) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = temporaryPathFor(filePath);
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode });
    fs.chmodSync(temporaryPath, mode);
    replaceSync(temporaryPath, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    removeSync(temporaryPath);
    throw error;
  }
};

export const writeTextAtomic = async (filePath, contents, { mode = 0o600 } = {}) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = temporaryPathFor(filePath);
  try {
    await fsp.writeFile(temporaryPath, contents, { encoding: 'utf8', mode });
    await fsp.chmod(temporaryPath, mode);
    await replace(temporaryPath, filePath);
    await fsp.chmod(filePath, mode);
  } catch (error) {
    await remove(temporaryPath);
    throw error;
  }
};
