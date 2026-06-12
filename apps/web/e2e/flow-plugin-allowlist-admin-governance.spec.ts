import { test, expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-plugin-allowlist-admin-governance.spec.ts
 *
 * EW-693 — governance authz contract for the admin plugin-allowlist surface
 * `api/admin/plugins/allowlist` (`PluginAllowlistController`), which gates
 * which non-first-party packages may be fetched by
 * `POST /api/plugins/:id/install` (FR-11). First-party `@ever-works/*` is
 * implicitly permitted and has no rows here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * This is a pure AUTHORIZATION-MATRIX spec by design. The controller is
 * `@UseGuards(AuthSessionGuard, IsPlatformAdminGuard)` — platform owner only
 * (`User.isPlatformAdmin === true`), and there is NO API to self-promote to
 * platform admin. So in CI (every registered user is a normal user) the entire
 * CRUD is unreachable, and the SECURITY contract to pin is precisely that:
 *   - unauthenticated            -> 401 (global AuthSessionGuard, before admin)
 *   - authenticated non-admin    -> 403 "Platform admin access required"
 * across every verb, with the guard taking precedence over the route's
 * ParseUUIDPipe and body ValidationPipe (so a malformed id / invalid body from
 * a non-admin still 403s — it never leaks a 400 that would confirm the route
 * shape to an unauthorized caller).
 *
 * Companion to the same root-cause fix as flow-composio-triggers-deep:
 * `PluginAllowlistEntity` was also missing from the DataSource `entities`
 * array, so the admin CRUD (and `PluginInstallerService.checkAllowlist` on the
 * non-first-party install path) threw EntityMetadataNotFound 500. It is now
 * registered; the admin guard means this spec can only reach the 401/403 gate,
 * but pinning that gate is the durable governance contract.
 *
 * NON-DUPLICATION: there is no other allowlist spec in the suite; this is the
 * first. It asserts ONLY the guard matrix (admin CRUD bodies are unreachable
 * without a platform-admin principal).
 *
 * PROBED CONTRACTS (live, http://127.0.0.1:3100, before writing):
 *   GET|POST|PATCH|DELETE /api/admin/plugins/allowlist[/:id]
 *     - no auth                  -> 401 { message:'Unauthorized', statusCode:401 }
 *     - authed non-admin         -> 403 { message:'Platform admin access required', error:'Forbidden', statusCode:403 }
 */

const ALLOWLIST = `${API_BASE}/api/admin/plugins/allowlist`;
const GHOST_UUID = '00000000-0000-0000-0000-000000000000';
const ADMIN_REQUIRED = 'Platform admin access required';

async function anon(playwright: PlaywrightWorkerArgs['playwright']): Promise<APIRequestContext> {
    return playwright.request.newContext();
}

test.describe('Plugin allowlist admin governance (EW-693)', () => {
    test('unauthenticated requests are rejected with 401 across every verb', async ({
        playwright,
    }) => {
        const ctx = await anon(playwright);
        try {
            const calls = [
                ctx.get(ALLOWLIST),
                ctx.post(ALLOWLIST, { data: { packageName: 'x', versionRange: '1.0.0' } }),
                ctx.patch(`${ALLOWLIST}/${GHOST_UUID}`, { data: { enabled: false } }),
                ctx.delete(`${ALLOWLIST}/${GHOST_UUID}`),
            ];
            for (const p of calls) {
                expect((await p).status()).toBe(401);
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('an authenticated NON-admin is forbidden (403 "Platform admin access required") across every verb', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        const list = await request.get(ALLOWLIST, { headers: h });
        expect(list.status()).toBe(403);
        const body = await list.json();
        expect(body.message).toContain(ADMIN_REQUIRED);
        expect(body.error).toBe('Forbidden');

        const create = await request.post(ALLOWLIST, {
            headers: h,
            data: { packageName: 'some-pkg', versionRange: '^1.0.0' },
        });
        expect(create.status()).toBe(403);

        const patch = await request.patch(`${ALLOWLIST}/${GHOST_UUID}`, {
            headers: h,
            data: { enabled: false },
        });
        expect(patch.status()).toBe(403);

        const remove = await request.delete(`${ALLOWLIST}/${GHOST_UUID}`, { headers: h });
        expect(remove.status()).toBe(403);
    });

    test('the admin guard runs BEFORE pipes: a non-admin with a malformed id or invalid body still 403s (never a route-shape-leaking 400)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        // Malformed uuid would trip ParseUUIDPipe (400) IF the guard let it
        // through — but the guard fires first, so it must be 403.
        const badIdPatch = await request.patch(`${ALLOWLIST}/not-a-uuid`, {
            headers: h,
            data: { enabled: true },
        });
        expect(badIdPatch.status()).toBe(403);

        const badIdDelete = await request.delete(`${ALLOWLIST}/not-a-uuid`, { headers: h });
        expect(badIdDelete.status()).toBe(403);

        // Invalid create body would trip the ValidationPipe (400) IF reached —
        // the guard must shadow it with 403.
        const invalidBody = await request.post(ALLOWLIST, {
            headers: h,
            data: { nonsense: true },
        });
        expect(invalidBody.status()).toBe(403);
    });
});
