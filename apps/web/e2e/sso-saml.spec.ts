import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * SSO / SAML — pass 10. Enterprise SSO endpoints (SAML/OIDC) may be
 * exposed for IDP-initiated flows or just metadata exchange. Probe
 * the canonical paths and verify auth + content shape. Skip cleanly
 * when SAML isn't configured (most envs).
 */

const SAML_PATHS = [
    '/api/auth/saml/metadata',
    '/api/saml/metadata',
    '/api/sso/saml/metadata',
    '/saml/metadata',
];

const SSO_INIT_PATHS = ['/api/auth/sso/start', '/api/sso/start', '/api/auth/sso'];

test.describe('SSO / SAML — metadata endpoint', () => {
    test('metadata endpoint (if exposed) returns XML', async ({ request }) => {
        let found: { path: string; status: number; ct: string; body: string } | null = null;
        for (const path of SAML_PATHS) {
            const res = await request.get(`${API_BASE}${path}`);
            if (res.status() === 404) continue;
            found = {
                path,
                status: res.status(),
                ct: res.headers()['content-type'] || '',
                body: await res.text(),
            };
            break;
        }
        if (!found) test.skip(true, 'no SAML metadata endpoint exposed');
        // SAML metadata is XML. Response status should be 200 for
        // public metadata, 401/403 if it's tenant-gated.
        expect(found!.status).toBeLessThan(500);
        if (found!.status === 200) {
            const looksXml =
                found!.ct.includes('xml') ||
                found!.body.trimStart().startsWith('<?xml') ||
                found!.body.trimStart().startsWith('<EntityDescriptor');
            expect(
                looksXml,
                `metadata content-type=${found!.ct}, body head=${found!.body.slice(0, 80)}`,
            ).toBe(true);
        }
    });
});

test.describe('SSO / SAML — init endpoint', () => {
    test('SSO init (if exposed) returns a redirect or auth-error', async ({ request }) => {
        let found = false;
        for (const path of SSO_INIT_PATHS) {
            const res = await request.get(`${API_BASE}${path}`, {
                // Don't follow redirects so we can inspect the response.
                maxRedirects: 0,
            });
            if (res.status() === 404) continue;
            found = true;
            // Expected: 302/303 redirect to IDP, OR 401/400 (no tenant
            // configured). Never 5xx.
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no SSO init endpoint exposed');
    });
});

test.describe('SSO / SAML — SAML response endpoint (callback)', () => {
    test('POST /saml/acs without auth → 4xx', async ({ request }) => {
        const ACS_PATHS = ['/api/auth/saml/acs', '/api/saml/acs', '/saml/acs'];
        let found = false;
        for (const path of ACS_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                form: { SAMLResponse: 'bogus' },
            });
            if (res.status() === 404 || res.status() === 405) continue;
            found = true;
            // ACS endpoint must reject a bogus SAMLResponse — 400 typical.
            expect(res.status()).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            return;
        }
        if (!found) test.skip(true, 'no SAML ACS endpoint exposed');
    });
});

test.describe('SSO — provider list / discover', () => {
    test('SSO providers list (if exposed) returns array', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const candidates = [
            '/api/auth/sso/providers',
            '/api/sso/providers',
            '/api/auth/providers/sso',
        ];
        for (const path of candidates) {
            const res = await request.get(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
            });
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            if (res.status() === 200) {
                const body = await res.json();
                const arr = Array.isArray(body) ? body : (body?.providers ?? body?.data ?? []);
                expect(Array.isArray(arr)).toBe(true);
            }
            return;
        }
        test.skip(true, 'no SSO providers endpoint exposed');
    });
});
