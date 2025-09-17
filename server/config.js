import { config as loadEnv } from 'dotenv';
import fs from 'fs';
import path from 'path';

loadEnv();

const defaultDbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'cwcot.db');
const dataDir = path.dirname(defaultDbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const DATABASE_PATH = defaultDbPath;
export const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
export const SERVER_PORT = Number(process.env.SERVER_PORT || process.env.PORT || 4000);
export const SERVER_HOST = process.env.SERVER_HOST || '0.0.0.0';
export const APP_URL = process.env.APP_URL || 'http://localhost:3000';
export const GEOCODE_BBOX = process.env.GEOCODE_BBOX || '-79.76,40.49,-71.85,45.01';
export const GEOCODE_COUNTRY = process.env.GEOCODE_COUNTRY || 'US';
