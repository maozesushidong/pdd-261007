import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const episodesFromEvents = (events) => {
  const episodes = [];
  let open = null;
  for (const event of [...events].sort((left, right) => left.at - right.at
    || left.sequence - right.sequence)) {
    if (event.kind === 'required') {
      if (!open) {
        open = { startedAt: new Date(event.at).toISOString(), completedAt: null,
          linkedToOrder: Boolean(event.linkedToOrder), startRecords: 0 };
        episodes.push(open);
      }
      open.startRecords += 1;
      open.linkedToOrder ||= Boolean(event.linkedToOrder);
    } else if (event.kind === 'completed' && open) {
      open.completedAt = new Date(event.at).toISOString();
      open = null;
    }
  }
  return episodes;
};

if (process.argv.includes('--self-test')) {
  const sample = episodesFromEvents([
    { at: 2_000, sequence: 2, kind: 'required', linkedToOrder: false },
    { at: 1_000, sequence: 1, kind: 'required', linkedToOrder: true },
    { at: 3_000, sequence: 3, kind: 'completed' },
    { at: 4_000, sequence: 4, kind: 'required', linkedToOrder: false },
  ]);
  assert.equal(sample.length, 2);
  assert.equal(sample[0].startRecords, 2);
  assert.equal(sample[0].linkedToOrder, true);
  assert.equal(sample[0].completedAt, '1970-01-01T00:00:03.000Z');
  assert.equal(sample[1].completedAt, null);
  console.log('PDD verification outbox episode audit self-test passed');
  process.exit(0);
}

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const untilMs = Date.parse(arg('--until') || new Date().toISOString());
const sinceMs = Date.parse(arg('--since')
  || new Date(untilMs - 4 * 60 * 60_000).toISOString());
if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs
  || untilMs - sinceMs > 7 * 24 * 60 * 60_000) {
  throw new Error('Use --since and --until for an increasing ISO range of at most 7 days');
}
const requestedShopIds = String(arg('--shops') || '').split(',').map((value) => value.trim())
  .filter(Boolean);
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shopsRoot = path.resolve(appRoot, '..', 'data', 'workflow', 'shops');
const envText = await fsp.readFile(path.join(appRoot, '.env.native'), 'utf8');
const databaseLine = envText.split(/\r?\n/u).find((line) => line.startsWith('DATABASE_URL='));
const databaseUrl = process.env.DATABASE_URL
  || databaseLine?.slice('DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
if (!databaseUrl) throw new Error('DATABASE_URL is unavailable');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
  application_name: 'pdd-verification-outbox-readonly-audit' });
try {
  const { rows: shops } = await pool.query(`SELECT id, name FROM shops
    WHERE enabled = true AND (cardinality($1::text[]) = 0 OR id = ANY($1::text[]))`,
  [requestedShopIds]);
  const dateKeys = [];
  for (let day = Math.floor(sinceMs / 86_400_000) * 86_400_000;
    day <= untilMs; day += 86_400_000) {
    dateKeys.push(new Date(day).toISOString().slice(0, 10).replace(/-/gu, ''));
  }
  let filesRead = 0;
  let malformedLines = 0;
  let rawStartRecords = 0;
  const byShop = [];
  for (const shop of shops) {
    const events = [];
    const seenKeys = new Set();
    for (const dateKey of dateKeys) {
      const file = path.join(shopsRoot, shop.id, 'state', 'sync-outbox',
        `events-${dateKey}.ndjson`);
      try { await fsp.access(file); } catch { continue; }
      filesRead += 1;
      const lines = readline.createInterface({ input: fs.createReadStream(file),
        crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { malformedLines += 1; continue; }
        if (event.eventType !== 'workflow.progress'
          || !['human-verification-required', 'human-verification-completed']
            .includes(event.payload?.patch?.step)) continue;
        const at = Date.parse(event.occurredAt || '');
        if (!Number.isFinite(at) || at > untilMs) continue;
        if (seenKeys.has(event.eventKey)) continue;
        seenKeys.add(event.eventKey);
        events.push({ at, sequence: Number(event.sequence) || 0,
          kind: event.payload.patch.step === 'human-verification-required'
            ? 'required' : 'completed',
          linkedToOrder: Boolean(event.orderNumber
            || event.payload.patch.orderNumber || event.payload.snapshot?.orderNumber) });
      }
    }
    const episodes = episodesFromEvents(events)
      .filter((episode) => Date.parse(episode.startedAt) >= sinceMs);
    if (!episodes.length) continue;
    rawStartRecords += episodes.reduce((total, episode) => total + episode.startRecords, 0);
    const completed = episodes.filter((episode) => episode.completedAt);
    const starts = episodes.map((episode) => Date.parse(episode.startedAt));
    byShop.push({ shopId: shop.id, shopName: shop.name,
      episodes: episodes.length, completed: completed.length,
      withoutCompletionEvent: episodes.length - completed.length,
      linkedToOrder: episodes.filter((episode) => episode.linkedToOrder).length,
      withoutOrder: episodes.filter((episode) => !episode.linkedToOrder).length,
      shortestGapMinutes: starts.length > 1
        ? Number((Math.min(...starts.slice(1).map((start, index) =>
          start - starts[index])) / 60_000).toFixed(1)) : null,
      episodesDetail: episodes.map((episode) => ({ ...episode,
        durationSeconds: episode.completedAt
          ? Math.round((Date.parse(episode.completedAt)
            - Date.parse(episode.startedAt)) / 1_000) : null })) });
  }
  byShop.sort((left, right) => right.episodes - left.episodes
    || left.shopName.localeCompare(right.shopName, 'zh-CN'));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(),
    since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(),
    source: 'Worker sync-outbox workflow.progress step transitions',
    limitation: 'An episode is an observed required-to-completed transition; a missing completion event does not prove a challenge is still active. Missing or malformed logs can undercount episodes.',
    shopsChecked: shops.length, filesRead, malformedLines,
    rawStartRecords, totalEpisodes: byShop.reduce((total, shop) => total + shop.episodes, 0),
    shops: byShop }, null, 2));
} finally {
  await pool.end();
}
