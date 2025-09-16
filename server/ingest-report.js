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
    status, inactive_at, data_json
  ) VALUES (
    @url, @hash, @address, @address_clean, @city_state_zip, @county, @lat, @lng,
    @price, @price_num, @sale_window, @beds, @beds_num, @baths, @baths_num, @sqft, @sqft_num,
    @lot_size_acres, @property_type, @year_built, @est_resale_value, @has_addendum,
    @addendum_url, @is_cwcot, @scraped_at, @first_seen, @last_seen, @last_changed,
    @status, @inactive_at, @data_json
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
    data_json=@data_json
  WHERE id=@id;
`);

const stmtInsertChange = db.prepare(`
  INSERT INTO property_changes (property_id, field, old_value, new_value, changed_at)
  VALUES (@property_id, @field, @old_value, @new_value, @changed_at);
`);

const stmtSelectActive = db.prepare("SELECT id, url FROM properties WHERE status = 'active'");
const stmtDeactivate = db.prepare(`
  UPDATE properties
  SET status='inactive', inactive_at=@inactive_at
  WHERE id=@id;
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
  const now = nowIso();
  const normalized = [];
  for (const item of items) {
    const norm = normalizeItem(item);
    await applyCoordinates(norm);
    normalized.push(norm);
  }

  const seenUrls = new Set();
  let created = 0;
let updated = 0;
let changed = 0;
let deactivatedCount = 0;

  const trackedFields = [
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
    'address_clean',
    'lot_size_acres',
    'est_resale_value',
  ];

  const runUpsert = db.transaction(records => {
    for (const payload of records) {
      if (!payload.url) continue;
      const existing = stmtSelectByUrl.get(payload.url);
      seenUrls.add(payload.url);

      if (!existing) {
        const insertPayload = {
          ...payload,
          first_seen: now,
          last_seen: now,
          last_changed: now,
          status: 'active',
          inactive_at: null,
        };
        stmtInsertProperty.run(insertPayload);
        created += 1;
        continue;
      }

      const comparisons = { ...existing };
      const changes = diffFields(comparisons, payload, trackedFields);
      const status = 'active';
      const updatePayload = {
        ...payload,
        id: existing.id,
        last_seen: now,
        last_changed: changes.length ? now : existing.last_changed,
        status,
        inactive_at: null,
      };
      stmtUpdateProperty.run(updatePayload);

      if (changes.length) {
        changed += 1;
        for (const change of changes) {
          stmtInsertChange.run({
            property_id: existing.id,
            field: change.field,
            old_value: change.oldValue != null ? String(change.oldValue) : null,
            new_value: change.newValue != null ? String(change.newValue) : null,
            changed_at: now,
          });
        }
      }
      updated += 1;
    }
  });

  runUpsert(normalized);

  // Mark properties not seen in this run as inactive
  const deactivate = db.transaction(() => {
    const active = stmtSelectActive.all();
    for (const row of active) {
      if (!seenUrls.has(row.url)) {
        stmtDeactivate.run({ id: row.id, inactive_at: now });
        deactivatedCount += 1;
      }
    }
  });

  deactivate();

  closeDb();

  console.log(
    JSON.stringify(
      {
        processed: normalized.length,
        created,
        updated,
        changed,
        deactivated: deactivatedCount,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error('Ingest failed:', err);
  closeDb();
  process.exit(1);
});
