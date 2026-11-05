import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// <repo>/data/agent-workstation.db；server 源码在 apps/server/src/db
const repoRoot = path.resolve(__dirname, '../../../..');
export const DEFAULT_DB_PATH = path.join(repoRoot, 'data', 'agent-workstation.db');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

export type DB = ReturnType<typeof createDb>['db'];

export function createDb(dbPath = process.env.AW_DB_PATH ?? DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function migrateDb(sqlite: Database.Database) {
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_DIR });
}
