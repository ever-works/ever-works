/**
 * APW-11 T20 — the App Launcher's `GET /api/me/apps` surface, end to end (ACC-E2E-12).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-E2E-12 — "App Launcher shows the App Work and the Ever platforms (step 7)"**
 * (`docs/specs/features/app-works/ACCEPTANCE.md:592-614`; its own row names this file:
 * "`apps/web/e2e/flow-app-launcher-apps.spec.ts` (created by APW-11 T20; APW-13 references
 * it)"):
 *
 * > - **Given** the launcher enabled and a live App Work (it has an address and a successful
 * >   production deployment),
 * > - **when** the user opens the App Launcher from the dashboard header,
 * > - **then** it lists Ever Works (**You're here**), the Ever platforms from the versioned
 * >   catalog that have an address for this environment, and the App Work by its display
 * >   name with its live address — with no setting changed (App Works default to **Show in
 * >   App Launcher** on, APW-11 FR-19).
 * >
 * > **Assertions.**
 * >
 * > - `GET /api/me/apps` → `200 { items, meta }` with `kind: 'platform'` items for this
 * >   environment's catalog entries and `kind: 'work'` items for exactly the live, exposed
 * >   Works in the active scope that the user can view (APW-11 FR-15–FR-17).
 * > - Hiding and pinning persist through `PUT /api/me/apps/preferences` and a reload and
 * >   write **no** Activity entry (personal arrangement, APW-11 FR-24–FR-29); turning the
 * >   Work-level **Show in App Launcher** off then on (`appLauncherExposed` on
 * >   `PUT /api/works/:id`) records `app.launcher.hidden` then `app.launcher.exposed`, with
 * >   actor and direction and no address (APW-11 FR-21).
 * > - Every tile `href` equals the item's `url` from `GET /api/me/apps` exactly (no query,
 * >   fragment or userinfo); the opened tab has `window.opener === null` and sends no
 * >   referrer; no launcher request carries a credential in its URL (network log)
 * >   (APW-11 FR-30–FR-32).
 *
 * **ACC-11-47** (`ACCEPTANCE.md:1409`) is what the FR-63 case here drives at the API layer:
 * "**Manage apps** past 200 items renders **Showing 200 of {count}** and still reaches every
 * eligible item (FR-62, FR-63)". Its UI half belongs to `app-launcher-manage.spec.ts`; the
 * half that can only be measured against the route is here — the filter narrows the
 * **eligible** set *before* the cap, and `meta.total` is the pre-filter count.
 *
 * ## This file is APW-11's, and Resolution R-22 is why
 *
 * `docs/specs/features/app-works/CONTRACTS.md` §0 Resolution R-22 assigns this file to
 * APW-11 T20; APW-13 T33 **references** it from
 * `apps/web/e2e/flow-app-works-harness-interlocks.spec.ts` and must not create it. T20 also
 * names four sibling specs (`app-launcher-manage`, `app-launcher-exposure`,
 * `app-launcher-keyboard-a11y`, `app-launcher-flag-off`) and a seed helper; those are not
 * this file and are not written here — this is the one ACCEPTANCE E2E-12 names.
 *
 * ## Measured, not assumed (2026-09-19, this worktree)
 *
 * Every claim below was measured against a stack this file's author started, because the
 * shared one other lanes were using (`apps/api/dist/main.js` on 3994) answers `401` on
 * `GET /api/me/apps` — so its launcher switch is on — but `404` on APW-11 T33's seed route
 * (its gate is shut) and `{"catalogVersion":null,…,"platforms":[]}` on
 * `GET /api/app-launcher/platforms` (no catalog). This lane's stack:
 *
 *   `node apps/api/dist/main.js` on **4083** — `NODE_ENV=development`,
 *   `DATABASE_TYPE=sqlite DATABASE_IN_MEMORY=true DATABASE_AUTOMIGRATE=true`,
 *   `EVER_WORKS_APP_LAUNCHER_ENABLED=true`, `E2E_APP_LAUNCHER_SEED=true`,
 *   `EVER_WORKS_APPS_DOMAIN=apps.e2e.local`, `EVER_WORKS_DOMAIN=e2e.local`,
 *   `EVER_WORKS_E2E_FAKES=1`, `EVER_WORKS_PLATFORM_CATALOG_BASE_URL=http://127.0.0.1:4084`
 *   (a fixture catalog serving `ever-works/platforms/main/platforms.json`); the repo's
 *   **prod web build** on **3212** with `API_URL=http://127.0.0.1:4083`.
 *
 * The case's own clauses, and what each measured:
 *
 *   - **A live App Work appears with no setting changed.** `POST /api/e2e/app-launcher/seed`
 *     with `kind: 'app'`, a `managedSubdomain` and one `READY` production deployment answers
 *     `201` with `appLauncherExposed: null`, and the Work is then **listed** — FR-19's
 *     default is on for an App Work, so "no setting changed" is a real state and not a
 *     missing row.
 *   - **A never-deployed Work is not.** The same fixture with `deployments: []` is absent
 *     from the panel read and present in the `includeHidden=true` read as
 *     `manageState: 'notLive'` with `url: null` — so the absence is a judgement about the
 *     Work rather than a read that lists nothing (FR-15).
 *   - **Hiding and pinning are the person's arrangement and write no Activity row.** A save
 *     of `{ visible: false }` + `{ pinned: true }` answers `{ saved, rejected, items }`; the
 *     hidden Work is gone from the panel read and present in the Manage-apps read with
 *     `manageState: 'listed', visible: false`; the pinned one moves to `section: 'pinned'`
 *     first with `pinOrder: 0`. The account's whole Activity list is **identical** before and
 *     after (FR-24–FR-29).
 *   - **Exposure writes exactly the two rows.** `PUT /api/works/:id` with
 *     `{ appLauncherExposed: false }` then `true` answers `200` and leaves
 *     `app.launcher.hidden` then `app.launcher.exposed` in the log, oldest first, each with
 *     `userId` = the member who made the choice and `metadata` exactly
 *     `{ explicit, previousEffective }` (FR-21, ACC-11-16).
 *   - **The cap is a window, not a wall.** With `limit=1`, `GET /api/me/apps` answers one
 *     item, `meta.total` the whole eligible count and `meta.truncated: true`; the items a
 *     one-item window cuts are still reachable by naming them, and `meta.total` never moves
 *     when a filter is applied (FR-63).
 *
 * ## What this file does not prove, stated rather than implied
 *
 *   - **The versioned catalog was not read.** `EVER_WORKS_PLATFORM_CATALOG_BASE_URL` pointed
 *     the API at a local fixture, because the real catalog lives in the private
 *     `ever-works/platforms` repository and no credential for it exists on this host. The
 *     *reader* is exercised — the fixture is fetched over HTTP, validated, its icons inlined,
 *     its omissions reported — but the private repository, its `main` ref and its published
 *     schema version are not.
 *   - **The 200-item boundary was not filled.** The cap was exercised at `limit=1` and at the
 *     route's maximum (`limit=200`) against a handful of eligible items: a real window at
 *     both ends, but not 200+ seeded Works, so "the 201st item is reachable" is proven about
 *     the *mechanism* (filter-before-cap) rather than against a 201-row fixture. ACC-11-47's
 *     own row is the one that fills it.
 *   - **No Activity row was read as another member.** Every actor assertion here is the member
 *     who made the change; ACC-11-11's "visible to a second member" is
 *     `app-launcher-exposure.spec.ts`'s.
 *   - **Nothing here deploys anything.** The "successful production deployment" is T33's
 *     fixture row written through the non-production seed route (APW11-G07): no cluster, no
 *     build, no DNS, no network.
 */
