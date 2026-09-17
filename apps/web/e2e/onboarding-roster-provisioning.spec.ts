import { test, expect } from '@playwright/test';
import { apiUrl, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * AW-20 P1 — the roster endpoints behind the setup wizard's
 * **Your agents** step, end to end against a running API.
 *
 * Deliberately API-level rather than UI-driven. What this epic adds that
 * can go wrong in production is a CONTRACT: which roster we propose for
 * the answers a person gave, which payloads we refuse before writing
 * anything, and whether acknowledging twice moves the timestamp. Driving
 * the wizard chrome to assert those would test the dialog, not the
 * contract, and would go red every time the chrome is restyled.
 *
 * Provisioning itself is deliberately NOT asserted to completion here: it
 * runs through whichever job runtime the environment has configured, and
 * a suite that assumes one is running would be asserting the environment
 * rather than the feature. The per-lane outcomes have direct coverage in
 * `packages/agent/src/agents/__tests__/roster-provisioning.service.spec.ts`.
 */
test.describe('Onboarding — the roster step', () => {
    let auth: { Authorization: string };

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        try {
            const user = await registerUserViaAPI(ctx, {});
            auth = authedHeaders(user.access_token);
        } finally {
            await ctx.dispose();
        }
    });

    test('proposes the general blueprint, coordinator first, for a brand-new account', async ({
        page,
    }) => {
        const res = await page.request.get(apiUrl('/api/onboarding/roster/blueprints'), {
            headers: auth,
        });
        expect(res.status()).toBe(200);

        const body = await res.json();
        expect(body.blueprintSlug).toBe('general');
        expect(body.derivedFromRoles).toBe(false);
        expect(body.maxLanes).toBe(8);
        expect(body.nameMax).toBe(60);
        expect(body.proposal.length).toBeGreaterThan(0);
        expect(body.proposal[0].laneKey).toBe('coordination');
        expect(body.proposal[0].isCoordinator).toBe(true);
        // The catalogue is what "+ Add a lane" offers, so it must be a
        // superset of the proposal.
        expect(body.catalog.length).toBeGreaterThanOrEqual(body.proposal.length);
    });

    test('re-derives the proposal from the roles and team size the wizard saved', async ({
        page,
    }) => {
        await page.request.patch(apiUrl('/api/onboarding/state'), {
            headers: auth,
            data: { state: { profile: { roles: ['marketing'], teamSize: 'solo' } } },
        });

        const res = await page.request.get(apiUrl('/api/onboarding/roster/blueprints'), {
            headers: auth,
        });
        const body = await res.json();

        expect(body.blueprintSlug).toBe('growth');
        expect(body.derivedFromRoles).toBe(true);
        // solo caps the proposal at three lanes, and the coordinator is
        // never the one trimmed.
        expect(body.laneCap).toBe(3);
        expect(body.proposal).toHaveLength(3);
        expect(body.proposal[0].isCoordinator).toBe(true);
    });

    test('returns i18n leaves rather than display copy', async ({ page }) => {
        const res = await page.request.get(apiUrl('/api/onboarding/roster/blueprints'), {
            headers: auth,
        });
        const body = await res.json();

        for (const option of body.catalog) {
            // A literal dot in a leaf makes next-intl throw at runtime.
            expect(option.labelKey).not.toContain('.');
            expect(option.labelKey).toMatch(/^[a-z][a-zA-Z0-9]*$/);
        }
    });

    test('reports an idle roster with no agents before anything is provisioned', async ({
        page,
    }) => {
        const res = await page.request.get(apiUrl('/api/onboarding/roster'), { headers: auth });
        expect(res.status()).toBe(200);

        const body = await res.json();
        expect(body.state).toBe('idle');
        expect(body.provisioning).toBeNull();
        expect(body.agents).toEqual([]);
        expect(body.acknowledgedAt).toBeNull();
    });

    test('refuses a payload that would produce a roster nobody coordinates', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/roster/provision'), {
            headers: auth,
            data: { lanes: [{ laneKey: 'research', name: 'Research' }] },
        });

        expect(res.status()).toBe(400);
    });

    test('refuses a lane key the platform does not ship', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/roster/provision'), {
            headers: auth,
            data: {
                lanes: [
                    { laneKey: 'coordination', name: 'Ada' },
                    { laneKey: 'not-a-lane', name: 'Mystery' },
                ],
            },
        });

        expect(res.status()).toBe(400);
    });

    test('refuses two agents claiming the same lane', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/roster/provision'), {
            headers: auth,
            data: {
                lanes: [
                    { laneKey: 'coordination', name: 'Ada' },
                    { laneKey: 'research', name: 'Research' },
                    { laneKey: 'research', name: 'Research too' },
                ],
            },
        });

        expect(res.status()).toBe(400);
    });

    test('refuses an empty agent name', async ({ page }) => {
        const res = await page.request.post(apiUrl('/api/onboarding/roster/provision'), {
            headers: auth,
            data: { lanes: [{ laneKey: 'coordination', name: '' }] },
        });

        expect(res.status()).toBe(400);
    });

    test('creates nothing when a payload is refused', async ({ page }) => {
        const res = await page.request.get(apiUrl('/api/onboarding/roster'), { headers: auth });
        const body = await res.json();

        expect(body.state).toBe('idle');
        expect(body.agents).toEqual([]);
    });

    test('records the introduction once and keeps the first timestamp', async ({ page }) => {
        const first = await page.request.post(apiUrl('/api/onboarding/roster/acknowledge'), {
            headers: auth,
        });
        expect(first.status()).toBe(200);
        const firstBody = await first.json();
        expect(firstBody.acknowledgedAt).not.toBeNull();

        const second = await page.request.post(apiUrl('/api/onboarding/roster/acknowledge'), {
            headers: auth,
        });
        expect(second.status()).toBe(200);
        const secondBody = await second.json();
        // Acknowledging twice is harmless, and must not move "when you met
        // your agents" every time the panel is reopened.
        expect(secondBody.acknowledgedAt).toBe(firstBody.acknowledgedAt);
    });
});
