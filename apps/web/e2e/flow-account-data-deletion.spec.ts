import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-account-data-deletion — Account data lifecycle: export → import
 * (with the real slug-conflict resolution engine) → deletion contract.
 *
 * These are multi-step, cross-feature INTEGRATION flows, NOT single-endpoint
 * smoke probes. Every shape below was confirmed against the LIVE API before
 * the assertions were written. The surface comes from:
 *   - apps/api/src/account/account.controller.ts (@Controller('api/account'))
 *   - packages/agent/src/account-transfer/{account-export,account-import}.service.ts
 *   - packages/agent/src/account-transfer/types.ts (AccountExportPayload,
 *     ImportPreview, ImportResult, ConflictResolution, MASKED_SECRET_PREFIX)
 *   - apps/web/src/components/settings/DangerZone.tsx + actions/settings.ts
 *
 * VERIFIED LIVE shapes (throwaway users):
 *   GET  /api/account/export
 *        → { version:1, exportedAt, includesSecrets, data:{ profile:{username,email},
 *            works:[], userPlugins:[] } }
 *        Header: Content-Disposition: attachment; filename="account-export.json"
 *        ?includeSecrets=true flips `includesSecrets`; secrets are NEVER raw — they
 *        are masked with the `MASKED:` prefix.
 *   POST /api/account/import/preview  (body = an export payload)
 *        → ImportPreview { valid, errors[], version, includesSecrets, hasMaskedSecrets,
 *            profile, workCount, totalItemCount, userPluginCount,
 *            conflicts:[{slug,existingName,incomingName}], missingPlugins[] }
 *        Empty `{}` body → 400 "Request body is empty".
 *        version!=1 → valid:false, "Unsupported export version: N. Only version 1 is supported."
 *   POST /api/account/import/apply  (body = { payload, resolutions:[{slug,strategy,newSlug?}] })
 *        → ImportResult { success, worksCreated, worksUpdated, worksSkipped,
 *            userPluginsImported, errors[], warnings[] }
 *        A pluginId not installed on this instance →
 *            warnings:["Plugin \"X\" is not installed on this instance, skipping"]
 *
 * DELETION CONTRACT (truthful, environment-adaptive):
 *   There is NO account-deletion REST endpoint — DELETE /api/account,
 *   POST /api/account/delete, POST /api/auth/delete-account, DELETE /api/auth/profile
 *   all 404 (verified live). The /settings/danger UI calls the `deleteAccount()`
 *   server action, which is intentionally a NO-OP guard returning
 *   { success:false, error:"Account deletion is disabled in demo" } — the
 *   account is preserved (a "safety/grace" contract: the destructive action is
 *   double-gated by an exact-email-match confirmation AND disabled server-side).
 *   We assert that real contract: the account is NEVER actually deleted and the
 *   user can still authenticate afterward.
 *
 * Isolation: all API mutations run on FRESH registerUserViaAPI() users so the
 * shared in-memory DB stays clean for sibling specs; the seeded user
 * (storageState) is used only for the UI-driven danger-zone assertion.
 */

const MASKED_SECRET_PREFIX = 'MASKED:';

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        // Login DTO is whitelisted — only {email,password} (passing `name` → 400).
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

interface AccountExportPayload {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: { username: string; email: string; avatar?: string };
        works: Array<{ slug: string; name: string; [k: string]: unknown }>;
        userPlugins: Array<{ pluginId: string; [k: string]: unknown }>;
    };
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; headers: Record<string, string>; body: AccountExportPayload }> {
    const res = await request.get(`${API_BASE}/api/account/export${query}`, {
        headers: authedHeaders(token),
    });
    const status = res.status();
    const headers = res.headers();
    const body = status === 200 ? ((await res.json()) as AccountExportPayload) : (null as never);
    return { status, headers, body };
}

