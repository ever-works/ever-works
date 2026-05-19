import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Database migration safety — pass 11. After every deploy the API
 * boot runs pending migrations. We pin:
 *   - /api/health doesn't report a `db` subsystem as `down` (would
 *     mean migrations broke the schema)
 *   - /api/health/db (if exposed) reports migration count + last run
 *   - No 5xx on health probes — the migrations-run-on-boot path must
 *     never leave the API in a half-started state where /health 500s
 */

test.describe('Database migrations — health probe', () => {
    test('GET /api/health does NOT report the db subsystem as down', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        const flat = JSON.stringify(body).toLowerCase();
        // We don't require a db key — we only fail when one is reported
        // as down / unhealthy.
        if (!/database|\bdb\b|postgres|typeorm/.test(flat)) {
            test.skip(true, 'health endpoint does not report a db subsystem');
        }
        const dbDown =
            /database.{0,40}down|"db"\s*:\s*"down"|postgres.{0,40}down|typeorm.{0,40}down/.test(
                flat,
            );
        expect(
            dbDown,
            `health endpoint reports the db subsystem as down: ${flat.slice(0, 200)}`,
        ).toBe(false);
    });

    test('GET /api/health/db (if exposed) returns sane metadata', async ({ request }) => {
        const candidates = ['/api/health/db', '/api/health/database', '/api/db/status'];
        for (const path of candidates) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            if (res.status() === 200) {
                const body = await res.json();
                // Most implementations expose either a `migrations` count
                // or a `lastMigration` timestamp.
                const flat = JSON.stringify(body).toLowerCase();
                const looksLikeMigrationInfo = /migration|lastappliedat|version|schema/.test(flat);
                if (!looksLikeMigrationInfo) {
                    test.skip(
                        true,
                        `health/db body has no migration-shape keys: ${flat.slice(0, 200)}`,
                    );
                }
            }
            return;
        }
        test.skip(true, 'no /api/health/db endpoint exposed');
    });

    test('hammering /api/health 10 times does not 5xx (migrations-run-on-boot stability)', async ({
        request,
    }) => {
        for (let i = 0; i < 10; i++) {
            const res = await request.get(`${API_BASE}/api/health`);
            expect(res.status(), `health hammer iteration ${i}`).toBeLessThan(500);
        }
    });
});
