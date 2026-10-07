import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

// Run database fixtures in an empty, isolated database, never in the live shop
// schema. DATABASE_URL supplies only the server/admin connection.
const sourceUrl = new URL(process.env.DATABASE_URL);
const database = `pdd_refund_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
assert.match(database, /^pdd_refund_test_[a-f0-9]{12}$/u);
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${database}`;
testUrl.search = '';
const admin = new pg.Client({ connectionString: sourceUrl.toString() });
let created = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`);
  created = true;
  const migrations = new pg.Client({ connectionString: testUrl.toString() });
  try {
    await migrations.connect();
    const directory = new URL('../infra/db/migrations/', import.meta.url);
    const files = readdirSync(directory).filter(file => /^\d{3}_.+\.sql$/u.test(file)).sort();
    // These are one-time data repairs with exact production-order assertions,
    // not schema migrations; those orders intentionally do not exist here.
    const productionDataRepairs = new Set([
      '281_retry_oms_reissue_after_confirmed_no_request.sql',
      '282_retry_oms_reissue_with_validated_second_confirm.sql',
      '283_retry_oms_reissue_after_vue_model_commit_fix.sql',
      '286_retry_oms_reissue_after_committed_reason_validation.sql',
      '293_archive_confirmed_return_refund_duplicate.sql',
    ]);
    for (const file of files) {
      if (productionDataRepairs.has(file)) continue;
      const sql = readFileSync(new URL(file, directory), 'utf8')
        .replace(/^\\encoding UTF8\s*$/gmu, "SET client_encoding = 'UTF8';");
      try { await migrations.query(sql); }
      catch (error) { throw new Error(`Isolated migration ${file}: ${error.message}`, { cause: error }); }
    }
  } finally { await migrations.end(); }
  process.env.DATABASE_URL = testUrl.toString();
  const fixture = process.env.PDD_ISOLATED_POSTGRES_FIXTURE || 'return-refund-claim-self-test.mjs';
  assert(['return-refund-claim-self-test.mjs', 'verification-restored-reconciliation-self-test.mjs', 'verification-requeue-once-self-test.mjs', 'stale-bound-refund-checkpoint-self-test.mjs'].includes(fixture));
  await import(`./${fixture}`);
  console.log(`isolated PostgreSQL harness passed: ${fixture}`);
} finally {
  process.env.DATABASE_URL = sourceUrl.toString();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
