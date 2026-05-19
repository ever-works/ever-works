import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Time-window coercion — pass 16. Endpoints accepting `from` / `to`
 * (or `start` / `end` / `since` / `until`) ranges should:
 *  - reject inverted ranges (`from > to`) with 4xx, not 5xx
 *  - reject malformed dates with 4xx, not 5xx
 *  - accept legitimately wide windows (1 year) without 5xx
 */

const TIME_WINDOW_PATHS = [
    '/api/activity-log?from=__FROM__&to=__TO__',
    '/api/works?createdAfter=__FROM__&createdBefore=__TO__',
];

const cases = {
    inverted: {
        from: '2026-12-31T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
    },
    malformed: {
        from: 'not-a-date',
        to: '2026-01-01T00:00:00Z',
    },
    wide: {
        from: '2025-01-01T00:00:00Z',
        to: '2026-12-31T23:59:59Z',
    },
};

test.describe('Time-window query params — coerce or reject without 5xx', () => {
    for (const [name, c] of Object.entries(cases)) {
        test(`${name} window is handled without 5xx across all probed endpoints`, async ({
            request,
        }) => {
            const u = await registerUserViaAPI(request);
            let probedAtLeastOne = false;
            for (const tpl of TIME_WINDOW_PATHS) {
                const url =
                    API_BASE +
                    tpl
                        .replace('__FROM__', encodeURIComponent(c.from))
                        .replace('__TO__', encodeURIComponent(c.to));
                const res = await request.get(url, {
                    headers: authedHeaders(u.access_token),
                });
                if (res.status() === 404) continue;
                probedAtLeastOne = true;
                expect(
                    res.status(),
                    `${tpl} with ${name} window crashed: ${res.status()}`,
                ).toBeLessThan(500);
            }
            if (!probedAtLeastOne) {
                test.skip(true, `no time-window endpoint accepted the ${name} probe`);
            }
        });
    }
});