import { test, expect, type APIRequestContext, type Browser, type Request } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { getAppLauncherPlatforms, getMyApps, putMyAppsPreferences } from './helpers/app-works';
import { loginViaUI } from './helpers/auth';

/**
 * One test at a time, for the reason the landed App Works PR-lane specs record
 * (`flow-app-work-fork-lifecycle.spec.ts:101-115`): `playwright.config.ts` sets
 * `fullyParallel: true`, and the browser case below drives a prod-built dashboard whose
 * first-hit render is the slowest thing in this file. In CI the shard already runs
 * `PLAYWRIGHT_WORKERS=1` (`playwright.config.ts:49-53`), where this setting is a no-op. No
 * assertion is weakened by it, and every case would be independent anyway: each registers its
 * own person, and a person's launcher is their own scope (FR-53).
 */
test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// This file's fixtures — the constants the platform spells
// ---------------------------------------------------------------------------

/** `E2eSeedWorkDto.kind`: an App Work, which is the kind FR-19 defaults to on. */
const APP_KIND = 'app';

/** The one deployment state FR-15 counts as "a successful production deployment". */
const READY = 'READY';

/** `work_deployments.environment` for a production row. */
const PRODUCTION = 'production';

/** APW-11 T33's non-production fixture route (404 unless its two-variable gate is open). */
const SEED_PATH = '/api/e2e/app-launcher/seed';

/** FR-63's filter query parameter, as `ListAppLauncherQueryDto` declares it. */
const FILTER_PARAM = 'q';

/** The route's documented maximum window (`APP_LAUNCHER_MAX_ITEMS_RESPONSE`). */
const MAX_WINDOW = 200;

