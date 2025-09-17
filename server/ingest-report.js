#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb, closeDb } from './db.js';
import {
  parseMoney,
  parseFloatish,
  cleanAddress,
  countyFromAddress,
  hashRecord,
  nowIso,
  diffFields,
  toBooleanFlag,
} from './utils.js';
import { resolveCoordinates as resolveGeocode } from './geocode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.log('Usage: node server/ingest-report.js <report.json> [--geocode]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) usage();

const shouldGeocode = args.includes('--geocode');
const reportArg = args.find(a => !a.startsWith('--'));
if (!reportArg) usage();

const reportPath = path.resolve(process.cwd(), reportArg);
if (!fs.existsSync(reportPath)) {
  console.error(`Report file not found: ${reportPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(reportPath, 'utf-8');
let items;
try {
  items = JSON.parse(raw);
  if (!Array.isArray(items)) {
    throw new Error('Expected JSON array');
  }
} catch (err) {
  console.error('Failed to parse JSON report:', err.message);
  process.exit(1);
}

const db = getDb();

const stmtSelectByUrl = db.prepare('SELECT * FROM properties WHERE url = ?');
const stmtInsertProperty = db.prepare(`
  INSERT INTO properties (
    url, hash, address, address_clean, city_state_zip, county, lat, lng,
    price, price_num, sale_window, beds, beds_num, baths, baths_num, sqft, sqft_num,
    lot_size_acres, property_type, year_built, est_resale_value, has_addendum,
    addendum_url, is_cwcot, scraped_at, first_seen, last_seen, last_changed,
    status, inactive_at, reactivated_at, data_json, last_run_id
  ) VALUES (
    @url, @hash, @address, @address_clean, @city_state_zip, @county, @lat, @lng,
    @price, @price_num, @sale_window, @beds, @beds_num, @baths, @baths_num, @sqft, @sqft_num,
    @lot_size_acres, @property_type, @year_built, @est_resale_value, @has_addendum,
    @addendum_url, @is_cwcot, @scraped_at, @first_seen, @last_seen, @last_changed,
    @status, @inactive_at, @reactivated_at, @data_json, @last_run_id
  );
`);

const stmtUpdateProperty = db.prepare(`
  UPDATE properties SET
    hash=@hash,
    address=@address,
    address_clean=@address_clean,
    city_state_zip=@city_state_zip,
    county=@county,
    lat=@lat,
    lng=@lng,
    price=@price,
    price_num=@price_num,
    sale_window=@sale_window,
    beds=@beds,
    beds_num=@beds_num,
    baths=@baths,
    baths_num=@baths_num,
    sqft=@sqft,
    sqft_num=@sqft_num,
    lot_size_acres=@lot_size_acres,
    property_type=@property_type,
    year_built=@year_built,
    est_resale_value=@est_resale_value,
    has_addendum=@has_addendum,
    addendum_url=@addendum_url,
    is_cwcot=@is_cwcot,
    scraped_at=@scraped_at,
    last_seen=@last_seen,
    last_changed=@last_changed,
    status=@status,
    inactive_at=@inactive_at,
    reactivated_at=@reactivated_at,
    data_json=@data_json,
    last_run_id=@last_run_id
  WHERE id=@id;
`);

const stmtInsertChange = db.prepare(`
  INSERT INTO property_changes (property_id, field, old_value, new_value, changed_at)
  VALUES (@property_id, @field, @old_value, @new_value, @changed_at);
`);

const stmtSelectActive = db.prepare("SELECT id, url FROM properties WHERE status = 'active'");
const stmtDeactivate = db.prepare(`
  UPDATE properties
  SET status='inactive', inactive_at=@inactive_at, last_run_id=@last_run_id
  WHERE id=@id;
`);

const stmtInsertRun = db.prepare(`
  INSERT INTO ingest_runs (started_at, status, input_path)
  VALUES (@started_at, @status, @input_path);
`);

const stmtFinalizeRun = db.prepare(`
  UPDATE ingest_runs SET
    finished_at=@finished_at,
    status=@status,
    record_count=@record_count,
    created_count=@created_count,
    updated_count=@updated_count,
    unchanged_count=@unchanged_count,
    changed_count=@changed_count,
    reactivated_count=@reactivated_count,
    deactivated_count=@deactivated_count,
    error=NULL
  WHERE id=@id;
`);

const stmtFailRun = db.prepare(`
  UPDATE ingest_runs SET finished_at=@finished_at, status='failed', error=@error WHERE id=@id;
`);

const stmtInsertEvent = db.prepare(`
  INSERT INTO property_ingest_events (run_id, property_id, event_type, detail, occurred_at)
  VALUES (@run_id, @property_id, @event_type, @detail, @occurred_at);
`);


function sanitizeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeItem(item) {
  const address = sanitizeString(item.address);
  const cityStateZip = sanitizeString(item.cityStateZip ?? item.city_state_zip);
  const addendumUrl = sanitizeString(item.addendum_url ?? item.addendumUrl);
  const saleWindow = sanitizeString(item.saleWindow ?? item.sale_window);
  const propertyType = sanitizeString(item.propertyType ?? item.property_type);
  const lotSizeAcres = sanitizeString(item.lotSizeAcres ?? item.lot_size_acres);
  const yearBuilt = sanitizeString(item.yearBuilt ?? item.year_built);
  const estResaleValue = sanitizeString(item.estResaleValue ?? item.est_resale_value);
  const beds = sanitizeString(item.beds);
  const baths = sanitizeString(item.baths);
  const sqft = sanitizeString(item.sqft);
  const rawLat = item.lat ?? item.latitude;
  const rawLng = item.lng ?? item.longitude;

  const result = {
    url: sanitizeString(item.url),
    scraped_at: sanitizeString(item.scraped_at ?? item.scrapedAt),
    address,
    city_state_zip: cityStateZip,
    county: countyFromAddress(address),
    address_clean: cleanAddress(address || cityStateZip),
    price: sanitizeString(item.price),
    price_num: parseMoney(item.price),
    sale_window: saleWindow,
    beds,
    beds_num: parseFloatish(beds),
    baths,
    baths_num: parseFloatish(baths),
    sqft,
    sqft_num: parseFloatish(sqft),
    lot_size_acres: lotSizeAcres,
    property_type: propertyType,
    year_built: yearBuilt,
    est_resale_value: estResaleValue,
    addendum_url: addendumUrl,
    has_addendum: toBooleanFlag(!!addendumUrl),
    is_cwcot: toBooleanFlag(!!item.isCWCOT || !!item.is_cwcot),
    lat: parseFloatish(rawLat),
    lng: parseFloatish(rawLng),
    data_json: JSON.stringify(item ?? {}),
  };

  result.hash = hashRecord(item);
  if (!result.scraped_at) {
    result.scraped_at = nowIso();
  }
  return result;
}

async function applyCoordinates(payload) {
  if (payload.lat != null && payload.lng != null) {
    return payload;
  }
  if (!payload.address_clean) return payload;
  const coords = await resolveGeocode(payload.address_clean, { allowNetwork: shouldGeocode });
  if (coords) {
    payload.lat = coords.lat;
    payload.lng = coords.lng;
  }
  return payload;
}

async function main() {
  let runId = null;
  const runStartedAt = nowIso();
  try {
    const runResult = stmtInsertRun.run({
      started_at: runStartedAt,
      status: 'running',
      input_path: reportPath,
    });
    runId = Number(runResult.lastInsertRowid);

    const normalized = [];
    for (const item of items) {
      const norm = normalizeItem(item);
      await applyCoordinates(norm);
      normalized.push(norm);
    }

    const trackedFields = [
      'hash',
      'address',
      'address_clean',
      'city_state_zip',
      'price',
      'price_num',
      'sale_window',
      'beds',
      'beds_num',
      'baths',
      'baths_num',
      'sqft',
      'sqft_num',
      'lat',
      'lng',
      'is_cwcot',
      'has_addendum',
      'lot_size_acres',
      'est_resale_value',
      'property_type',
      'year_built',
      'addendum_url',
      'scraped_at',
    ];

    const seenUrls = new Set();
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let changed = 0;
    let reactivated = 0;
    let deactivatedCount = 0;

    const occurredAt = nowIso();

    const runUpsert = db.transaction(({ records, runId: currentRunId, occurredAt: ts }) => {
      for (const payload of records) {
        const url = payload.url;
        if (!url) continue;
        if (seenUrls.has(url)) continue;

        const existing = stmtSelectByUrl.get(url);
        seenUrls.add(url);

        if (!existing) {
          const insertPayload = {
            ...payload,
            first_seen: ts,
            last_seen: ts,
            last_changed: ts,
            status: 'active',
            inactive_at: null,
            reactivated_at: null,
            last_run_id: currentRunId,
          };
          const result = stmtInsertProperty.run(insertPayload);
          const propertyId = Number(result.lastInsertRowid);
          stmtInsertEvent.run({
            run_id: currentRunId,
            property_id: propertyId,
            event_type: 'created',
            detail: null,
            occurred_at: ts,
          });
          created += 1;
          continue;
        }

        const wasInactive = existing.status !== 'active';
        const comparisons = { ...existing };
        const changes = diffFields(comparisons, payload, trackedFields);
        const reactivatedAt = wasInactive ? ts : existing.reactivated_at;

        const updatePayload = {
          ...payload,
          id: existing.id,
          last_seen: ts,
          last_changed: changes.length ? ts : existing.last_changed,
          status: 'active',
          inactive_at: null,
          reactivated_at: reactivatedAt,
          last_run_id: currentRunId,
        };
        stmtUpdateProperty.run(updatePayload);

        const eventDetail = {};
        let eventType = 'seen';

        if (wasInactive) {
          reactivated += 1;
          eventType = 'reactivated';
          eventDetail.reactivated = true;
        }

        if (changes.length) {
          changed += 1;
          eventDetail.changedFields = changes.map(change => change.field);
          eventType = wasInactive ? 'reactivated_changed' : 'changed';
          for (const change of changes) {
            stmtInsertChange.run({
              property_id: existing.id,
              field: change.field,
              old_value: change.oldValue != null ? String(change.oldValue) : null,
              new_value: change.newValue != null ? String(change.newValue) : null,
              changed_at: ts,
            });
          }
        } else if (!wasInactive) {
          unchanged += 1;
        }

        const detail = Object.keys(eventDetail).length ? JSON.stringify(eventDetail) : null;
        stmtInsertEvent.run({
          run_id: currentRunId,
          property_id: existing.id,
          event_type: eventType,
          detail,
          occurred_at: ts,
        });

        updated += 1;
      }
    });

    runUpsert({ records: normalized, runId, occurredAt });

    const deactivate = db.transaction(({ runId: currentRunId, occurredAt: ts }) => {
      const active = stmtSelectActive.all();
      for (const row of active) {
        if (!seenUrls.has(row.url)) {
          stmtDeactivate.run({ id: row.id, inactive_at: ts, last_run_id: currentRunId });
          stmtInsertEvent.run({
            run_id: currentRunId,
            property_id: row.id,
            event_type: 'deactivated',
            detail: JSON.stringify({ reason: 'missing_in_ingest' }),
            occurred_at: ts,
          });
          deactivatedCount += 1;
        }
      }
    });

    deactivate({ runId, occurredAt });

    const finishedAt = nowIso();
    stmtFinalizeRun.run({
      id: runId,
      finished_at: finishedAt,
      status: 'completed',
      record_count: normalized.length,
      created_count: created,
      updated_count: updated,
      unchanged_count: unchanged,
      changed_count: changed,
      reactivated_count: reactivated,
      deactivated_count: deactivatedCount,
    });

    console.log(
      JSON.stringify(
        {
          runId,
          processed: normalized.length,
          created,
          updated,
          unchanged,
          changed,
          reactivated,
          deactivated: deactivatedCount,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const finishedAt = nowIso();
    if (runId != null) {
      stmtFailRun.run({
        id: runId,
        finished_at: finishedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    closeDb();
  }
}

main().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
