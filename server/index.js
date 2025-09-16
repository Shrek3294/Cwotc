import express from 'express';
import cors from 'cors';

import { getDb } from './db.js';
import { SERVER_PORT, MAPBOX_TOKEN } from './config.js';
import { geocodeMissingProperties, getGeocodeStats } from './geocode.js';

const app = express();
app.use(cors());
app.use(express.json());

const db = getDb();

function parseBoolean(value) {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function formatProperty(row, { includeRaw = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    url: row.url,
    address: row.address,
    addressClean: row.address_clean,
    cityStateZip: row.city_state_zip,
    county: row.county,
    lat: row.lat,
    lng: row.lng,
    price: row.price,
    priceNum: row.price_num,
    saleWindow: row.sale_window,
    beds: row.beds,
    bedsNum: row.beds_num,
    baths: row.baths,
    bathsNum: row.baths_num,
    sqft: row.sqft,
    sqftNum: row.sqft_num,
    lotSizeAcres: row.lot_size_acres,
    propertyType: row.property_type,
    yearBuilt: row.year_built,
    estResaleValue: row.est_resale_value,
    hasAddendum: Boolean(row.has_addendum),
    addendumUrl: row.addendum_url,
    isCwcot: Boolean(row.is_cwcot),
    scrapedAt: row.scraped_at,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastChanged: row.last_changed,
    status: row.status,
    inactiveAt: row.inactive_at,
    changeCount: row.change_count ?? 0,
  };
  if (includeRaw) {
    try {
      base.raw = row.data_json ? JSON.parse(row.data_json) : null;
    } catch (err) {
      base.raw = null;
    }
  }
  return base;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', database: true, mapboxToken: Boolean(MAPBOX_TOKEN) });
});

app.get('/api/config', (_req, res) => {
  res.json({
    mapboxToken: MAPBOX_TOKEN || null,
    serverTime: new Date().toISOString(),
  });
});

app.get('/api/properties', (req, res) => {
  const status = req.query.status ?? 'active';
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const offset = Number(req.query.offset) || 0;
  const maxPrice = Number(req.query.maxPrice);
  const onlyCwcot = parseBoolean(req.query.onlyCwcot);
  const hasAddendum = parseBoolean(req.query.hasAddendum);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'lastSeen';
  const sortDir = (typeof req.query.order === 'string' ? req.query.order : 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const sortMap = {
    price: 'p.price_num',
    lastSeen: 'p.last_seen',
    firstSeen: 'p.first_seen',
    beds: 'p.beds_num',
    baths: 'p.baths_num',
    sqft: 'p.sqft_num',
    saleWindow: 'p.sale_window',
  };
  const orderBy = sortMap[sortKey] || 'p.last_seen';

  const whereParts = [];
  const params = { limit, offset };

  if (status === 'active') {
    whereParts.push("p.status = 'active'");
  } else if (status === 'inactive') {
    whereParts.push("p.status = 'inactive'");
  }

  if (Number.isFinite(maxPrice)) {
    params.maxPrice = maxPrice;
    whereParts.push('(p.price_num IS NULL OR p.price_num <= @maxPrice)');
  }
  if (onlyCwcot) {
    whereParts.push('p.is_cwcot = 1');
  }
  if (hasAddendum) {
    whereParts.push('p.has_addendum = 1');
  }
  if (search) {
    params.search = `%${search}%`;
    whereParts.push('(p.address_clean LIKE @search OR p.city_state_zip LIKE @search OR p.county LIKE @search)');
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const query = `
    SELECT p.*, (
      SELECT COUNT(*) FROM property_changes c WHERE c.property_id = p.id
    ) as change_count
    FROM properties p
    ${whereClause}
    ORDER BY ${orderBy} ${sortDir}
    LIMIT @limit OFFSET @offset
  `;

  const rows = db.prepare(query).all(params);

  const countQuery = `SELECT COUNT(*) AS total FROM properties p ${whereClause}`;
  const totals = db.prepare(countQuery).get(params);

  res.json({
    total: totals?.total ?? 0,
    count: rows.length,
    items: rows.map(row => formatProperty(row)),
  });
});

app.get('/api/properties/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid property id' });
    return;
  }
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }
  const changes = db
    .prepare('SELECT field, old_value, new_value, changed_at FROM property_changes WHERE property_id = ? ORDER BY datetime(changed_at) DESC')
    .all(id)
    .map(change => ({
      field: change.field,
      oldValue: change.old_value,
      newValue: change.new_value,
      changedAt: change.changed_at,
    }));
  res.json({ property: formatProperty(row, { includeRaw: true }), changes });
});

app.get('/api/stats', (_req, res) => {
  const metrics = {
    total: db.prepare('SELECT COUNT(*) AS c FROM properties').get().c,
    active: db.prepare("SELECT COUNT(*) AS c FROM properties WHERE status = 'active'").get().c,
    inactive: db.prepare("SELECT COUNT(*) AS c FROM properties WHERE status = 'inactive'").get().c,
    cwcot: db.prepare('SELECT COUNT(*) AS c FROM properties WHERE is_cwcot = 1').get().c,
    withAddendum: db.prepare('SELECT COUNT(*) AS c FROM properties WHERE has_addendum = 1').get().c,
    mappable: db.prepare('SELECT COUNT(*) AS c FROM properties WHERE lat IS NOT NULL AND lng IS NOT NULL').get().c,
    unmapped: db.prepare('SELECT COUNT(*) AS c FROM properties WHERE lat IS NULL OR lng IS NULL').get().c,
    priceMin: db.prepare('SELECT MIN(price_num) AS v FROM properties WHERE price_num IS NOT NULL').get().v,
    priceMax: db.prepare('SELECT MAX(price_num) AS v FROM properties WHERE price_num IS NOT NULL').get().v,
  };
  const counties = db.prepare("SELECT COUNT(DISTINCT county) AS c FROM properties WHERE county <> ''").get().c;
  const latestRun = db.prepare('SELECT MAX(last_seen) AS last_seen FROM properties').get().last_seen;
  res.json({
    ...metrics,
    counties,
    latestRun,
    geocoding: getGeocodeStats(),
  });
});

app.get('/api/geocode/summary', (_req, res) => {
  const stats = getGeocodeStats();
  const missing = db.prepare('SELECT COUNT(*) AS c FROM properties WHERE lat IS NULL OR lng IS NULL').get().c;
  res.json({
    cache: stats,
    propertiesMissingCoords: missing,
    mapboxToken: Boolean(MAPBOX_TOKEN),
  });
});

app.post('/api/geocode/missing', async (_req, res) => {
  if (!MAPBOX_TOKEN) {
    res.status(400).json({ error: 'MAPBOX_TOKEN is not configured' });
    return;
  }
  try {
    const result = await geocodeMissingProperties({ allowNetwork: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/geocode/cache', (_req, res) => {
  db.prepare('DELETE FROM geocodes').run();
  res.json({ cleared: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(SERVER_PORT, () => {
  console.log(`Server listening on http://localhost:${SERVER_PORT}`);
});