/** A unique, lower-case, DNS-shaped label component for this run. */
function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A managed-subdomain label: `E2E_SEED_HOST_LABEL_PATTERN` wants lower-case labels only. */
function label(prefix: string): string {
    return `${prefix}-${stamp()}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 60);
}

// ---------------------------------------------------------------------------
// The shapes this file reads back
// ---------------------------------------------------------------------------

/** One item of `GET /api/me/apps` (`packages/contracts/src/apps/app-launcher.ts:142-173`). */
interface LauncherItem {
    key: string;
    kind: string;
    section: string;
    name: string;
    description?: string;
    iconDataUri?: string;
    url: string | null;
    host: string | null;
    current?: boolean;
    status?: string;
    workKind?: string;
    chip?: string;
    visible: boolean;
    pinned: boolean;
    pinOrder: number | null;
    order: number;
    manageState: string;
}

/** `GET /api/me/apps` (`packages/contracts/src/apps/app-launcher.ts:183-222`). */
interface LauncherList {
    items: LauncherItem[];
    meta: {
        environment: string;
        catalogVersion: string | null;
        catalogAvailable: boolean;
        scopeKey: string;
        worksTotal: number;
        total: number;
        truncated: boolean;
        pinLimit: number;
        appWorksAvailable: boolean;
    };
}

/** `GET /api/app-launcher/platforms` (`…/app-launcher.ts:276-291`). */
interface PlatformsList {
    catalogVersion: string | null;
    environment: string;
    platforms: LauncherItem[];
}

/** What `POST /api/e2e/app-launcher/seed` answers (T33, `e2e-seed.controller.ts:224-235`). */
interface SeededWork {
    workId: string;
    slug: string;
    kind: string;
    name: string;
    appLauncherExposed: boolean | null;
    managedSubdomain: string | null;
    deployments: Array<{ id: string; state: string; environment: string; website: string | null }>;
    customDomain: { id: string; domain: string; verified: boolean } | null;
}

/** One row of `GET /api/activity-log`, as the launcher assertions read it. */
interface ActivityRow {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    summary: string | null;
    details: unknown;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

/** One registered person, with the token the API wrappers carry. */
interface LaneUser extends RegisteredUser {
    token: string;
}

// ---------------------------------------------------------------------------
// Lane fixtures, through the routes (never the database — APW11-G07)
// ---------------------------------------------------------------------------

/**
 * Register one person for one case, and dismiss onboarding.
 *
 * The dismissal is not cosmetic: the wizard is a portal that intercepts clicks, and the
 * browser case below has to reach the dashboard header. The same call, for the same reason,
 * is in `flow-agent-computer-watch.spec.ts:19-26`.
 *
 * A `429` here is a stack fact rather than a spec finding, so it is re-thrown naming the
 * three variables the PR lane sets. Measured on this lane (2026-09-19): `/api/auth/register`
 * is capped at **5/min** unless the lane raises it (`auth.controller.ts:117-124`), and this
 * file registers one person per case from a single IP — the first run failed at the sixth
 * registration with `ThrottlerException: Too Many Requests` until the API was restarted with
 * the workflow's env.
 */
async function registerLaneUser(request: APIRequestContext, purpose: string): Promise<LaneUser> {
    let user: RegisteredUser;
    try {
        user = await registerUserViaAPI(request, { name: `APW-11 T20 ${purpose} ${stamp()}` });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('(429)')) {
            throw error;
        }
        throw new Error(
            `${message} — STACK: a lane registers many people from a single IP, so the API must ` +
                'run with the e2e.yml auth-throttle env (REGISTER_THROTTLE_LIMIT=100000, ' +
                'LOGIN_THROTTLE_LIMIT=100000, E2E_DISABLE_AUTH_THROTTLE=true), which ' +
                '`.github/workflows/e2e.yml:391-410` sets.',
        );
    }
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(user.access_token),
    });
    expect(
        dismissed.status(),
        `POST /api/onboarding/dismiss answered ${dismissed.status()} — without it the wizard ` +
            'portal intercepts the dashboard header this file drives.',
    ).toBeLessThan(400);
    return { ...user, token: user.access_token };
}

/** One Work fixture, in T33's closed shape. */
interface SeedInput {
    label: string;
    /** The display name; defaults to a run-unique name carrying the label. */
    name?: string;
    /** Whether the fixture gets a `managedSubdomain` at all. */
    managedSubdomain?: boolean;
    deployments?: Array<{
        state: string;
        environment: string;
        website?: string;
        createdAt?: string;
    }>;
    appLauncherExposed?: boolean;
}

/**
 * Seed one Work **through the route** (APW11-G07 — the lane's API runs on an in-memory
 * sqlite, so the test process cannot write the rows, and no e2e helper touches a database).
 *
 * A `404` here is a stack fact rather than a spec finding, so the failure message names the
 * two variables the gate reads (`e2e-seed.controller.ts:156-165`) instead of leaving a reader
 * to guess which lane this file was written for.
 */
async function seedWork(
    request: APIRequestContext,
    token: string,
    input: SeedInput,
): Promise<SeededWork> {
    const body: Record<string, unknown> = {
        kind: APP_KIND,
        name: input.name ?? `APW11 ${input.label} ${stamp()}`,
        deployments: input.deployments ?? [{ state: READY, environment: PRODUCTION }],
    };
    if (input.managedSubdomain !== false) {
        body.managedSubdomain = label(`apw11-${input.label}`);
    }
    if (input.appLauncherExposed !== undefined) {
        body.appLauncherExposed = input.appLauncherExposed;
    }

    const response = await request.post(`${API_BASE}${SEED_PATH}`, {
        headers: authedHeaders(token),
        data: body,
    });
    const text = await response.text();
    expect(
        response.status(),
        `POST ${SEED_PATH} answered ${response.status()} — this lane needs NODE_ENV !== ` +
            `'production' and E2E_APP_LAUNCHER_SEED=true on the API (APW-11 T33); ` +
            `body=${text.slice(0, 300)}`,
    ).toBe(201);
    return JSON.parse(text) as SeededWork;
}

/** The panel read: `GET /api/me/apps`, with FR-63's own query parameters. */
async function readLauncher(
    request: APIRequestContext,
    token: string,
    query: { includeHidden?: boolean; limit?: number; q?: string } = {},
): Promise<LauncherList> {
    const result = await getMyApps(request, {
        token,
        query: {
            includeHidden:
                query.includeHidden === undefined ? undefined : String(query.includeHidden),
            limit: query.limit,
            [FILTER_PARAM]: query.q,
        },
    });
    expect(
        result.status,
        `GET /api/me/apps answered ${result.status} — a 404 means the API runs with ` +
            'EVER_WORKS_APP_LAUNCHER_ENABLED unset (ACC-11-28’s off state); ' +
            `body=${result.text.slice(0, 200)}`,
    ).toBe(200);
    return result.json as LauncherList;
}

/** One Work's tile in a list, or `null` when that Work is not in it. */
function tileOf(list: LauncherList, workId: string): LauncherItem | null {
    return list.items.find((item) => item.key === `work:${workId}`) ?? null;
}

/**
 * The apex this installation derives a managed label under — `EVER_WORKS_APPS_DOMAIN`, else
 * `EVER_WORKS_DOMAIN`, per `managed-host-root.resolver.ts`'s default resolver. `null` when
 * this *test* process was told neither, which is the one case where the exact URL is not
 * asserted and its shape is asserted instead (the API derives it either way).
 */
function managedRoot(): string | null {
    const apps = (process.env.EVER_WORKS_APPS_DOMAIN ?? '').trim();
    if (apps.length > 0) return apps;
    const domain = (process.env.EVER_WORKS_DOMAIN ?? '').trim();
    return domain.length > 0 ? domain : null;
}

/**
 * FR-15/FR-16: the seeded Work must be **listed** in the read under test — that is the case's
 * Given — and when it is not, this reports *why* rather than leaving an absence to be guessed
 * at.
 *
 * The Manage-apps read (`includeHidden=true`) is what makes that possible: it lists not-live
 * and hidden items too, so a Work that is merely absent from the panel read shows up there
 * with the state that kept it off. Measured (2026-09-19): with the API started **without**
 * `EVER_WORKS_APPS_DOMAIN`/`EVER_WORKS_DOMAIN`, a seeded App Work is `notLive` — it has no
 * address, because `managed-host-root.resolver.ts` refuses to invent one — and the failure
 * below names that variable instead of reading like a launcher defect.
 */
async function expectLive(
    request: APIRequestContext,
    token: string,
    list: LauncherList,
    seeded: SeededWork,
): Promise<LauncherItem> {
    const item = tileOf(list, seeded.workId);
    if (item !== null) {
        expect(
            item.manageState,
            `the seeded Work is '${item.manageState}', not 'listed': it needs a READY production ` +
                'deployment AND an address (FR-15), and an App Work’s managed label only has an ' +
                'address when the API runs with EVER_WORKS_APPS_DOMAIN (or EVER_WORKS_DOMAIN) ' +
                `set — \`managed-host-root.resolver.ts\` invents no host. url=${item.url}`,
        ).toBe('listed');
        expect(item.url, 'a listed tile carries its address (FR-16)').not.toBeNull();
        return item;
    }

    const manage = await readLauncher(request, token, { includeHidden: true });
    const behind = tileOf(manage, seeded.workId);
    expect(
        behind?.manageState,
        `work:${seeded.workId} is not in the panel read. Its state in the Manage-apps read is ` +
            'the reason: `notLive` means no READY production deployment, no address, or both — ' +
            'and an App Work’s managed label only has an address when the API runs with ' +
            'EVER_WORKS_APPS_DOMAIN (or EVER_WORKS_DOMAIN) set. `exposureOff` means its FR-19 ' +
            'setting is off, and `undefined` means the Work is not in the seeder’s own scope at all.',
    ).toBe('listed');
    expect(
        item,
        'a `listed` item belongs to the panel read as well — two reads of one Work disagreeing ' +
            'would be a launcher defect rather than a stack one',
    ).not.toBeNull();
    return item as LauncherItem;
}

