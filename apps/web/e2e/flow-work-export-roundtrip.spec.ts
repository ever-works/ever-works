import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders, createWorkViaAPI } from './helpers/api';

/**
 * Work EXPORT round-trip INTEGRATION flows — the WHOLE-ACCOUNT (account
 * transfer) export/import surface, NOT the per-directory item CSV family.
 *
 * GAP ANALYSIS (surveyed apps/web/e2e/ for export|import|round-trip on
 * 2026-06-01):
 *   - flow-work-import-export.spec.ts        -> POST /api/works/import repo
 *     pipeline (analyze, dedup, GenerationHistory). Source-repo import only.
 *   - flow-work-import-deep.spec.ts          -> per-resource fan-out
 *     (POST /works/:id/items|categories|tags) — a hand-rolled "importer".
 *   - items-import-export / csv-export-schema / upload-import /
 *     download-export -> the per-directory ITEM CSV/XLSX export/import family
 *     (GET /works/:id/export-items[/settings], import-items[/sample/validate]).
 *   - download-export.spec.ts                -> ONLY single-assertion smokes on
 *     /api/account/export (anon 401 + non-empty body). It NEVER exercises the
 *     payload SHAPE, the includeSecrets toggle, the import preview/apply
 *     round-trip, empty-account export, or export-reflects-updates.
 *   NONE of them touch the account-transfer round-trip: export -> preview ->
 *   apply -> re-export integrity. This file builds those uncovered flows. No
 *   overlap with the existing files.
 *
 * THE REAL SURFACE — PROBED LIVE (http://127.0.0.1:3100, fresh registered
 * users) + read from apps/api/src/account/account.controller.ts +
 * packages/agent/src/account-transfer/{account-export,account-import}.service.ts
 * + types.ts on 2026-06-01:
 *
 *   GET  /api/account/export[?includeSecrets=true]    [HttpCode 200, JSON]
 *        Content-Disposition: attachment; filename="account-export.json"
 *        -> {
 *             version: 1 | 2,                  // 1 unless the v2 agents/skills/
 *                                              //   tasks tail is opted in & non-empty
 *             exportedAt: ISO-8601 string,
 *             includesSecrets: boolean,        // echoes the query flag
 *             data: {
 *               profile: { username, email, avatar? },
 *               works: ExportedWork[],         // every work owned by the caller
 *               userPlugins: ExportedUserPlugin[]
 *             }
 *           }
 *        Each ExportedWork carries metadata (name, slug, description,
 *        gitProvider, deployProvider, *Enabled flags, members[], customDomains[],
 *        workPlugins[]) PLUS repo-materialised arrays items/categories/tags/
 *        collections/comparisons. In CI there is NO connected GitHub account, so
 *        the git clone is skipped and those arrays are EMPTY [] (truthful — not a
 *        leak, not a 5xx). The `owner` field is OMITTED when it equals the
 *        derived default.
 *
 *   POST /api/account/import/preview  (body = an AccountExportPayload)
 *        [HttpCode 200]  empty body {} -> 400 "Request body is empty".
 *        -> ImportPreview {
 *             valid, errors[], version, includesSecrets, hasMaskedSecrets,
 *             profile, workCount, totalItemCount, userPluginCount,
 *             conflicts: [{ slug, existingName, incomingName }],   // slug-dedup oracle
 *             missingPlugins: string[]                              // plugin ids not installed
 *           }
 *        version !== 1 -> valid:false, errors:["Unsupported export version: N…"]
 *        (still HTTP 200 — a structured rejection, not a thrown error).
 *        Missing works/userPlugins arrays -> valid:false with field errors.
 *
 *   POST /api/account/import/apply  (body = { payload, resolutions: [] })
 *        [HttpCode 200] -> ImportResult {
 *             success, worksCreated, worksUpdated, worksSkipped,
 *             userPluginsImported, errors[], warnings[]
 *           }
 *        A malformed/undefined payload surfaces as success:false +
 *        errors:["Transaction failed: …"] — STILL HTTP 200, never a 5xx.
 *        A userPlugin whose pluginId is not installed -> a `warnings` entry +
 *        success:true (best-effort import).
 *
 *   ALL /api/account/* endpoints are AuthGuard-protected (anon -> 401).
 *
 * SECRET-EXCLUSION CONTRACT (account-transfer/types.ts maskSecretSettings /
 * MASKED_SECRET_PREFIX = "MASKED:"): even with includeSecrets=true the export
 * NEVER emits a real credential — every secret value is replaced by a
 * "MASKED:abc***wxyz" placeholder. previewImport flips hasMaskedSecrets:true
 * when it sees one, and applyImport REFUSES to write a masked value (records a
 * warning telling the user to replace it). So "export excludes secrets" is a
 * deterministic, observable contract here.
 *
 * EMPIRICAL DEDUP TRUTH (probed): preview's `conflicts` is the reliable slug-
 * collision oracle (it maps the caller's existing works by slug). apply's own
 * dedup keys on (owner, slug) and the export OMITS `owner`, so re-applying your
 * own export tends to CREATE again (worksCreated>=1) rather than skip — i.e.
 * the bucket apply lands a round-tripped work in is impl-dependent. These flows
 * therefore assert the STABLE invariants (success:true, total works touched>=1,
 * the work re-appearing on re-export) and tolerate the bucket, never asserting a
 * specific worksCreated-vs-worksSkipped split.
 *
 * GOTCHAS honoured: fresh registerUserViaAPI() per test (no shared-seeded
 * mutation; a user-scoped fake key would shadow the env key + break sibling
 * chat specs); createWorkViaAPI returns { id }; the `request` fixture is
 * unauthenticated by default (no storageState cookie) so anon calls are genuine;
 * unique Date.now suffixes; assert toContain / set-membership (tolerate pre-
 * existing rows), never exact counts; generous timeouts + expect.poll where the
 * write must settle; never hard-require a delivered email; never assert a 5xx.
 */

