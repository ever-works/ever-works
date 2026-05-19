import { test, expect } from '@playwright/test';

/**
 * WebRTC / media permissions — pass 11. If any page requests mic /
 * camera / display access, that request must be gated behind explicit
 * user action — never on page load. We monitor for getUserMedia /
 * getDisplayMedia calls during a fresh navigation.
 */

test.describe('WebRTC permissions — not requested on page load', () => {
    test('navigating to /en/login does not request mic/camera', async ({ page, baseURL }) => {
        const requests: string[] = [];
        await page.addInitScript(() => {
            const w = window as unknown as {
                __mediaCalls: string[];
            };
            w.__mediaCalls = [];
            const origGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(
                navigator.mediaDevices,
            );
            const origGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(
                navigator.mediaDevices,
            );
            if (navigator.mediaDevices && origGetUserMedia) {
                navigator.mediaDevices.getUserMedia = (constraints) => {
                    w.__mediaCalls.push('getUserMedia:' + JSON.stringify(constraints));
                    return origGetUserMedia(constraints);
                };
            }
            if (navigator.mediaDevices && origGetDisplayMedia) {
                navigator.mediaDevices.getDisplayMedia = (constraints) => {
                    w.__mediaCalls.push('getDisplayMedia:' + JSON.stringify(constraints));
                    return origGetDisplayMedia(constraints);
                };
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        const calls = await page.evaluate(
            () => (window as unknown as { __mediaCalls?: string[] }).__mediaCalls ?? [],
        );
        // The login page MUST NOT preemptively request media access.
        // Any call here would surface as a permission prompt on real
        // browsers — a UX disaster.
        expect(calls.length, `login preemptively called: ${calls.join(', ')}`).toBe(0);
        void requests;
    });

    test('navigating to /en/register does not request mic/camera', async ({ page, baseURL }) => {
        await page.addInitScript(() => {
            (window as unknown as { __mediaCalls: string[] }).__mediaCalls = [];
            const orig = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
            if (navigator.mediaDevices && orig) {
                navigator.mediaDevices.getUserMedia = (c) => {
                    (window as unknown as { __mediaCalls: string[] }).__mediaCalls.push(
                        'getUserMedia',
                    );
                    return orig(c);
                };
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'networkidle',
        });
        const calls = await page.evaluate(
            () => (window as unknown as { __mediaCalls?: string[] }).__mediaCalls ?? [],
        );
        expect(calls.length).toBe(0);
    });
});

test.describe('WebRTC — permissions-policy header (if set)', () => {
    test('login page Permissions-Policy denies camera/microphone by default', async ({
        page,
        baseURL,
    }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const pp = res!.headers()['permissions-policy'] || res!.headers()['feature-policy'];
        if (!pp) {
            test.skip(true, 'no Permissions-Policy header set');
        }
        // We accept any policy that EITHER explicitly denies these
        // (`camera=()`) OR doesn't grant them. The dangerous shape is
        // `camera=*` which would let any embedded iframe pop the prompt.
        for (const feat of ['camera', 'microphone', 'geolocation']) {
            const featClause = new RegExp(`${feat}\\s*=\\s*(\\*|\\(self\\)|\\([^)]*\\))`, 'i');
            const m = pp!.match(featClause);
            if (!m) continue;
            expect(
                m[1].includes('*'),
                `Permissions-Policy grants ${feat}=* — should be restricted to (self) or ()`,
            ).toBe(false);
        }
    });
});