/** The account's Activity rows, newest first, as the API answers them. */
async function activityRows(request: APIRequestContext, token: string): Promise<ActivityRow[]> {
    const response = await request.get(`${API_BASE}/api/activity-log?limit=100`, {
        headers: authedHeaders(token),
    });
    expect(response.status(), `GET /api/activity-log answered ${response.status()}`).toBe(200);
    const body = (await response.json()) as { activities?: ActivityRow[] };
    return body.activities ?? [];
}

/** `PUT /api/works/:id` with the one field APW-11 T17 writes (FR-19/FR-21). */
async function setExposure(
    request: APIRequestContext,
    token: string,
    workId: string,
    value: boolean | null,
): Promise<void> {
    const response = await request.put(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data: { appLauncherExposed: value },
    });
    const text = await response.text();
    expect(
        response.status(),
        `PUT /api/works/${workId} answered ${response.status()} — an editor may change ` +
            `exposure, and the seeded Work’s owner is an editor of it; body=${text.slice(0, 200)}`,
    ).toBe(200);
}

/** One fresh browser context with no inherited session, so this case logs in for itself. */
async function freshContext(browser: Browser) {
    return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/** A URL parameter that would place a credential in a URL (FR-31). */
const CREDENTIAL_PARAMS = ['token', 'access_token', 'accessToken', 'sessionToken', 'ew_live_'];

/**
 * Why a URL carries a credential, or `null` when it does not.
 *
 * A predicate rather than an inline scan because the browser case asserts a **control**
 * through the same function (a planted URL must be caught): a scan that never fires proves
 * nothing, which is the technique ACC-11-24's Test line requires.
 */
function credentialInUrl(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw, 'http://placeholder.invalid');
    } catch {
        return null;
    }
    if (url.username.length > 0 || url.password.length > 0) {
        return `userinfo in ${url.origin}`;
    }
    for (const [key] of url.searchParams) {
        if (CREDENTIAL_PARAMS.some((name) => name.toLowerCase() === key.toLowerCase())) {
            return `query parameter ${key}`;
        }
    }
    if (/\bew_live_[A-Za-z0-9]/.test(url.pathname)) {
        return 'a live key in the path';
    }
    return null;
}

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the stack the case needs, checked before any case asserts anything
// ---------------------------------------------------------------------------

test('the lane carries the launcher and the non-production seed route (APW-11 T20/T33)', async ({
    request,
}) => {
    // 1. The installation switch. The web resolves it from this route
    //    (`apps/web/src/lib/feature-flags/app-launcher.ts:71-91`), so a `true` here is also
    //    what mounts the header control the browser case presses.
    const config = await request.get(`${API_BASE}/api/config`);
    expect(config.status(), 'GET /api/config').toBe(200);
    const features = ((await config.json()) as { features?: { appLauncherEnabled?: unknown } })
        .features;
    expect(
        features?.appLauncherEnabled,
        'STACK: the API must run with EVER_WORKS_APP_LAUNCHER_ENABLED=true — with it unset ' +
            'every launcher route answers 404 (ACC-11-28) and this file cannot run.',
    ).toBe(true);

    // 2. The session read itself, before any fixture exists: a fresh person has the platform
    //    tiles, no Works, and their own (personal) scope.
    const user = await registerLaneUser(request, 'preflight');
    const empty = await readLauncher(request, user.token);
    expect(
        empty.meta.scopeKey,
        'a bare-Bearer session read is the PERSONAL scope (`helpers/api.ts:83-94`)',
    ).toBe('personal');
    expect(empty.meta.pinLimit, 'APP_LAUNCHER_PIN_LIMIT (FR-25)').toBe(6);
    expect(typeof empty.meta.appWorksAvailable).toBe('boolean');
    expect(
        empty.items.filter((item) => item.kind === 'work'),
        'a person who has seeded nothing has no Work tiles',
    ).toEqual([]);

    // 3. The seed route's gate, measured rather than assumed: with a session and a body
    //    outside the closed fixture shape the route answers 400 when it is mounted, and 404
    //    when the gate is shut (`e2e-seed.controller.ts:177-185`, before the handler).
    const probe = await request.post(`${API_BASE}${SEED_PATH}`, {
        headers: authedHeaders(user.token),
        data: {},
    });
    expect(
        probe.status(),
        'STACK: POST /api/e2e/app-launcher/seed must answer 400 for an empty body — a 404 ' +
            'means the API runs with NODE_ENV=production or E2E_APP_LAUNCHER_SEED unset, and ' +
            'every fixture below would have to be written some other way.',
    ).toBe(400);

    // 4. FR-37's public catalog read, so a stack with no catalog at all is visible here
    //    rather than as a mysteriously short list later.
    const platforms = await getAppLauncherPlatforms(request);
    expect(
        platforms.status,
        `GET /api/app-launcher/platforms answered ${platforms.status} (FR-37)`,
    ).toBe(200);
});

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the read: the live App Work beside the environment's platforms
// ---------------------------------------------------------------------------

