import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * `apps/api/src/migrations/` is not an ordinary source directory — it is
 * the input to a RUNTIME glob.
 *
 * `packages/agent/src/database/database.config.ts` boots the API with
 * `migrations: ['<cwd>/dist/migrations/*.js', '<cwd>/apps/api/dist/migrations/*.js']`
 * and `migrationsRun: true` (prod/stage). The glob is FLAT and matches
 * every `.js` file in that one directory, while `nest build -b swc`
 * compiles the whole of `src` — spec files included — into `dist`.
 *
 * So any file dropped directly into `src/migrations/` is executed by
 * `DataSource.initialize()` on every pod boot. For a Jest spec that
 * means its top-level `describe(...)` runs outside Jest and throws
 * `ReferenceError: describe is not defined`, TypeORM's
 * `DirectoryExportedClassesLoader` propagates it, and the API
 * crash-loops — invisibly, because Kubernetes rolls back to the old
 * pods. That is the incident this file exists to prevent; migration
 * specs therefore live one level down in `__tests__/`, whose compiled
 * output (`dist/migrations/__tests__/*.js`) the glob cannot reach.
 */
describe('src/migrations directory contract', () => {
    const MIGRATIONS_DIR = join(__dirname, '..');

    /** Only files the runtime glob would actually pick up. */
    const flatFiles = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);

    it('contains no test file that the runtime migration glob would execute', () => {
        const specs = flatFiles.filter((name) => /\.(spec|test)\.ts$/.test(name));

        expect(specs).toEqual([]);
    });

    it('every flat file is a timestamped migration module, nothing else', () => {
        const strays = flatFiles.filter((name) => !/^\d{13}-[A-Za-z0-9]+\.ts$/.test(name));

        expect(strays).toEqual([]);
    });

    it('no flat migration file references Jest globals', () => {
        // Belt and braces: a helper that merely IMPORTS a spec would be
        // just as fatal, and the filename check above cannot see that.
        const offenders = flatFiles.filter((name) => {
            const source = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
            return /^\s*(describe|it|test)\s*\(/m.test(source);
        });

        expect(offenders).toEqual([]);
    });
});
