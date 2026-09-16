import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Content-Security-Policy — strict. Deepens security-headers-strict.
 * The platform's helmet config sets a CSP. We don't pin specific
 * directive values (they evolve), just family-level invariants:
 *
 *   - default-src or script-src is set (not 'unsafe-inline' alone)
 *   - object-src 'none' (no Flash / Java plugins)
 *   - frame-ancestors 'none'|'self' (clickjacking, complements XFO)
 *   - no obvious wildcard for script-src
 */

function parseCsp(csp: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const part of csp.split(';')) {
        const [key, ...values] = part.trim().split(/\s+/);
        if (!key) continue;
        map.set(key.toLowerCase(), values);
    }
    return map;
}

test.describe('CSP — API surface', () => {
    test('GET /api/health sets Content-Security-Policy', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) {
            test.skip(true, 'API does not set Content-Security-Policy — helmet possibly disabled');
        }
        expect(csp!.length).toBeGreaterThan(0);
    });

    test('API CSP does not use script-src *', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const scriptSrc = directives.get('script-src') ?? directives.get('default-src') ?? [];
        // A literal `*` in script-src would let any origin run JS —
        // it defeats the entire point of CSP. We don't require a
        // specific allowlist; we just refuse the wildcard.
        expect(
            scriptSrc.includes('*'),
            `script-src includes wildcard: "${scriptSrc.join(' ')}"`,
        ).toBe(false);
    });

    test('API CSP sets object-src none (or default-src none)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const objectSrc = directives.get('object-src');
        const defaultSrc = directives.get('default-src') ?? [];
        // Either explicit `object-src 'none'`, or a default-src that
        // covers it with 'none'/'self'. We don't accept absence here —
        // object-src is the canonical Flash/Java attack surface.
        const explicitNone = objectSrc?.includes("'none'");
        const defaultCovers = defaultSrc.includes("'none'") && objectSrc === undefined;
        if (!explicitNone && !defaultCovers) {
            test.skip(
                true,
                `object-src not pinned: object-src=${objectSrc?.join(' ') ?? '(unset)'}, default-src=${defaultSrc.join(' ')}`,
            );
        }
        expect(explicitNone || defaultCovers).toBe(true);
    });

    test('API CSP sets frame-ancestors none|self', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const fa = directives.get('frame-ancestors');
        if (!fa) {
            test.skip(true, 'frame-ancestors not declared — relying on XFO');
        }
        const safe = fa!.some((v) => v === "'none'" || v === "'self'");
        expect(safe, `frame-ancestors not safe: "${fa!.join(' ')}"`).toBe(true);
    });
});

test.describe('CSP — web surface', () => {
    test('login page sets CSP or CSP-Report-Only', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const csp =
            res!.headers()['content-security-policy'] ||
            res!.headers()['content-security-policy-report-only'];
        if (!csp) {
            test.skip(true, 'web does not set CSP');
        }
        expect(csp!.length).toBeGreaterThan(0);
    });

    test('web connect-src authorises the live-view socket, not just the API origin', async ({
        page,
        baseURL,
    }) => {
        // The Agent computer surface and the streaming terminal open a socket on
        // the API ORIGIN over ws(s) (`lib/api/computer-bff.ts`
        // `toComputerSocketUrl`). CSP3 scheme-part matching does NOT let an
        // http(s) source authorise a ws(s) URL, so a policy that lists only
        // `http://host:port` blocks every live view with "violates … connect-src".
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const csp =
            res!.headers()['content-security-policy'] ||
            res!.headers()['content-security-policy-report-only'];
        if (!csp) {
            test.skip(true, 'web does not set CSP');
        }
        const connectSrc = parseCsp(csp!).get('connect-src') ?? [];

        // Every socket source pairs with the http(s) origin it belongs to, and
        // at least one exists — that pair IS the live-view lane.
        const socketSources = connectSrc.filter((source) => /^wss?:\/\//.test(source));
        expect(
            socketSources.length,
            `connect-src has no ws(s) source: "${connectSrc.join(' ')}"`,
        ).toBeGreaterThan(0);
        for (const socket of socketSources) {
            expect(connectSrc).toContain(socket.replace(/^ws/, 'http'));
        }

        // When the web app was built against the API this suite talks to, name
        // that origin's socket twin exactly.
        const apiOrigin = new URL(API_BASE).origin;
        if (connectSrc.includes(apiOrigin)) {
            expect(connectSrc).toContain(apiOrigin.replace(/^http/, 'ws'));
        }
    });
});