test('[ACC-E2E-12 · ACC-11-09] the read lists the live App Work with no setting changed, beside the environment’s platform tiles', async ({
    request,
}) => {
    const user = await registerLaneUser(request, 'listing');
    const seeded = await seedWork(request, user.token, { label: 'listing' });
    expect(
        seeded.appLauncherExposed,
        'FR-19: a Work nobody has touched carries NO explicit exposure — the kind default is on',
    ).toBeNull();

    const list = await readLauncher(request, user.token);

    // The case's own **Given**, asserted first so that a mis-configured stack fails with the
    // sentence that names the variable it needs rather than with a count that reads like a
    // launcher bug (measured: with the apex unset this read answers `worksTotal: 0`).
    const work = await expectLive(request, user.token, list, seeded);

    // `meta` — the facts a client must not re-derive (plan §4.1). `total` is the eligible set
    // counted before the cap (FR-63), and nothing here is truncated.
    expect(
        list.meta.environment,
        'the environment is what this read’s addresses belong to (FR-10)',
    ).toMatch(/^(production|stage|develop)$/);
    expect(list.meta.scopeKey).toBe('personal');
    expect(list.meta.truncated, 'a handful of items is never a truncated answer').toBe(false);
    expect(list.meta.total, 'meta.total counts what the response carries when nothing is cut').toBe(
        list.items.length,
    );
    expect(
        list.meta.worksTotal,
        'FR-4: worksTotal counts the Works this read lists — the one seeded Work',
    ).toBe(1);

    // The platforms. Both reads answer from the same catalog, so they must agree item for
    // item — which is what makes this an assertion about the launcher rather than about the
    // fixture catalog's contents.
    const platforms = await getAppLauncherPlatforms(request, {
        query: { environment: list.meta.environment },
    });
    expect(platforms.status).toBe(200);
    const catalog = platforms.json as PlatformsList;
    expect(catalog.environment).toBe(list.meta.environment);
    expect(
        list.meta.catalogVersion,
        'meta echoes the version of the catalog the read used (S9)',
    ).toBe(catalog.catalogVersion);

    const platformTiles = list.items.filter((item) => item.kind === 'platform');
    const current = platformTiles.filter((item) => item.current === true);
    expect(
        current.length,
        'FR-13: exactly one tile is where the person already is — the self tile, which the ' +
            'controller synthesises when the catalog carries no usable entry for this environment',
    ).toBe(1);
    for (const entry of catalog.platforms) {
        const tile = platformTiles.find((item) => item.key === entry.key);
        expect(
            tile,
            `the catalog entry ${entry.key} must be listed for ${list.meta.environment}`,
        ).toBeDefined();
        expect(tile?.url, `${entry.key}: the address the catalog read reports`).toBe(entry.url);
        expect(tile?.host, `${entry.key}: host travels with the address`).toBe(entry.host);
        expect(tile?.current ?? false, `${entry.key}: the catalog’s own current flag`).toBe(
            entry.current ?? false,
        );
    }
    // The same fact the other way round: the launcher carries no platform the catalog does
    // not have (FR-8 — no list is compiled into the product).
    for (const tile of platformTiles) {
        expect(
            catalog.platforms.some((entry) => entry.key === tile.key),
            `${tile.key} is in the launcher but not in the catalog read`,
        ).toBe(true);
    }

    // The App Work: by display name, with its live address, under `section: 'works'`.
    expect(work.kind).toBe('work');
    expect(work.section).toBe('works');
    expect(work.name, 'FR-57: the tile carries the Work’s display name').toBe(seeded.name);
    expect(work.workKind, 'the tile says what the Work is').toBe(APP_KIND);
    expect(work.visible, 'FR-27: an untouched item is shown').toBe(true);
    expect(work.pinned, 'nothing was pinned').toBe(false);
    expect(work.pinOrder, 'an unpinned item has no rank (FR-26)').toBeNull();

    // FR-16/FR-55: the managed label under the apps apex and nothing else — no path the
    // launcher added, no query, no fragment, no userinfo.
    const url = new URL(work.url as string);
    expect(url.protocol, 'FR-32: only https is opened').toBe('https:');
    expect(url.pathname, 'the launcher adds no path to the address it opens').toBe('/');
    expect(url.search, 'no query is added to an opened address (FR-31)').toBe('');
    expect(url.hash).toBe('');
    expect(url.username, 'no userinfo travels in an address (FR-31)').toBe('');
    expect(url.password).toBe('');
    expect(url.host, 'host travels with the address').toBe(work.host);
    expect(
        url.hostname.startsWith(`${seeded.managedSubdomain}.`),
        `the fixture’s own label is the host’s first label: host=${url.hostname}, ` +
            `label=${seeded.managedSubdomain}`,
    ).toBe(true);
    const root = managedRoot();
    if (root !== null) {
        expect(
            work.url,
            'the exact managed address, derived from the apex this installation uses',
        ).toBe(`https://${seeded.managedSubdomain}.${root}/`);
    }
});

