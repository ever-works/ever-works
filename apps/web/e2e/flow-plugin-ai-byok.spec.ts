import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { getPluginViaAPI, patchPluginSettingsViaAPI } from './helpers/plugins';
import { isAiProviderConfigured } from './helpers/chat';

/**
 * BYOK (Bring-Your-Own-Key) — complex, multi-step INTEGRATION flows for the way
 * the platform stores, MASKS, validates, rotates and isolates a user-supplied AI
 * provider `apiKey` on the OpenRouter ai-provider plugin. Every shape, status and
 * mask format below was PROBED against the LIVE stack (http://127.0.0.1:3100) on
 * 2026-06-01 before the assertions were written — this asserts the platform's
 * REAL secret-handling behaviour, never a guess. The sibling specs
 * (flow-plugin-ai-matrix / flow-plugin-ai-provider-resolution) cover the catalogue,
 * defaultModel persistence, provider override + work-active resolution; this file is
 * exclusively about the SECRET apiKey lifecycle, which they do not exercise.
 *
 * SCHEMA (packages/plugins/openrouter/src/openrouter.plugin.ts):
 *   - apiKey: { 'x-secret': true, 'x-scope': 'user', 'x-envVar':'PLUGIN_OPENROUTER_API_KEY' }
 *   - required: ['apiKey', 'defaultModel']
 *   So apiKey is a REQUIRED, USER-scoped SECRET. It is also env-backed, so when no
 *   user key is set the effective key resolves from the env (adaptive — see below).
 *
 * PROBED CONTRACTS (live, http 3100):
 *   - PATCH /api/plugins/openrouter/settings  (controller →
 *     PluginOperationsService.updateUserPluginSettings — NOT the env-var-filtering
 *     PluginSettingsService path, so the BYOK key DOES persist for the user despite
 *     x-envVar):
 *       • apiKey is accepted via EITHER the `settings` OR the `secretSettings` body
 *         field — both land in the user's secretSettings and mask identically.
 *       • Response `settings.apiKey` is PARTIAL-REVEAL masked by partialReveal():
 *           len>8  → first4 + '••••' + last4   (e.g. 'sk-AAAA-realkey-11112222' → 'sk-A••••2222')
 *           len<=8 → first2 + '••••' + last2   ('sk-123' → 'sk••••23'; 'abcd1234' → 'ab••••34')
 *         The bullet char is U+2022 ('•'). The RAW key is NEVER echoed back.
 *       • Response `resolvedSettings.apiKey` is a FIXED 8-bullet mask '••••••••'
 *         (projectDisplaySettings) whenever an effective key exists (user OR env).
 *       • The PATCH response also carries a non-throwing `validation` envelope from
 *         tryValidateConnection(): { success, message, modelResults[] }. With a
 *         working effective key → success:true; with a bad user key → success:false
 *         and modelResults with upstream 401s — PROVING the user key was actually
 *         used for a real upstream completion attempt (a good env key would have
 *         succeeded instead).
 *       • Re-PATCHing the MASKED value back (a string containing '••••') is STRIPPED
 *         by stripMaskedValues() — the real stored key is preserved, never corrupted.
 *       • Clearing a REQUIRED secret via apiKey:null is REJECTED 400
 *         { message:'Invalid plugin settings', errors:['Missing required fields: apiKey'] }
 *         (null is stripped before validation → required field missing). The stored
 *         key is unchanged. Rotation (PATCH a new key) is the supported update path.
 *       • Unknown plugin id → 404.
 *   - GET /api/plugins/openrouter:
 *       • fresh user (no user key) → `settings` is null (no user row); resolvedSettings
 *         reflects the ENV/default chain (apiKey '••••••••' iff an env key is wired).
 *       • after a BYOK PATCH → `settings.apiKey` is the partial-reveal mask above.
 *   - POST /api/plugins/openrouter/validate-connection (explicit, THROWING):
 *       • good effective key → 200 { success:true, message:'OpenRouter connection
 *         verified — N model(s) tested successfully.' }
 *       • bad user key → 400 { message:'OpenRouter: N model(s) failed validation…',
 *         modelResults:[…401…] } (NOT a 5xx). This is distinct from the PATCH's
 *         non-throwing `validation` field which returns success:false in the 200 body.
 *
 * ENVIRONMENT-ADAPTIVE: the LOCAL stack ships PLUGIN_OPENROUTER_API_KEY, so a fresh
 * user's effective key resolves from the env → real validation/completion succeeds;
 * in CI (no key) the SAME path fails truthfully. Each flow asserts the REAL outcome
 * for whatever env it runs in via isAiProviderConfigured()/the validation envelope,
 * never skipping the round-trip and never asserting a fictional contract. The
 * MASKING, ROTATION, CLEAR-REJECTION and ISOLATION assertions hold in BOTH envs
 * because they are about how the user's OWN key is stored/returned, independent of
 * whether the upstream provider call ultimately succeeds.
 *
 * ISOLATION (critical): every mutation runs on its OWN FRESH registerUserViaAPI()
 * user — NEVER the shared seeded user — because writing a user-scoped fake apiKey
 * SHADOWS the env key and would break sibling chat specs on the seeded account.
 * Unique Date.now()-suffixed emails; tolerant assertions (toContain / regex), never
 * exact counts. Filename uses the safe `flow-` prefix (not matched by the no-auth
 * testIgnore regex) and is fully API-orchestrated, so it does not contend on the UI.
 */

