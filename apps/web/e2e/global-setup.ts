import { test as setup, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TEST_USER } from './helpers/test-user';
import { registerViaAPI, loginViaAPI } from './helpers/auth';
import {
    createOrganization,
    newWebhookSecret,
    putTriggerEmptyBagConfig,
    putTriggerWebhookConfig,
    registerSeedUser,
} from './helpers/api-seed';
import { writeSeed, SEED_PATH } from './helpers/seed';

const authFile = 'e2e/.auth/user.json';
const credentialsFile = 'e2e/.auth/test-user.json';

/**
 * Global setup: create a test user and save authenticated browser state.
 *
 * Authenticated tests reuse this state so they don't need to log in individually.
 */
setup('authenticate', async ({ page, baseURL }) => {
    // Dev-mode compilation of the dashboard route on first hit can take a
    // long time, and step 7 below additionally pre-compiles the heavy
    // dashboard routes (10-25s EACH on a cold runner), so the whole setup
    // needs a very generous budget.
    setup.setTimeout(600_000);

    // 0. EW-743 Phase A — seed two tenants against the live API so the
    //    webhook receiver spec runs against real fixtures instead of
    //    skipping every case. The first tenant carries a resolvable
    //    `webhookSecret` bag (covers the 11 "happy path" cases); the
    //    second tenant has NO job-runtime config (covers the 12th case:
    //    "tenant exists but webhookSecret bag absent → 401"). Best-effort:
    //    on any failure we log and continue — every spec self-skips when
    //    its required env/seed is missing, so a degraded API never blocks
    //    the rest of the suite. The seed file is the single source of
    //    truth specs read via `loadSeed()`.
    const apiBase = process.env.API_URL || 'http://localhost:3100';
    try {
        const primaryUser = await registerSeedUser(apiBase, 'primary');
        const primaryTenant = await createOrganization(apiBase, primaryUser, 'primary');
        const webhookSecret = newWebhookSecret();
        await putTriggerWebhookConfig(apiBase, primaryTenant, webhookSecret);

        let tenantIdNoSecret: string | undefined;
        let secondaryUserMeta: { email: string; password: string; username: string } | undefined;
        try {
            const secondaryUser = await registerSeedUser(apiBase, 'secondary');
            const secondaryTenant = await createOrganization(apiBase, secondaryUser, 'secondary');
            // EW-743 — the webhook spec's "tenant exists but
            // webhookSecret bag absent → 401" case needs a config row
            // with a resolvable secret ref whose bag does NOT carry
            // `webhookSecret`. Without this PUT the secondary tenant
            // has no config at all and the controller returns 404
            // instead of the fail-closed 401. Best-effort: a degraded
            // call here only loses the 401 case (the spec falls back
            // to skipping when TENANT_ID_NO_SECRET is absent).
            try {
                await putTriggerEmptyBagConfig(apiBase, secondaryTenant);
            } catch (err) {
                console.warn(
                    `[e2e global-setup] secondary empty-bag config skipped (${(err as Error).message}). ` +
                        `Webhook spec's "no-secret" case will report a 404 vs 401 mismatch.`,
                );
            }
            tenantIdNoSecret = secondaryTenant.tenantId;
            secondaryUserMeta = {
                email: secondaryUser.email,
                password: secondaryUser.password,
                username: secondaryUser.username,
            };
        } catch (err) {
            console.warn(
                `[e2e global-setup] secondary tenant seed skipped (${(err as Error).message}). ` +
                    `Webhook spec's "no-secret" case will skip itself.`,
            );
        }

        writeSeed({
            apiBase,
            tenantId: primaryTenant.tenantId,
            webhookSecret,
            tenantIdNoSecret,
            primaryUser: {
                email: primaryUser.email,
                password: primaryUser.password,
                username: primaryUser.username,
            },
            secondaryUser: secondaryUserMeta,
            generatedAt: new Date().toISOString(),
        });
        console.log(
            `[e2e global-setup] seeded tenants: primary=${primaryTenant.tenantId}` +
                (tenantIdNoSecret ? `, no-secret=${tenantIdNoSecret}` : '') +
                ` → ${SEED_PATH}`,
        );
    } catch (err) {
        console.warn(
            `[e2e global-setup] tenant seed failed (${(err as Error).message}). ` +
                `Webhook + allow-list specs will self-skip. Verify API is up at ${apiBase}.`,
        );
    }

    // 1. Register the user via API (fast). Capture the access token so
    //    we can also lazy-bootstrap a tenant for TEST_USER (step 1b) —
    //    every browser-driven spec that depends on the `chromium`
    //    project's storageState relies on this user, and several
    //    (EW-743 Phase A admin allow-list + 3-mode picker; future
    //    settings/job-runtime) require a tenant context to render at
    //    all. Without the lazy-create, the provider picker doesn't
    //    populate and the operator admin page falls through to the
    //    not-found tree.
    let testUserToken: string | undefined;
    try {
        const registered = await registerViaAPI(baseURL!, TEST_USER);
        testUserToken = registered.access_token;
    } catch {
        // User may already exist from a previous run — try logging in instead
        try {
            const logged = await loginViaAPI(baseURL!, {
                email: TEST_USER.email,
                password: TEST_USER.password,
            });
            testUserToken = logged.access_token;
        } catch {
            // Both register + login failed (API down / throttled). Step 3's
            // UI login flow will surface the real failure and `chromium`
            // specs will fail loudly there instead of skipping silently.
        }
    }

    // 1b. Lazy-bootstrap a tenant for TEST_USER if we got a token. The
    //     dev-mode bootstrap-platform-admin path (EW-743 P? — see
    //     `AuthService.grantPlatformAdminIfBootstrapped`) is what makes
    //     the admin allow-list spec assert against a real admin user.
    //     Best-effort: every artifact already required is written above,
    //     so a degraded API only loses the tenant context for the few
    //     specs that actually need it (they self-skip on lookup failure).
    if (testUserToken) {
        try {
            const apiBaseInner = process.env.API_URL || apiBase;
            const orgRes = await fetch(`${apiBaseInner}/api/organizations`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${testUserToken}`,
                },
                body: JSON.stringify({
                    name: `E2E TestUser Org ${process.pid}`,
                    slug: `e2e-test-user-org-${process.pid}-${Date.now().toString(36)}`,
                }),
            });
            if (!orgRes.ok) {
                console.warn(
                    `[e2e global-setup] TEST_USER organization lazy-create returned ${orgRes.status} — admin/3-mode specs may skip or fall through to the not-found tree.`,
                );
            }
        } catch (err) {
            console.warn(
                `[e2e global-setup] TEST_USER organization lazy-create threw (${(err as Error).message}). Continuing — admin/3-mode specs may degrade.`,
            );
        }
    }

    // 2. Thorough warmup: hit /en/login AND /en so both routes are compiled
    //    by the dev server before we attempt the login flow. The post-login
    //    server-action redirect needs the destination to be ready, otherwise
    //    the browser sits on /en/login while the dev server compiles /en.
    await page.goto('/en/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    await page.goto('/en', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    // 3. Log in via the UI so cookies are properly set by the Next.js server.
    //    Wait for the page (and any Fast Refresh rebuilds) to settle before
    //    interacting with the form, otherwise the submit button can get
    //    re-rendered out from under us in dev mode.
    await page.goto('/en/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);

    await page.locator('input[name="email"]').fill(TEST_USER.email);
    await page.locator('input[name="password"]').fill(TEST_USER.password);
    await page.locator('button[type="submit"]').click();

    // Wait for successful redirect to dashboard. After PR #1052 dropped
    // the URL-level locale prefix (`localePrefix: 'never'`), the legacy
    // `/en/...` paths still 307-redirect to the unprefixed equivalents,
    // so this regex accepts BOTH shapes — `/en/<path>` for any test that
    // happens to land mid-redirect, and the canonical unprefixed
    // `/<path>` for everything else. We anchor at the protocol+host
    // boundary so the path-specific lookahead actually fires against
    // the URL pathname, not a stray substring.
    await page.waitForURL(
        /^https?:\/\/[^/]+(?:\/en)?(\/(?!login|register|forgot|reset|email|auth)|$|\?)/,
        { timeout: 120_000 },
    );

    // Verify we're authenticated
    await expect(page).not.toHaveURL(/\/login/);

    // 3. Pre-dismiss the onboarding wizard so subsequent authenticated tests
    //    aren't blocked by the modal portal intercepting clicks. v2 stores
    //    the dismissed flag on the server (users.onboarding_dismissed_at) so
    //    we POST /api/onboarding/dismiss against the NestJS API directly
    //    (port 3100). The baseURL is :3000 (Next.js) which doesn't proxy
    //    /api routes, so a relative POST would silently 404. The legacy
    //    localStorage key is kept for the few specs still on v1.
    const ONBOARDING_KEY = 'ever-works-onboarding';
    await page.evaluate((key) => {
        try {
            window.localStorage.setItem(
                key,
                JSON.stringify({ step: 0, modalDismissed: true, headerDismissed: true }),
            );
        } catch {
            // localStorage may not be available; tests can dismiss manually.
        }
    }, ONBOARDING_KEY);

    try {
        const loginRes = await fetch(`${apiBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: TEST_USER.email,
                password: TEST_USER.password,
            }),
        });
        if (loginRes.ok) {
            const { access_token } = (await loginRes.json()) as { access_token?: string };
            if (access_token) {
                const dismissRes = await fetch(`${apiBase}/api/onboarding/dismiss`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${access_token}` },
                });
                // If the endpoint exists but rejects the call, surface it.
                // 404 is tolerated (older API builds without v2 wizard route),
                // but anything else means onboarding_dismissed_at stays NULL
                // and the modal will block subsequent Playwright clicks — the
                // exact regression this setup is meant to prevent.
                if (!dismissRes.ok && dismissRes.status !== 404) {
                    console.warn(
                        `[e2e global-setup] onboarding dismiss returned ${dismissRes.status} ${dismissRes.statusText} — wizard may still block clicks`,
                    );
                }
            }
        }
    } catch {
        // Wizard-v2 endpoint may not exist on older API builds — the
        // localStorage shim above keeps the legacy tests green either way.
    }

    // 4. Dismiss the "Connect your GitHub account" modal if it appears, and
    //    record the dismissal in localStorage (key is keyed by userId, so we
    //    have to interact rather than seed it directly).
    const dismissBtn = page.getByRole('button', { name: /I'll do this later/i });
    if (await dismissBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dismissBtn.click();
        await page.waitForTimeout(500);
    }

    // 5. Save the browser state (cookies, localStorage)
    await page.context().storageState({ path: authFile });

    // 6. Persist the TEST_USER credentials so OTHER spec processes can
    //    log in via API with the SAME email/password the setup project
    //    just registered. Without this, every spec that imports
    //    `helpers/test-user.ts` runs a fresh `const suffix =
    //    Date.now().toString(36)` at module load (each worker is its own
    //    Node process), producing a different email — `loginViaAPI`
    //    then 401s with "Invalid email or password". Specs needing a
    //    bearer token import `loadSeededTestUser()` from
    //    `helpers/seeded-test-user.ts` to read this file instead.
    mkdirSync(dirname(credentialsFile), { recursive: true });
    writeFileSync(
        credentialsFile,
        JSON.stringify({ ...TEST_USER, generatedAt: new Date().toISOString() }, null, 2),
        'utf8',
    );

    // 7. Warm up the heavy dashboard routes. The sharded e2e job runs the
    //    web tier under `next dev`, which compiles each route LAZILY on its
    //    first visit — a 10-25s cold compile. The first spec to hit an
    //    un-warmed route can blow past its own navigation timeout, which is
    //    the intermittent "random" flakiness seen on /tasks/new,
    //    /settings/*, /missions and /ideas. Pre-visiting them here — while
    //    the browser is still authenticated (storageState saved in step 5)
    //    so the auth-gated routes actually COMPILE instead of redirecting
    //    to /login — moves that one-time compile into setup, before any
    //    assertions run, so every spec hits an already-warm route.
    //
    //    Best-effort: every artifact above is already written, so a slow or
    //    failing warm-up must NEVER fail setup or block the suite. Each
    //    visit is individually guarded.
    const warmupRoutes = [
        '/en/works',
        '/en/tasks',
        '/en/tasks/new',
        '/en/missions',
        '/en/ideas',
        '/en/skills',
        '/en/agents',
        '/en/activity',
        '/en/plugins',
        '/en/settings',
        '/en/settings/api-keys',
        '/en/settings/security',
        '/en/settings/data',
        '/en/settings/danger',
        '/en/settings/notifications',
        '/en/settings/integrations/channels',
        '/en/works/new',
    ];
    //
    //    Bound the whole loop so it can NEVER blow the 600s setup budget: a
    //    degraded dev server that hangs every route at the per-route timeout
    //    would otherwise accumulate 17 × 60s ≈ 17min and trip
    //    `setup.setTimeout(600_000)` mid-loop — which would fail the entire
    //    setup project (including the already-saved auth artifacts) and block
    //    every dependent spec. So: (a) a 30s per-route cap (cold compile is
    //    ~10-25s; a route that needs more just warms during its first spec,
    //    which has its own 90s budget), and (b) a hard cumulative deadline well
    //    under the setup budget, after which we stop early and log what was
    //    skipped (never a silent truncation). Codex/Greptile P2 on PR #1196.
    const WARMUP_BUDGET_MS = 240_000;
    const warmupDeadline = Date.now() + WARMUP_BUDGET_MS;
    let warmed = 0;
    for (const route of warmupRoutes) {
        if (Date.now() > warmupDeadline) {
            console.warn(
                `[e2e global-setup] warm-up budget (${WARMUP_BUDGET_MS}ms) exhausted after ` +
                    `${warmed}/${warmupRoutes.length} routes; skipping the rest. Auth artifacts ` +
                    `are already saved (steps 5-6); remaining routes warm on first spec hit.`,
            );
            break;
        }
        try {
            await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch {
            // Best-effort warm-up — never block the suite on a slow compile.
        }
        warmed++;
    }
});
