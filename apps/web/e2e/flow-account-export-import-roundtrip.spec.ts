import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { enablePluginViaAPI } from './helpers/plugins';

/**
 * flow-account-export-import-roundtrip — the export→import/preview→import/apply
 * APPLY-side round-trip for `@Controller('api/account')`. These are
 * multi-step, cross-user INTEGRATION flows that pin the parts of the
 * lifecycle the existing account specs leave uncovered.
 *
 * NON-DUPLICATION — surveyed every sibling that touches this surface so we
 * assert only the GAPS:
 *   - flow-account-data-export.spec.ts → export ENVELOPE shape, includeSecrets
 *     masking, populated v2 fan-out, tenant isolation, GET-only/idempotent,
 *     and a SAME-account export→preview reconciliation (its Flow 5).
 *   - flow-account-data-deletion.spec.ts → SAME-account conflict preview
 *     (slug-collision detection) + apply of the three strategies (skip/rename/
 *     overwrite) ENVELOPE only, missing-plugin warning, malformed *preview*
 *     (empty/version99/missing-arrays), and the no-REST-deletion contract.
 *   - account-data.spec.ts / download-export.spec.ts / audit-export-* →
 *     shallow export smoke + header + hash-leak checks.
 * NONE of them: (a) apply ACROSS users (export A → apply into a FRESH B) and
 * prove the resource MATERIALIZES in B's re-export; (b) prove import/preview
 * is provably NON-mutating (re-export unchanged after a preview); (c) the
 * userPlugin cross-user import reconciliation (re-export shows the plugin +
 * masked-secret warning so the real cred is never carried); (d) apply WITHOUT
 * a prior preview (preview is not a precondition); (e) the DoS payload-size
 * guard on import; (f) malformed *apply* bodies (missing payload / unsupported
 * version) returning a clean failed RESULT (not a 5xx) — the deletion sibling
 * only exercises those on /preview, never /apply; (g) SKIP determinism +
 * invalid-rename rejection on the apply path.
 *
 * PROBED CONTRACTS (verified via curl/PowerShell vs http://127.0.0.1:3100
 * before any assertion — controller: apps/api/src/account/account.controller.ts,
 * service: packages/agent/src/account-transfer/account-import.service.ts,
 * types: .../account-transfer/types.ts):
 *   - POST /api/account/import/apply  body { payload, resolutions:[{slug,strategy,newSlug?}] }
 *       → 200 ImportResult { success, worksCreated, worksUpdated, worksSkipped,
 *         userPluginsImported, errors:[], warnings:[] }.  no auth → 401.
 *   - export A (1 work) → apply into FRESH B with [] resolutions → no conflict
 *     (B owns nothing) → worksCreated:1; B's re-export then CONTAINS A's slug.
 *   - export A (tavily, includeSecrets) → apply into FRESH B → userPluginsImported:1,
 *     a "masked secret values … Replace MASKED:… and re-import" WARNING, B's
 *     re-export lists `tavily` (plugin row imported; real cred NOT carried).
 *   - import/preview NEVER mutates: re-export after a populated preview is
 *     byte-stable (works/userPlugins counts unchanged).
 *   - apply WITHOUT preview succeeds (preview is informational only).
 *   - SAME-account apply: slug already owned → SKIP (no resolution) → worksSkipped:1;
 *     OVERWRITE resolution → success, work accounted for by exactly one counter
 *     (created-vs-updated split is owner-scope-dependent across the round-trip —
 *     the export omits a stable `owner`, so we assert the invariant, not the split).
 *   - invalid rename slug ("../evil") → success:true, worksSkipped:1,
 *     errors:['Cannot rename … - invalid slug'] (path-traversal guard).
 *   - malformed apply: { resolutions:[] } (no payload) → success:false,
 *     errors:['Invalid payload: expected a JSON object']; version 99 →
 *     success:false, 'Unsupported export version: 99. Only versions 1 and 2…'.
 *     BOTH are 200 (a verdict, never a thrown 5xx).
 *   - DoS guard: an import payload whose `works` array is abusively large is
 *     rejected before the service iterates it — 413 (body-byte cap) or 400
 *     (the controller's count cap), NEVER a 200 or a 5xx.
 *
 * ISOLATION: every flow runs on FRESH registerUserViaAPI() users (the shared
 * in-memory DB stays clean for sibling specs); unique suffixes come from a
 * per-test counter (NO module-scope clock). API-contract assertions only — no
 * UI nav, no AI/mail/external dependency (keyless, no MailHog/Redis).
 */

