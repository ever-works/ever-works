import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { enablePluginViaAPI } from './helpers/plugins';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Account data export — COMPLEX, cross-feature INTEGRATION flows for
 * `GET /api/account/export` and its export→import/preview round-trip.
 *
 * Gap analysis (surveyed sibling specs that touch this surface so we do
 * NOT duplicate them):
 *   - account-data.spec.ts          → shallow: 200 + JSON + truthy body, 401 unauth.
 *   - download-export.spec.ts       → content-type/disposition smoke across 3 exports.
 *   - audit-export-sanitization.spec.ts → no bcrypt/argon2/scrypt hash in account export.
 *   - usage-export-pii-isolation.spec.ts → usage-export (NOT account export) cross-tenant.
 *   - flow-work-export-roundtrip / flow-work-import-export → WORK-level git export, not account.
 *   - flow-data-sync-* → GitHub sync push/pull, not the download export contract.
 * NONE of them assert the FULL account-export envelope shape, the
 * versioned v1→v2 payload-tail contract, the includeSecrets MASKED:
 * round-trip (real secret bytes absent), the populated-account fan-out
 * (works + plugins + agents all appearing), or the export→import/preview
 * round-trip. Those are the uncovered flows below.
 *
 * PROBED, TRUTHFUL contract (verified via curl vs http://127.0.0.1:3100
 * before any assertion — controller: apps/api/src/account/account.controller.ts,
 * service: packages/agent/src/account-transfer/account-export.service.ts):
 *   - GET /api/account/export
 *       → 200, Content-Type: application/json; charset=utf-8
 *       → Content-Disposition: attachment; filename="account-export.json"
 *       → X-Content-Type-Options: nosniff
 *       → body { version:1|2, exportedAt:<ISO>, includesSecrets:boolean,
 *                data:{ profile:{username,email,avatar?}, works:[], userPlugins:[] } }
 *       → no auth / bogus bearer → 401.  POST → 404 (GET-only).  HEAD → 200.
 *   - Query toggles (all `=== 'true'` string compares server-side):
 *       includeSecrets=true  → includesSecrets:true; userPlugin.secretSettings
 *                              present but every value masked `MASKED:abc***wxyz`
 *                              (the REAL secret bytes NEVER appear).
 *       (default)            → userPlugin entries omit `secretSettings` entirely.
 *       includeAgents=true   → version bumps to 2, data.agents:[{ __kind:'agent', … }].
 *       (default no toggles) → version 1, data keys EXACTLY profile/works/userPlugins.
 *   - The export carries NO password / passwordHash / salt / hash keys ANYWHERE,
 *     even with includeSecrets=true (probed: grep count 0).
 *   - POST /api/account/import/preview <export-body> → 200 validation envelope
 *       { valid, errors:[], version, includesSecrets, hasMaskedSecrets,
 *         profile, workCount, totalItemCount, userPluginCount, conflicts:[],
 *         missingPlugins:[] }.  empty {} → 400.  no auth → 401.
 *   - A freshly-enabled secret-bearing user plugin (e.g. tavily apiKey) is the
 *     cleanest way to seed a maskable secret into the export.
 *
 * Cross-spec isolation: every flow runs on a FRESH registerUserViaAPI()
 * user (a user-scoped plugin secret must NOT shadow the shared seeded
 * user's env key). The seeded user (storageState) is used ONLY for the
 * UI-driven render assertion. Unique suffixes everywhere; assertions
 * tolerate pre-existing rows (toContain / >= , never exact counts on
 * shared state).
 */

const EXPORT_PATH = `${API_BASE}/api/account/export`;
const TIMEOUT = 25_000;

/** A real-looking secret we can grep for verbatim — must NEVER appear in the export. */
function fakeSecret(): string {
    return `sk-LIVE-${Date.now().toString(36)}-abcdefghijklmnop12345`;
}

/** Fetch + parse the account export for a bearer, asserting the JSON envelope. */
async function fetchExport(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; body: string; json: any; headers: Record<string, string> }> {
    const res = await request.get(`${EXPORT_PATH}${query}`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    const status = res.status();
    const headers = res.headers();
    const body = await res.text();
    let json: any = null;
    try {
        json = JSON.parse(body);
    } catch {
        /* leave null — caller asserts status first */
    }
    return { status, body, json, headers };
}

test.describe('Account data export — contract, secrets, populated fan-out, auth gate', () => {
    // ── Flow 1 ────────────────────────────────────────────────────
    // The export envelope is a stable, versioned JSON download whose
    // `data.profile` mirrors the registered user. Pins the full shape,
    // the attachment headers, and the nosniff guard in one walk.
    test('Flow 1: export envelope shape + headers mirror the authenticated user', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const { status, json, headers, body } = await fetchExport(request, u.access_token);
        expect(status, `export status ${status} body=${body.slice(0, 200)}`).toBe(200);

        // Download headers — application/json + attachment filename + nosniff.
        expect(headers['content-type'] || '', 'content-type').toMatch(/application\/json/i);
        expect(headers['content-disposition'] || '', 'content-disposition').toMatch(/attachment/i);
        expect(headers['content-disposition'] || '', 'filename').toMatch(/account-export\.json/i);
        expect(headers['x-content-type-options'] || '', 'nosniff').toMatch(/nosniff/i);

        // Envelope top-level contract.
        expect(json, 'parseable JSON envelope').toBeTruthy();
        expect(json.version, 'fresh account → v1 envelope').toBe(1);
        expect(typeof json.exportedAt, 'exportedAt is a string').toBe('string');
        expect(Number.isNaN(Date.parse(json.exportedAt)), 'exportedAt is a valid ISO date').toBe(
            false,
        );
        expect(json.includesSecrets, 'no includeSecrets toggle → false').toBe(false);

        // data.* contract — the user's identity is faithfully echoed.
        expect(json.data, 'data present').toBeTruthy();
        expect(json.data.profile, 'profile present').toBeTruthy();
        expect(json.data.profile.email, 'profile email matches registered user').toBe(u.email);
        expect(typeof json.data.profile.username, 'profile username is a string').toBe('string');
        expect(Array.isArray(json.data.works), 'works is an array').toBe(true);
        expect(Array.isArray(json.data.userPlugins), 'userPlugins is an array').toBe(true);
        // A fresh account has no works / plugins yet.
        expect(json.data.works.length, 'fresh works empty').toBe(0);
        expect(json.data.userPlugins.length, 'fresh userPlugins empty').toBe(0);

        // A v1 envelope carries EXACTLY the v1 data keys — no surprise tail.
        expect(Object.keys(json.data).sort(), 'v1 data keys').toEqual(
            ['profile', 'userPlugins', 'works'].sort(),
        );
    });

    // ── Flow 2 ────────────────────────────────────────────────────
    // The export must never leak a real credential. Enable a
    // secret-bearing user plugin, then prove: (a) without the toggle
    // `secretSettings` is omitted; (b) with includeSecrets=true the
    // value is MASKED: and the REAL secret bytes are nowhere in the
    // payload; (c) no password/hash field appears either way.
    test('Flow 2: includeSecrets masks plugin secrets — real bytes never exported', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const secret = fakeSecret();

        // tavily exposes a `secretSettings.apiKey` — cleanest maskable secret.
        await enablePluginViaAPI(request, u.access_token, 'tavily', {
            secretSettings: { apiKey: secret },
        });

        // (a) Default export: secretSettings stripped entirely, never present.
        const plain = await fetchExport(request, u.access_token);
        expect(plain.status).toBe(200);
        expect(plain.json.includesSecrets, 'default includesSecrets false').toBe(false);
        const plainTavily = (plain.json.data.userPlugins as any[]).find(
            (p) => p.pluginId === 'tavily',
        );
        expect(plainTavily, 'tavily user-plugin present in export').toBeTruthy();
        expect('secretSettings' in plainTavily, 'default export omits secretSettings').toBe(false);
        expect(plain.body.includes(secret), 'real secret absent from default export').toBe(false);

        // (b) includeSecrets=true: secretSettings present but MASKED.
        const withSecrets = await fetchExport(request, u.access_token, '?includeSecrets=true');
        expect(withSecrets.status).toBe(200);
        expect(withSecrets.json.includesSecrets, 'includesSecrets flag true').toBe(true);
        const maskedTavily = (withSecrets.json.data.userPlugins as any[]).find(
            (p) => p.pluginId === 'tavily',
        );
        expect(maskedTavily, 'tavily present in secret export').toBeTruthy();
        expect(maskedTavily.secretSettings, 'secretSettings present when toggled').toBeTruthy();
        const maskedValue = String(maskedTavily.secretSettings.apiKey ?? '');
        expect(maskedValue, 'apiKey value is masked').toMatch(/^MASKED:/);
        // The crux: the REAL secret bytes must NOT appear anywhere in the body.
        expect(
            withSecrets.body.includes(secret),
            'real secret leaked into includeSecrets export',
        ).toBe(false);

        // (c) Neither variant carries a password / hash field.
        for (const variant of [plain.body, withSecrets.body]) {
            expect(
                /passwordHash|"password"|"salt"|\$2[aby]?\$\d{2}\$|\$argon2/i.test(variant),
                'export must not carry password/hash material',
            ).toBe(false);
        }
    });

    // ── Flow 3 ────────────────────────────────────────────────────
    // A populated account fans out into the export: a created work, an
    // enabled user plugin, and (v2 tail) an agent must all surface in
    // the SAME export when their toggles are set. Proves the export is
    // not a stub — it reflects real owned resources.
    test('Flow 3: populated account exports works + plugins + agents (v2 tail)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        const work = await createWorkViaAPI(request, u.access_token, {
            name: `export-fanout-${stamp}`,
            slug: `export-fanout-${stamp}`,
        });
        await enablePluginViaAPI(request, u.access_token, 'tavily', {
            secretSettings: { apiKey: fakeSecret() },
        });
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `ExportAgent ${stamp}`,
        });

        // Default (no agent toggle) → still v1; work + plugin already present.
        const v1 = await fetchExport(request, u.access_token);
        expect(v1.status).toBe(200);
        expect(v1.json.version, 'no agent toggle → still v1').toBe(1);
        expect(work.id, 'work created with an id').toBeTruthy();
        const workSlugsV1 = (v1.json.data.works as any[]).map((w) => w.slug);
        expect(workSlugsV1, 'created work appears in export').toContain(`export-fanout-${stamp}`);
        const pluginIdsV1 = (v1.json.data.userPlugins as any[]).map((p) => p.pluginId);
        expect(pluginIdsV1, 'enabled plugin appears in export').toContain('tavily');
        // v1 envelope must NOT carry an agents tail.
        expect('agents' in v1.json.data, 'v1 export has no agents tail').toBe(false);

        // includeAgents=true → version bumps to 2 and the agent surfaces.
        const v2 = await fetchExport(
            request,
            u.access_token,
            '?includeAgents=true&includeSkills=true&includeTasks=true',
        );
        expect(v2.status).toBe(200);
        expect(v2.json.version, 'agent present → version bumps to 2').toBe(2);
        expect(Array.isArray(v2.json.data.agents), 'data.agents is an array').toBe(true);
        expect(v2.json.data.agents.length, 'at least the created agent').toBeGreaterThanOrEqual(1);
        // Every exported agent self-identifies via the discriminant.
        for (const a of v2.json.data.agents) {
            expect(a.__kind, 'agent tail discriminant').toBe('agent');
        }
        // The work + plugin are STILL present in the v2 envelope (additive tail).
        const workSlugsV2 = (v2.json.data.works as any[]).map((w) => w.slug);
        expect(workSlugsV2, 'work still present in v2 envelope').toContain(
            `export-fanout-${stamp}`,
        );
        // The just-created agent's slug/name is somewhere in the agents tail body.
        expect(
            JSON.stringify(v2.json.data.agents).includes(agent.slug) ||
                JSON.stringify(v2.json.data.agents).includes(`ExportAgent ${stamp}`),
            'created agent identifiable in tail',
        ).toBe(true);
    });

    // ── Flow 4 ────────────────────────────────────────────────────
    // The export is strictly auth-gated AND single-tenant. Anonymous /
    // bogus bearers get 401; the export contains ONLY the caller's own
    // data — a second user's email/id never appears in the first
    // user's export, even though both live in the shared in-memory DB.
    test('Flow 4: export is auth-gated and never leaks another tenant', async ({ request }) => {
        // Auth gate — no token and a bogus token both 401.
        const anon = await request.get(EXPORT_PATH, { timeout: TIMEOUT });
        expect(anon.status(), 'unauth export → 401').toBe(401);
        const bogus = await request.get(EXPORT_PATH, {
            headers: authedHeaders('not-a-real-token.aaa.bbb'),
            timeout: TIMEOUT,
        });
        expect(bogus.status(), 'bogus bearer → 401').toBe(401);

        // Two distinct tenants, each with an identity-marked work.
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const bStamp = Date.now().toString(36);
        await createWorkViaAPI(request, bob.access_token, {
            name: `bob-secret-${bStamp}`,
            slug: `bob-secret-${bStamp}`,
        });

        const aliceExport = await fetchExport(request, alice.access_token);
        expect(aliceExport.status).toBe(200);
        // Alice's export is HER profile — not Bob's.
        expect(aliceExport.json.data.profile.email, 'alice export = alice profile').toBe(
            alice.email,
        );
        // Bob's email / user id / work slug must be nowhere in Alice's bytes.
        expect(
            aliceExport.body.toLowerCase().includes(bob.email.toLowerCase()),
            "alice export leaked bob's email",
        ).toBe(false);
        const bobId = bob.user?.id;
        if (bobId) {
            expect(aliceExport.body.includes(bobId), "alice export leaked bob's user id").toBe(
                false,
            );
        }
        expect(
            aliceExport.body.includes(`bob-secret-${bStamp}`),
            "alice export leaked bob's work slug",
        ).toBe(false);
    });

    // ── Flow 5 ────────────────────────────────────────────────────
    // Round-trip: an account export, fed verbatim back into
    // /import/preview, validates cleanly and the preview's summary
    // counts reconcile with what the export actually contained. Closes
    // the export→import loop end-to-end on a populated account.
    test('Flow 5: export → import/preview round-trip validates + reconciles counts', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        await createWorkViaAPI(request, u.access_token, {
            name: `rt-work-${stamp}`,
            slug: `rt-work-${stamp}`,
        });
        await enablePluginViaAPI(request, u.access_token, 'tavily', {
            secretSettings: { apiKey: fakeSecret() },
        });

        // Export WITH masked secrets so the preview reports hasMaskedSecrets.
        const exp = await fetchExport(request, u.access_token, '?includeSecrets=true');
        expect(exp.status).toBe(200);
        const exportedWorkCount = (exp.json.data.works as any[]).length;
        const exportedPluginCount = (exp.json.data.userPlugins as any[]).length;
        expect(exportedWorkCount, 'export has the created work').toBeGreaterThanOrEqual(1);
        expect(exportedPluginCount, 'export has the enabled plugin').toBeGreaterThanOrEqual(1);

        // Feed the EXACT export body back into the preview endpoint.
        const preview = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: authedHeaders(u.access_token),
            data: exp.json,
            timeout: TIMEOUT,
        });
        expect(preview.status(), `preview status ${preview.status()}`).toBe(200);
        const pv = await preview.json();

        expect(pv.valid, 'self-export previews as valid').toBe(true);
        expect(Array.isArray(pv.errors) && pv.errors.length === 0, 'no preview errors').toBe(true);
        expect(pv.version, 'preview echoes export version').toBe(exp.json.version);
        expect(pv.includesSecrets, 'preview echoes includesSecrets').toBe(true);
        // A masked-secret export must be flagged for the user to re-enter creds.
        expect(pv.hasMaskedSecrets, 'masked secrets flagged in preview').toBe(true);
        // Summary counts reconcile with the export payload.
        expect(pv.workCount, 'preview workCount reconciles').toBe(exportedWorkCount);
        expect(pv.userPluginCount, 'preview userPluginCount reconciles').toBe(exportedPluginCount);
        expect(pv.profile?.email, 'preview profile = exporter email').toBe(u.email);
        expect(Array.isArray(pv.conflicts), 'conflicts is an array').toBe(true);

        // import/preview is itself auth-gated and rejects empty bodies.
        const emptyAnon = await request.post(`${API_BASE}/api/account/import/preview`, {
            data: {},
            timeout: TIMEOUT,
        });
        expect(emptyAnon.status(), 'preview unauth → 401').toBe(401);
        const emptyAuthed = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: authedHeaders(u.access_token),
            data: {},
            timeout: TIMEOUT,
        });
        expect(emptyAuthed.status(), 'preview empty body → 400').toBe(400);
    });

    // ── Flow 6 ────────────────────────────────────────────────────
    // Method + idempotency surface: the export is a GET-only,
    // side-effect-free download. Two consecutive exports return
    // byte-identical `data` (only `exportedAt` differs), POST is not
    // routed (404), and HEAD mirrors the GET status without a body.
    test('Flow 6: export is GET-only, idempotent, side-effect-free', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        await createWorkViaAPI(request, u.access_token, {
            name: `idem-${stamp}`,
            slug: `idem-${stamp}`,
        });

        // POST to the export route is not a valid method → 404 (GET-only controller).
        const post = await request.post(EXPORT_PATH, {
            headers: authedHeaders(u.access_token),
            timeout: TIMEOUT,
        });
        expect(post.status(), 'POST /export not routed → 404').toBe(404);

        // HEAD mirrors GET auth/status (200 for the owner) without a JSON
        // body. NestJS maps HEAD→GET (probed: 200); tolerate 204/404 in
        // case the dev router doesn't auto-register the HEAD verb. The
        // load-bearing assertion is simply "never a 5xx, never a 401".
        const head = await request.head(EXPORT_PATH, {
            headers: authedHeaders(u.access_token),
            timeout: TIMEOUT,
        });
        expect(head.status(), `HEAD status ${head.status()}`).toBeLessThan(500);
        expect(head.status(), 'HEAD with valid bearer is not unauthorized').not.toBe(401);

        // Two back-to-back exports: `data` must be byte-identical (read is a
        // pure projection); only the `exportedAt` timestamp may move.
        const first = await fetchExport(request, u.access_token);
        const second = await fetchExport(request, u.access_token);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(
            JSON.stringify(second.json.data),
            'export data is stable across reads (no side effects)',
        ).toBe(JSON.stringify(first.json.data));
        // The export never mutated the account: the work count is unchanged.
        expect(
            (second.json.data.works as any[]).length,
            'work count unchanged after repeated export',
        ).toBe((first.json.data.works as any[]).length);
        // And the projection actually reflects the created work both times.
        for (const e of [first, second]) {
            expect(
                (e.json.data.works as any[]).map((w) => w.slug),
                'created work present in each read',
            ).toContain(`idem-${stamp}`);
        }
    });
});

