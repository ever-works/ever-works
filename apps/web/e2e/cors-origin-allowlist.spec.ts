import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * CORS origin allowlist — pass 16. Preflight from an obviously
 * attacker-controlled origin should either:
 *  - be rejected (no Access-Control-Allow-Origin header), OR
 *  - be answered without an `Access-Control-Allow-Credentials: true`
 *    header (so credentialed requests from evil.example fail)
 *
 * Preflight from a legitimate origin (`https://*.ever.works`,
 * `https://localhost:3000`, etc.) should either echo the origin OR
 * `*` for non-credentialed.
 */

const EVIL_ORIGINS = ['https://evil.example.com', 'http://attacker.local', 'https://ever.evil'];
const TRUSTED_PATTERNS = [/ever\.works$/i, /localhost(:\d+)?$/i];

test.describe('CORS — evil origins do not get credentialed access', () => {
    test('preflight from evil.example never returns ACAO + ACAC=true together', async ({
        request,
    }) => {
        for (const origin of EVIL_ORIGINS) {
            const res = await request.fetch(`${API_BASE}/api/health`, {
                method: 'OPTIONS',
                headers: {
                    Origin: origin,
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Authorization',
                },
            });
            const acao = res.headers()['access-control-allow-origin'] || '';
            const acac = res.headers()['access-control-allow-credentials'] || '';
            const echoed = Boolean(acao) && (acao === origin || acao === '*');
            const credentialed = /true/i.test(acac);
            // `Boolean(...)` coerce: `echoed && credentialed` would
            // otherwise return the falsy operand verbatim (e.g. "")
            // instead of `false`, making the toBe(false) assertion
            // flake on strict-equality even when the CORS layer is
            // doing the right thing.
            expect(
                Boolean(echoed && credentialed),
                `preflight echoes evil origin "${origin}" with credentials=true: ACAO="${acao}" ACAC="${acac}"`,
            ).toBe(false);
        }
    });

    test('preflight from a trusted-shape origin (if accepted) does not wildcard with credentials', async ({
        request,
    }) => {
        // Pick a plausible production-shape origin.
        const trusted = 'https://app.ever.works';
        const res = await request.fetch(`${API_BASE}/api/health`, {
            method: 'OPTIONS',
            headers: {
                Origin: trusted,
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'Authorization',
            },
        });
        const acao = res.headers()['access-control-allow-origin'] || '';
        const acac = res.headers()['access-control-allow-credentials'] || '';
        if (!acao) {
            test.skip(true, 'CORS not enabled — preflight returned no Access-Control-Allow-Origin');
        }
        // ACAO=* with ACAC=true is invalid per CORS spec — browsers
        // reject. Catch the misconfig at the test layer too.
        const wildcardWithCreds = acao === '*' && /true/i.test(acac);
        expect(wildcardWithCreds, `trusted origin got ACAO=* with ACAC=true — invalid combo`).toBe(
            false,
        );
        // Sanity: a trusted-shape origin OR wildcard is fine.
        const matchesTrustedShape =
            acao === '*' ||
            acao === trusted ||
            TRUSTED_PATTERNS.some((re) => re.test(new URL(acao).hostname || ''));
        if (!matchesTrustedShape) {
            test.info().annotations.push({
                type: 'informational',
                description: `unexpected ACAO value for trusted origin: "${acao}"`,
            });
        }
    });
});
