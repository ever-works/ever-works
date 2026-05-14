import { test, expect } from '@playwright/test';
import { apiUrl, loginViaAPI, authedHeaders } from './helpers/api';
import { TEST_USER } from './helpers/test-user';

/**
 * v2 onboarding wizard end-to-end coverage.
 *
 * These tests exercise the choice-driven flow (Welcome → AI → Storage →
 * Deploy → Plugins → Create Work). The shared chromium project's
 * storageState has `dismissedAt` already set in the API (see
 * `global-setup.ts > POST /api/onboarding/dismiss`), so we explicitly
 * undismiss the wizard for these specs before each test.
 *
 * Auth model: the endpoints live on the NestJS API at :3100, so
 * `page.request` against a relative path resolves to the Next.js web at
 * :3000 (no proxy → 404) AND cookies set on :3000 do not transfer to
 * :3100. We log in via API to obtain a Bearer token and authenticate the
 * `/api/onboarding/*` calls directly, mirroring `global-setup.ts`.
 */

test.describe('Onboarding wizard v2 — choice-driven flow', () => {
    let auth: { Authorization: string };

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        try {
            const { access_token } = await loginViaAPI(ctx, {
                email: TEST_USER.email,
                password: TEST_USER.password,
            });
            auth = authedHeaders(access_token);
        } finally {
            await ctx.dispose();
        }
    });

    test.beforeEach(async ({ page }) => {
        // Reset server state to pristine for each test so we exercise the
        // auto-open path. The /api/onboarding/state PATCH endpoint accepts
        // a partial state; explicitly re-load the dashboard after each reset
        // so the layout's RSC fetch picks up the new server state.
        await page.request.patch(apiUrl('/api/onboarding/state'), {
            headers: auth,
            data: {
                state: {
                    lastStep: 0,
                    ai: { choice: 'ever-works' },
                    storage: { choice: 'ever-works-git' },
                    deploy: { choice: 'ever-works' },
                    skippedSteps: [],
                    pluginsReviewed: false,
                },
            },
        });
    });

    test('catalog endpoint returns the six AI cards with Ever Works as default', async ({
        page,
    }) => {
        const res = await page.request.get(apiUrl('/api/onboarding/catalog'), {
            headers: auth,
        });
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as {
            ai: Array<{ choice: string; default?: boolean }>;
        };
        expect(body.ai).toHaveLength(6);
        const def = body.ai.find((c) => c.default);
        expect(def?.choice).toBe('ever-works');
    });

    test('state endpoint round-trips a partial PATCH', async ({ page }) => {
        const patch = await page.request.patch(apiUrl('/api/onboarding/state'), {
            headers: auth,
            data: { state: { ai: { choice: 'openrouter' }, lastStep: 2 } },
        });
        expect(patch.ok()).toBe(true);

        const res = await page.request.get(apiUrl('/api/onboarding/state'), {
            headers: auth,
        });
        const body = (await res.json()) as {
            state: { ai: { choice: string }; lastStep: number };
        };
        expect(body.state.ai.choice).toBe('openrouter');
        expect(body.state.lastStep).toBe(2);
    });

    test('rejects an invalid AI choice with a 400', async ({ page }) => {
        const res = await page.request.patch(apiUrl('/api/onboarding/state'), {
            headers: auth,
            data: { state: { ai: { choice: 'not-a-real-provider' } } },
        });
        expect(res.status()).toBe(400);
    });

    test('telemetry endpoint accepts an allow-listed event', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/telemetry'), {
            headers: auth,
            data: { event: 'onboarding_opened', properties: { trigger: 'auto' } },
        });
        // 204 No Content on success
        expect(res.status()).toBe(204);
    });

    test('telemetry endpoint rejects an unknown event', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/telemetry'), {
            headers: auth,
            data: { event: 'definitely_not_in_allowlist', properties: {} },
        });
        expect(res.status()).toBe(400);
    });

    test('complete endpoint is idempotent', async ({ page }) => {
        const first = await page.request.post(apiUrl('/api/onboarding/complete'), {
            headers: auth,
            data: {},
        });
        const second = await page.request.post(apiUrl('/api/onboarding/complete'), {
            headers: auth,
            data: {},
        });
        expect(first.ok()).toBe(true);
        expect(second.ok()).toBe(true);
    });

    test('dismiss endpoint is idempotent', async ({ page }) => {
        const first = await page.request.post(apiUrl('/api/onboarding/dismiss'), {
            headers: auth,
            data: {},
        });
        const second = await page.request.post(apiUrl('/api/onboarding/dismiss'), {
            headers: auth,
            data: {},
        });
        expect(first.ok()).toBe(true);
        expect(second.ok()).toBe(true);
    });
});
