import crypto from 'crypto';

export function parseMoney(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function parseFloatish(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function cleanAddress(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace('Strret', 'Street').replace('Statio', 'Station');
  s = s.replace(/(\d+)-(\d+)\s*([A-Za-z])/g, '$1-$2 $3');
  s = s.replace(/(Route|Rte|Rt|Highway|Hwy|State Route|County Route|CR)\s*(\d+[A-Za-z]?)([A-Z])/g, '$1 $2 $3');
  s = s.replace(/(Unit|Apt|Suite|Ste|#)\s*([0-9A-Za-z-]+)([A-Z][a-z])/g, '$1 $2 $3');
  const streetTypes = /(Dr|St|Ave|Rd|Ct|Ln|Pl|Blvd|Pkwy|Ter|Cir|Way|Rte|Rt|Drive|Street|Avenue|Road|Court|Lane|Place|Boulevard|Parkway|Terrace|Circle|Route|Highway|Path)/;
  s = s.replace(new RegExp(`${streetTypes.source}([A-Z])`, 'g'), '$1 $2');
  s = s.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ');
  const parts = s.split(',').map(p => p.trim());
  if (parts.length) {
    parts[0] = parts[0]
      .replace(/(\d+)-(\d+)/g, '$1-$2')
      .replace(/(\d+)(st|nd|rd|th)/gi, '$1$2 ')
      .trim();
  }
  return parts.filter(Boolean).join(', ').replace(/  +/g, ' ').trim();
}

export function countyFromAddress(address) {
  if (!address) return '';
  const m = String(address).match(/,\s*([^,]*County)\s*$/);
  return m ? m[1].trim() : '';
}

export function hashRecord(record) {
  const json = JSON.stringify(record || {});
  return crypto.createHash('sha1').update(json).digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function diffFields(existing, next, fields) {
  const changes = [];
  for (const field of fields) {
    const prev = existing[field];
    const curr = next[field];
    if (prev === undefined && curr === undefined) continue;
    if (prev === curr) continue;
    changes.push({ field, oldValue: prev ?? null, newValue: curr ?? null });
  }
  return changes;
}

export function toBooleanFlag(value) {
  return value ? 1 : 0;
}
