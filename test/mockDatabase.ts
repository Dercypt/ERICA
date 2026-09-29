import type { ISQLiteDatabase, OutboxItem, OutboxStatus } from '../src/features/dispatch/outboxQueue';

export class MockSQLiteDatabase implements ISQLiteDatabase {
  public rows: Map<string, OutboxItem> = new Map();

  async execAsync(_sql: string): Promise<void> {
    // schema creation / pragmas
  }

  async runAsync(sql: string, ...params: any[]): Promise<{ lastInsertRowId?: number; changes?: number }> {
    const trimmed = sql.trim();

    if (trimmed.startsWith('INSERT INTO outbox_queue')) {
      const [id, recipient, payload, attempts, status, nextRetryAt, createdAt] = params;
      const item: OutboxItem = {
        id: String(id),
        recipient: String(recipient),
        payload: String(payload),
        attempts: Number(attempts),
        status: status as OutboxStatus,
        nextRetryAt: Number(nextRetryAt),
        createdAt: Number(createdAt),
      };
      this.rows.set(String(id), item);
      return { changes: 1 };
    }

    if (trimmed.includes("SET status = 'SENT' WHERE id = ?")) {
      const id = String(params[0]);
      const existing = this.rows.get(id);
      if (existing) {
        existing.status = 'SENT';
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (trimmed.startsWith('UPDATE outbox_queue SET payload = ? WHERE id = ?')) {
      const [payload, id] = params;
      const existing = this.rows.get(String(id));
      if (existing) {
        existing.payload = String(payload);
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (trimmed.startsWith('UPDATE outbox_queue SET status = ? WHERE id = ?')) {
      const [status, id] = params;
      const existing = this.rows.get(String(id));
      if (existing) {
        existing.status = status as OutboxStatus;
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (trimmed.includes("SET status = 'IN_FLIGHT' WHERE id IN")) {
      let changes = 0;
      for (const id of params) {
        const item = this.rows.get(String(id));
        if (item) {
          item.status = 'IN_FLIGHT';
          changes++;
        }
      }
      return { changes };
    }

    if (trimmed.includes("SET status = 'PENDING' WHERE status = 'IN_FLIGHT'")) {
      let changes = 0;
      for (const item of this.rows.values()) {
        if (item.status === 'IN_FLIGHT') {
          item.status = 'PENDING';
          changes++;
        }
      }
      return { changes };
    }

    if (trimmed.startsWith('UPDATE outbox_queue SET attempts = ?, nextRetryAt = ?, status = ? WHERE id = ?')) {
      const [attempts, nextRetryAt, status, id] = params;
      const item = this.rows.get(String(id));
      if (item) {
        item.attempts = Number(attempts);
        item.nextRetryAt = Number(nextRetryAt);
        item.status = status as OutboxStatus;
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (trimmed.startsWith('DELETE FROM outbox_queue')) {
      const count = this.rows.size;
      this.rows.clear();
      return { changes: count };
    }

    return { changes: 0 };
  }

  async getAllAsync<T>(sql: string, ...params: any[]): Promise<T[]> {
    const trimmed = sql.trim();

    if (trimmed.includes("WHERE status = 'PENDING' AND nextRetryAt <= ?")) {
      const [now, limit] = params;
      const results: OutboxItem[] = [];
      for (const item of this.rows.values()) {
        if (item.status === 'PENDING' && item.nextRetryAt <= Number(now)) {
          results.push({ ...item });
        }
      }
      results.sort((a, b) => a.createdAt - b.createdAt);
      const capped = typeof limit === 'number' ? results.slice(0, limit) : results;
      return capped as unknown as T[];
    }

    if (trimmed.includes("WHERE status = 'PENDING'")) {
      const results: OutboxItem[] = [];
      for (const item of this.rows.values()) {
        if (item.status === 'PENDING') {
          results.push({ ...item });
        }
      }
      results.sort((a, b) => a.createdAt - b.createdAt);
      return results as unknown as T[];
    }

    if (trimmed.includes('SELECT status, COUNT(*) as count FROM outbox_queue GROUP BY status')) {
      const counts: Record<string, number> = {};
      for (const item of this.rows.values()) {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
      }
      const res = Object.entries(counts).map(([status, count]) => ({ status, count }));
      return res as unknown as T[];
    }

    if (trimmed.includes('WHERE status = ?')) {
      const [status] = params;
      const results = Array.from(this.rows.values()).filter((i) => i.status === status);
      return results as unknown as T[];
    }

    // Default select all
    return Array.from(this.rows.values()) as unknown as T[];
  }

  async getFirstAsync<T>(sql: string, ...params: any[]): Promise<T | null> {
    const all = await this.getAllAsync<T>(sql, ...params);
    return all.length > 0 ? (all[0] as T) : null;
  }
}
