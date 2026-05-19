import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * API version header — pass 14. Best-practice REST APIs surface a
 * version in headers so clients can negotiate compatibility. Common
 * shapes: `X-API-Version`, `X-Version`, `API-Version`, or a `Server`
 * suffix carrying the app version.
 *
 * We probe /api/health and assert that EITHER a recognised version
 * header is present OR the body's JSON carries a `version` field.
 * If neither, the platform is silent on versioning — that's an
 * informational skip (clients can't pin compat).
 */

const VERSION_HEADERS = [
    'x-api-version',
    'x-version',
    'api-version',
    'x-app-version',
    'x-platform-version',
];

test.describe('Versioning — /api/health surfaces a platform version', () => {
    test('/api/health response carries a version somewhere (header or body)', async ({
        request,
    }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBeLessThan(500);
        const headerVersion = VERSION_HEADERS.map((h) => res.headers()[h]).filter(Boolean)[0];
        let bodyVersion: string | undefined;
        try {
            const body = await res.json();
            bodyVersion =
                body?.version ??
                body?.app?.version ??
                body?.info?.version ??
                body?.platform?.version;
        } catch {
            // Not JSON — ignore.
        }
        if (!headerVersion && !bodyVersion) {
            test.info().annotations.push({
                type: 'informational',
                description:
                    "no version header or body field on /api/health — clients can't pin compat",
            });
            test.skip(true, 'no version info exposed');
        }
        const version = headerVersion || bodyVersion!;
        // Version should look like a semver-ish or git-ish string.
        // Accept: 1.2.3, v1.2.3, 1.2.3-rc.4, sha-shaped (8+ hex), or
        // a YYYY-MM-DD date.
        const semverShape = /^v?\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(version);
        const shaShape = /^[a-f0-9]{8,40}$/.test(version);
        const dateShape = /^\d{4}-\d{2}-\d{2}$/.test(version);
        expect(
            semverShape || shaShape || dateShape,
            `version doesn't match semver/sha/date: "${version}"`,
        ).toBe(true);
    });

    test('Version header (if present) is stable across calls', async ({ request }) => {
        const a = await request.get(`${API_BASE}/api/health`);
        const b = await request.get(`${API_BASE}/api/health`);
        const aVer = VERSION_HEADERS.map((h) => a.headers()[h]).filter(Boolean)[0];
        const bVer = VERSION_HEADERS.map((h) => b.headers()[h]).filter(Boolean)[0];
        if (!aVer || !bVer) {
            test.skip(true, 'no version header to compare');
        }
        expect(aVer, 'version header drifted between consecutive calls').toBe(bVer);
    });
});