const PLUGIN_ID = 'openrouter';
const SETTINGS_URL = `${API_BASE}/api/plugins/${PLUGIN_ID}/settings`;
const VALIDATE_URL = `${API_BASE}/api/plugins/${PLUGIN_ID}/validate-connection`;
const MODEL = 'openai/gpt-4o-mini';
/** The single mask glyph (U+2022 BULLET) used by partialReveal()/projectDisplaySettings. */
const BULLET = '•';
/** The fixed resolvedSettings mask for any present secret. */
const FIXED_MASK = BULLET.repeat(8); // '••••••••'

/** Register a brand-new isolated user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request, {
        email: `e2e-byok-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
    });
    return u.access_token;
}

/** GET the openrouter plugin and pull the user `settings` + masked `resolvedSettings`. */
async function readState(
    request: APIRequestContext,
    token: string,
): Promise<{
    settings: Record<string, unknown> | null;
    resolvedSettings: Record<string, unknown> | null;
}> {
    const p = await getPluginViaAPI(request, token, PLUGIN_ID);
    return {
        settings: (p.settings ?? null) as Record<string, unknown> | null,
        resolvedSettings: (p.resolvedSettings ?? null) as Record<string, unknown> | null,
    };
}

/** Persist a BYOK key + defaultModel for the current user; returns the full PATCH response. */
async function setKey(
    request: APIRequestContext,
    token: string,
    apiKey: string,
    model = MODEL,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
        settings: { apiKey, defaultModel: model },
    });
    return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

