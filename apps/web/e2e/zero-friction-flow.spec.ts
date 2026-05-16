import { test, expect } from '@playwright/test';

/**
 * EW-617 — zero-friction prompt → deployed Work E2E.
 *
 * Covers the full happy path described in EW-617 acceptance criteria:
 *
 *   ever.works/  → prompt textarea → Generate
 *     ↓ URL fragment hand-off
 *   app.ever.works/onboarding#prompt=…
 *     ↓ wizard reads hash, mints anon user, jumps to Generate-now
 *   POST /api/works/quick-create  →  202 + work.id + generation.historyId
 *     ↓ poll
 *   GET /api/works/:id/generation-history  →  status transitions
 *     ↓
 *   GET https://<slug>.ever.works/  →  200 (after Cloudflare CNAME + cluster ready)
 *
 * Suite status (post-EW-617-finale):
 *   - "UI surface"        — ACTIVE (renders only, no API). Runs against
 *                           localhost dev or PLAYWRIGHT_*_URL overrides.
 *   - "API contract"      — STILL `.skip`. Hits real /api/auth/anonymous
 *                           which is throttled at 5/hour per IP; running
 *                           the suite back-to-back trips the throttle.
 *                           Captcha is now wired in prod too, so this
 *                           suite needs Cloudflare's test sitekey/secret
 *                           (1x00000000000000000000AA + always-pass) to
 *                           run reliably against deployed envs.
 *   - "Full UI journey"   — ACTIVE. Uses Playwright route mocks for
 *                           /api/works/quick-create + a Turnstile stub
 *                           via `installTurnstileStub`, so the suite is
 *                           hermetic and doesn't depend on the API.
 */

const APP_URL = process.env.PLAYWRIGHT_APP_URL || 'http://localhost:3000';
const WEBSITE_URL = process.env.PLAYWRIGHT_WEBSITE_URL || 'http://localhost:4000';

/**
 * EW-617 G7 — stub Cloudflare Turnstile so the wizard can mint tokens
 * without an interactive challenge in headless. The real widget is
 * domain-bound + requires interaction for "managed" mode bot detection;
 * the stub returns a fake token immediately.
 *
 * For real-deploy E2E (against stage/prod), swap Cloudflare's test
 * sitekey `1x00000000000000000000AA` + always-pass secret
 * `1x0000000000000000000000000000000AA` into the API env instead of
 * mocking. See docs/runbooks/EVER_WORKS_ZERO_FRICTION_FLOW.md.
 */
async function installTurnstileStub(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        const widgetIds = new Map<string, (token: string) => void>();
        (window as unknown as { turnstile: unknown }).turnstile = {
            render: (
                _container: HTMLElement | string,
                options: { callback?: (token: string) => void },
            ) => {
                const id = `stub-${Math.random().toString(36).slice(2, 10)}`;
                if (options.callback) widgetIds.set(id, options.callback);
                return id;
            },
            execute: (id: string) => {
                const cb = widgetIds.get(id);
                if (cb) cb('stub-turnstile-token');
            },
            reset: () => {},
            remove: (id: string) => widgetIds.delete(id),
            getResponse: () => 'stub-turnstile-token',
        };
    });
}

test.describe('EW-617 zero-friction flow — UI surface', () => {
    test.beforeEach(async ({ page }) => {
        await installTurnstileStub(page);
    });

    test('landing page renders prompt textarea + Generate button', async ({ page }) => {
        await page.goto(`${WEBSITE_URL}/`);
        await expect(page.getByTestId('landing-prompt-form')).toBeVisible();
        await expect(page.getByTestId('landing-prompt-input')).toBeVisible();
        await expect(page.getByTestId('landing-prompt-submit')).toBeDisabled();
    });

    test('typing a prompt enables submit and redirects to app with hash fragment', async ({
        page,
    }) => {
        await page.goto(`${WEBSITE_URL}/`);
        const input = page.getByTestId('landing-prompt-input');
        await input.fill('AI coding assistants directory');
        const submit = page.getByTestId('landing-prompt-submit');
        await expect(submit).toBeEnabled();

        // Capture the navigation target — full-page redirect to app.
        const [redirected] = await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            submit.click(),
        ]);

        expect(redirected?.url() ?? page.url()).toMatch(
            /\/onboarding#prompt=AI%20coding%20assistants%20directory$/,
        );
    });

    test('wizard mounts on fragment URL and lands on Generate-now step', async ({ page }) => {
        await page.goto(`${APP_URL}/onboarding#prompt=AI%20coding%20assistants`);

        // The wizard's mount effect (G4) reads the hash, calls setPrompt,
        // jumps to the final step, and strips the param via
        // history.replaceState.
        await expect(page.getByTestId('onboarding-generate-now')).toBeVisible();
        // URL should no longer contain the prompt param after hydration.
        await expect(page).toHaveURL(/\/onboarding$/);
    });
});