test('[ACC-E2E-12 · FR-15–FR-17] only live, exposed Works are listed — a never-deployed one is notLive behind includeHidden, and another person’s is absent', async ({
    request,
}) => {
    const owner = await registerLaneUser(request, 'liveness');
    const live = await seedWork(request, owner.token, { label: 'live' });
    const neverDeployed = await seedWork(request, owner.token, {
        label: 'never',
        deployments: [],
    });

    const list = await readLauncher(request, owner.token);
    await expectLive(request, owner.token, list, live);
    expect(
        tileOf(list, neverDeployed.workId),
        'FR-15: no successful production deployment is no address, so the Work is not live and ' +
            'is not on the panel — even though it is exposed by default (FR-19)',
    ).toBeNull();

    // The same read with `includeHidden=true` is Manage apps, which lists not-live items too
    // (FR-27/FR-63) — so the absence above is a judgement about the Work, not an empty read.
    const manage = await readLauncher(request, owner.token, { includeHidden: true });
    const behind = tileOf(manage, neverDeployed.workId);
    expect(behind, 'Manage apps lists the not-live Work').not.toBeNull();
    expect(behind?.manageState, 'FR-56: not live is its own state').toBe('notLive');
    expect(behind?.url, 'a tile that is not listed carries no address (FR-16)').toBeNull();
    expect(behind?.host).toBeNull();
    expect(
        behind?.visible,
        'FR-27: nobody hid it — it is simply not live, which is a different fact',
    ).toBe(true);

    // FR-17/FR-53 — one person's launcher never carries another person's Works.
    const stranger = await registerLaneUser(request, 'stranger');
    const theirs = await readLauncher(request, stranger.token);
    expect(
        tileOf(theirs, live.workId),
        'a Work seeded by another person is not in this person’s scope',
    ).toBeNull();
    expect(
        tileOf(theirs, neverDeployed.workId),
        'not even through the Manage-apps read',
    ).toBeNull();
});

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the personal arrangement: hide, pin, and no Activity row
// ---------------------------------------------------------------------------

test('[ACC-E2E-12 · FR-24–FR-29] hiding and pinning persist through the save and write no Activity entry', async ({
    request,
}) => {
    const user = await registerLaneUser(request, 'arrangement');
    const hidden = await seedWork(request, user.token, { label: 'hidden' });
    const pinned = await seedWork(request, user.token, { label: 'pinned' });

    const before = await activityRows(request, user.token);

    const saved = await putMyAppsPreferences(request, {
        token: user.token,
        body: {
            changes: [
                { key: `work:${hidden.workId}`, visible: false },
                { key: `work:${pinned.workId}`, pinned: true },
            ],
        },
    });
    expect(
        saved.status,
        `PUT /api/me/apps/preferences answered ${saved.status}; body=${saved.text.slice(0, 300)}`,
    ).toBe(200);
    const saveBody = saved.json as {
        saved: number;
        rejected: Array<{ key: string; reason: string }>;
    };
    expect(saveBody.saved, 'both changes are the person’s own items').toBe(2);
    expect(saveBody.rejected, 'nothing was refused').toEqual([]);

    // The reload the case asks for: the panel read no longer carries the hidden Work, and the
    // pinned one is in the pinned section at rank 0.
    const panel = await readLauncher(request, user.token);
    expect(
        tileOf(panel, hidden.workId),
        'a hidden item is the person’s arrangement, so the panel does not render it (FR-27)',
    ).toBeNull();
    const pinnedTile = await expectLive(request, user.token, panel, pinned);
    expect(pinnedTile.pinned).toBe(true);
    expect(
        pinnedTile.pinOrder,
        'FR-62: a pin appends after the last pin — and this is the first',
    ).toBe(0);
    expect(pinnedTile.section, 'FR-2: pinned wins over the kind’s section').toBe('pinned');
    expect(panel.items[0]?.key, 'the pinned section sorts first').toBe(`work:${pinned.workId}`);

    // Manage apps still lists the hidden one, with its state intact — that is how it is
    // unhidden.
    const manage = await readLauncher(request, user.token, { includeHidden: true });
    const hiddenTile = tileOf(manage, hidden.workId);
    expect(hiddenTile, 'Manage apps lists a hidden item').not.toBeNull();
    expect(hiddenTile?.visible, 'the stored `false` is resolved onto the item').toBe(false);
    expect(hiddenTile?.manageState, 'it is live and merely hidden — not not-live').toBe('listed');
    expect(
        hiddenTile?.url,
        'a hidden item keeps its address in the Manage-apps read (FR-27)',
    ).not.toBeNull();

    // FR-24–FR-29: the arrangement is personal state, and the Activity log is about the Work.
    const after = await activityRows(request, user.token);
    expect(
        after.map((row) => `${row.action}@${row.createdAt}`),
        'saving a personal arrangement writes NO Activity entry — the log is unchanged',
    ).toEqual(before.map((row) => `${row.action}@${row.createdAt}`));
});

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the exposure toggle (APW-11 T17) and its two Activity rows
// ---------------------------------------------------------------------------

