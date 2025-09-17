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
  const ensureColumn = (table, column, definition) => {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all();
    const hasColumn = existing.some(row => row.name === column);
    if (!hasColumn) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      input_path TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      reactivated_count INTEGER NOT NULL DEFAULT 0,
      deactivated_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      notes TEXT
    );

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
      reactivated_at TEXT,
      data_json TEXT,
      notes TEXT,
      last_run_id INTEGER,
      FOREIGN KEY(last_run_id) REFERENCES ingest_runs(id)
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

    CREATE TABLE IF NOT EXISTS property_ingest_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      property_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ingest_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
    CREATE INDEX IF NOT EXISTS idx_properties_last_seen ON properties(last_seen);
    CREATE INDEX IF NOT EXISTS idx_properties_price_num ON properties(price_num);
    CREATE INDEX IF NOT EXISTS idx_properties_latlng ON properties(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_property_ingest_events_property ON property_ingest_events(property_id);
    CREATE INDEX IF NOT EXISTS idx_property_ingest_events_run ON property_ingest_events(run_id);
  `);

  ensureColumn('properties', 'reactivated_at', 'TEXT');
  ensureColumn('properties', 'last_run_id', 'INTEGER');
  ensureColumn('ingest_runs', 'status', "TEXT NOT NULL DEFAULT 'running'");
  ensureColumn('ingest_runs', 'input_path', 'TEXT');
  ensureColumn('ingest_runs', 'record_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'created_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'updated_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'unchanged_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'changed_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'reactivated_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'deactivated_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ingest_runs', 'error', 'TEXT');
  ensureColumn('ingest_runs', 'notes', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_properties_last_run ON properties(last_run_id);
  `);
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
