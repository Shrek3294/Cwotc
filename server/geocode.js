import { MAPBOX_TOKEN, GEOCODE_BBOX, GEOCODE_COUNTRY } from './config.js';
import { getDb } from './db.js';
import { nowIso } from './utils.js';

const db = getDb();
const stmtSelectGeocode = db.prepare('SELECT lat, lng FROM geocodes WHERE address_clean = ?');
const stmtUpsertGeocode = db.prepare(`
  INSERT INTO geocodes (address_clean, lat, lng, source, updated_at, created_at)
  VALUES (@address_clean, @lat, @lng, @source, @updated_at, @created_at)
  ON CONFLICT(address_clean) DO UPDATE SET
    lat=excluded.lat,
    lng=excluded.lng,
    source=excluded.source,
    updated_at=excluded.updated_at;
`);

export function getCachedGeocode(addressClean) {
  if (!addressClean) return null;
  return stmtSelectGeocode.get(addressClean) || null;
}

export function saveGeocode(addressClean, coords, source = 'mapbox') {
  if (!addressClean || !coords) return null;
  const now = nowIso();
  stmtUpsertGeocode.run({
    address_clean: addressClean,
    lat: coords.lat,
    lng: coords.lng,
    source,
    created_at: now,
    updated_at: now,
  });
  return coords;
}

export async function geocodeRemote(addressClean) {
  if (!addressClean || !MAPBOX_TOKEN) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const params = new URLSearchParams({
      access_token: MAPBOX_TOKEN,
      limit: '1',
      types: 'address,place,postcode',
      country: GEOCODE_COUNTRY,
    });
    if (GEOCODE_BBOX) params.set('bbox', GEOCODE_BBOX);
    const endpoint = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addressClean)}.json?${params.toString()}`;
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.features?.length) return null;
    const [lng, lat] = data.features[0].center || [];
    if (lat == null || lng == null) return null;
    return { lat: Number(lat), lng: Number(lng) };
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('Geocode failed for', addressClean, err.message);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveCoordinates(addressClean, { allowNetwork = false } = {}) {
  if (!addressClean) return null;
  const cached = getCachedGeocode(addressClean);
  if (cached) return cached;
  if (!allowNetwork) return null;
  if (!MAPBOX_TOKEN) {
    console.warn('MAPBOX_TOKEN missing. Unable to geocode address', addressClean);
    return null;
  }
  const coords = await geocodeRemote(addressClean);
  if (coords) {
    saveGeocode(addressClean, coords, 'mapbox');
  }
  return coords;
}

export function getGeocodeStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM geocodes').get().count;
  const mostRecent = db.prepare('SELECT MAX(updated_at) as updated_at FROM geocodes').get().updated_at;
  return { total, mostRecent };
}

export async function geocodeMissingProperties({ allowNetwork = true } = {}) {
  const missingRows = db.prepare(`
    SELECT id, address_clean FROM properties
    WHERE (lat IS NULL OR lng IS NULL OR lat = '')
      AND address_clean IS NOT NULL AND address_clean <> ''
      AND status = 'active'
  `).all();
  if (!missingRows.length) return { attempted: 0, geocoded: 0 };

  let geocoded = 0;
  for (const row of missingRows) {
    const coords = await resolveCoordinates(row.address_clean, { allowNetwork });
    if (coords) {
      db.prepare('UPDATE properties SET lat=@lat, lng=@lng WHERE id=@id').run({
        lat: coords.lat,
        lng: coords.lng,
        id: row.id,
      });
      geocoded += 1;
    }
  }
  return { attempted: missingRows.length, geocoded };
}