test.describe('BYOK — user apiKey storage, masking, validation, rotation & isolation', () => {
    test('Flow 1: PATCH a BYOK key — stored masked (partial-reveal in settings, fixed ••••••••  in resolvedSettings); raw key never echoed; settings & secretSettings fields are interchangeable', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Baseline: a brand-new user has NO user-scoped row → settings is null. The
        // resolvedSettings still reflect the env/default chain (apiKey present iff a
        // key is wired in this env — adaptive).
        const before = await readState(request, token);
        expect(
            before.settings,
            'a fresh user has no user-scoped openrouter settings row',
        ).toBeNull();

        // --- Persist a BYOK key via the `settings` field --------------------------
        const rawKey = 'sk-or-BYOK1-abcdefgh-11112222';
        const patch = await setKey(request, token, rawKey);
        expect(patch.status, `BYOK PATCH should succeed; body=${JSON.stringify(patch.body)}`).toBe(
            200,
        );

        // The response NEVER echoes the raw key — `settings.apiKey` is partial-reveal
        // masked: first4 + '••••' + last4 for this >8-char key.
        const respSettings = (patch.body.settings ?? {}) as Record<string, unknown>;
        const respMasked = respSettings.apiKey as string;
        expect(respMasked, 'settings.apiKey is returned, masked').toBeTruthy();
        expect(respMasked, 'the raw secret is NEVER echoed back').not.toBe(rawKey);
        expect(respMasked, 'partial-reveal contains the bullet mask').toContain(BULLET);
        expect(respMasked, 'partial-reveal preserves the real prefix').toBe(
            `${rawKey.slice(0, 4)}${BULLET.repeat(4)}${rawKey.slice(-4)}`,
        );
        // resolvedSettings.apiKey is the FIXED 8-bullet mask (a present secret), and the
        // chosen non-secret defaultModel is returned in the clear.
        const respResolved = (patch.body.resolvedSettings ?? {}) as Record<string, unknown>;
        expect(respResolved.apiKey, 'resolvedSettings.apiKey is the fixed mask').toBe(FIXED_MASK);
        expect(respResolved.defaultModel, 'non-secret defaultModel resolves in the clear').toBe(
            MODEL,
        );

        // Persisted state (GET) mirrors the masked PATCH response — poll because the
        // in-memory store settles asynchronously under load.
        await expect
            .poll(async () => (await readState(request, token)).settings?.apiKey, {
                timeout: 15_000,
                message: 'the masked BYOK key persists in user settings',
            })
            .toBe(respMasked);
        const persisted = await readState(request, token);
        expect(persisted.resolvedSettings?.apiKey, 'GET resolvedSettings stays fixed-masked').toBe(
            FIXED_MASK,
        );

        // --- The `secretSettings` body field is an EQUIVALENT route for the key -----
        // A second fresh user writes the same key via secretSettings and gets the
        // identical masked projection — the API treats the two body fields the same.
        const token2 = await freshToken(request);
        const viaSecret = await patchPluginSettingsViaAPI(request, token2, PLUGIN_ID, {
            settings: { defaultModel: MODEL },
            secretSettings: { apiKey: rawKey },
        });
        expect(
            viaSecret.status,
            `secretSettings route should succeed; body=${JSON.stringify(viaSecret.body)}`,
        ).toBe(200);
        const viaSecretSettings = ((viaSecret.body as Record<string, unknown>).settings ??
            {}) as Record<string, unknown>;
        expect(
            viaSecretSettings.apiKey,
            'apiKey written via secretSettings masks identically to the settings route',
        ).toBe(respMasked);
    });

    test('Flow 2: the masked value NEVER round-trips — re-PATCHing the returned mask is stripped and the real stored key is preserved', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const rawKey = 'sk-or-PRESERVE-cafebabe-77778888';
        const first = await setKey(request, token, rawKey);
        expect(first.status, 'initial key set').toBe(200);
        const masked = ((first.body.settings ?? {}) as Record<string, unknown>).apiKey as string;
        expect(masked, 'we captured the masked echo').toContain(BULLET);

        // A naive UI re-submit posts the MASKED string back (the user only changed the
        // model). The server's stripMaskedValues() drops any value containing '••••',
        // so the real key is left intact and the mask is unchanged — never corrupted
        // into the literal bullet string.
        const reModel = 'anthropic/claude-3.5-haiku';
        const resubmit = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: masked, defaultModel: reModel },
        });
        expect(
            resubmit.status,
            `re-submit of the masked value succeeds; body=${JSON.stringify(resubmit.body)}`,
        ).toBe(200);
        const afterSettings = ((resubmit.body as Record<string, unknown>).settings ?? {}) as Record<
            string,
            unknown
        >;
        expect(
            afterSettings.apiKey,
            'the mask is unchanged — the real key was preserved, not overwritten with bullets',
        ).toBe(masked);
        expect(afterSettings.defaultModel, 'the non-secret model DID update').toBe(reModel);

        // And the persisted state confirms the stored key never became the bullet string.
        await expect
            .poll(async () => (await readState(request, token)).settings?.defaultModel, {
                timeout: 15_000,
            })
            .toBe(reModel);
        const persisted = await readState(request, token);
        expect(
            persisted.settings?.apiKey,
            'persisted key is still the original masked projection',
        ).toBe(masked);
        expect(
            persisted.settings?.apiKey,
            'the stored value is NOT a pure bullet placeholder',
        ).not.toBe(FIXED_MASK);
    });

    test('Flow 3: partial-reveal mask math is length-adaptive (short keys reveal 2+2, longer keys 4+4) and always hides the middle', async ({
        request,
    }) => {
        // Each probe is its OWN fresh user so the keys never cross-contaminate.
        const cases: Array<{ key: string; prefix: number }> = [
            { key: 'sk-123', prefix: 2 }, // len 6  (<=8) → 2 + •••• + 2  → 'sk••••23'
            { key: 'abcd1234', prefix: 2 }, // len 8  (<=8) → 2 + •••• + 2  → 'ab••••34'
            { key: 'sk-or-LONGER-deadbeef-9999', prefix: 4 }, // len>8 → 4 + •••• + 4
        ];

        for (const { key, prefix } of cases) {
            const token = await freshToken(request);
            const res = await setKey(request, token, key);
            expect(res.status, `set key "${key}" (len ${key.length})`).toBe(200);
            const masked = ((res.body.settings ?? {}) as Record<string, unknown>).apiKey as string;

            const expected = `${key.slice(0, prefix)}${BULLET.repeat(4)}${key.slice(-prefix)}`;
            expect(masked, `key of length ${key.length} masks as ${prefix}+••••+${prefix}`).toBe(
                expected,
            );
            // The interior characters of the key must NOT survive in the mask.
            const interior = key.slice(prefix, key.length - prefix);
            if (interior.length > 0) {
                // strip the revealed prefix/suffix, the remainder is the mask itself.
                const middle = masked.slice(prefix, masked.length - prefix);
                expect(middle, 'the middle is fully replaced by bullets').toBe(BULLET.repeat(4));
                expect(masked, 'the raw interior never leaks').not.toContain(interior);
            }
            // resolvedSettings is always the fixed 8-bullet mask regardless of key length.
            const resolved = (res.body.resolvedSettings ?? {}) as Record<string, unknown>;
            expect(resolved.apiKey, 'resolvedSettings mask is length-independent').toBe(FIXED_MASK);
        }
    });

    test('Flow 4: a BYOK key is actually USED for a real upstream completion — a bad key surfaces a clean validation failure (adaptive), a good effective key validates', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Establish the env baseline for THIS user BEFORE writing any user key: is a
        // usable provider key wired in this environment? (Local: yes via env; CI: no.)
        const envUsable = await isAiProviderConfigured(request, token);

        // --- Write a deliberately INVALID BYOK key --------------------------------
        const badKey = 'sk-or-INVALID-deadbeef-00000000';
        const patch = await setKey(request, token, badKey);
        expect(patch.status, 'PATCH with a (well-formed but wrong) key still persists').toBe(200);

        // The PATCH response carries a NON-throwing validation envelope. The bad user
        // key SHADOWS the env key, so the effective key is now the bad one → the
        // upstream model probe fails. This is the proof the key was actually USED.
        const validation = (patch.body.validation ?? null) as {
            success?: boolean;
            message?: string;
            modelResults?: Array<{ success?: boolean; error?: string }>;
        } | null;
        expect(validation, 'the PATCH response carries a validation envelope').toBeTruthy();
        expect(validation?.success, 'a wrong BYOK key fails connection validation').toBe(false);
        expect(
            validation?.message ?? '',
            'the failure message references a model/validation problem',
        ).toMatch(/validation|model|401|auth|invalid|key/i);
        if (validation?.modelResults?.length) {
            expect(
                validation.modelResults.every((m) => m.success !== true),
                'no model tier validated against the bad key',
            ).toBe(true);
        }

        // --- The explicit (throwing) validate-connection endpoint mirrors this ----
        // With the bad user key it returns 400 + a modelResults body, NEVER a 5xx.
        const explicit = await request.post(VALIDATE_URL, { headers: authedHeaders(token) });
        expect(
            explicit.status(),
            'explicit validate-connection with a bad key is a clean 400 (not 5xx)',
        ).toBe(400);
        const explicitBody = (await explicit.json().catch(() => ({}))) as {
            message?: string;
            modelResults?: unknown[];
        };
        expect(explicitBody.message ?? '', 'the 400 explains the connection/model failure').toMatch(
            /openrouter|validation|model|401|auth/i,
        );

        // --- ADAPTIVE control: clear the shadow by proving the env path ----------
        // A SEPARATE fresh user (no user key) validates against the env key. Locally
        // this succeeds (200 success:true); in CI it fails truthfully (400). Either
        // way the outcome differs from / explains the bad-key path above.
        const cleanToken = await freshToken(request);
        const envValidate = await request.post(VALIDATE_URL, {
            headers: authedHeaders(cleanToken),
        });
        if (envUsable) {
            expect(
                envValidate.status(),
                'with an env key wired, the no-user-key validation succeeds 200',
            ).toBe(200);
            const okBody = (await envValidate.json().catch(() => ({}))) as { success?: boolean };
            expect(okBody.success, 'the env-key validation reports success').toBe(true);
        } else {
            // No env key in this env → the no-user-key path ALSO fails, but cleanly.
            expect(
                envValidate.status(),
                'with no key anywhere the validation fails cleanly (4xx, not 5xx)',
            ).toBeGreaterThanOrEqual(400);
            expect(envValidate.status(), 'never a server error').toBeLessThan(500);
        }
    });

    test('Flow 5: rotate the BYOK key (mask reflects the new key) and prove a REQUIRED secret cannot be cleared via null (400), leaving the key intact', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Set key A, capture its mask.
        const keyA = 'sk-or-AAAA-rotate-11112222';
        const setA = await setKey(request, token, keyA);
        expect(setA.status, 'key A set').toBe(200);
        const maskA = ((setA.body.settings ?? {}) as Record<string, unknown>).apiKey as string;
        expect(maskA, 'mask A reveals A prefix/suffix').toBe(
            `${keyA.slice(0, 4)}${BULLET.repeat(4)}${keyA.slice(-4)}`,
        );

        // Rotate to key B (different prefix + suffix) → the mask MUST change to track B.
        const keyB = 'sk-or-ZZZZ-rotate-99998888';
        const setB = await setKey(request, token, keyB);
        expect(setB.status, 'key B (rotation) set').toBe(200);
        const maskB = ((setB.body.settings ?? {}) as Record<string, unknown>).apiKey as string;
        expect(maskB, 'mask B reveals B prefix/suffix').toBe(
            `${keyB.slice(0, 4)}${BULLET.repeat(4)}${keyB.slice(-4)}`,
        );
        expect(maskB, 'rotation produced a NEW mask (the key actually changed)').not.toBe(maskA);

        await expect
            .poll(async () => (await readState(request, token)).settings?.apiKey, {
                timeout: 15_000,
            })
            .toBe(maskB);

        // --- Clearing a REQUIRED secret via null is REJECTED ----------------------
        // null is stripped before validation → required apiKey missing → 400. The key
        // is NOT cleared — required-field integrity wins over the clear request.
        const clearViaSettings = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            settings: { apiKey: null as unknown as string, defaultModel: MODEL },
        });
        expect(
            clearViaSettings.status,
            'clearing a required secret via settings.apiKey:null is rejected 400',
        ).toBe(400);
        const clearBody = clearViaSettings.body as { message?: string; errors?: string[] };
        expect(clearBody?.message ?? '', 'the 400 is the invalid-settings contract').toContain(
            'Invalid plugin settings',
        );
        expect(
            (clearBody?.errors ?? []).join(' '),
            'the 400 names apiKey as the missing required field',
        ).toContain('apiKey');

        // The same rejection via the secretSettings route.
        const clearViaSecret = await patchPluginSettingsViaAPI(request, token, PLUGIN_ID, {
            secretSettings: { apiKey: null as unknown as string },
        });
        expect(
            clearViaSecret.status,
            'clearing via secretSettings.apiKey:null is rejected too',
        ).toBe(400);

        // The key survived both rejected clears — still key B's mask.
        const afterClear = await readState(request, token);
        expect(afterClear.settings?.apiKey, 'the rejected clears were no-ops — key B remains').toBe(
            maskB,
        );
    });

    test('Flow 6: cross-user BYOK isolation — user A’s key is invisible to user B, who sees only the env/default chain; unknown providers 404', async ({
        request,
    }) => {
        // User A writes a distinctive BYOK key.
        const tokenA = await freshToken(request);
        const keyA = 'sk-or-USERA-secret-aaaa1111';
        const setA = await setKey(request, tokenA, keyA);
        expect(setA.status, 'user A persists a BYOK key').toBe(200);
        const maskA = ((setA.body.settings ?? {}) as Record<string, unknown>).apiKey as string;
        expect(maskA, 'A captured a masked key').toContain(BULLET);

        // User B (brand new) must NOT see A's user-scoped settings row at all.
        const tokenB = await freshToken(request);
        const bState = await readState(request, tokenB);
        expect(
            bState.settings,
            "user B has no user-scoped settings row — A's key does not leak across users",
        ).toBeNull();
        // Even B's masked resolvedSettings (env/default chain) must not be A's mask.
        if (bState.resolvedSettings?.apiKey !== undefined) {
            expect(
                bState.resolvedSettings.apiKey,
                "B's resolved apiKey is the env/default fixed mask, never A's partial-reveal",
            ).toBe(FIXED_MASK);
            expect(bState.resolvedSettings.apiKey, "B never sees A's distinctive mask").not.toBe(
                maskA,
            );
        }

        // A still sees A's own key (sanity — the isolation is one-directional, not a wipe).
        const aState = await readState(request, tokenA);
        expect(aState.settings?.apiKey, "user A still owns A's masked key").toBe(maskA);

        // Writing to an UNKNOWN ai-provider id is a clean 404 for either user — the
        // settings route is plugin-scoped and does not silently create phantom rows.
        const unknownId = `no-such-ai-${Date.now()}`;
        const unknown = await request.patch(`${API_BASE}/api/plugins/${unknownId}/settings`, {
            headers: authedHeaders(tokenB),
            data: { settings: { apiKey: 'x', defaultModel: 'y' } },
        });
        expect(unknown.status(), 'BYOK PATCH to an unknown provider id → 404 (never 5xx)').toBe(
            404,
        );

        // And B writing its OWN key creates an INDEPENDENT row that does not disturb A.
        const keyB = 'sk-or-USERB-secret-bbbb2222';
        const setB = await setKey(request, tokenB, keyB);
        expect(setB.status, 'user B persists its own independent BYOK key').toBe(200);
        const maskB = ((setB.body.settings ?? {}) as Record<string, unknown>).apiKey as string;
        expect(maskB, "B's mask reflects B's key").toBe(
            `${keyB.slice(0, 4)}${BULLET.repeat(4)}${keyB.slice(-4)}`,
        );
        expect(maskB, "B's mask is distinct from A's").not.toBe(maskA);
        // A is unchanged after B's write.
        const aAfter = await readState(request, tokenA);
        expect(aAfter.settings?.apiKey, "A's key is untouched by B's independent write").toBe(
            maskA,
        );
    });
});
