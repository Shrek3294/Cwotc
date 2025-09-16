#!/usr/bin/env node
import { getDb, closeDb } from './db.js';
import { nowIso } from './utils.js';

const args = process.argv.slice(2);
let days = 30;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if ((arg === '--days' || arg === '-d') && args[i + 1]) {
    days = Number(args[i + 1]);
    i += 1;
  }
}
if (!Number.isFinite(days) || days < 1) {
  console.error('Invalid --days value. Expect positive integer.');
  process.exit(1);
}

const db = getDb();
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const result = db
  .prepare(
    "DELETE FROM properties WHERE status = 'inactive' AND inactive_at IS NOT NULL AND inactive_at < ?",
  )
  .run(cutoff);

closeDb();

console.log(
  JSON.stringify(
    {
      deleted: result.changes,
      cutoff,
      ranAt: nowIso(),
    },
    null,
    2,
  ),
);