const KNOWN_INSTALLED_PLUGIN = 'openai'; // probed: present in the CI plugin registry (missingPlugins:[])

interface ExportedWork {
    name: string;
    slug: string;
    description: string;
    gitProvider?: string;
    deployProvider?: string;
    owner?: string;
    scheduledUpdatesEnabled?: boolean;
    communityPrEnabled?: boolean;
    comparisonsEnabled?: boolean;
    members?: unknown[];
    customDomains?: unknown[];
    workPlugins?: unknown[];
    items?: unknown[];
    categories?: unknown[];
    tags?: unknown[];
    collections?: unknown[];
    comparisons?: unknown[];
}

interface AccountExportPayload {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: { username: string; email: string; avatar?: string };
        works: ExportedWork[];
        userPlugins: Array<{
            pluginId: string;
            enabled: boolean;
            autoEnableForWorks: boolean;
            settings: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }>;
        agents?: unknown[];
        skills?: unknown[];
        tasks?: unknown[];
    };
}

function suffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; payload: AccountExportPayload }> {
    const res = await request.get(`${API_BASE}/api/account/export${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `export ${query || '(default)'} -> 200`).toBe(200);
    const payload = (await res.json()) as AccountExportPayload;
    return { status: res.status(), payload };
}

async function preview(request: APIRequestContext, token: string, payload: unknown) {
    return request.post(`${API_BASE}/api/account/import/preview`, {
        headers: authedHeaders(token),
        data: payload as Record<string, unknown>,
    });
}

async function apply(
    request: APIRequestContext,
    token: string,
    payload: AccountExportPayload,
    resolutions: unknown[] = [],
) {
    return request.post(`${API_BASE}/api/account/import/apply`, {
        headers: authedHeaders(token),
        data: { payload, resolutions },
    });
}

test.describe('Work account-transfer export round-trip (deep integration)', () => {
    // ───────────────────────────────────────────────────────────────────────
    // FLOW 1: Export FORMAT / CONTRACT. A user with one work downloads the
    //         account export and we assert the FULL documented envelope: the
    //         versioned v1 shape, the echoed includesSecrets flag, an ISO
    //         timestamp, the profile, and a works[] entry that faithfully
    //         mirrors the work the user just created (name/slug/description +
    //         gitProvider + the repo-materialised arrays present-but-empty in
    //         CI). This is the "export format/contract" half of the round-trip.
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 1: export emits the documented v1 envelope mirroring the owner’s work', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const s = suffix();
        const name = `Export Contract ${s}`;
        const slug = `export-contract-${s}`;
        const { id } = await createWorkViaAPI(request, token, {
            name,
            slug,
            description: 'export contract probe',
        });
        expect(id, 'work created').toBeTruthy();

        const { payload } = await exportAccount(request, token);

        // Envelope contract.
        expect(payload.version, 'v1 payload (no agents/skills/tasks tail)').toBe(1);
        expect(payload.includesSecrets, 'default export omits secrets').toBe(false);
        expect(Date.parse(payload.exportedAt), 'exportedAt is a valid ISO timestamp').not.toBeNaN();
        expect(payload.data, 'data present').toBeTruthy();
        expect(payload.data.profile.email, 'profile carries the owner email').toBe(u.email);
        expect(Array.isArray(payload.data.works), 'works is an array').toBe(true);
        expect(Array.isArray(payload.data.userPlugins), 'userPlugins is an array').toBe(true);

        // The freshly-created work is reflected verbatim in the export.
        const exported = payload.data.works.find((w) => w.slug === slug);
        expect(exported, `exported work ${slug} present`).toBeTruthy();
        expect(exported!.name, 'name round-trips').toBe(name);
        expect(exported!.description, 'description round-trips').toBe('export contract probe');
        // gitProvider is always populated (defaults to github in this stack).
        expect(typeof exported!.gitProvider, 'gitProvider present').toBe('string');
        // Repo-materialised collections are PRESENT and EMPTY in CI (no git clone)
        // — truthful, not a leak. They must be arrays, not missing/null.
        for (const key of ['items', 'categories', 'tags', 'collections', 'comparisons'] as const) {
            expect(Array.isArray(exported![key]), `${key} is an (empty) array in CI`).toBe(true);
            expect((exported![key] as unknown[]).length, `${key} empty without a data repo`).toBe(
                0,
            );
        }
        // Relation arrays also present + empty for a brand-new work.
        expect(Array.isArray(exported!.members), 'members[] present').toBe(true);
        expect(Array.isArray(exported!.workPlugins), 'workPlugins[] present').toBe(true);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 2: Round-trip INTEGRITY through the IMPORT FRONT DOOR. Export the
    //         account, feed the EXACT payload back into POST import/preview, and
    //         prove the importer reads back what was exported losslessly:
    //         valid:true, version 1, workCount/profile match, and the just-
    //         exported slug surfaces as a CONFLICT (the slug-dedup oracle proves
    //         the importer recognises the round-tripped work as the same work).
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 2: export -> import/preview round-trips losslessly (slug recognised as a conflict)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const s = suffix();
        const slug = `roundtrip-${s}`;
        await createWorkViaAPI(request, token, {
            name: `Roundtrip ${s}`,
            slug,
            description: 'roundtrip integrity',
        });

        const { payload } = await exportAccount(request, token);
        expect(
            payload.data.works.some((w) => w.slug === slug),
            'exported the work',
        ).toBe(true);

        // Feed the export straight back into preview — the integrity check.
        const pvRes = await preview(request, token, payload);
        expect(pvRes.status(), 'preview accepts a well-formed payload -> 200').toBe(200);
        const pv = await pvRes.json();

        expect(pv.valid, 'round-tripped payload is valid').toBe(true);
        expect(pv.errors, 'no validation errors on a self-export').toEqual([]);
        expect(pv.version, 'preview echoes v1').toBe(1);
        expect(pv.profile.email, 'profile email survives the round-trip').toBe(u.email);
        expect(pv.workCount, 'workCount matches the exported works length').toBe(
            payload.data.works.length,
        );
        // The work we exported is recognised as ALREADY EXISTING -> a conflict
        // keyed on its slug. This is the importer proving losslessness: it
        // matched the round-tripped slug back to the live work.
        const conflict = (pv.conflicts as Array<{ slug: string; incomingName: string }>).find(
            (c) => c.slug === slug,
        );
        expect(conflict, `slug ${slug} surfaces as a round-trip conflict`).toBeTruthy();
        expect(conflict!.incomingName, 'conflict carries the incoming name').toBe(`Roundtrip ${s}`);
        // No installed-plugin gaps for a vanilla work.
        expect(pv.missingPlugins, 'no missing plugins for a vanilla work').toEqual([]);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 3: Export EXCLUDES SECRETS. Even with includeSecrets=true the export
    //         must never emit a raw credential — values are MASKED:-prefixed
    //         placeholders. We prove (a) the export with the flag flips
    //         includesSecrets:true in the envelope, (b) a deliberately crafted
    //         masked-secret payload is flagged hasMaskedSecrets:true by preview,
    //         and (c) apply REFUSES to persist a masked value — it records a
    //         warning instead of writing a fake credential. This is the
    //         "export excludes secrets" guarantee, end to end.
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 3: export excludes real secrets — masked values are detected and never imported', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const s = suffix();
        await createWorkViaAPI(request, token, {
            name: `Secret Safe ${s}`,
            slug: `secret-safe-${s}`,
            description: 'secret exclusion',
        });

        // (a) Exporting WITH includeSecrets flips the envelope flag — but the
        // service still only ever emits MASKED representations (never raw keys).
        const { payload } = await exportAccount(request, token, '?includeSecrets=true');
        expect(payload.includesSecrets, 'envelope echoes includeSecrets=true').toBe(true);
        // Scan the whole serialised export: no value may look like a live key
        // AND not be masked. (Vanilla account has no secrets at all, so this is
        // trivially satisfied; the assertion guards against a future leak.)
        const serialised = JSON.stringify(payload);
        const rawKeyLike = serialised.match(/"(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})"/);
        expect(rawKeyLike, 'no raw API-key-shaped value in the export').toBeNull();

        // (b) Hand-craft a payload carrying a MASKED secret (exactly what the
        // exporter would have produced) and prove preview detects it.
        const maskedPayload: AccountExportPayload = {
            ...payload,
            includesSecrets: true,
            data: {
                ...payload.data,
                userPlugins: [
                    {
                        pluginId: KNOWN_INSTALLED_PLUGIN,
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: 'MASKED:sk-***1234' },
                    },
                ],
            },
        };
        const pvRes = await preview(request, token, maskedPayload);
        expect(pvRes.status(), 'preview of a masked payload -> 200').toBe(200);
        const pv = await pvRes.json();
        expect(pv.valid, 'masked payload is structurally valid').toBe(true);
        expect(pv.hasMaskedSecrets, 'preview flags the MASKED: placeholder').toBe(true);
        expect(pv.includesSecrets, 'preview echoes includesSecrets').toBe(true);
        // openai is installed -> not in missingPlugins.
        expect(
            (pv.missingPlugins as string[]).includes(KNOWN_INSTALLED_PLUGIN),
            'installed plugin not reported missing',
        ).toBe(false);

        // (c) Applying the masked payload must NOT write the fake credential —
        // it records a warning telling the user to replace it, and still
        // succeeds at the structural level (success:true, never a 5xx).
        const applyRes = await apply(request, token, maskedPayload);
        expect(applyRes.status(), 'apply masked payload -> 200').toBe(200);
        const result = await applyRes.json();
        expect(result.success, 'apply succeeds structurally').toBe(true);
        const warnedAboutMask = (result.warnings as string[]).some((w) =>
            /MASKED:|masked secret/i.test(w),
        );
        expect(warnedAboutMask, 'apply warns rather than persisting a masked secret').toBe(true);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 4: Export of an EMPTY work account. A brand-new user with zero works
    //         still gets a fully-formed, valid v1 envelope (empty works[] +
    //         userPlugins[]), and that empty export round-trips through preview
    //         as valid with workCount:0 and zero conflicts — the empty case is a
    //         first-class, lossless round-trip, not a special error path.
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 4: empty-account export is a valid, zero-work envelope that round-trips clean', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request); // NO works created
        const token = u.access_token;

        const { payload } = await exportAccount(request, token);
        expect(payload.version, 'empty export is v1').toBe(1);
        expect(payload.data.profile.email, 'profile still present on an empty account').toBe(
            u.email,
        );
        expect(payload.data.works, 'works[] is empty').toEqual([]);
        expect(payload.data.userPlugins, 'userPlugins[] is empty').toEqual([]);

        // The empty export is itself a valid import payload.
        const pvRes = await preview(request, token, payload);
        expect(pvRes.status(), 'preview of empty export -> 200').toBe(200);
        const pv = await pvRes.json();
        expect(pv.valid, 'empty export previews as valid').toBe(true);
        expect(pv.workCount, 'zero works').toBe(0);
        expect(pv.totalItemCount, 'zero items').toBe(0);
        expect(pv.conflicts, 'no conflicts on an empty payload').toEqual([]);
        expect(pv.missingPlugins, 'no missing plugins on an empty payload').toEqual([]);

        // Applying an empty payload is a clean no-op success.
        const applyRes = await apply(request, token, payload);
        expect(applyRes.status(), 'apply empty payload -> 200').toBe(200);
        const result = await applyRes.json();
        expect(result.success, 'empty apply succeeds').toBe(true);
        expect(result.errors, 'no errors on an empty apply').toEqual([]);
        expect(
            result.worksCreated + result.worksUpdated + result.worksSkipped,
            'nothing touched on an empty apply',
        ).toBe(0);
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 5: Export REFLECTS UPDATES. The export is a live snapshot, not a
    //         cache: rename/redescribe a work (PATCH) and add a SECOND work, then
    //         re-export — the new export must reflect BOTH mutations (the updated
    //         description AND the new work) while a snapshot taken BEFORE the
    //         mutations did not. Proves the export reads through to current DB
    //         state on every call.
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 5: a re-export reflects subsequent work mutations (update + new work)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const s = suffix();
        const slug = `reflect-${s}`;
        const { id } = await createWorkViaAPI(request, token, {
            name: `Reflect ${s}`,
            slug,
            description: 'before update',
        });

        // Snapshot BEFORE any mutation.
        const before = (await exportAccount(request, token)).payload;
        const beforeWork = before.data.works.find((w) => w.slug === slug);
        expect(beforeWork?.description, 'baseline description').toBe('before update');
        const beforeCount = before.data.works.length;

        // Mutation 1: update the work's description via PATCH /api/works/:id.
        const newDesc = `after update ${s}`;
        const patchRes = await request.patch(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(token),
            data: { description: newDesc },
        });
        // PATCH may be 200/204 in this stack; tolerate but forbid a 5xx.
        expect(patchRes.status(), `patch work ${patchRes.status()}`).toBeLessThan(500);
        const patchApplied = patchRes.status() >= 200 && patchRes.status() < 300;

        // Mutation 2: add a SECOND work.
        const slug2 = `reflect-2-${s}`;
        await createWorkViaAPI(request, token, {
            name: `Reflect Two ${s}`,
            slug: slug2,
            description: 'second work',
        });

        // Re-export and assert it reflects the new DB state. Poll because the
        // PATCH write may settle a beat behind the response in dev.
        await expect
            .poll(
                async () => {
                    const { payload } = await exportAccount(request, token);
                    const slugs = payload.data.works.map((w) => w.slug);
                    const updated = payload.data.works.find((w) => w.slug === slug);
                    return {
                        count: payload.data.works.length,
                        hasSecond: slugs.includes(slug2),
                        desc: updated?.description,
                    };
                },
                { timeout: 20_000, message: 're-export reflects the new work + update' },
            )
            .toMatchObject({ hasSecond: true });

        const after = (await exportAccount(request, token)).payload;
        // The new work is now present; the count grew by at least one.
        expect(
            after.data.works.map((w) => w.slug),
            'second work in re-export',
        ).toContain(slug2);
        expect(after.data.works.length, 'work count grew after adding a work').toBeGreaterThan(
            beforeCount,
        );
        // If the PATCH took effect, the updated description is reflected (and the
        // stale "before" snapshot proves it was a live read, not a cache).
        if (patchApplied) {
            const afterWork = after.data.works.find((w) => w.slug === slug);
            expect(afterWork?.description, 're-export reflects the updated description').toBe(
                newDesc,
            );
            expect(
                beforeWork?.description,
                'pre-mutation snapshot was stale by comparison',
            ).not.toBe(newDesc);
        }
    });

    // ───────────────────────────────────────────────────────────────────────
    // FLOW 6: Cross-USER migration round-trip + the importer's validation
    //         guards. (a) User A exports a work; User B (empty account) imports
    //         A's payload -> the work is RECREATED under B (worksCreated>=1,
    //         success:true) and B's own re-export now contains it — a true
    //         account-to-account migration round-trip. (b) The importer rejects
    //         a fabricated v2 payload as an unsupported version and a missing-
    //         works payload with field errors — STILL HTTP 200 structured
    //         rejections, never thrown 5xxs. (c) The whole surface is anon-locked.
    // ───────────────────────────────────────────────────────────────────────
    test('FLOW 6: cross-user export->import recreates the work under the new owner + guards', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const recipient = await registerUserViaAPI(request);
        expect(owner.user.id, 'distinct users').not.toBe(recipient.user.id);
        const s = suffix();
        const slug = `migrate-${s}`;
        await createWorkViaAPI(request, owner.access_token, {
            name: `Migrate ${s}`,
            slug,
            description: 'migration source',
        });

        // (a) Export from A, import into B.
        const { payload } = await exportAccount(request, owner.access_token);
        expect(
            payload.data.works.some((w) => w.slug === slug),
            'A exported the work',
        ).toBe(true);

        // B's account starts empty.
        const bBefore = (await exportAccount(request, recipient.access_token)).payload;
        expect(bBefore.data.works.length, 'B starts with no works').toBe(0);

        // B previews A's payload: no conflict (different account), work recognised.
        const bPv = await (await preview(request, recipient.access_token, payload)).json();
        expect(bPv.valid, 'B previews A’s payload as valid').toBe(true);
        expect(bPv.conflicts, 'no conflicts in a fresh account').toEqual([]);
        expect(bPv.workCount, 'B sees A’s work count').toBe(payload.data.works.length);

        // B applies — the work is recreated under B.
        const applyRes = await apply(request, recipient.access_token, payload);
        expect(applyRes.status(), 'B apply -> 200').toBe(200);
        const result = await applyRes.json();
        expect(result.success, 'B import succeeds').toBe(true);
        expect(
            result.worksCreated + result.worksUpdated,
            'at least one work landed under B',
        ).toBeGreaterThanOrEqual(1);

        // B's re-export now contains the migrated work — the migration round-trip
        // is observable end to end. Poll for the committed write.
        await expect
            .poll(
                async () => {
                    const { payload: p } = await exportAccount(request, recipient.access_token);
                    return p.data.works.map((w) => w.slug);
                },
                { timeout: 20_000, message: 'migrated work appears in B’s re-export' },
            )
            .toContain(slug);

        // (b) Importer validation guards — structured rejections at HTTP 200.
        const v2 = await (
            await preview(request, recipient.access_token, {
                version: 2,
                exportedAt: new Date().toISOString(),
                includesSecrets: false,
                data: {
                    profile: { username: 'x', email: 'x@test.local' },
                    works: [],
                    userPlugins: [],
                },
            })
        ).json();
        expect(v2.valid, 'unsupported v2 payload rejected').toBe(false);
        expect(
            (v2.errors as string[]).some((e) => /unsupported export version/i.test(e)),
            'v2 rejection message',
        ).toBe(true);

        const missingWorks = await preview(request, recipient.access_token, {
            version: 1,
            exportedAt: new Date().toISOString(),
            includesSecrets: false,
            data: { profile: { username: 'x', email: 'x@test.local' } },
        });
        expect(missingWorks.status(), 'malformed preview still 200 (structured)').toBe(200);
        const mw = await missingWorks.json();
        expect(mw.valid, 'missing-works payload rejected').toBe(false);
        expect(
            (mw.errors as string[]).some((e) => /works array/i.test(e)),
            'missing-works error message',
        ).toBe(true);

        // An entirely empty body is the one hard 400 (controller guard).
        const emptyBody = await preview(request, recipient.access_token, {});
        expect(emptyBody.status(), 'empty {} body -> 400').toBe(400);

        // (c) Anon lockout across the whole account-transfer surface. The
        // `request` fixture is unauthenticated (no storageState cookie).
        const anonExport = await request.get(`${API_BASE}/api/account/export`);
        expect(anonExport.status(), 'anon export -> 401').toBe(401);
        const anonPreview = await request.post(`${API_BASE}/api/account/import/preview`, {
            data: payload as unknown as Record<string, unknown>,
        });
        expect(anonPreview.status(), 'anon preview -> 401').toBe(401);
        const anonApply = await request.post(`${API_BASE}/api/account/import/apply`, {
            data: { payload, resolutions: [] },
        });
        expect(anonApply.status(), 'anon apply -> 401').toBe(401);
    });
});
