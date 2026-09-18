import { QueryFailedError } from 'typeorm';
import { isUniqueConstraintError } from '../db-error.utils';

/**
 * APW-07 T8 — the duplicate-key classifier the Environment value store leans
 * on, across all three drivers `database.config.ts` supports.
 *
 * `WorkAppEnvValueRepository.insertIfAbsent` writes with the query builder's
 * `orIgnore()`, which is `INSERT … ON CONFLICT ("workId", "name") DO NOTHING`
 * on Postgres and the equivalent form on the SQLite family — but MySQL/MariaDB
 * get NO ignore clause from TypeORM at all, so a lost insert race arrives there
 * as a unique-constraint error. The plan's own escape arm for that driver is
 * "the service does the compare-and-set itself" (`plan.md:199-200`), and this
 * helper is what makes that arm reachable: without the MySQL spellings it would
 * rethrow instead of reading back the winner's row.
 *
 * The negative case matters as much as the positive ones: a FOREIGN KEY or NOT
 * NULL violation is a real defect and must never be swallowed as "someone else
 * won the race".
 */
describe('isUniqueConstraintError', () => {
    function failure(driverError: { code?: string | number; message?: string }): QueryFailedError {
        // A driver error is an `Error` at runtime; only `code`/`message` are read.
        return new QueryFailedError('INSERT INTO "t" ("a") VALUES ($1)', ['a'], {
            name: 'error',
            ...driverError,
        } as Error);
    }

    it('recognises the Postgres unique_violation', () => {
        expect(isUniqueConstraintError(failure({ code: '23505' }))).toBe(true);
        expect(
            isUniqueConstraintError(
                failure({
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "uq_x"',
                }),
            ),
        ).toBe(true);
    });

    it('recognises the SQLite unique violation, by code and by message', () => {
        expect(isUniqueConstraintError(failure({ code: 'SQLITE_CONSTRAINT_UNIQUE' }))).toBe(true);
        expect(isUniqueConstraintError(failure({ code: 'SQLITE_CONSTRAINT' }))).toBe(true);
        expect(
            isUniqueConstraintError(
                failure({ message: 'UNIQUE constraint failed: work_app_env_values.workId' }),
            ),
        ).toBe(true);
    });

    it('recognises the MySQL and MariaDB duplicate-entry error', () => {
        // mysql2 reports the driver code; the server error number arrives as 1062.
        expect(isUniqueConstraintError(failure({ code: 'ER_DUP_ENTRY' }))).toBe(true);
        expect(isUniqueConstraintError(failure({ code: 1062 }))).toBe(true);
        expect(isUniqueConstraintError(failure({ code: '1062' }))).toBe(true);
        expect(
            isUniqueConstraintError(
                failure({
                    code: 'ER_DUP_ENTRY',
                    message:
                        "Duplicate entry 'w1-JWT_SECRET' for key 'uq_work_app_env_values_work_name'",
                }),
            ),
        ).toBe(true);
    });

    it('never claims a different constraint violation', () => {
        // A foreign key or NOT NULL failure is a real defect: swallowing it
        // would hand a caller someone else's row and hide the bug.
        expect(isUniqueConstraintError(failure({ code: '23503' }))).toBe(false);
        expect(isUniqueConstraintError(failure({ code: 'SQLITE_CONSTRAINT_NOTNULL' }))).toBe(false);
        expect(isUniqueConstraintError(failure({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }))).toBe(
            false,
        );
    });

    it('never claims something that is not a query failure at all', () => {
        expect(isUniqueConstraintError(new Error('duplicate key value'))).toBe(false);
        expect(isUniqueConstraintError(undefined)).toBe(false);
        expect(isUniqueConstraintError('unique constraint failed')).toBe(false);
    });
});
