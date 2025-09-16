import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATABASE_PATH } from './config.js';

let dbInstance;

export function getDb() {
  if (!dbInstance) {
    const dir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    dbInstance = new Database(DATABASE_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    initializeSchema(dbInstance);
  }
  return dbInstance;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      address TEXT,
      address_clean TEXT,
      city_state_zip TEXT,
      county TEXT,
      lat REAL,
      lng REAL,
      price TEXT,
      price_num REAL,
      sale_window TEXT,
      beds TEXT,
      beds_num REAL,
      baths TEXT,
      baths_num REAL,
      sqft TEXT,
      sqft_num REAL,
      lot_size_acres TEXT,
      property_type TEXT,
      year_built TEXT,
      est_resale_value TEXT,
      has_addendum INTEGER NOT NULL DEFAULT 0,
      addendum_url TEXT,
      is_cwcot INTEGER NOT NULL DEFAULT 0,
      scraped_at TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_changed TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      inactive_at TEXT,
      data_json TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS property_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL,
      FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS geocodes (
      address_clean TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
    CREATE INDEX IF NOT EXISTS idx_properties_last_seen ON properties(last_seen);
    CREATE INDEX IF NOT EXISTS idx_properties_price_num ON properties(price_num);
    CREATE INDEX IF NOT EXISTS idx_properties_latlng ON properties(lat, lng);
  `);
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
