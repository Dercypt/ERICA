import type { ISQLiteDatabase } from '../src/features/dispatch/outboxQueue';

export function openDatabaseAsync(name: string): Promise<ISQLiteDatabase>;
export function createTestDatabase(): ISQLiteDatabase;
export function resetMockSqlite(): void;
