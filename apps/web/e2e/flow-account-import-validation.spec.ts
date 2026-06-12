import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-account-import-validation.spec.ts
 *
 * REGRESSION pins for the account import preview/apply payload-validation
 * contract (account-transfer/account-import.service.ts). Found by the
 * unmapped-500 hunt: the `previewImport` slug/pluginId loops dereferenced
 * array ELEMENTS unguarded (the `Array.isArray` checks only cover the
 * containers), so a null/non-object element threw a TypeError → unmapped 500;
 * other malformed shapes (a work with no name, a non-object profile, a
 * bare-string userPlugin) passed preview as `valid:true` and then failed
 * mid-apply. And `applyImport` ran `new Map(resolutions.map(...))` BEFORE its
 * transaction try/catch, so a truthy non-array `resolutions` (the controller
 * passes `body.resolutions || []`) → 500.
 *
 * The fix validates element shape up-front: every malformed preview is a clean
 * `200 { valid:false, errors:[…] }` (NEVER a 500, never a false `valid:true`),
 * and a non-array `resolutions` is a clean `200 { success:false, errors:[…] }`.
 *
 * NON-DUPLICATION: the roundtrip + UI specs (flow-account-export-import-
 * roundtrip, flow-settings-data-management-ui, flow-account-data-deletion) cover
 * VALID payload round-trips + the top-level shape guards (payload:null,
 * bad-version). This file pins the per-ELEMENT validation gap they leave.
 *
 * PROBED LIVE (http://127.0.0.1:3100) before assertion.
 */

const PREVIEW = `${API_BASE}/api/account/import/preview`;
const APPLY = `${API_BASE}/api/account/import/apply`;

interface PreviewResult {
    valid: boolean;
    errors: string[];
    workCount?: number;
    userPluginCount?: number;
}

async function preview(
    request: APIRequestContext,
    token: string,
    payload: unknown,
): Promise<{ status: number; body: PreviewResult }> {
    const res = await request.post(PREVIEW, {
        headers: authedHeaders(token),
        data: payload as Record<string, unknown>,
    });
    return { status: res.status(), body: (await res.json()) as PreviewResult };
}

async function apply(
    request: APIRequestContext,
    token: string,
    body: unknown,
): Promise<{ status: number; body: { success: boolean; errors: string[] } }> {
    const res = await request.post(APPLY, {
        headers: authedHeaders(token),
        data: body as Record<string, unknown>,
    });
    return {
        status: res.status(),
        body: (await res.json()) as { success: boolean; errors: string[] },
    };
}

test.describe('Account import — payload element validation (no unmapped 500 / no accept-invalid)', () => {
    test('previewImport: a null/non-object array ELEMENT is a clean 200 valid:false (was an unmapped 500)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const cases: Array<{ label: string; data: unknown }> = [
            {
                label: 'works:[null]',
                data: { version: 1, data: { profile: {}, works: [null], userPlugins: [] } },
            },
            {
                label: 'userPlugins:[null]',
                data: { version: 1, data: { profile: {}, works: [], userPlugins: [null] } },
            },
            {
                label: 'workPlugins:[{ok},null]',
                data: {
                    version: 1,
                    data: {
                        profile: {},
                        works: [{ slug: 'a', name: 'A', workPlugins: [{ pluginId: 'x' }, null] }],
                        userPlugins: [],
                    },
                },
            },
        ];

        for (const { label, data } of cases) {
            const { status, body } = await preview(request, token, data);
            expect(status, `${label} → 200 (preview never 5xx)`).toBe(200);
            expect(body.valid, `${label} → valid:false`).toBe(false);
            expect(body.errors.length, `${label} → carries a validation error`).toBeGreaterThan(0);
        }
    });

    test('previewImport: malformed-but-shaped elements report valid:false (was a misleading valid:true)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);

        const cases: Array<{ label: string; data: unknown }> = [
            {
                label: 'work missing name (only slug)',
                data: {
                    version: 1,
                    data: { profile: {}, works: [{ slug: 'x' }], userPlugins: [] },
                },
            },
            {
                label: 'userPlugin is a bare string',
                data: { version: 1, data: { profile: {}, works: [], userPlugins: ['notobject'] } },
            },
            {
                label: 'profile is a string',
                data: { version: 1, data: { profile: 'str', works: [], userPlugins: [] } },
            },
        ];

        for (const { label, data } of cases) {
            const { status, body } = await preview(request, token, data);
            expect(status, `${label} → 200`).toBe(200);
            expect(body.valid, `${label} → valid:false (no longer accept-invalid)`).toBe(false);
            expect(body.errors.length, `${label} → carries an error`).toBeGreaterThan(0);
        }
    });

    test('previewImport: a well-formed payload is still valid:true', async ({ request }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const { status, body } = await preview(request, token, {
            version: 1,
            data: {
                profile: { username: 'u', email: 'u@e.co' },
                works: [{ slug: 'w1', name: 'W1' }],
                userPlugins: [],
            },
        });
        expect(status).toBe(200);
        expect(body.valid, 'a well-formed payload validates').toBe(true);
        expect(body.errors).toEqual([]);
        expect(body.workCount).toBe(1);
    });

    test('applyImport: a non-array (or null-element) resolutions is a clean failed result (was an unmapped 500)', async ({
        request,
    }) => {
        const { access_token: token } = await registerUserViaAPI(request);
        const payload = { version: 1, data: { profile: {}, works: [], userPlugins: [] } };

        // Truthy non-array resolutions reach `new Map(resolutions.map(...))`
        // (controller passes `body.resolutions || []`) — used to 500.
        const nonArray = await apply(request, token, { payload, resolutions: 'notarray' });
        expect(nonArray.status, 'non-array resolutions → 200 (not 500)').toBe(200);
        expect(nonArray.body.success, 'non-array resolutions → success:false').toBe(false);

        // A null element used to throw on `r.slug`; now it is skipped.
        const nullElem = await apply(request, token, { payload, resolutions: [null] });
        expect(nullElem.status, 'null-element resolutions → 200 (not 500)').toBe(200);

        // The valid empty-resolutions path is unaffected.
        const ok = await apply(request, token, { payload, resolutions: [] });
        expect(ok.status, 'empty resolutions → 200').toBe(200);
        expect(ok.body.success, 'empty resolutions on an empty payload succeeds').toBe(true);
    });
});
