// Node stand-in for expo-sqlite backed by the built-in node:sqlite engine, so storage code
// runs real SQL in tests. Each database name maps to one in-memory database.
import { DatabaseSync } from 'node:sqlite';

const databases = new Map();

class NodeSqliteDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  async execAsync(sql) {
    this.db.exec(sql);
  }
  async runAsync(sql, ...params) {
    const result = this.db.prepare(sql).run(...params);
    return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
  }
  async getAllAsync(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  async getFirstAsync(sql, ...params) {
    return this.db.prepare(sql).get(...params) ?? null;
  }
}

export async function openDatabaseAsync(name) {
  if (!databases.has(name)) {
    databases.set(name, new NodeSqliteDatabase());
  }
  return databases.get(name);
}

export function createTestDatabase() {
  return new NodeSqliteDatabase();
}

export function resetMockSqlite() {
  databases.clear();
}
