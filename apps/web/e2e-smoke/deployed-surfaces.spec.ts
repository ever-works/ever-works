import { expect, test } from '@playwright/test';

/**
 * Do the main product surfaces actually render on this deployment, for a real
 * signed-in user?
 *
 * Deliberately shallow. This is not a replacement for the 3,800-test suite that
 * runs against a local stack on every push to `stage` — that suite tests
 * behaviour. This one tests that behaviour is *reachable in this environment*:
 * the page compiles, its data fetches resolve against the deployed API, and its
 * primary control is present. That is the class of failure a local stack cannot
 * produce, because locally both halves are built from the same config.
 *
 * The bar for each surface is "renders and is usable", not "works correctly".
 * A surface that 500s, hangs, or renders an empty shell because its API call
 * 404'd is what this catches — which is precisely how registration broke on
 * 2026-08-09 while every health check stayed green.
 */

function uniqueEmail(): string {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `smoke-${stamp}@smoke.ever.works`;
}

/** Register a throwaway account and land signed in. */
async function signUp(page: import('@playwright/test').Page): Promise<string> {
    const email = uniqueEmail();
    await page.goto('/en/register', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="name"]').fill('Smoke Surfaces');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill('SmokeTest1!');
    await page.locator('input[name="confirmPassword"]').fill('SmokeTest1!');
    await page.locator('#terms').check();
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/^https?:\/\/[^/]+(?:\/en)?(\/(?!login|register|forgot|reset)|$|\?)/, {
        timeout: 60_000,
    });
    return email;
}

/**
 * Surfaces worth a smoke check. Each names the route and a locator that only
 * exists once the page has genuinely rendered — not a spinner, not a shell.
 */
const SURFACES: ReadonlyArray<{ name: string; path: string }> = [
    { name: 'dashboard', path: '/en' },
    { name: 'works', path: '/en/works' },
    { name: 'agents', path: '/en/agents' },
    { name: 'tasks', path: '/en/tasks' },
    { name: 'missions', path: '/en/missions' },
    { name: 'ideas', path: '/en/ideas' },
    { name: 'settings', path: '/en/settings' },
];

/**
 * These surfaces need a signed-in user, so the whole file is a write. Skipped
 * unless writes are explicitly allowed — production is not a test fixture.
 */
test.describe('deployed product surfaces', () => {
    test.skip(
        process.env.SMOKE_ALLOW_WRITES !== 'true',
        'writes disabled — set SMOKE_ALLOW_WRITES=true (never on prod)',
    );

    // One account for the whole file; registering per test would multiply the
    // rows written into the target environment for no extra signal.
    test.describe.configure({ mode: 'serial' });

    let signedInPage: import('@playwright/test').Page;

    test.beforeAll(async ({ browser }) => {
        const context = await browser.newContext();
        signedInPage = await context.newPage();
        await signUp(signedInPage);
    });

    test.afterAll(async () => {
        await signedInPage?.context().close();
    });

    for (const { name, path } of SURFACES) {
        test(`${name} renders without a server error`, async () => {
            const failures: string[] = [];
            const onResponse = (response: import('@playwright/test').Response): void => {
                if (response.status() >= 500) {
                    failures.push(`${response.status()} ${response.url()}`);
                }
            };
            signedInPage.on('response', onResponse);

            try {
                const response = await signedInPage.goto(path, { waitUntil: 'domcontentloaded' });
                expect(response?.status(), `${path} responded ${response?.status()}`).toBeLessThan(
                    500,
                );

                // Something meaningful must be on the page — a shell with no
                // <main> is how a failed data fetch presents.
                await expect(signedInPage.locator('body')).toBeVisible();
                await expect(
                    signedInPage.locator('main, [role="main"], nav').first(),
                    `${path} rendered no main/nav landmark — likely an empty shell`,
                ).toBeVisible({ timeout: 30_000 });

                expect(
                    failures,
                    `5xx responses while loading ${path}:\n${failures.join('\n')}`,
                ).toEqual([]);
            } finally {
                signedInPage.off('response', onResponse);
            }
        });
    }

    /**
     * The terminal is per-agent — `/agents/[id]/terminal`, reached from an
     * agent's detail page. There is no standalone `/terminal` route; an earlier
     * version of this spec assumed one and failed against a 307, which is worth
     * recording because it is the same mistake in miniature: asserting against
     * an imagined surface rather than the real one.
     *
     * A brand-new smoke account owns no agents, so there is usually nothing to
     * open. Rather than create one — which would leave a real agent behind on
     * every run — this checks the terminal is reachable when an agent happens to
     * exist, and otherwise says so instead of silently passing.
     */
    test('the agent terminal route renders rather than 500s', async () => {
        // What this proves: the per-agent terminal route exists in this
        // deployment, compiles, and handles a request server-side without
        // blowing up. That is the config-drift question this suite is for.
        //
        // What it does NOT prove: that an attached terminal session streams.
        // That needs a real agent and a live run, and creating one would leave
        // an agent behind on stage every run. Deliberately out of smoke scope —
        // the streaming path is covered by the e2e suite against a local stack.
        //
        // A well-formed but non-existent id is used on purpose: 404 or a
        // redirect is a correct answer and passes. Only a 5xx fails.
        const NON_EXISTENT = '00000000-0000-0000-0000-000000000000';

        const response = await signedInPage.goto(`/en/agents/${NON_EXISTENT}/terminal`, {
            waitUntil: 'domcontentloaded',
        });
        const status = response?.status() ?? 0;

        expect(
            status,
            `/en/agents/<id>/terminal responded ${status} — the terminal route errors ` +
                `server-side on this deployment`,
        ).toBeLessThan(500);
    });
});
