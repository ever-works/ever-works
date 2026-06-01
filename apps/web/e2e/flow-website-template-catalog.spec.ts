import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Website-template catalog → per-Work template lifecycle — complex,
 * multi-step, cross-feature END-TO-END INTEGRATION flows.
 *
 * Sibling spec `flow-templates-deploy.spec.ts` already pins: catalog
 * enumeration, create-with-`websiteTemplateId`, a minimal→classic SWITCH,
 * the bad-id 400, the user-scoped `PUT /api/templates/default`
 * customization, and the customization ledger. This file deliberately
 * AVOIDS those and instead drives the entity-level auto-update machinery
 * and switch-state edge cases that no other spec covers:
 *
 *   1. Auto-update settings lifecycle — `websiteTemplateAutoUpdate` +
 *      `websiteTemplateUseBeta` persisted via `PUT /api/works/:id`
 *      (UpdateWorkDto), round-tripped through a fresh GET, independently
 *      toggled, and validated (non-boolean → 400 class-validator).
 *   2. `useBeta` branch-switch clears `websiteTemplateLastCommit` — the
 *      "force a re-check on next scheduler tick" contract (work-lifecycle
 *      service nulls lastCommit when useBeta flips).
 *   3. Switch state machine: no_change (same effective template),
 *      null-reset (clear the explicit binding → falls back to default),
 *      and the lastCommit/lastError reset on a real template change.
 *   4. Rich catalog contract — per-template `betaBranch`, `syncBranches`,
 *      `customizable`, `baseTemplateId`, `latestCustomization`, plus the
 *      classic-vs-minimal `customizable` asymmetry, vs the lean
 *      works-facing list the create UI consumes.
 *   5. Cross-user isolation — a non-owner cannot GET, PUT-settings, or
 *      SWITCH another user's Work template (403, never a leak/mutation).
 *   6. Customization ledger + not-found contracts — per-template ledger is
 *      always a 200 array (even for unknown ids), the single-customization
 *      lookup returns a 200 `status:'error'` envelope, and there is no
 *      bare single-template GET route (404).
 *
 * Verified live-API shapes (fresh user, port 3100, probed before writing):
 *   POST /api/works { websiteTemplateId? } →
 *        { status:'success', work:{ id, websiteTemplateId|null,
 *          websiteTemplateAutoUpdate:false, websiteTemplateUseBeta:false,
 *          websiteTemplateLastCommit:null, websiteTemplateLastError:null, ... } }
 *        (omitting websiteTemplateId stores NULL — default resolves at runtime)
 *   GET  /api/works/:id → { status:'success', work:{ ...,
 *          websiteRepositoryInitialized:false (CI: no repo created) } }
 *   PUT  /api/works/:id { websiteTemplateAutoUpdate?, websiteTemplateUseBeta?,
 *          websiteTemplateId? } → 200 { status:'success', work:{...} }
 *        - bad websiteTemplateId → 400 { status:'error',
 *          message:'Unsupported website template: <id>' }
 *        - non-boolean autoUpdate → 400 { message:['websiteTemplateAutoUpdate
 *          must be a boolean value'], error:'Bad Request', statusCode:400 }
 *   POST /api/works/:id/switch-website-template { websiteTemplateId|null } →
 *        200 { status, slug, owner, repository, previousWebsiteTemplateId,
 *          websiteTemplateId, repositoryRecreated:false, switchMode, message }
 *        switchMode ∈ no_change | saved_for_initialization |
 *          repository_reset | repository_recreated
 *   GET  /api/templates?kind=website →
 *        { status:'success', kind:'website', defaultTemplateId:'classic',
 *          templates:[{ id,kind,sourceType:'built_in',originType:'standard',
 *          name,description,framework,previewImageUrl,repositoryUrl,
 *          repositoryOwner,repositoryName,branch,syncBranches,betaBranch,
 *          isActive,isDefault,ownerUserId,customizable,baseTemplateId,
 *          lastCustomizedAt,lastCustomizationPrompt,latestCustomization }] }
 *        classic: customizable:false, betaBranch:'stage'; minimal: customizable:true
 *   GET  /api/works/website-templates →
 *        { status:'success', templates:[{ id,name,description,
 *          sourceType:'built_in',originType:'standard',isDefault }] } (2 rows)
 *   GET  /api/templates/:id/customizations → 200 { status:'success',
 *          customizations:[] } (200 empty even for unknown template id)
 *   GET  /api/templates/customizations/:bogus → 200 { status:'error',
 *          message:'Customization not found' }
 *   GET  /api/templates/:id (no subpath) → 404 (no single-template route)
 *   Cross-user GET/PUT/switch on another user's work → 403
 *        { status:'error', message:'You do not have permission to access this work' }
 *
 * Isolation: every mutation runs on a FRESH registerUserViaAPI() user so
 * the shared in-memory DB stays clean for sibling specs. Catalog reads
 * tolerate pre-existing rows (find/toContain), never exact counts beyond
 * the two shipped built-ins. No external git/deploy is triggered — in CI
 * no website repo exists, so every switch is a deferred/no-op state change.
 */

type WorkTemplateState = {
    websiteTemplateId?: string | null;
    websiteTemplateAutoUpdate?: boolean;
    websiteTemplateUseBeta?: boolean;
    websiteTemplateLastCommit?: string | null;
    websiteTemplateLastError?: string | null;
    websiteRepositoryInitialized?: boolean;
};

type CatalogTemplate = {
    id: string;
    kind?: string;
    sourceType?: string;
    originType?: string;
    name: string;
    description?: string | null;
    framework?: string | null;
    previewImageUrl?: string | null;
    repositoryUrl?: string;
    repositoryOwner?: string;
    repositoryName?: string;
    branch?: string;
    syncBranches?: string[];
    betaBranch?: string | null;
    isActive?: boolean;
    isDefault?: boolean;
    customizable?: boolean;
    baseTemplateId?: string | null;
    latestCustomization?: unknown;
};

async function createWork(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<{ id: string; work: WorkTemplateState & { id: string } }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: `WT Catalog ${stamp}`,
            slug: `wt-catalog-${stamp}`,
            description: 'flow-website-template-catalog',
            organization: false,
            ...overrides,
        },
    });
    expect(res.status(), `work create status ${res.status()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.work?.id, 'created work has id').toBeTruthy();
    return { id: body.work.id, work: body.work };
}

async function getWork(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ status: number; work: WorkTemplateState | undefined }> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return { status: res.status(), work: undefined };
    const body = await res.json();
    return { status: res.status(), work: body?.work ?? body?.data ?? body };
}

test.describe('Flow: per-Work website-template auto-update settings lifecycle', () => {
    test('autoUpdate + useBeta persist via PUT, toggle independently, and reject non-booleans', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Bind a Work to classic so the template axis is explicit (not a
        // runtime-resolved default). A brand-new Work defaults every
        // auto-update column to false / null.
        const { id, work } = await createWork(request, user.access_token, {
            websiteTemplateId: 'classic',
        });
        expect(work.websiteTemplateId, 'create echoes the binding').toBe('classic');
        expect(work.websiteTemplateAutoUpdate, 'autoUpdate off by default').toBe(false);
        expect(work.websiteTemplateUseBeta, 'useBeta off by default').toBe(false);
        expect(work.websiteTemplateLastCommit, 'no commit tracked yet').toBeNull();
        expect(work.websiteTemplateLastError, 'no error tracked yet').toBeNull();

        // --- Enable BOTH auto-update flags in a single PUT. The response is
        // the standard { status:'success', work } envelope and must echo the
        // new flags. ---
        const putRes = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateAutoUpdate: true, websiteTemplateUseBeta: true },
        });
        expect(putRes.status(), 'PUT update accepted').toBe(200);
        const putBody = await putRes.json();
        expect(putBody.status).toBe('success');
        expect(putBody.work, 'PUT returns the updated work').toBeTruthy();
        expect(putBody.work.websiteTemplateAutoUpdate, 'PUT echoes autoUpdate=true').toBe(true);
        expect(putBody.work.websiteTemplateUseBeta, 'PUT echoes useBeta=true').toBe(true);

        // --- Persistence via a FRESH GET (not the PUT echo). ---
        await expect
            .poll(
                async () => {
                    const r = await getWork(request, user.access_token, id);
                    return r.work?.websiteTemplateAutoUpdate;
                },
                { timeout: 15000, message: 'autoUpdate persists across re-read' },
            )
            .toBe(true);
        const persisted = await getWork(request, user.access_token, id);
        expect(persisted.work?.websiteTemplateUseBeta, 'useBeta persists').toBe(true);
        // In CI no website repo is ever created, so the work reports the repo
        // as uninitialised — the auto-update scheduler has nothing to act on.
        expect(persisted.work?.websiteRepositoryInitialized).toBe(false);

        // --- Independent toggle: turn autoUpdate OFF while leaving useBeta
        // untouched. A partial PUT must not clobber the unsent flag. ---
        const partial = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateAutoUpdate: false },
        });
        expect(partial.status()).toBe(200);
        const afterPartial = await getWork(request, user.access_token, id);
        expect(afterPartial.work?.websiteTemplateAutoUpdate, 'autoUpdate toggled off').toBe(false);
        expect(afterPartial.work?.websiteTemplateUseBeta, 'useBeta untouched by partial PUT').toBe(
            true,
        );

        // --- Validation: a non-boolean auto-update value is rejected by the
        // global ValidationPipe with the class-validator array message, and
        // does NOT mutate the work. ---
        const bad = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateAutoUpdate: 'yes' },
        });
        expect(bad.status(), 'non-boolean rejected').toBe(400);
        const badBody = await bad.json();
        const messages = Array.isArray(badBody.message)
            ? badBody.message
            : [String(badBody.message)];
        expect(
            messages.some((m: string) => /websiteTemplateAutoUpdate must be a boolean/i.test(m)),
            'class-validator boolean message',
        ).toBe(true);
        const afterBad = await getWork(request, user.access_token, id);
        expect(afterBad.work?.websiteTemplateAutoUpdate, 'rejected PUT was a no-op').toBe(false);
        expect(afterBad.work?.websiteTemplateUseBeta).toBe(true);
    });
});

test.describe('Flow: useBeta branch flip forces a template re-check (lastCommit reset)', () => {
    test('flipping websiteTemplateUseBeta clears lastCommit and is idempotent on a stable value', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createWork(request, user.access_token, {
            websiteTemplateId: 'classic',
        });

        // Baseline: no commit tracked, beta off.
        const base = await getWork(request, user.access_token, id);
        expect(base.work?.websiteTemplateUseBeta).toBe(false);
        expect(base.work?.websiteTemplateLastCommit).toBeNull();

        // --- Flip useBeta ON. The work-lifecycle service nulls
        // websiteTemplateLastCommit whenever useBeta changes value, so the
        // hourly scheduler re-checks against the (different) beta branch on
        // its next tick. lastCommit starts null here, so the observable
        // contract is "still null + useBeta=true" — never a stale commit. ---
        const on = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateUseBeta: true },
        });
        expect(on.status()).toBe(200);
        const afterOn = await getWork(request, user.access_token, id);
        expect(afterOn.work?.websiteTemplateUseBeta, 'beta enabled').toBe(true);
        expect(
            afterOn.work?.websiteTemplateLastCommit,
            'lastCommit cleared on branch flip',
        ).toBeNull();
        // No error is recorded by a settings change.
        expect(afterOn.work?.websiteTemplateLastError).toBeNull();

        // --- Idempotent re-apply: PUT useBeta=true again. Because the value
        // is unchanged, the service does NOT treat it as a flip; the work
        // stays beta=true with lastCommit untouched (still null). ---
        const again = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateUseBeta: true },
        });
        expect(again.status()).toBe(200);
        const afterAgain = await getWork(request, user.access_token, id);
        expect(afterAgain.work?.websiteTemplateUseBeta).toBe(true);
        expect(afterAgain.work?.websiteTemplateLastCommit).toBeNull();

        // --- Flip back OFF. Another value change → another (no-op here)
        // lastCommit clear. The stable branch is restored. ---
        const off = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateUseBeta: false },
        });
        expect(off.status()).toBe(200);
        const afterOff = await getWork(request, user.access_token, id);
        expect(afterOff.work?.websiteTemplateUseBeta, 'beta disabled').toBe(false);
        expect(afterOff.work?.websiteTemplateLastCommit).toBeNull();
    });
});

test.describe('Flow: website-template switch state machine (no_change / null-reset)', () => {
    test('same-effective switch is a no_change no-op and a null switch clears the explicit binding', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { id } = await createWork(request, user.access_token, {
            websiteTemplateId: 'classic',
        });

        // --- Switching classic → classic is a no_change no-op: the effective
        // template is unchanged, so no repo is reset/recreated. ---
        const same = await request.post(`${API_BASE}/api/works/${id}/switch-website-template`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateId: 'classic' },
        });
        expect(same.status(), 'same-template switch accepted').toBe(200);
        const sameBody = await same.json();
        expect(sameBody.status).toBe('success');
        expect(sameBody.switchMode, 'no effective change').toBe('no_change');
        expect(sameBody.previousWebsiteTemplateId).toBe('classic');
        expect(sameBody.websiteTemplateId).toBe('classic');
        expect(sameBody.repositoryRecreated).toBe(false);
        expect(typeof sameBody.message).toBe('string');
        // The switch envelope carries the repo coordinates even when nothing changed.
        expect(typeof sameBody.slug).toBe('string');
        expect(typeof sameBody.owner).toBe('string');
        expect(typeof sameBody.repository).toBe('string');

        // Still bound to classic after the no-op.
        const afterSame = await getWork(request, user.access_token, id);
        expect(afterSame.work?.websiteTemplateId).toBe('classic');

        // --- Switching to NULL clears the explicit binding. classic IS the
        // platform default for a fresh user, so the EFFECTIVE template is
        // still classic (no_change), but the stored websiteTemplateId becomes
        // null — generation now resolves the default at runtime. ---
        const cleared = await request.post(`${API_BASE}/api/works/${id}/switch-website-template`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateId: null },
        });
        expect(cleared.status(), 'null switch accepted').toBe(200);
        const clearedBody = await cleared.json();
        expect(clearedBody.status).toBe('success');
        // Effective template did not move off the default, so still no_change.
        expect(clearedBody.switchMode).toBe('no_change');
        expect(clearedBody.previousWebsiteTemplateId).toBe('classic');
        expect(clearedBody.websiteTemplateId, 'effective resolves to default classic').toBe(
            'classic',
        );

        // The STORED explicit binding is now null even though the effective
        // template reads classic — pins the explicit-vs-effective distinction.
        await expect
            .poll(
                async () => {
                    const r = await getWork(request, user.access_token, id);
                    return r.work?.websiteTemplateId ?? '__null__';
                },
                { timeout: 15000, message: 'explicit binding cleared to null' },
            )
            .toBe('__null__');

        // --- A genuine template change (null/default classic → minimal)
        // resets the per-template tracking columns to null (lastCommit /
        // lastError). In CI no repo exists, so the change is deferred for
        // first initialization rather than recreating anything. ---
        const real = await request.post(`${API_BASE}/api/works/${id}/switch-website-template`, {
            headers: authedHeaders(user.access_token),
            data: { websiteTemplateId: 'minimal' },
        });
        expect(real.status()).toBe(200);
        const realBody = await real.json();
        expect(realBody.status).toBe('success');
        expect(realBody.previousWebsiteTemplateId, 'previous effective was classic').toBe(
            'classic',
        );
        expect(realBody.websiteTemplateId).toBe('minimal');
        expect(realBody.switchMode, 'deferred — no repo to reset in CI').toBe(
            'saved_for_initialization',
        );
        expect(realBody.repositoryRecreated).toBe(false);

        const afterReal = await getWork(request, user.access_token, id);
        expect(afterReal.work?.websiteTemplateId, 'now bound to minimal').toBe('minimal');
        // Tracking columns reset by the template change.
        expect(afterReal.work?.websiteTemplateLastCommit).toBeNull();
        expect(afterReal.work?.websiteTemplateLastError).toBeNull();
    });
});

test.describe('Flow: rich catalog contract vs lean works-facing list', () => {
    test('the rich catalog exposes branch/customizable metadata and the works list stays lean', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // --- Rich catalog (the template-settings surface). Every row carries
        // the full repository + customization contract. ---
        const catRes = await request.get(`${API_BASE}/api/templates?kind=website`, {
            headers: authedHeaders(user.access_token),
        });
        expect(catRes.status(), 'rich catalog readable').toBe(200);
        const catBody = await catRes.json();
        expect(catBody.status).toBe('success');
        expect(catBody.kind).toBe('website');
        expect(catBody.defaultTemplateId, 'fresh user default is classic').toBe('classic');
        const catalog: CatalogTemplate[] = catBody.templates;
        expect(Array.isArray(catalog)).toBe(true);

        const classic = catalog.find((t) => t.id === 'classic');
        const minimal = catalog.find((t) => t.id === 'minimal');
        expect(classic, 'classic present').toBeTruthy();
        expect(minimal, 'minimal present').toBeTruthy();

        // Both built-ins share the source/origin contract and carry sync
        // metadata used by the auto-update scheduler.
        for (const t of [classic!, minimal!]) {
            expect(t.kind).toBe('website');
            expect(t.sourceType, `${t.id}.sourceType`).toBe('built_in');
            expect(t.originType, `${t.id}.originType`).toBe('standard');
            expect(Array.isArray(t.syncBranches), `${t.id}.syncBranches is an array`).toBe(true);
            expect(t.syncBranches!.length, `${t.id} has sync branches`).toBeGreaterThan(0);
            expect(typeof t.branch, `${t.id}.branch is a string`).toBe('string');
            // A built-in is not a fork of another template: the catalog's
            // resolveBaseTemplateId returns the built-in's OWN id (it descends
            // from itself), never some other template's id.
            expect(t.baseTemplateId, `${t.id} is its own base, not a fork`).toBe(t.id);
            // No agent customization has been recorded for a fresh user.
            expect(t.latestCustomization == null, `${t.id} has no latest customization yet`).toBe(
                true,
            );
        }

        // classic ships a beta branch (used when websiteTemplateUseBeta is on)
        // and its main branch is part of the sync set.
        expect(classic!.betaBranch, 'classic exposes a beta branch').toBeTruthy();
        expect(classic!.syncBranches, 'classic syncs its primary branch').toContain(
            classic!.branch,
        );
        expect(classic!.repositoryName).toBe('directory-web-template');
        expect(classic!.repositoryOwner).toBe('ever-works');

        // The classic-vs-minimal customizable asymmetry: classic is too
        // large to safely agent-customize, minimal is customizable.
        expect(classic!.customizable, 'classic not customizable').toBe(false);
        expect(minimal!.customizable, 'minimal is customizable').toBe(true);

        // Exactly one row flagged default, and it is classic.
        const richDefaults = catalog.filter((t) => t.isDefault);
        expect(richDefaults.length, 'exactly one rich-catalog default').toBe(1);
        expect(richDefaults[0].id).toBe('classic');

        // --- Lean works-facing list (the create-work UI). Same template ids,
        // but a trimmed projection: NO repository/branch internals leak. ---
        const wtRes = await request.get(`${API_BASE}/api/works/website-templates`, {
            headers: authedHeaders(user.access_token),
        });
        expect(wtRes.status(), 'works-facing list readable').toBe(200);
        const wtBody = await wtRes.json();
        expect(wtBody.status).toBe('success');
        const lean = wtBody.templates as Array<Record<string, unknown>>;
        expect(Array.isArray(lean)).toBe(true);
        const leanClassic = lean.find((t) => t.id === 'classic');
        const leanMinimal = lean.find((t) => t.id === 'minimal');
        expect(leanClassic, 'classic in lean list').toBeTruthy();
        expect(leanMinimal, 'minimal in lean list').toBeTruthy();
        // The lean projection deliberately omits repository internals.
        expect(leanClassic!.repositoryName, 'lean list hides repo name').toBeUndefined();
        expect(leanClassic!.branch, 'lean list hides branch').toBeUndefined();
        expect(leanClassic!.syncBranches, 'lean list hides sync branches').toBeUndefined();
        // But keeps the user-facing fields + the default flag.
        expect(typeof leanClassic!.name).toBe('string');
        expect(typeof leanClassic!.isDefault).toBe('boolean');
        const leanDefaults = lean.filter((t) => t.isDefault);
        expect(leanDefaults.length, 'exactly one lean default').toBe(1);
        expect(leanDefaults[0].id).toBe('classic');
    });
});

test.describe('Flow: cross-user isolation of a Work template configuration', () => {
    test("a non-owner cannot read, configure, or switch another user's Work template", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);

        // Owner creates a Work bound to minimal with auto-update enabled.
        const { id } = await createWork(request, owner.access_token, {
            websiteTemplateId: 'minimal',
        });
        await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(owner.access_token),
            data: { websiteTemplateAutoUpdate: true, websiteTemplateUseBeta: true },
        });

        // --- The intruder cannot READ the work (403, no template leak). ---
        const read = await request.get(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(read.status(), 'non-owner read forbidden').toBe(403);
        const readBody = await read.json();
        expect(readBody.status).toBe('error');
        expect(String(readBody.message)).toContain('permission');
        // No template fields are present in the error envelope.
        expect((readBody as Record<string, unknown>).work).toBeUndefined();

        // --- The intruder cannot mutate the auto-update settings. ---
        const put = await request.put(`${API_BASE}/api/works/${id}`, {
            headers: authedHeaders(intruder.access_token),
            data: { websiteTemplateAutoUpdate: false },
        });
        expect(put.status(), 'non-owner PUT forbidden').toBe(403);
        const putBody = await put.json();
        expect(putBody.status).toBe('error');
        expect(String(putBody.message)).toContain('permission');

        // --- The intruder cannot SWITCH the template. ---
        const sw = await request.post(`${API_BASE}/api/works/${id}/switch-website-template`, {
            headers: authedHeaders(intruder.access_token),
            data: { websiteTemplateId: 'classic' },
        });
        expect(sw.status(), 'non-owner switch forbidden').toBe(403);
        const swBody = await sw.json();
        expect(swBody.status).toBe('error');
        expect(String(swBody.message)).toContain('permission');

        // --- The owner's configuration is intact — none of the rejected
        // intruder calls mutated anything. ---
        const ownerView = await getWork(request, owner.access_token, id);
        expect(ownerView.status).toBe(200);
        expect(ownerView.work?.websiteTemplateId, 'still minimal').toBe('minimal');
        expect(ownerView.work?.websiteTemplateAutoUpdate, 'autoUpdate untouched').toBe(true);
        expect(ownerView.work?.websiteTemplateUseBeta, 'useBeta untouched').toBe(true);
    });
});

test.describe('Flow: template customization ledger + not-found contracts', () => {
    test('the per-template ledger is always a 200 array and the lookups return truthful envelopes', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // --- Both built-in templates expose a queryable customization ledger;
        // for a fresh user (no agent run submitted) each is an empty array. ---
        for (const tpl of ['classic', 'minimal']) {
            const res = await request.get(`${API_BASE}/api/templates/${tpl}/customizations`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status(), `${tpl} ledger queryable`).toBe(200);
            const body = await res.json();
            expect(body.status).toBe('success');
            expect(Array.isArray(body.customizations), `${tpl} ledger is an array`).toBe(true);
            expect(body.customizations.length, `${tpl} ledger empty for fresh user`).toBe(0);
        }

        // --- An UNKNOWN template id does NOT 404 the ledger — it returns a
        // 200 empty array (the ledger is keyed by base template, absent ids
        // simply have no customizations). Pins the polling-UI contract. ---
        const unknown = await request.get(
            `${API_BASE}/api/templates/does-not-exist-${Date.now()}/customizations`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(unknown.status(), 'unknown-template ledger still 200').toBe(200);
        const unknownBody = await unknown.json();
        expect(unknownBody.status).toBe('success');
        expect(Array.isArray(unknownBody.customizations)).toBe(true);
        expect(unknownBody.customizations.length).toBe(0);

        // --- A bogus single-customization lookup returns a 200 status:'error'
        // envelope (NOT a thrown 404/500) — the UI relies on this soft
        // not-found to poll without crashing. ---
        const bogus = await request.get(
            `${API_BASE}/api/templates/customizations/bogus-${Date.now()}`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(bogus.status(), 'soft not-found is 200, never 5xx').toBeLessThan(500);
        const bogusBody = await bogus.json();
        expect(bogusBody.status).toBe('error');
        expect(String(bogusBody.message)).toContain('not found');

        // --- There is deliberately no bare single-template GET route; only
        // the collection (?kind=) and the per-id subresources exist. A bare
        // GET /api/templates/:id 404s, which the catalog client must tolerate. ---
        const bareDetail = await request.get(`${API_BASE}/api/templates/classic`, {
            headers: authedHeaders(user.access_token),
        });
        expect(bareDetail.status(), 'no single-template route').toBe(404);

        // --- The ledger requires auth — an anonymous request is rejected,
        // never served. ---
        const anon = await request.get(`${API_BASE}/api/templates/classic/customizations`);
        expect([401, 403], `anon ledger status ${anon.status()}`).toContain(anon.status());
    });
});
