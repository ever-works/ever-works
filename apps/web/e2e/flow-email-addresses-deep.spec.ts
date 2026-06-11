import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-email-addresses-deep — DEEP coverage of the tenant email-address
 * surface on `apps/api/src/email/email.controller.ts` +
 * `email.service.ts`, focused on the UPDATE route and the lifecycle
 * edges that the existing email specs do NOT pin.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────
 * `sec-pin-email-agent-ownership.spec.ts` already owns: compose
 * agent-ownership ordering, the no-existence-oracle 404 equality,
 * address-list caller scoping + direction PARTITIONING, the verification
 * token's single-use replay + entropy/TTL SHAPE + delete-invalidates-token,
 * CREATE-body whitelist validation (email/direction enum/extra prop/
 * missing providerSettings), and anon 401 on the mutation routes.
 * `flow-agent-inbox-messaging.spec.ts` already owns: the happy-path
 * reply-from lifecycle (register → set default true → verify good/bogus →
 * disable drops from active pool → token consumed after confirm), cross-user
 * PATCH/DELETE → 404, and the own-address triggerVerification → 500.
 * `notifications-v2-inbox.spec.ts` owns the basic create/list/delete CRUD.
 *
 * This file pins ONLY the residual gaps, all on the PATCH update route and
 * the disable/enable + token-vs-disable lifecycle edges:
 *   · UPDATE-body whitelist + per-field type validation (vs the create-body
 *     whitelist sec-pin pins) and the pipe-before-ownership ordering on PATCH;
 *   · PATCH on a non-existent own id → 404 (the un-owned-row branch reached
 *     from the OWNER, distinct from sec-pin's cross-user 404);
 *   · providerSettings rotation persists and leaves the verification state
 *     untouched; an empty `{}` PATCH is a safe no-op;
 *   · DISABLE does NOT invalidate the verification token (the sharp contrast
 *     with DELETE, which sec-pin proves DOES kill the token) — and a confirm
 *     can still flip `verified` while the row is disabled;
 *   · the disable→enable round-trip restores the active pool + clears
 *     `disabledAt`;
 *   · `defaultForReplies` is NON-exclusive (two coexisting defaults — no
 *     auto-unset of a prior default);
 *   · the `direction` QUERY param is NOT enum-validated (unknown/`both`
 *     value → 200 empty/filtered, never the body's 400) — the read filter
 *     is permissive where the write enum is strict;
 *   · create-body MaxLength bounds (address ≤320, pluginId ≤128);
 *   · triggerVerification ORDERING — a foreign address 404s on ownership
 *     BEFORE the provider call, while the owner's own trigger reaches the
 *     keyless provider boundary (500). (flow-inbox asserts the own→500 leg;
 *     this file pins the foreign→404-first contrast.)
 *
 * ── PROBED CONTRACTS (live sqlite stack, http://127.0.0.1:3100, keyless) ──
 *   POST /api/email/addresses → 201 { address:{ … 15 fields incl.
 *     verified:false, verificationToken, verificationTokenExpiresAt(~now+24h),
 *     defaultForReplies, disabledAt:null } }.
 *     · address local-part >320 chars → 400 ['address must be shorter than or
 *       equal to 320 characters', …]; pluginId >128 → 400 ['pluginId must be
 *       shorter than or equal to 128 characters'].
 *   PATCH /api/email/addresses/:id → 200 { address } (whole updated row):
 *     · { verified:true } (non-whitelisted field) → 400 ['property verified
 *       should not exist']; { disabled:'yes' } → 400 ['disabled must be a
 *       boolean value']; { defaultForReplies:'x' } → 400.
 *     · own non-existent id (zero-UUID) → 404 'Email address not found'.
 *     · { providerSettings:{…} } rotates settings, leaves verified/token
 *       intact; {} is a 200 no-op (no field changes).
 *     · { defaultForReplies:true } on two rows → BOTH stay true (non-exclusive).
 *     · { disabled:true } stamps disabledAt + drops the row from the active
 *       list; { disabled:false } clears disabledAt + restores it.
 *   GET /api/email/verify/:token (PUBLIC) → always 200 { verified:bool }:
 *     · a DISABLED address's still-issued token confirms verified:true (disable
 *       ≠ token revocation), even though the row stays out of the active list.
 *   GET /api/email/addresses?direction=<x> → 200 always; an unknown value
 *     (`both`, `sideways`) returns a filtered/empty list, NOT a 400 — the
 *     query filter is permissive (contrast the strict create-body enum).
 *   POST /api/email/addresses/:id/verify → foreign id 404 'Email address not
 *     found' (ownership before the provider call); own id 500 (keyless
 *     provider boundary — env-adaptive, no real mail required).
 *
 * All flows are API-contract only — fresh users per test, unique suffixes
 * from a per-test counter (no module-scope clock / await), no mail read-back,
 * no UI navigation. TS strict.
 */

interface EmailAddress {
    id: string;
    userId: string;
    address: string;
    direction: 'outbound' | 'inbound' | 'both';
    pluginId: string;
    providerSettings: Record<string, unknown>;
    verified: boolean;
    verificationToken: string | null;
    verificationTokenExpiresAt: string | null;
    defaultForReplies: boolean;
    disabledAt: string | null;
}

interface ApiErrorBody {
    message: string | string[];
    error?: string;
    statusCode: number;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const ADDR_NOT_FOUND = 'Email address not found';

let seq = 0;
function uniq(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function messages(body: ApiErrorBody): string {
    return Array.isArray(body.message) ? body.message.join(' | ') : body.message;
}

async function createAddress(
    request: APIRequestContext,
    token: string,
    overrides: Partial<{
        address: string;
        direction: 'outbound' | 'inbound' | 'both';
        defaultForReplies: boolean;
    }> = {},
): Promise<EmailAddress> {
    const res = await request.post(`${API_BASE}/api/email/addresses`, {
        headers: authedHeaders(token),
        data: {
            address: overrides.address ?? `${uniq('deep')}@example.com`,
            direction: overrides.direction ?? 'outbound',
            pluginId: 'postmark',
            providerSettings: { apiKey: 'ci-fake-key' },
            ...(overrides.defaultForReplies !== undefined
                ? { defaultForReplies: overrides.defaultForReplies }
                : {}),
        },
    });
    expect(res.status(), `createAddress body=${await res.text().catch(() => '')}`).toBe(201);
    return ((await res.json()) as { address: EmailAddress }).address;
}

function patch(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/email/addresses/${id}`, {
        headers: authedHeaders(token),
        data,
    });
}

async function listAddresses(
    request: APIRequestContext,
    token: string,
    direction?: string,
): Promise<EmailAddress[]> {
    const qs = direction ? `?direction=${encodeURIComponent(direction)}` : '';
    const res = await request.get(`${API_BASE}/api/email/addresses${qs}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { addresses: EmailAddress[] }).addresses;
}

test.describe('Email addresses — deep PATCH + lifecycle-edge contracts', () => {
    // ------------------------------------------------------------------
    // UPDATE-body validation (the gap vs sec-pin's CREATE-body whitelist)
    // ------------------------------------------------------------------

    test('PATCH rejects non-whitelisted fields — a privileged column cannot be smuggled in', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        // `verified` is server-controlled (set only by the confirm flow); the
        // update DTO does not list it, so forbidNonWhitelisted must reject the
        // attempt rather than letting a caller self-verify via PATCH.
        const res = await patch(request, user.access_token, addr.id, { verified: true });
        expect(res.status(), `body=${await res.text().catch(() => '')}`).toBe(400);
        expect(messages((await res.json()) as ApiErrorBody)).toContain(
            'property verified should not exist',
        );

        // The row stayed unverified — the rejected PATCH was a true no-op.
        const after = (await listAddresses(request, user.access_token)).find(
            (x) => x.id === addr.id,
        );
        expect(after?.verified).toBe(false);
    });

    test('PATCH type-validates each boolean field (disabled, defaultForReplies)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        const badDisabled = await patch(request, user.access_token, addr.id, { disabled: 'yes' });
        expect(badDisabled.status()).toBe(400);
        expect(messages((await badDisabled.json()) as ApiErrorBody)).toContain(
            'disabled must be a boolean value',
        );

        const badDefault = await patch(request, user.access_token, addr.id, {
            defaultForReplies: 'true',
        });
        expect(badDefault.status()).toBe(400);
        expect(messages((await badDefault.json()) as ApiErrorBody)).toContain(
            'defaultForReplies must be a boolean value',
        );

        // Neither malformed PATCH mutated the row.
        const after = (await listAddresses(request, user.access_token)).find(
            (x) => x.id === addr.id,
        );
        expect(after?.disabledAt ?? null).toBeNull();
        expect(after?.defaultForReplies).toBe(false);
    });

    test('PATCH on a non-existent OWN id 404s with the address-not-found message', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // The caller owns nothing at this id — same 404 a cross-user PATCH
        // yields, so "row missing" and "row not yours" are indistinguishable.
        const res = await patch(request, user.access_token, ZERO_UUID, { defaultForReplies: true });
        expect(res.status()).toBe(404);
        const body = (await res.json()) as ApiErrorBody;
        expect(body.message).toBe(ADDR_NOT_FOUND);
        expect(body.error).toBe('Not Found');
    });

    test('PATCH rotates providerSettings without disturbing the verification state', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);
        expect(addr.verificationToken).toBeTruthy();

        const res = await patch(request, user.access_token, addr.id, {
            providerSettings: { apiKey: 'rotated-key', region: 'eu' },
        });
        expect(res.status()).toBe(200);
        const updated = ((await res.json()) as { address: EmailAddress }).address;
        expect(updated.providerSettings).toEqual({ apiKey: 'rotated-key', region: 'eu' });
        // Rotating credentials is orthogonal to verification — the outstanding
        // confirmation token and the unverified flag both survive untouched.
        expect(updated.verified).toBe(false);
        expect(updated.verificationToken).toBe(addr.verificationToken);
    });

    test('an empty PATCH body is a safe 200 no-op', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token, { defaultForReplies: true });

        const res = await patch(request, user.access_token, addr.id, {});
        expect(res.status()).toBe(200);
        const updated = ((await res.json()) as { address: EmailAddress }).address;
        // Every field that was set at creation is preserved verbatim.
        expect(updated.id).toBe(addr.id);
        expect(updated.defaultForReplies).toBe(true);
        expect(updated.disabledAt ?? null).toBeNull();
        expect(updated.providerSettings).toEqual(addr.providerSettings);
    });

    // ------------------------------------------------------------------
    // Disable vs the verification token — the sharp DELETE contrast
    // ------------------------------------------------------------------

    test('disabling an address does NOT revoke its verification token (unlike delete)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);
        const token = addr.verificationToken as string;
        expect(token).toBeTruthy();

        // Retire the row. sec-pin proves DELETE kills the outstanding token;
        // disable is a softer state — the confirmation link must STILL work.
        const disable = await patch(request, user.access_token, addr.id, { disabled: true });
        expect(disable.status()).toBe(200);
        expect(
            ((await disable.json()) as { address: EmailAddress }).address.disabledAt,
        ).not.toBeNull();

        // The disabled row is gone from the active list (findActiveByUser)…
        expect(
            (await listAddresses(request, user.access_token)).some((x) => x.id === addr.id),
        ).toBe(false);

        // …yet its still-issued confirmation link confirms it (disable is not
        // token revocation; verified is set even while the row is disabled).
        const confirm = await request.get(`${API_BASE}/api/email/verify/${token}`);
        expect(confirm.status()).toBe(200);
        expect(((await confirm.json()) as { verified: boolean }).verified).toBe(true);
    });

    test('disable→enable round-trip restores the address to the active pool', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        await patch(request, user.access_token, addr.id, { disabled: true });
        expect(
            (await listAddresses(request, user.access_token)).some((x) => x.id === addr.id),
        ).toBe(false);

        const reEnable = await patch(request, user.access_token, addr.id, { disabled: false });
        expect(reEnable.status()).toBe(200);
        const restored = ((await reEnable.json()) as { address: EmailAddress }).address;
        // Re-enabling clears the disabledAt timestamp…
        expect(restored.disabledAt ?? null).toBeNull();

        // …and the row is once again a candidate in the active list.
        const active = await listAddresses(request, user.access_token);
        const back = active.find((x) => x.id === addr.id);
        expect(back, 'a re-enabled address rejoins the active pool').toBeTruthy();
        expect(back?.disabledAt ?? null).toBeNull();
    });

    // ------------------------------------------------------------------
    // defaultForReplies is non-exclusive; direction query is permissive
    // ------------------------------------------------------------------

    test('defaultForReplies is non-exclusive — two addresses can both be default', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        // Marking a second address default does NOT auto-unset the first —
        // there is no single-default invariant enforced server-side.
        const first = await createAddress(request, user.access_token, { defaultForReplies: true });
        const second = await createAddress(request, user.access_token, { defaultForReplies: true });
        expect(first.defaultForReplies).toBe(true);
        expect(second.defaultForReplies).toBe(true);

        const list = await listAddresses(request, user.access_token);
        const defaults = list.filter((x) => x.defaultForReplies);
        expect(defaults.map((x) => x.id).sort()).toEqual([first.id, second.id].sort());

        // Re-asserting default on the second leaves the first default too.
        await patch(request, user.access_token, second.id, { defaultForReplies: true });
        const firstAfter = (await listAddresses(request, user.access_token)).find(
            (x) => x.id === first.id,
        );
        expect(firstAfter?.defaultForReplies).toBe(true);
    });

    test('the direction QUERY filter is permissive — unknown values return 200, not the body 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const outAddr = await createAddress(request, user.access_token, { direction: 'outbound' });

        // The create BODY rejects a bad direction enum (sec-pin pins that 400),
        // but the read QUERY param is NOT enum-validated: an unsupported value
        // is treated as a (non-matching) filter and yields a 200 empty list —
        // never a 400. This asymmetry is the contract.
        for (const bad of ['sideways', 'both', 'OUTBOUND']) {
            const res = await request.get(
                `${API_BASE}/api/email/addresses?direction=${encodeURIComponent(bad)}`,
                { headers: authedHeaders(user.access_token) },
            );
            expect(res.status(), `direction=${bad}`).toBe(200);
            const { addresses } = (await res.json()) as { addresses: EmailAddress[] };
            // The caller's real outbound row never appears under a bogus filter.
            expect(
                addresses.some((x) => x.id === outAddr.id),
                `direction=${bad}`,
            ).toBe(false);
        }

        // The exact-match filter still finds it (proves the row really exists).
        expect(
            (await listAddresses(request, user.access_token, 'outbound')).some(
                (x) => x.id === outAddr.id,
            ),
        ).toBe(true);
    });

    // ------------------------------------------------------------------
    // Create-body length bounds + trigger-verification ownership ordering
    // ------------------------------------------------------------------

    test('create enforces MaxLength bounds on address and pluginId', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const headers = authedHeaders(user.access_token);

        const longAddress = `${'a'.repeat(330)}@example.com`;
        const tooLongAddr = await request.post(`${API_BASE}/api/email/addresses`, {
            headers,
            data: {
                address: longAddress,
                direction: 'outbound',
                pluginId: 'postmark',
                providerSettings: {},
            },
        });
        expect(tooLongAddr.status()).toBe(400);
        expect(messages((await tooLongAddr.json()) as ApiErrorBody)).toContain(
            'address must be shorter than or equal to 320 characters',
        );

        const tooLongPlugin = await request.post(`${API_BASE}/api/email/addresses`, {
            headers,
            data: {
                address: `${uniq('ok')}@example.com`,
                direction: 'outbound',
                pluginId: 'p'.repeat(200),
                providerSettings: {},
            },
        });
        expect(tooLongPlugin.status()).toBe(400);
        expect(messages((await tooLongPlugin.json()) as ApiErrorBody)).toContain(
            'pluginId must be shorter than or equal to 128 characters',
        );
    });

    test('triggerVerification checks ownership before the provider call (foreign 404 vs own 500)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const addr = await createAddress(request, owner.access_token);

        // A foreign caller is stopped by the ownership lookup BEFORE the
        // provider boundary — a clean 404, never the provider 500 the owner
        // would hit (so a stranger learns nothing about the address wiring).
        const foreign = await request.post(`${API_BASE}/api/email/addresses/${addr.id}/verify`, {
            headers: authedHeaders(intruder.access_token),
        });
        expect(foreign.status(), `body=${await foreign.text().catch(() => '')}`).toBe(404);
        expect(((await foreign.json()) as ApiErrorBody).message).toBe(ADDR_NOT_FOUND);

        // The owner clears ownership and reaches the keyless provider boundary,
        // which 500s on this stack (no provider key / no MailHog). We assert the
        // ENV-ADAPTIVE boundary status, not a delivered mail — the ownership
        // gate is the security contract, the 500 is the keyless-provider tell.
        const own = await request.post(`${API_BASE}/api/email/addresses/${addr.id}/verify`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(own.status(), `own trigger body=${await own.text().catch(() => '')}`).toBe(500);

        // The address remains owner-scoped and unverified afterwards (the
        // failed trigger neither verified it nor leaked it to the intruder).
        const ownerRow = (await listAddresses(request, owner.access_token)).find(
            (x) => x.id === addr.id,
        );
        expect(ownerRow?.verified).toBe(false);
        expect(
            (await listAddresses(request, intruder.access_token)).some((x) => x.id === addr.id),
        ).toBe(false);
    });

    // ------------------------------------------------------------------
    // Verification token is structurally time-boxed (the precondition the
    // internal expired-branch gates on — that branch is not e2e-reachable
    // because no API accepts a past expiry).
    // ------------------------------------------------------------------

    test('a fresh address carries a future-dated (~24h) verification expiry that is not yet past', async ({
        request,
    }) => {
        const before = Date.now();
        const user = await registerUserViaAPI(request);
        const addr = await createAddress(request, user.access_token);

        // The TTL stamp is the precondition the confirm flow checks: a token
        // whose expiry is already past returns { verified:false } (service
        // email.service.ts L211). On this build the expiry is always future,
        // so a same-build confirm succeeds — proving the non-expired branch.
        expect(addr.verificationTokenExpiresAt).toBeTruthy();
        const expiresAt = new Date(addr.verificationTokenExpiresAt as string).getTime();
        const DAY = 24 * 60 * 60 * 1000;
        expect(expiresAt).toBeGreaterThan(before);
        expect(expiresAt).toBeLessThanOrEqual(before + DAY + 5 * 60 * 1000);

        // A not-yet-expired token confirms — the live, exercisable half of the
        // TTL contract (the expired half needs a past stamp no API will accept).
        const confirm = await request.get(`${API_BASE}/api/email/verify/${addr.verificationToken}`);
        expect(confirm.status()).toBe(200);
        expect(((await confirm.json()) as { verified: boolean }).verified).toBe(true);
    });
});