test.describe('Account data export — UI surface (seeded auth)', () => {
    // ── Flow 7 (UI) ──────────────────────────────────────────────
    // The /settings/data page renders the export controls the API
    // contract backs: an "Export Data" action, the includeSecrets
    // masking toggle, and its masked-values warning copy. Uses the
    // seeded storageState user (UI-only assertion, no mutation).
    test('Flow 7: settings/data renders export controls + masking warning', async ({
        page,
        baseURL,
    }) => {
        const origin = baseURL ?? 'http://localhost:3000';
        await page.goto(`${origin}/en/settings/data`, { waitUntil: 'domcontentloaded' });

        // The export section advertises the JSON download (i18n copy probed
        // from messages/en.json: exportDescription "Download your account
        // data … as a JSON file").
        const body = page.locator('body');
        await expect(body).toContainText(/export/i, { timeout: 15_000 });

        // The export action button is present and enabled.
        const exportBtn = page
            .getByRole('button', { name: /export data/i })
            .or(page.locator('button').filter({ hasText: /export/i }))
            .first();
        await expect(exportBtn, 'export button visible').toBeVisible({ timeout: 15_000 });
        await expect(exportBtn, 'export button enabled').toBeEnabled({ timeout: 10_000 });

        // The includeSecrets checkbox gates secret masking — toggling it
        // surfaces the masked-values warning (no real secrets ever leave).
        const secretToggle = page.locator('input[type="checkbox"]').first();
        await expect(secretToggle, 'a secrets/feature checkbox exists').toBeVisible({
            timeout: 10_000,
        });
        await secretToggle.check();
        await expect(secretToggle).toBeChecked();
        // The masking warning copy ("masked values") should appear when the
        // secrets toggle is on. Best-effort: assert the warning OR that the
        // page still mentions masking somewhere (LOCAL/CI render divergence).
        const warning = page
            .getByText(/masked value/i)
            .or(page.getByText(/replace them with real credentials/i))
            .first();
        await expect(warning, 'masked-secret warning shown').toBeVisible({ timeout: 10_000 });
    });
});
