import { QueryFailedError } from 'typeorm';

/**
 * True when a TypeORM error is a UNIQUE-constraint violation, across both the
 * sqlite driver (CI / e2e, in-memory) and postgres (production). A pre-insert
 * existence check can always lose a concurrent race — two callers both pass the
 * check, then the unique index lets exactly one INSERT land and rejects the
 * rest. This helper lets services translate that lost race into a clean 409
 * Conflict (matching the sequential-duplicate message) instead of leaking a
 * raw 500 DB error to the client.
 */
export function isUniqueConstraintError(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) return false;
    const driverError = (err as QueryFailedError & { driverError?: { code?: string | number } })
        .driverError;
    const code = String(driverError?.code ?? '');
    const message = `${err.message ?? ''}`.toLowerCase();
    return (
        code === '23505' || // postgres unique_violation
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT' || // older better-sqlite3 / node-sqlite codes
        message.includes('unique constraint failed') || // sqlite text
        message.includes('duplicate key value') // postgres text
    );
}