test.describe('flow: account data export — full data-shape contract', () => {
    test('a fresh user exports a v1 payload whose profile + envelope match their real account', async ({
        request,
    }) => {
        // Step 1 — register a brand-new user (clean account, no works/plugins yet).
        const user = await registerUserViaAPI(request);

        // Step 2 — export with no query params → the canonical v1 payload.
        const v1 = await exportAccount(request, user.access_token);
        expect(v1.status, 'export must be 200 for an authenticated user').toBe(200);

        // Step 3 — it is a JSON *download*, not a page: assert the attachment header
        // + content-type the controller hard-codes (@Header Content-Disposition).
        expect(v1.headers['content-type'] || '', 'export is JSON').toMatch(/application\/json/i);
        expect(
            v1.headers['content-disposition'] || '',
            'export must be served as a file download',
        ).toContain('attachment; filename="account-export.json"');

        // Step 4 — envelope shape is exactly the AccountExportPayload contract.
        expect(v1.body.version, 'a clean account exports as v1').toBe(1);
        expect(typeof v1.body.exportedAt, 'exportedAt is an ISO timestamp string').toBe('string');
        expect(Number.isNaN(Date.parse(v1.body.exportedAt)), 'exportedAt parses as a date').toBe(
            false,
        );
        expect(v1.body.includesSecrets, 'default export excludes secrets').toBe(false);

        // Step 5 — the profile inside the export is THIS user's real profile,
        // proving the export is user-scoped (not a global / other-user dump).
        expect(v1.body.data.profile.email, 'exported profile email matches the account').toBe(
            user.email,
        );
        expect(v1.body.data.profile.username, 'exported profile username matches').toBe(user.name);

        // Step 6 — a brand-new account has empty works + plugins collections
        // (arrays, never null), so downstream import readers can iterate safely.
        expect(Array.isArray(v1.body.data.works), 'works is an array').toBe(true);
        expect(Array.isArray(v1.body.data.userPlugins), 'userPlugins is an array').toBe(true);
        expect(v1.body.data.works.length, 'no works yet on a fresh account').toBe(0);

        // Step 7 — opting into secrets flips the flag (?includeSecrets=true). Even
        // so, the platform NEVER exports raw credentials — only `MASKED:` values.
        // A fresh user has no plugins, so just assert the flag flips truthfully.
        const withSecrets = await exportAccount(request, user.access_token, '?includeSecrets=true');
        expect(withSecrets.status, 'secret export still 200').toBe(200);
        expect(withSecrets.body.includesSecrets, 'includeSecrets=true is honored').toBe(true);
    });

    test('export reflects newly created works — create a Work, re-export, see it appear', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Baseline export: zero works.
        const before = await exportAccount(request, user.access_token);
        expect(before.body.data.works.length).toBe(0);

        // Mutate real state: create a Work via the works API.
        const stamp = Date.now().toString(36);
        const slug = `flow-export-work-${stamp}`;
        const created = await createWorkViaAPI(request, user.access_token, {
            name: `Flow Export Work ${stamp}`,
            slug,
        });
        expect(created.id, 'work was created with an id').toBeTruthy();

        // Re-export: the new work must now be present in data.works, scoped to
        // this user. Assert it CONTAINS our slug (tolerate any platform-default
        // rows) rather than an exact count.
        const after = await exportAccount(request, user.access_token);
        const slugs = after.body.data.works.map((w) => w.slug);
        expect(
            slugs,
            `export should include the created work; got ${JSON.stringify(slugs)}`,
        ).toContain(slug);
        const exportedWork = after.body.data.works.find((w) => w.slug === slug)!;
        expect(exportedWork.name, 'exported work carries its real name').toBe(
            `Flow Export Work ${stamp}`,
        );
    });

    test('export is auth-gated — no bearer token → 401, never a data leak', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/account/export`);
        expect(res.status(), 'unauthenticated export must be rejected').toBe(401);
    });
});

test.describe('flow: account merge-conflict — import preview + resolution engine', () => {
    test('round-trip a real Work through export → preview detects the slug conflict → apply resolves it', async ({
        request,
    }) => {
        // Step 1 — fresh user owns exactly one Work.
        const user = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const slug = `flow-merge-${stamp}`;
        await createWorkViaAPI(request, user.access_token, {
            name: `Flow Merge Work ${stamp}`,
            slug,
        });

        // Step 2 — export that account state. This becomes the "incoming" payload
        // we re-import into the SAME account, which guarantees a slug collision.
        const exported = await exportAccount(request, user.access_token);
        expect(exported.body.data.works.map((w) => w.slug)).toContain(slug);

        // Step 3 — preview the import of the same payload. The preview engine
        // detects conflicts by slug (against findByUser) and must surface ours.
        const previewRes = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: authedHeaders(user.access_token),
            data: exported.body,
        });
        expect(previewRes.status(), 'preview of a valid payload is 200').toBe(200);
        const preview = await previewRes.json();

        expect(preview.valid, 'a well-formed v1 payload previews as valid').toBe(true);
        expect(preview.errors, 'no validation errors on a valid payload').toEqual([]);
        expect(preview.version, 'preview echoes the payload version').toBe(1);
        expect(preview.workCount, 'preview counts the incoming works').toBeGreaterThanOrEqual(1);

        // The heart of the merge-conflict contract: the colliding slug is reported
        // with both the existing and incoming names so the UI can prompt the user.
        const conflict = (
            preview.conflicts as Array<{
                slug: string;
                existingName: string;
                incomingName: string;
            }>
        ).find((c) => c.slug === slug);
        expect(conflict, `preview must report the conflict on "${slug}"`).toBeTruthy();
        expect(conflict!.existingName, 'existing name surfaced for the conflict').toBe(
            `Flow Merge Work ${stamp}`,
        );
        expect(conflict!.incomingName, 'incoming name surfaced for the conflict').toBe(
            `Flow Merge Work ${stamp}`,
        );

        // Step 4 — APPLY the import with an explicit OVERWRITE resolution for the
        // conflicting slug. Assert the ImportResult ENVELOPE (success + the five
        // counters + errors/warnings arrays), never a 5xx.
        //
        // Deviation note: the apply path's existing-work lookup is owner-scoped
        // (findByOwnerAndSlug) while the export omits `owner`, so whether a
        // resolved conflict lands as worksUpdated vs worksCreated is not perfectly
        // deterministic across the export round-trip. We therefore assert the
        // stable invariants — clean envelope, no errors, and the work is fully
        // ACCOUNTED FOR by exactly one counter — instead of pinning the
        // created-vs-updated split. (Verified live: success:true, errors:[].)
        const applyRes = await request.post(`${API_BASE}/api/account/import/apply`, {
            headers: authedHeaders(user.access_token),
            data: { payload: exported.body, resolutions: [{ slug, strategy: 'overwrite' }] },
        });
        expect(applyRes.status(), 'apply of a valid payload is 200, never 5xx').toBe(200);
        const result = await applyRes.json();

        expect(result.success, 'apply succeeds').toBe(true);
        expect(result.errors, 'apply produced no hard errors').toEqual([]);
        for (const k of [
            'worksCreated',
            'worksUpdated',
            'worksSkipped',
            'userPluginsImported',
        ] as const) {
            expect(typeof result[k], `ImportResult.${k} is numeric`).toBe('number');
        }
        const accountedFor = result.worksCreated + result.worksUpdated + result.worksSkipped;
        expect(
            accountedFor,
            'the conflicting work must be created, updated, or skipped — never silently dropped',
        ).toBeGreaterThanOrEqual(1);
    });

    test('the three resolution strategies (skip / rename / overwrite) all return a clean ImportResult', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const slug = `flow-strat-${stamp}`;
        await createWorkViaAPI(request, user.access_token, {
            name: `Flow Strategy Work ${stamp}`,
            slug,
        });
        const exported = await exportAccount(request, user.access_token);

        // Apply once per strategy. Each must complete with success:true, no errors,
        // and a numeric counter envelope. (Strategy semantics are unit-tested in
        // the agent package; here we prove the API surface honors all three and
        // never 5xxs on the merge-conflict path.)
        const strategies: Array<{ strategy: 'skip' | 'rename' | 'overwrite'; newSlug?: string }> = [
            { strategy: 'skip' },
            { strategy: 'rename', newSlug: `${slug}-copy-${stamp}` },
            { strategy: 'overwrite' },
        ];

        for (const s of strategies) {
            const res = await request.post(`${API_BASE}/api/account/import/apply`, {
                headers: authedHeaders(user.access_token),
                data: {
                    payload: exported.body,
                    resolutions: [
                        {
                            slug,
                            strategy: s.strategy,
                            ...(s.newSlug ? { newSlug: s.newSlug } : {}),
                        },
                    ],
                },
            });
            expect(res.status(), `apply(${s.strategy}) must not 5xx`).toBe(200);
            const r = await res.json();
            expect(r.success, `apply(${s.strategy}) succeeds`).toBe(true);
            expect(r.errors, `apply(${s.strategy}) has no errors`).toEqual([]);
            expect(
                r.worksCreated + r.worksUpdated + r.worksSkipped,
                `apply(${s.strategy}) accounts for the work`,
            ).toBeGreaterThanOrEqual(1);
        }
    });

    test('import preview rejects malformed payloads with truthful, specific errors', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        // (a) Empty body → clean 400 (controller guard), NOT a 500.
        const emptyRes = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: H,
            data: {},
        });
        expect(emptyRes.status(), 'empty preview body → 400').toBe(400);
        const emptyBody = await emptyRes.json();
        expect(emptyBody.message, 'specific 400 message').toBe('Request body is empty');

        // (b) Unsupported version → 200 but valid:false with the exact contract
        //     error. (The preview is a *validator*, so it answers 200 with a
        //     verdict rather than throwing.)
        const badVersion = {
            version: 99,
            exportedAt: new Date().toISOString(),
            includesSecrets: false,
            data: { profile: { username: 'x', email: 'x@x.x' }, works: [], userPlugins: [] },
        };
        const verRes = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: H,
            data: badVersion,
        });
        expect(verRes.status(), 'version preview still answers 200 with a verdict').toBe(200);
        const verBody = await verRes.json();
        expect(verBody.valid, 'an unsupported version is invalid').toBe(false);
        expect(
            (verBody.errors as string[]).some((e) => /Unsupported export version: 99/.test(e)),
            `expected the unsupported-version error; got ${JSON.stringify(verBody.errors)}`,
        ).toBe(true);

        // (c) Missing required collections → valid:false enumerating each problem.
        const missingArrays = {
            version: 1,
            exportedAt: new Date().toISOString(),
            includesSecrets: false,
            data: { profile: { username: 'x', email: 'x@x.x' } },
        };
        const maRes = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: H,
            data: missingArrays,
        });
        expect(maRes.status()).toBe(200);
        const maBody = await maRes.json();
        expect(maBody.valid, 'a payload missing works/userPlugins is invalid').toBe(false);
        expect(
            (maBody.errors as string[]).some((e) => /works array/i.test(e)),
            'reports the missing works array',
        ).toBe(true);
        expect(
            (maBody.errors as string[]).some((e) => /userPlugins array/i.test(e)),
            'reports the missing userPlugins array',
        ).toBe(true);
    });

    test('a payload referencing an uninstalled plugin → masked-secret + missing-plugin contract', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);
        const exported = await exportAccount(request, user.access_token);

        // Inject a userPlugin whose pluginId is NOT installed on this instance and
        // whose secret value is MASKED (as a real export would carry it).
        const fakePluginId = `totally-fake-plugin-${Date.now().toString(36)}`;
        const payload: AccountExportPayload = {
            ...exported.body,
            includesSecrets: true,
            data: {
                ...exported.body.data,
                userPlugins: [
                    {
                        pluginId: fakePluginId,
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: `${MASKED_SECRET_PREFIX}sk-***abcd` },
                    },
                ],
            },
        };

        // Preview surfaces BOTH the masked-secret flag and the missing plugin so
        // the UI can warn the user to (a) replace MASKED: values and (b) install
        // the plugin before importing.
        const previewRes = await request.post(`${API_BASE}/api/account/import/preview`, {
            headers: H,
            data: payload,
        });
        expect(previewRes.status()).toBe(200);
        const preview = await previewRes.json();
        expect(preview.valid, 'envelope itself is still structurally valid').toBe(true);
        expect(preview.hasMaskedSecrets, 'preview detects the MASKED: secret value').toBe(true);
        expect(
            preview.missingPlugins as string[],
            'preview lists the uninstalled plugin',
        ).toContain(fakePluginId);

        // Applying it does not 5xx: the engine skips the uninstalled plugin and
        // records a precise warning while reporting overall success.
        const applyRes = await request.post(`${API_BASE}/api/account/import/apply`, {
            headers: H,
            data: { payload, resolutions: [] },
        });
        expect(applyRes.status(), 'apply with a missing plugin still 200').toBe(200);
        const result = await applyRes.json();
        expect(result.success, 'apply reports overall success').toBe(true);
        expect(result.userPluginsImported, 'the uninstalled plugin is NOT imported').toBe(0);
        expect(
            (result.warnings as string[]).some(
                (w) => w.includes(fakePluginId) && /not installed on this instance/i.test(w),
            ),
            `expected a "not installed" warning for ${fakePluginId}; got ${JSON.stringify(
                result.warnings,
            )}`,
        ).toBe(true);
    });
});

test.describe('flow: account deletion — danger-zone confirmation + grace/safety contract', () => {
    test('no REST account-deletion endpoint is exposed (all candidate paths 404), so the account survives', async ({
        request,
    }) => {
        // A self-delete endpoint, if it existed, would be a catastrophic surface —
        // confirm the platform exposes NONE of the conventional shapes. (Verified
        // live: every candidate 404s.) The account-transfer controller is
        // export/import/sync only; deletion is intentionally not wired server-side.
        const user = await registerUserViaAPI(request);
        const H = authedHeaders(user.access_token);

        const del = await request.delete(`${API_BASE}/api/account`, { headers: H });
        expect([404, 405]).toContain(del.status());
        const postDelete = await request.post(`${API_BASE}/api/account/delete`, { headers: H });
        expect([404, 405]).toContain(postDelete.status());
        const authDelete = await request.post(`${API_BASE}/api/auth/delete-account`, {
            headers: H,
        });
        expect([404, 405]).toContain(authDelete.status());
        const profileDelete = await request.delete(`${API_BASE}/api/auth/profile`, { headers: H });
        expect([404, 405]).toContain(profileDelete.status());

        // Because nothing deleted the account, the user can still authenticate and
        // re-export their data — the deletion "grace" contract: the account is
        // fully preserved until a real, future deletion path ships.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: user.email, password: user.password },
        });
        expect(login.status(), 'account survives — login still works').toBe(200);
        const reExport = await exportAccount(request, (await login.json()).access_token);
        expect(reExport.status, 'data export still reachable after delete attempts').toBe(200);
        expect(reExport.body.data.profile.email, 'still the same account').toBe(user.email);
    });

    test('danger-zone UI double-gates deletion: destructive button stays disabled until the exact email is typed, then the action is safely refused', async ({
        page,
    }) => {
        const seeded = loadSeededTestUser();

        // Step 1 — open the danger zone (seeded/authenticated via storageState).
        await page.goto('/en/settings/danger', { waitUntil: 'domcontentloaded' });

        // The page is hydration-racey under `next dev`; wait for the destructive
        // affordance to mount with a generous timeout.
        const deleteBtn = page.getByRole('button', { name: /delete my account/i });
        await expect(deleteBtn).toBeVisible({ timeout: 30_000 });

        // Step 2 — reveal the confirmation panel. Retry-to-open to survive the
        // headlessui/dev hydration race where the first click is dropped.
        const confirmInput = page.getByPlaceholder(/enter your email/i);
        await expect(async () => {
            if (!(await confirmInput.isVisible().catch(() => false))) {
                await deleteBtn.click();
            }
            await expect(confirmInput).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 20_000 });

        // Step 3 — the final destructive button must be DISABLED while the typed
        // value does not match the account email (client guard
        // `confirmEmail !== user.email`). This is the first gate.
        const confirmBtn = page.getByRole('button', { name: /yes, delete my account/i });
        await expect(confirmBtn, 'destructive button is gated before any input').toBeDisabled();

        // Typing the WRONG email keeps it disabled.
        await confirmInput.fill('not-the-right-email@example.com');
        await expect(confirmBtn, 'wrong email keeps the button disabled').toBeDisabled();
        await expect(page, 'no navigation occurred on a mismatch').toHaveURL(/\/settings\/danger/);

        // Step 4 — typing the EXACT account email un-gates the button (proving the
        // confirmation is wired to the real, fresh profile email).
        await confirmInput.fill(seeded.email);
        await expect(confirmBtn, 'exact-email match enables the destructive button').toBeEnabled({
            timeout: 10_000,
        });

        // Step 5 — confirm. The SERVER-SIDE grace contract kicks in: the
        // `deleteAccount()` action is intentionally a no-op and returns
        // { success:false, error:"Account deletion is disabled in demo" }, which
        // the UI surfaces as an error toast and DOES NOT navigate to /register.
        await confirmBtn.click();

        // The truthful outcome: deletion is REFUSED. We assert the user stays put
        // on /danger (no redirect to the register page that a *successful* delete
        // would trigger). The error-toast copy is environment/i18n-dependent and
        // transient, so we assert the durable navigation invariant instead.
        await page.waitForTimeout(1_500);
        await expect(
            page,
            'deletion is disabled server-side — the user is NOT redirected to register',
        ).toHaveURL(/\/settings\/danger/);
    });
});