test('[ACC-E2E-12 · ACC-11-16] turning Show in App Launcher off then on records app.launcher.hidden then app.launcher.exposed', async ({
    request,
}) => {
    const user = await registerLaneUser(request, 'exposure');
    const seeded = await seedWork(request, user.token, { label: 'exposure' });

    // Off. FR-19/FR-56: the Work is still live, so its state is `exposureOff`, not `notLive`.
    await setExposure(request, user.token, seeded.workId, false);
    const off = await readLauncher(request, user.token);
    expect(
        tileOf(off, seeded.workId),
        'FR-21: with the Work-level setting off the Work is not on the panel',
    ).toBeNull();
    const offManage = await readLauncher(request, user.token, { includeHidden: true });
    const offTile = tileOf(offManage, seeded.workId);
    expect(offTile?.manageState, 'it is live but not exposed').toBe('exposureOff');
    expect(offTile?.url, 'FR-16: `url` is null exactly when the item is not listed').toBeNull();

    // On again.
    await setExposure(request, user.token, seeded.workId, true);
    await expectLive(request, user.token, await readLauncher(request, user.token), seeded);

    // The two rows, oldest first: the direction is the action, the actor is the member who
    // chose, and the record's own payload carries no address (FR-21, FR-43).
    const rows = (await activityRows(request, user.token)).filter((row) =>
        row.action.startsWith('app.launcher.'),
    );
    expect(
        rows.map((row) => row.action).reverse(),
        'one row per real change, in the order the changes were made',
    ).toEqual(['app.launcher.hidden', 'app.launcher.exposed']);

    const [hidden, exposed] = rows.slice().reverse();
    expect(hidden.userId, 'the actor is the member who made the choice').toBe(user.user.id);
    expect(exposed.userId).toBe(user.user.id);
    expect(hidden.workId, 'the row names the Work it is about').toBe(seeded.workId);
    expect(hidden.actionType, 'APW-11’s Activity type, not a raw action string').toBe(
        'app_launcher',
    );
    expect(hidden.summary).toBe('Show in App Launcher turned off');
    expect(exposed.summary).toBe('Show in App Launcher turned on');

    // "with actor and direction and no address": asserted on the row's OWN payload — what the
    // launcher wrote. (The activity list additionally joins the Work each row is about; that
    // join carries the Work's name and managed label, which is a property of the log's list
    // shape rather than of this record, and it is reported rather than asserted here.)
    const ownPayload = JSON.stringify({
        actionType: hidden.actionType,
        action: hidden.action,
        summary: hidden.summary,
        details: hidden.details,
        metadata: hidden.metadata,
    });
    const needles = [seeded.managedSubdomain, 'https://', 'http://', '.e2e.local'].filter(
        (needle): needle is string => needle !== null,
    );
    expect(
        needles.filter((needle) => ownPayload.includes(needle)),
        `the row’s own payload carries no address: ${ownPayload}`,
    ).toEqual([]);
    expect(hidden.metadata, 'the record’s metadata is exactly the pair FR-61 names').toEqual({
        explicit: true,
        previousEffective: true,
    });
    expect(exposed.metadata).toEqual({ explicit: true, previousEffective: false });
});

// ---------------------------------------------------------------------------
// FR-63 / ACC-11-47 — the cap is a window, and the filter is what opens it
// ---------------------------------------------------------------------------

test('[FR-63 · ACC-11-47] the filter narrows the eligible set before the cap, and meta.total is the pre-filter count', async ({
    request,
}) => {
    const user = await registerLaneUser(request, 'filter');
    // Distinctive names, one of them accented, so the filter's fold (case, accents,
    // substring — `launcher-filter.ts:54-103`) is exercised rather than assumed.
    const seeded: SeededWork[] = [];
    for (const suffix of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
        seeded.push(
            await seedWork(request, user.token, {
                label: `filter-${suffix}`,
                name: `APW11 Filter ${suffix} ${stamp()}`,
            }),
        );
    }
    const accented = await seedWork(request, user.token, {
        label: 'filter-accent',
        name: `Café Réseau ${stamp()}`,
    });
    seeded.push(accented);

    const full = await readLauncher(request, user.token);
    expect(full.meta.truncated, 'the whole eligible set fits in the default window').toBe(false);
    expect(full.items.length).toBe(full.meta.total);
    expect(
        full.items.length,
        'the case needs more than one eligible item for a window to exist at all',
    ).toBeGreaterThan(1);

    // The window at its narrowest: one item out, and the count of everything not shown.
    const window = await readLauncher(request, user.token, { limit: 1 });
    expect(window.items.length, 'limit=1 is a real window').toBe(1);
    expect(window.meta.total, 'FR-63: the count is the eligible set, not the rows returned').toBe(
        full.meta.total,
    );
    expect(window.meta.truncated, 'the answer hit its cap, and says so (FR-34)').toBe(true);

    // The window at the route's maximum (`APP_LAUNCHER_MAX_ITEMS_RESPONSE`).
    const max = await readLauncher(request, user.token, { limit: MAX_WINDOW });
    expect(max.items.length, `limit=${MAX_WINDOW} carries everything this fixture has`).toBe(
        Math.min(full.meta.total, MAX_WINDOW),
    );
    expect(max.meta.truncated).toBe(full.meta.total > MAX_WINDOW);

    // **FR-63's guarantee.** Each seeded Work is named uniquely, so it can be demanded
    // *specifically* from behind a one-item window: the filter narrows the eligible set
    // before the cap, which is the only way the item at the end of a long list is reachable.
    for (const work of seeded) {
        const index = full.items.findIndex((item) => item.key === `work:${work.workId}`);
        expect(index, `${work.name} is in the eligible set`).toBeGreaterThanOrEqual(0);
        const reached = await readLauncher(request, user.token, { limit: 1, q: work.name });
        expect(
            reached.items.map((item) => item.key),
            `?limit=1&${FILTER_PARAM}=${work.name} must reach work:${work.workId} — the filter ` +
                'narrows before the cap (FR-63)',
        ).toEqual([`work:${work.workId}`]);
        expect(
            reached.meta.total,
            'the filter never moves the count FR-63’s “Showing {n} of {count}” line renders',
        ).toBe(full.meta.total);
    }

    // Every eligible item, including the ones a narrow window cut, is reachable by naming it;
    // and a filtered answer is a genuine match rather than the whole list under a cap.
    for (const item of full.items) {
        const reached = await readLauncher(request, user.token, { q: item.name });
        expect(
            reached.items.map((row) => row.key),
            `?${FILTER_PARAM}=${item.name} must carry ${item.key}`,
        ).toContain(item.key);
        expect(
            reached.items.every((row) => row.name.toLowerCase().includes(item.name.toLowerCase())),
            `every row of ?${FILTER_PARAM}=${item.name} is a genuine match, not the whole list ` +
                'under a cap',
        ).toBe(true);
    }

    // The fold: accent-insensitive, case-insensitive, substring.
    const exact = await readLauncher(request, user.token, { q: accented.name });
    const folded = await readLauncher(request, user.token, { q: 'cafe reseau' });
    expect(
        folded.items.map((row) => row.key),
        '`cafe reseau` reaches `Café Réseau` — the fold the browser uses, applied on the server',
    ).toEqual(exact.items.map((row) => row.key));
    const shouted = await readLauncher(request, user.token, { q: accented.name.toUpperCase() });
    expect(
        shouted.items.map((row) => row.key),
        'the filter is case-insensitive',
    ).toEqual(exact.items.map((row) => row.key));
    const substring = await readLauncher(request, user.token, { q: 'cafe' });
    expect(
        substring.items.map((row) => row.key),
        'a substring is enough — the person is reaching an item, not spelling it',
    ).toContain(`work:${accented.workId}`);

    // A filter that matches nothing answers nothing, rather than the whole list — which is
    // the difference between a cleared box and no match (`normalizeLauncherFilter`).
    const nothing = await readLauncher(request, user.token, { q: `no-such-item-${stamp()}` });
    expect(nothing.items).toEqual([]);
    expect(nothing.meta.total, 'the count is about the scope, not about one query').toBe(
        full.meta.total,
    );
    expect(nothing.meta.truncated, 'a short answer that was not cut is not truncated').toBe(false);

    // A cleared filter is the whole list again.
    const cleared = await readLauncher(request, user.token, { q: '   ' });
    expect(
        cleared.items.map((row) => row.key),
        'a blank filter is no filter',
    ).toEqual(full.items.map((row) => row.key));
});

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the panel, the tile href, the opened tab and the request log
// ---------------------------------------------------------------------------