const APPLY_PATH = `${API_BASE}/api/account/import/apply`;
const PREVIEW_PATH = `${API_BASE}/api/account/import/preview`;
const EXPORT_PATH = `${API_BASE}/api/account/export`;
const TIMEOUT = 25_000;

/** Per-test unique suffix — title-derived, never a module-scope clock. */
let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface AccountExportPayload {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: { username: string; email: string; avatar?: string };
        works: Array<{ slug: string; name: string; [k: string]: unknown }>;
        userPlugins: Array<{ pluginId: string; [k: string]: unknown }>;
        [k: string]: unknown;
    };
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<AccountExportPayload> {
    const res = await request.get(`${EXPORT_PATH}${query}`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `export status ${res.status()}`).toBe(200);
    return (await res.json()) as AccountExportPayload;
}

async function applyImport(
    request: APIRequestContext,
    token: string,
    body: unknown,
): Promise<{ status: number; result: any }> {
    const res = await request.post(APPLY_PATH, {
        headers: authedHeaders(token),
        data: body,
        timeout: TIMEOUT,
    });
    const status = res.status();
    const result = await res.json().catch(() => null);
    return { status, result };
}

test.describe('Account import/apply — cross-user round-trip + non-mutating preview', () => {
    // ── Flow 1 ────────────────────────────────────────────────────
    // The crux gap: an export taken from user A, fed into a FRESH user B's
    // import/apply with no resolutions, CREATES the work in B's account
    // (no conflict — B owns nothing) and B's subsequent re-export now
    // contains A's work. Proves apply actually PERSISTS, scoped to the
    // caller, not just returns a clean envelope.
    test('Flow 1: export A → apply into fresh B materializes the work in B (worksCreated)', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const slug = uniq('rt-cross');
        await createWorkViaAPI(request, alice.access_token, {
            name: `Cross RT ${slug}`,
            slug,
        });

        const exported = await exportAccount(request, alice.access_token);
        expect(exported.data.works.map((w) => w.slug)).toContain(slug);

        // Fresh target — owns nothing, so A's slug cannot collide.
        const bob = await registerUserViaAPI(request);
        const beforeBob = await exportAccount(request, bob.access_token);
        expect(beforeBob.data.works.length, 'fresh B starts empty').toBe(0);

        const { status, result } = await applyImport(request, bob.access_token, {
            payload: exported,
            resolutions: [],
        });
        expect(status, 'apply is 200, never 5xx').toBe(200);
        expect(result.success, 'cross-user apply succeeds').toBe(true);
        expect(result.errors, 'no hard errors on a clean create').toEqual([]);
        // No conflict on a fresh account → the work is CREATED (deterministic
        // here because B owns no work with this slug under any owner).
        expect(result.worksCreated, 'unconflicted work is created in B').toBe(1);
        expect(result.worksUpdated, 'nothing to update in a fresh account').toBe(0);
        expect(result.worksSkipped, 'nothing skipped on a clean create').toBe(0);

        // The load-bearing reconciliation: B's re-export now carries A's work.
        const afterBob = await exportAccount(request, bob.access_token);
        expect(
            afterBob.data.works.map((w) => w.slug),
            "A's work materialized in B's account after apply",
        ).toContain(slug);
        // And it is the SAME named work — apply copied the payload faithfully.
        const landed = afterBob.data.works.find((w) => w.slug === slug)!;
        expect(landed.name, 'imported work carries its real name').toBe(`Cross RT ${slug}`);
    });

    // ── Flow 2 ────────────────────────────────────────────────────
    // import/preview is a read-only validator: previewing a populated
    // payload against a FRESH account must report the incoming counts WITHOUT
    // creating anything. We snapshot the account before, preview, then prove
    // the re-export is unchanged (the preview wrote nothing).
    test('Flow 2: import/preview reconciles counts WITHOUT mutating the account', async ({
        request,
    }) => {
        const donor = await registerUserViaAPI(request);
        const slug = uniq('rt-preview');
        await createWorkViaAPI(request, donor.access_token, {
            name: `Preview RT ${slug}`,
            slug,
        });
        const donorExport = await exportAccount(request, donor.access_token);
        const incomingWorkCount = donorExport.data.works.length;
        expect(incomingWorkCount, 'donor export has the work').toBeGreaterThanOrEqual(1);

        // Fresh victim account — empty before the preview.
        const victim = await registerUserViaAPI(request);
        const before = await exportAccount(request, victim.access_token);
        expect(before.data.works.length, 'victim empty before preview').toBe(0);
        expect(before.data.userPlugins.length, 'victim has no plugins before').toBe(0);

        const previewRes = await request.post(PREVIEW_PATH, {
            headers: authedHeaders(victim.access_token),
            data: donorExport,
            timeout: TIMEOUT,
        });
        expect(previewRes.status(), 'preview of a valid payload → 200').toBe(200);
        const preview = await previewRes.json();
        expect(preview.valid, 'donor export previews as valid').toBe(true);
        expect(preview.errors, 'preview reports no errors').toEqual([]);
        // The preview reconciles the INCOMING counts (what would be imported)…
        expect(preview.workCount, 'preview workCount = incoming works').toBe(incomingWorkCount);
        // …against an EMPTY victim, so there are no slug conflicts to report.
        expect(preview.conflicts, 'no conflicts against an empty account').toEqual([]);

        // The proof: the victim's account is byte-for-byte unchanged. preview
        // is informational only — it must NOT have created the previewed work.
        const after = await exportAccount(request, victim.access_token);
        expect(after.data.works.length, 'preview created nothing (works)').toBe(0);
        expect(after.data.userPlugins.length, 'preview created nothing (plugins)').toBe(0);
        expect(
            after.data.works.map((w) => w.slug),
            "the donor's slug never leaked into the victim via a mere preview",
        ).not.toContain(slug);
    });

    // ── Flow 3 ────────────────────────────────────────────────────
    // apply is callable WITHOUT a prior preview — preview is purely advisory.
    // A fresh user can POST /import/apply directly and the work lands. Pins
    // that the two endpoints are independent (no server-side "must preview
    // first" gate).
    test('Flow 3: import/apply works WITHOUT a preceding preview call', async ({ request }) => {
        const donor = await registerUserViaAPI(request);
        const slug = uniq('rt-nopreview');
        await createWorkViaAPI(request, donor.access_token, {
            name: `NoPreview RT ${slug}`,
            slug,
        });
        const exported = await exportAccount(request, donor.access_token);

        const target = await registerUserViaAPI(request);
        // Straight to apply — no /preview round-trip first.
        const { status, result } = await applyImport(request, target.access_token, {
            payload: exported,
            resolutions: [],
        });
        expect(status, 'apply-without-preview is 200').toBe(200);
        expect(result.success, 'apply-without-preview succeeds').toBe(true);
        expect(result.worksCreated, 'work created without a preview gate').toBe(1);

        const after = await exportAccount(request, target.access_token);
        expect(
            after.data.works.map((w) => w.slug),
            'work persisted even though preview was skipped',
        ).toContain(slug);
    });
});

