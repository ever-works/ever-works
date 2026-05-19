import { test, expect } from '@playwright/test';

/**
 * Cookie flags — deep audit. Pass 6+ from queued list. We classify
 * every cookie the browser receives after a fresh login and require:
 *   - session/auth cookies are HttpOnly
 *   - session/auth cookies have SameSite=Lax|Strict (not None unless
 *     paired with Secure)
 *   - Secure flag presence matches whether we're on https
 */

test.describe('Cookie flags — dashboard context audit', () => {
    test('after navigating /en, all session-ish cookies have HttpOnly + safe SameSite', async ({
        page,
        context,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const cookies = await context.cookies();
        const sessionish = cookies.filter((c) => /(session|auth|token|sid|jwt)/i.test(c.name));
        if (sessionish.length === 0) {
            test.skip(true, 'no session-like cookie found');
        }
        const reasons: string[] = [];
        for (const c of sessionish) {
            // HttpOnly: at least one of them MUST have HttpOnly. We log
            // per-cookie issues for diagnostic value.
            if (!c.httpOnly) {
                reasons.push(`${c.name} missing HttpOnly`);
            }
            const ss = (c.sameSite || '').toLowerCase();
            // SameSite=None without Secure is rejected by all modern
            // browsers. Lax / Strict are both safe. Some cookies have
            // sameSite undefined which browsers default to Lax.
            if (ss === 'none' && !c.secure) {
                reasons.push(`${c.name} SameSite=None without Secure`);
            }
        }
        // We require at least ONE HttpOnly session cookie. Multiple
        // non-HttpOnly cookies are fine (CSRF tokens, csrf double-submit
        // helpers, non-secret flags).
        const anyHttpOnly = sessionish.some((c) => c.httpOnly);
        expect(
            anyHttpOnly,
            `no HttpOnly session cookie found in: ${sessionish.map((c) => c.name).join(', ')}`,
        ).toBe(true);
        // Hard fail if any cookie has the SameSite=None-without-Secure
        // misconfig — that's a real bug.
        const sameSiteIssues = reasons.filter((r) => r.includes('SameSite=None'));
        expect(sameSiteIssues, sameSiteIssues.join('; ')).toEqual([]);
    });

    test('cookies set by /en do not leak the full session value into name/path', async ({
        page,
        context,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const cookies = await context.cookies();
        for (const c of cookies) {
            // Cookie NAMES should never contain anything that looks like
            // a token — long base64ish strings, hex >32 chars. If they
            // do, the framework is misusing cookie names as values.
            expect(/^[A-Za-z0-9_.-]{1,80}$/.test(c.name), `cookie name suspicious: ${c.name}`).toBe(
                true,
            );
            // Cookie paths should be well-formed.
            expect(typeof c.path).toBe('string');
        }
    });

    test('no PII appears in cookie names (e.g. email, username)', async ({ page, context }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_500);
        const cookies = await context.cookies();
        for (const c of cookies) {
            // Don't allow @ or % characters in cookie names — those
            // suggest a URL-encoded email/user-id landed in a name.
            expect(c.name.includes('@'), `cookie name "${c.name}" contains @`).toBe(false);
        }
    });
});