test('[ACC-E2E-12 · FR-30–FR-32] every tile href equals the item url exactly, and the opened tab has no opener, no referrer and no credential in any request URL', async ({
    browser,
    request,
}) => {
    const user = await registerLaneUser(request, 'panel');
    const seeded = await seedWork(request, user.token, { label: 'panel' });
    const item = await expectLive(
        request,
        user.token,
        await readLauncher(request, user.token),
        seeded,
    );

    const context = await freshContext(browser);
    const page = await context.newPage();
    try {
        await loginViaUI(page, { email: user.email, password: user.password });

        // Every request the launcher's own page makes from here on, in order.
        const seen: string[] = [];
        page.on('request', (observed) => seen.push(observed.url()));

        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(
            page.getByTestId('app-launcher-control'),
            'FR-54: the header control is mounted because the installation switch is on — the ' +
                'web resolves the same switch from GET /api/config',
        ).toBeAttached({ timeout: 30_000 });
        await expect(
            page.getByTestId('app-launcher-unavailable'),
            'the @ever-works/app-launcher element chunk must load, or the control is disabled ' +
                'and there is no panel to open',
        ).toHaveCount(0);

        const trigger = page.locator('ever-app-launcher button[aria-haspopup="menu"]');
        await expect(trigger, 'the launcher’s own trigger').toBeVisible({ timeout: 30_000 });
        await trigger.click();

        const tileLink = page.locator(`ever-app-launcher a.tile[data-key="work:${seeded.workId}"]`);
        await expect(tileLink, 'the seeded Work is a tile in the panel').toBeVisible({
            timeout: 30_000,
        });

        // The tile by display name, with its live address.
        await expect(tileLink).toContainText(seeded.name);
        await expect(tileLink).toContainText(item.host as string);

        // FR-30–FR-32, on the element the browser actually opens: the exact stored URL, a new
        // tab, and the two attributes that strip the opener and the referrer.
        await expect(
            tileLink,
            'the tile href IS the item’s url — nothing added, nothing lost',
        ).toHaveAttribute('href', item.url as string);
        await expect(tileLink).toHaveAttribute('target', '_blank');
        await expect(tileLink).toHaveAttribute('rel', /noopener/);
        await expect(tileLink).toHaveAttribute('rel', /noreferrer/);
        await expect(tileLink).toHaveAttribute('referrerpolicy', 'no-referrer');

        // Activate it. The address is a host this lane has no DNS for, so the navigation is
        // intercepted and answered locally — the *request* is what the case is about, and it
        // is captured before anything is served.
        const navigation: { request: Request | null } = { request: null };
        await context.route(
            (url) => url.toString() === item.url,
            async (route) => {
                navigation.request = route.request();
                await route.fulfill({
                    status: 200,
                    contentType: 'text/html',
                    body: '<!doctype html><title>launcher-target</title>opened by the launcher',
                });
            },
        );

        const [popup] = await Promise.all([context.waitForEvent('page'), tileLink.click()]);
        await popup.waitForLoadState('domcontentloaded');

        expect(
            navigation.request?.url() ?? null,
            'the tab was opened at exactly the item’s url (no query, fragment or userinfo)',
        ).toBe(item.url);
        expect(
            navigation.request?.headers()['referer'] ?? null,
            'FR-30: the opened tab sends no referrer',
        ).toBeNull();
        expect(
            await popup.evaluate(() => window.opener === null),
            'FR-30: the opened tab holds no opener reference',
        ).toBe(true);
        expect(
            await popup.evaluate(() => document.referrer),
            'FR-30: and the document reports no referrer',
        ).toBe('');

        // FR-31, over the network log the browser actually produced. The control comes first:
        // a planted credential must be seen AND caught, or this scan is decoration.
        await page.evaluate(() =>
            fetch('/api/health?access_token=planted-by-the-control').catch(() => undefined),
        );
        await expect
            .poll(() => seen.some((url) => url.includes('planted-by-the-control')), {
                message: 'the request observer must see the control request',
            })
            .toBe(true);
        const planted = seen.find((url) => url.includes('planted-by-the-control')) as string;
        expect(
            credentialInUrl(planted),
            'the checker must catch the control it is pointed at',
        ).not.toBeNull();

        // And a control for the observer itself: the panel's own read must be in the log, so
        // an empty log cannot pass this case.
        expect(
            seen.some((url) => url.includes('/api/me/apps')),
            'the panel read is in the log — the scan saw the launcher’s own traffic',
        ).toBe(true);

        const launcherTraffic = seen.filter((url) => !url.includes('planted-by-the-control'));
        const leaks = launcherTraffic
            .map((url) => ({ url, reason: credentialInUrl(url) }))
            .filter((entry) => entry.reason !== null);
        expect(
            leaks,
            `FR-31: no launcher request places a credential in its URL — ${JSON.stringify(leaks)}`,
        ).toEqual([]);
    } finally {
        await context.close();
    }
});