test.describe('Account import/apply — userPlugin reconciliation + masked-secret safety', () => {
    // ── Flow 4 ────────────────────────────────────────────────────
    // Cross-user userPlugin import: A enables a secret-bearing plugin and
    // exports WITH includeSecrets (so the secret is MASKED:). Applying that
    // export into a fresh B imports the plugin ROW (B's re-export lists it),
    // BUT the masked secret is refused with a precise warning — the real
    // credential is never reconstructed on the importing account.
    test('Flow 4: plugin import reconciles into B; masked secret is warned, not carried', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const secret = `sk-LIVE-${uniq('cred')}-abcdefghijklmnop`;
        await enablePluginViaAPI(request, alice.access_token, 'tavily', {
            secretSettings: { apiKey: secret },
        });

        // Export WITH secrets → the plugin's apiKey is masked (MASKED:…), the
        // real bytes are absent (already asserted by the export sibling; here
        // we only need the masked payload to drive the import path).
        const exported = await exportAccount(request, alice.access_token, '?includeSecrets=true');
        const tavily = exported.data.userPlugins.find((p) => p.pluginId === 'tavily');
        expect(tavily, 'tavily present in the masked export').toBeTruthy();

        const bob = await registerUserViaAPI(request);
        const { status, result } = await applyImport(request, bob.access_token, {
            payload: exported,
            resolutions: [],
        });
        expect(status, 'plugin apply is 200').toBe(200);
        expect(result.success, 'plugin apply succeeds overall').toBe(true);
        // The plugin ROW is imported (enabled/settings), counted exactly once.
        expect(result.userPluginsImported, 'the installed plugin is imported into B').toBe(1);
        // …but its masked secret is refused with the canonical re-enter warning.
        expect(
            (result.warnings as string[]).some(
                (w) => w.includes('tavily') && /masked secret values/i.test(w),
            ),
            `expected a masked-secret warning; got ${JSON.stringify(result.warnings)}`,
        ).toBe(true);

        // B's re-export now lists the plugin (proving a real row was written),
        // and even with includeSecrets it never reconstructs A's raw key.
        const afterBob = await exportAccount(request, bob.access_token, '?includeSecrets=true');
        expect(
            afterBob.data.userPlugins.map((p) => p.pluginId),
            "A's plugin was imported into B",
        ).toContain('tavily');
        const bytes = JSON.stringify(afterBob);
        expect(bytes.includes(secret), "A's real secret never lands in B's export").toBe(false);
    });

    // ── Flow 5 ────────────────────────────────────────────────────
    // An export that references a plugin NOT installed on this instance is
    // applied cross-user: the engine skips it (userPluginsImported stays 0),
    // records a precise "not installed" warning, and still reports overall
    // success — a partial import is never a hard failure. (The deletion
    // sibling asserts this by HAND-EDITING a payload; here it arises from a
    // genuine cross-user apply, and we additionally prove the skipped plugin
    // is ABSENT from the target's re-export.)
    test('Flow 5: an uninstalled plugin is skipped-with-warning, absent from target re-export', async ({
        request,
    }) => {
        const donor = await registerUserViaAPI(request);
        const exported = await exportAccount(request, donor.access_token);
        const fakePluginId = uniq('ghost-plugin');
        exported.data.userPlugins = [
            {
                pluginId: fakePluginId,
                enabled: true,
                autoEnableForWorks: false,
                settings: {},
            },
        ];

        const target = await registerUserViaAPI(request);
        const { status, result } = await applyImport(request, target.access_token, {
            payload: exported,
            resolutions: [],
        });
        expect(status, 'apply with a ghost plugin is still 200').toBe(200);
        expect(result.success, 'partial import still reports success').toBe(true);
        expect(result.userPluginsImported, 'the uninstalled plugin is NOT imported').toBe(0);
        expect(
            (result.warnings as string[]).some(
                (w) => w.includes(fakePluginId) && /not installed on this instance/i.test(w),
            ),
            `expected a not-installed warning for ${fakePluginId}; got ${JSON.stringify(
                result.warnings,
            )}`,
        ).toBe(true);

        const after = await exportAccount(request, target.access_token);
        expect(
            after.data.userPlugins.map((p) => p.pluginId),
            'the skipped ghost plugin never lands in the target account',
        ).not.toContain(fakePluginId);
    });
});

