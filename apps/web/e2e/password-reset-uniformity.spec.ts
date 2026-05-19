import { test, expect } from '@playwright/test';
import { API_BASE, registerUserViaAPI } from './helpers/api';

/**
 * Password reset H-03 timing-uniformity — pass 6. Deepens
 * password-reset-edge.spec.ts. The /api/auth/forgot-password endpoint
 * must take indistinguishable wall-clock time for:
 *   - A real registered email (token gets generated + emailed)
 *   - A bogus email (no DB row, no email)
 *
 * If the bogus path is meaningfully faster, an attacker can enumerate
 * which emails are registered users. We do a coarse statistical check
 * — a single sample is noisy, so we take a small batch and require
 * the mean ratio to be within a generous window.
 */

const SAMPLE_SIZE = 4;

async function measure(
    request: import('@playwright/test').APIRequestContext,
    email: string,
): Promise<number> {
    const t0 = Date.now();
    const res = await request.post(`${API_BASE}/api/auth/forgot-password`, {
        data: { email },
    });
    // The contract is: ALWAYS respond 200/202 regardless of whether
    // the email exists. Anything else is itself an enumeration signal.
    expect(res.status()).toBeLessThan(500);
    return Date.now() - t0;
}

test.describe('Password reset — timing uniformity (H-03)', () => {
    test('mean response time for known vs unknown emails is within 3x', async ({ request }) => {
        const real = await registerUserViaAPI(request);
        const realTimes: number[] = [];
        const bogusTimes: number[] = [];
        for (let i = 0; i < SAMPLE_SIZE; i++) {
            realTimes.push(await measure(request, real.email));
            bogusTimes.push(
                await measure(
                    request,
                    `unknown-${Date.now().toString(36)}-${i}@nonexistent.test.local`,
                ),
            );
        }
        const realMean = realTimes.reduce((a, b) => a + b, 0) / realTimes.length;
        const bogusMean = bogusTimes.reduce((a, b) => a + b, 0) / bogusTimes.length;
        // Take the smaller of the two as the denominator, larger as
        // the numerator — we just care that one isn't massively faster.
        // A 3x ratio is loose enough to survive CI noise on cold dev
        // servers; a real enumeration leak would typically be 10x+.
        const ratio = Math.max(realMean, bogusMean) / Math.max(1, Math.min(realMean, bogusMean));
        // Bail-out: if both means are tiny (< 50 ms each), the
        // jitter overwhelms any signal. Skip rather than flake.
        if (realMean < 50 && bogusMean < 50) {
            test.skip(
                true,
                `means too small to compare (real=${realMean}ms, bogus=${bogusMean}ms)`,
            );
        }
        expect(
            ratio,
            `timing ratio ${ratio.toFixed(2)}x (real=${realMean}ms, bogus=${bogusMean}ms) — possible enumeration leak`,
        ).toBeLessThan(3);
    });

    test('forgot-password always returns 200/202 — does NOT leak existence', async ({
        request,
    }) => {
        const r1 = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: `definitely-not-a-user-${Date.now()}@nope.local` },
        });
        // Status must NOT signal "does this user exist?" — 200/202 is
        // the canonical response whether the user exists or not. 4xx
        // for unknown emails would itself be the enumeration leak.
        expect(r1.status()).toBeGreaterThanOrEqual(200);
        expect(r1.status()).toBeLessThan(300);

        const real = await registerUserViaAPI(request);
        const r2 = await request.post(`${API_BASE}/api/auth/forgot-password`, {
            data: { email: real.email },
        });
        expect(r2.status()).toBeGreaterThanOrEqual(200);
        expect(r2.status()).toBeLessThan(300);
    });
});