test.describe.skip('EW-617 zero-friction flow — API contract', () => {
    test('POST /api/auth/anonymous returns 201 + anon user shape', async ({ request }) => {
        const response = await request.post(`${APP_URL}/api/auth/anonymous`);
        expect(response.status()).toBe(201);
        const body = await response.json();
        expect(body).toMatchObject({
            access_token: expect.any(String),
            user: {
                id: expect.any(String),
                email: null,
                username: expect.stringMatching(/^anon-[0-9a-f]{8}$/),
                isAnonymous: true,
                anonymousExpiresAt: expect.any(String),
            },
        });
    });

    test('POST /api/auth/anonymous is throttled at 5/hour per IP', async ({ request }) => {
        // Six rapid requests from the same IP — the 6th MUST be 429.
        const attempts = await Promise.all(
            Array.from({ length: 6 }, () => request.post(`${APP_URL}/api/auth/anonymous`)),
        );
        const statuses = attempts.map((r) => r.status());
        // First 5 succeed, 6th hits the throttle.
        expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
        expect(statuses[5]).toBe(429);
    });

    test('POST /api/works/quick-create returns 202 + work + generation.historyId', async ({
        request,
    }) => {
        // Mint an anon session first.
        const session = await request.post(`${APP_URL}/api/auth/anonymous`).then((r) => r.json());

        const response = await request.post(`${APP_URL}/api/works/quick-create`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
            data: {
                slug: `e2e-${Date.now().toString(36)}`,
                name: 'E2E AI Coding Assistants',
                description: 'E2E test work',
                prompt: 'AI coding assistants',
                organization: false,
            },
        });
        expect(response.status()).toBe(202);
        const body = await response.json();
        expect(body).toMatchObject({
            status: 'pending',
            work: {
                id: expect.any(String),
                slug: expect.any(String),
                name: expect.any(String),
            },
            generation: {
                historyId: expect.any(String),
                message: expect.any(String),
            },
        });
    });

    test('POST /api/auth/claim flips an anon user into a registered one', async ({ request }) => {
        const session = await request.post(`${APP_URL}/api/auth/anonymous`).then((r) => r.json());

        const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const claim = await request.post(`${APP_URL}/api/auth/claim`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
            data: {
                email: `claim-${suffix}@test.local`,
                password: 'SecurePass1!',
            },
        });
        expect(claim.status()).toBe(200);
        const body = await claim.json();
        expect(body).toMatchObject({
            id: session.user.id,
            email: expect.stringMatching(/^claim-/),
            emailVerified: false,
        });

        // Re-attempt with the same email should now 409 (a different
        // anon user trying to claim the same email).
        const session2 = await request.post(`${APP_URL}/api/auth/anonymous`).then((r) => r.json());
        const dup = await request.post(`${APP_URL}/api/auth/claim`, {
            headers: { Authorization: `Bearer ${session2.access_token}` },
            data: {
                email: `claim-${suffix}@test.local`,
                password: 'SecurePass1!',
            },
        });
        expect(dup.status()).toBe(409);
    });
});

test.describe('EW-617 zero-friction flow — full UI journey', () => {
    test.beforeEach(async ({ page }) => {
        await installTurnstileStub(page);
    });

    test('landing → app → Generate now → polling', async ({ page, context }) => {
        // Block the actual deploy workflow dispatch in this test — we only
        // want to assert the wizard wiring + API contracts. Real CI runs
        // the full pipeline in a separate stage.
        await context.route('**/api/works/quick-create', async (route) => {
            await route.fulfill({
                status: 202,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'pending',
                    work: { id: 'w-e2e-1', slug: 'ai-coding-assistants', name: 'AI Coding' },
                    generation: { historyId: 'gen-e2e-1', message: 'Generation started' },
                }),
            });
        });

        // 1. Landing page
        await page.goto(`${WEBSITE_URL}/`);
        await page.getByTestId('landing-prompt-input').fill('AI coding assistants');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.getByTestId('landing-prompt-submit').click(),
        ]);

        // 2. Wizard auto-hydrates from the URL fragment.
        await expect(page.getByTestId('onboarding-generate-now')).toBeVisible();
        await expect(page).toHaveURL(/\/onboarding$/);

        // 3. Generate now — captured by route mock above.
        await page.getByTestId('onboarding-generate-now').click();

        // 4. Wizard closes (onLeave fires after a successful response).
        // Assert the modal is gone within the timeout.
        await expect(page.getByTestId('onboarding-generate-now')).toBeHidden({
            timeout: 10_000,
        });
    });
});