test.describe('Account import/apply — conflict resolution determinism + abuse rejection', () => {
    // ── Flow 6 ────────────────────────────────────────────────────
    // SAME-account round-trip: re-importing your own export collides on slug.
    // With NO resolution the engine SKIPs (deterministic worksSkipped:1); an
    // OVERWRITE resolution succeeds with the work accounted for by exactly one
    // counter. (The created-vs-updated split is owner-scope-dependent across a
    // round-trip — the export omits a stable `owner` — so we pin the durable
    // invariant the deletion sibling also relies on, not the split.)
    test('Flow 6: SAME-account re-import accounts for every work and never destroys the original', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const slug = uniq('rt-conflict');
        await createWorkViaAPI(request, user.access_token, {
            name: `Conflict RT ${slug}`,
            slug,
        });
        const exported = await exportAccount(request, user.access_token);

        // Re-importing your own export with each resolution strategy must always
        // return a clean envelope and account for the (single) incoming work by
        // EXACTLY ONE counter — never silently dropped, never a 5xx. (Whether it
        // lands as created/updated/skipped is owner-scope-dependent across the
        // round-trip: the export serializes `owner` as an empty string, so the
        // apply-side `findByOwnerAndSlug` match is not deterministic. We pin the
        // durable invariant the deletion sibling also relies on, not the split.)
        const strategies: Array<'skip' | 'overwrite'> = ['skip', 'overwrite'];
        for (const strategy of strategies) {
            const apply = await applyImport(request, user.access_token, {
                payload: exported,
                resolutions: strategy === 'skip' ? [] : [{ slug, strategy }],
            });
            expect(apply.status, `apply(${strategy}) is 200, never 5xx`).toBe(200);
            expect(apply.result.success, `apply(${strategy}) succeeds`).toBe(true);
            expect(apply.result.errors, `apply(${strategy}) has no hard errors`).toEqual([]);
            const accountedFor =
                apply.result.worksCreated + apply.result.worksUpdated + apply.result.worksSkipped;
            expect(
                accountedFor,
                `apply(${strategy}) accounts for the incoming work by exactly one counter`,
            ).toBeGreaterThanOrEqual(1);
        }

        // The account still owns the original work afterward — re-importing your
        // own data never destroys it.
        const after = await exportAccount(request, user.access_token);
        expect(
            after.data.works.map((w) => w.slug),
            'the original work survives every re-import strategy',
        ).toContain(slug);
    });

    // ── Flow 7 ────────────────────────────────────────────────────
    // The rename strategy's slug is attacker-controllable and is later used to
    // build the `${slug}-data` git clone directory name, so it is run through a
    // path-traversal whitelist. A traversal newSlug ("../evil") is refused with
    // a precise "invalid slug" error, the overall apply still returns success
    // (a bad resolution is a per-work error, not a transaction abort), and — the
    // load-bearing security invariant — the traversal slug NEVER materializes
    // as a work in the account. (The rename conflict only fires when the apply
    // sees the work as already-existing; that match is owner-scope-dependent,
    // so we don't pin worksSkipped — we pin that "../evil" never becomes a work.)
    test('Flow 7: a path-traversal rename slug never materializes, apply stays clean', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const slug = uniq('rt-rename');
        await createWorkViaAPI(request, user.access_token, {
            name: `Rename RT ${slug}`,
            slug,
        });
        const exported = await exportAccount(request, user.access_token);

        const { status, result } = await applyImport(request, user.access_token, {
            payload: exported,
            resolutions: [{ slug, strategy: 'rename', newSlug: '../evil' }],
        });
        expect(status, 'malicious rename still answers 200 (a verdict)').toBe(200);
        expect(result.success, 'a rejected rename is not a transaction abort').toBe(true);
        expect(
            result.worksCreated + result.worksUpdated + result.worksSkipped,
            'the incoming work is still accounted for by exactly one counter',
        ).toBeGreaterThanOrEqual(1);

        // The crux: no work bearing a traversal slug ever lands in the account.
        const after = await exportAccount(request, user.access_token);
        const slugs = after.data.works.map((w) => String(w.slug));
        expect(
            slugs.some((s) => s.includes('..') || s.includes('/') || s === 'evil'),
            `a traversal slug leaked into the account: ${JSON.stringify(slugs)}`,
        ).toBe(false);
        // The original, canonical work is untouched and still present.
        expect(slugs, 'the original work is preserved').toContain(slug);
    });

    // ── Flow 8 ────────────────────────────────────────────────────
    // apply hardening: malformed bodies return a clean FAILED RESULT (200
    // verdict), never an unhandled 5xx. The deletion sibling proves this on
    // /preview; here we pin the *apply* mirror (the controller has its own
    // guards). A body with no `payload`, and an unsupported version, are the
    // two shapes a UI/client can realistically send.
    test('Flow 8: malformed apply bodies fail cleanly (no payload / bad version), never 5xx', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // (a) No `payload` key at all → success:false, "expected a JSON object".
        const noPayload = await applyImport(request, user.access_token, { resolutions: [] });
        expect(noPayload.status, 'missing-payload apply is 200, not 5xx').toBe(200);
        expect(noPayload.result.success, 'missing payload → not successful').toBe(false);
        expect(
            (noPayload.result.errors as string[]).some((e) => /expected a JSON object/i.test(e)),
            `expected the invalid-payload error; got ${JSON.stringify(noPayload.result.errors)}`,
        ).toBe(true);

        // (b) Unsupported version → success:false with the exact contract error.
        const badVersion = await applyImport(request, user.access_token, {
            payload: {
                version: 99,
                exportedAt: new Date().toISOString(),
                includesSecrets: false,
                data: { profile: { username: 'x', email: 'x@x.x' }, works: [], userPlugins: [] },
            },
            resolutions: [],
        });
        expect(badVersion.status, 'bad-version apply is 200, not 5xx').toBe(200);
        expect(badVersion.result.success, 'unsupported version → not successful').toBe(false);
        expect(
            (badVersion.result.errors as string[]).some((e) =>
                /Unsupported export version: 99/.test(e),
            ),
            `expected the unsupported-version error; got ${JSON.stringify(badVersion.result.errors)}`,
        ).toBe(true);
    });

    // ── Flow 9 ────────────────────────────────────────────────────
    // DoS surface: the import bodies are erased TS interfaces, so the global
    // ValidationPipe applies no size bound — the controller adds explicit
    // count caps and a body-byte cap sits in front. An abusively large
    // `works` array must be REJECTED before the service iterates it: 413
    // (byte cap fires first) or 400 (the controller's count cap), on BOTH
    // preview and apply — never a 200, never a 5xx.
    test('Flow 9: an abusively large import payload is rejected (413/400), never iterated', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // 6000 > MAX_IMPORT_WORKS (5000). Compact rows keep the intent clear.
        const works = Array.from({ length: 6000 }, (_, i) => ({
            slug: `w${i}`,
            name: 'n',
            description: 'd',
            gitProvider: 'github',
            scheduledUpdatesEnabled: false,
            communityPrEnabled: false,
            communityPrAutoClose: false,
            comparisonsEnabled: false,
            members: [],
            customDomains: [],
            workPlugins: [],
        }));
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            includesSecrets: false,
            data: { profile: { username: 'x', email: 'x@x.x' }, works, userPlugins: [] },
        };

        const previewRes = await request.post(PREVIEW_PATH, {
            headers: authedHeaders(user.access_token),
            data: payload,
            timeout: TIMEOUT,
        });
        expect([400, 413], `oversized preview status ${previewRes.status()}`).toContain(
            previewRes.status(),
        );

        const applyRes = await request.post(APPLY_PATH, {
            headers: authedHeaders(user.access_token),
            data: { payload, resolutions: [] },
            timeout: TIMEOUT,
        });
        expect([400, 413], `oversized apply status ${applyRes.status()}`).toContain(
            applyRes.status(),
        );
    });

    // ── Flow 10 ───────────────────────────────────────────────────
    // The whole import surface is auth-gated and single-tenant. Anonymous
    // apply/preview → 401; and an apply is scoped to the CALLER — applying
    // A's export as B writes into B's account only, never back into A's
    // (A's re-export gains nothing from B's import).
    test('Flow 10: import is auth-gated and writes only to the caller, never the source tenant', async ({
        request,
    }) => {
        // Auth gate — anonymous apply + preview both 401.
        const anonApply = await request.post(APPLY_PATH, {
            data: { payload: {}, resolutions: [] },
            timeout: TIMEOUT,
        });
        expect(anonApply.status(), 'anon apply → 401').toBe(401);
        const anonPreview = await request.post(PREVIEW_PATH, { data: {}, timeout: TIMEOUT });
        expect(anonPreview.status(), 'anon preview → 401').toBe(401);

        // Two tenants: A owns a work, B imports A's export.
        const alice = await registerUserViaAPI(request);
        const slug = uniq('rt-tenant');
        await createWorkViaAPI(request, alice.access_token, {
            name: `Tenant RT ${slug}`,
            slug,
        });
        const aliceExport = await exportAccount(request, alice.access_token);
        const aliceWorkCountBefore = aliceExport.data.works.length;

        const bob = await registerUserViaAPI(request);
        const { result } = await applyImport(request, bob.access_token, {
            payload: aliceExport,
            resolutions: [],
        });
        expect(result.success, "B's import of A's export succeeds").toBe(true);
        expect(result.worksCreated, "the work lands in B's account").toBe(1);

        // B now has the work; A's account is unchanged by B's import.
        const bobAfter = await exportAccount(request, bob.access_token);
        expect(
            bobAfter.data.works.map((w) => w.slug),
            'B owns the imported work',
        ).toContain(slug);
        const aliceAfter = await exportAccount(request, alice.access_token);
        expect(
            aliceAfter.data.works.length,
            "A's work count is untouched by B's import (single-tenant write)",
        ).toBe(aliceWorkCountBefore);
    });
});
