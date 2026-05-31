import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Profile identity — full, multi-step integration flows.
 *
 * Drives the real profile-identity surface end-to-end across several entities
 * and assertions. Verified against the live stack before writing:
 *
 *   PUT  /api/auth/profile        (AuthSessionGuard, @HttpCode 200, UpdateProfileDto)
 *       body whitelist = { username(>=3), avatar(@IsUrl), committerName(string|null),
 *                          committerEmail(@IsEmail), emailBudgetAlerts(@IsBoolean) }.
 *       Unknown props → 400 "property X should not exist". Returns the fresh user
 *       object DIRECTLY (no `.user` envelope).
 *   GET  /api/auth/profile/fresh  (AuthSessionGuard) → fresh DB row, same flat shape.
 *
 * Probed truths the assertions rely on (do not "fix" these to guesses):
 *   - register requires username >= 3 chars; registerUserViaAPI sends the long
 *     generated `name`, so fresh users register cleanly.
 *   - committerEmail "not-an-email"  → 400 ["committerEmail must be an email"].
 *   - avatar "not-a-url" / ""        → 400 ["avatar must be a URL address"].
 *   - avatar with a DISALLOWED host (e.g. https://example.com/...) is a valid URL,
 *     so the API STORES it (200) — only the next/image render falls back, because
 *     next.config.ts allows just github.com / *.googleusercontent.com /
 *     avatars.githubusercontent.com / opengraph.githubassets.com.
 *   - emailBudgetAlerts DEFAULTS to true on a fresh user, so Flow 1 flips it to
 *     false then back to a known value rather than assuming an initial state.
 *
 * Isolation: all API-only mutations run on a FRESH registerUserViaAPI() user so
 * the shared seeded user (storageState) stays clean for sibling specs. The single
 * UI-render flow uses the seeded user (its avatar is asserted by polling the
 * <img> the seeded session actually renders), tolerating concurrent mutation.
 *
 * Note on helpers: helpers/profile.ts exposes update/get helpers, but its
 * `updateProfileViaAPI` patch type predates `emailBudgetAlerts` and its
 * `ProfileUser` return type omits committer/alerts fields. To assert the full
 * identity shape truthfully we issue the PUT/GET inline here (the endpoints,
 * not the helpers, are the contract under test) — no helper is modified.
 */

// Allowed-host, real, cacheable avatar images (stable GitHub PNGs) — next/image
// optimises these. Distinct hosts/paths so each change is observable.
const AVATAR_GITHUB = 'https://github.com/github.png';
const AVATAR_OCTOCAT = 'https://github.com/octocat.png';
// A valid URL on a host next/image does NOT allow — stored by API, fails to render.
const AVATAR_DISALLOWED_HOST = 'https://example.com/face.png';

/** Full profile shape we care about (superset of the helper's ProfileUser). */
interface FullProfile {
    id: string;
    username: string;
    email: string;
    avatar?: string | null;
    committerName?: string | null;
    committerEmail?: string | null;
    emailBudgetAlerts?: boolean;
}

type ProfilePatch = {
    username?: string;
    avatar?: string;
    committerName?: string | null;
    committerEmail?: string | null;
    emailBudgetAlerts?: boolean;
};

async function getFreshProfile(request: APIRequestContext, token: string): Promise<FullProfile> {
    const res = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `profile/fresh body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return (body.user ?? body) as FullProfile;
}

/** Raw PUT (caller asserts status) — used for both happy-path and 400 cases. */
function putProfile(
    request: APIRequestContext,
    token: string,
    patch: ProfilePatch,
): Promise<APIResponse> {
    return request.put(`${API_BASE}/api/auth/profile`, {
        headers: authedHeaders(token),
        data: patch,
    });
}

async function putProfileOk(
    request: APIRequestContext,
    token: string,
    patch: ProfilePatch,
): Promise<FullProfile> {
    const res = await putProfile(request, token, patch);
    expect(res.status(), `updateProfile body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return (body.user ?? body) as FullProfile;
}

async function messageOf(res: APIResponse): Promise<string> {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const message = (body as { message?: unknown }).message;
    return Array.isArray(message) ? message.join(' ') : String(message);
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted: ONLY { email, password } — never pass `name`.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Profile identity — committer + alerts (fresh user)', () => {
    test('multi-field profile update persists across PUT → GET /fresh; invalid committerEmail rejected', async ({
        request,
    }) => {
        // Fresh, isolated user — keeps the shared seeded user untouched.
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Baseline: confirm the probed defaults so the deltas below are meaningful.
        const before = await getFreshProfile(request, token);
        expect(before.id).toBe(u.user.id);
        expect(before.committerName ?? null).toBeNull();
        expect(before.committerEmail ?? null).toBeNull();
        // Fresh users default emailBudgetAlerts=true (probed) — start from that fact.
        expect(before.emailBudgetAlerts).toBe(true);

        // 1. Update FOUR identity fields in one PUT.
        const newUsername = `Renamed_${Date.now().toString(36)}`;
        const committerName = 'Commit Bot';
        const committerEmail = `commit-${Date.now().toString(36)}@example.com`;
        const updated = await putProfileOk(request, token, {
            username: newUsername,
            committerName,
            committerEmail,
            emailBudgetAlerts: false,
        });
        // PUT echoes the fresh user — assert every field on the response.
        expect(updated.username).toBe(newUsername);
        expect(updated.committerName).toBe(committerName);
        expect(updated.committerEmail).toBe(committerEmail);
        expect(updated.emailBudgetAlerts).toBe(false);

        // 2. GET /fresh independently reflects ALL of them from the DB row.
        const fresh = await getFreshProfile(request, token);
        expect(fresh.username).toBe(newUsername);
        expect(fresh.committerName).toBe(committerName);
        expect(fresh.committerEmail).toBe(committerEmail);
        expect(fresh.emailBudgetAlerts).toBe(false);
        // Email is immutable here — never changed by a profile update.
        expect(fresh.email).toBe(u.email);

        // 3. A second PUT flips the boolean back and clears committer name to null.
        const flipped = await putProfileOk(request, token, {
            emailBudgetAlerts: true,
            committerName: null,
        });
        expect(flipped.emailBudgetAlerts).toBe(true);
        expect(flipped.committerName ?? null).toBeNull();
        // committerEmail untouched by the partial PUT — still the value from step 1.
        expect(flipped.committerEmail).toBe(committerEmail);
        const refetched = await getFreshProfile(request, token);
        expect(refetched.emailBudgetAlerts).toBe(true);
        expect(refetched.committerName ?? null).toBeNull();
        expect(refetched.committerEmail).toBe(committerEmail);

        // 4. Invalid committerEmail → 400 with the real validator message; nothing persists.
        const bad = await putProfile(request, token, { committerEmail: 'not-an-email' });
        expect(bad.status()).toBe(400);
        expect(await messageOf(bad)).toContain('committerEmail must be an email');

        // 5. The rejected update left the previously-valid committerEmail intact.
        const afterReject = await getFreshProfile(request, token);
        expect(afterReject.committerEmail).toBe(committerEmail);

        // 6. The DTO whitelist rejects unknown properties (forbidNonWhitelisted).
        const unknown = await putProfile(request, token, {
            bogusField: 'x',
        } as unknown as ProfilePatch);
        expect(unknown.status()).toBe(400);
        expect(await messageOf(unknown)).toContain('bogusField');
    });
});

test.describe('Profile identity — avatar change + render (seeded user)', () => {
    test('a real GitHub avatar persists and the sidebar <img> renders the new src; a second change follows', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const me = await getFreshProfile(request, token);
        const username = me.username;
        expect(username, 'seeded user must have a username for the avatar alt').toBeTruthy();

        // 1. Set avatar A via the profile API; persistence is authoritative.
        const afterA = await putProfileOk(request, token, { avatar: AVATAR_GITHUB });
        expect(afterA.avatar).toBe(AVATAR_GITHUB);
        expect((await getFreshProfile(request, token)).avatar).toBe(AVATAR_GITHUB);

        // 2. The dashboard sidebar renders the user avatar <img> (next/image,
        //    alt={user.username} — see DashboardSidebar.tsx) with the optimised src.
        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        const avatarImgA = page.locator(`img[alt="${username}"]`).first();
        await expect(avatarImgA).toBeVisible({ timeout: 30_000 });
        // next/image URL-encodes the origin URL into the optimizer `src` query.
        await expect
            .poll(async () => (await avatarImgA.getAttribute('src')) ?? '', { timeout: 15_000 })
            .toContain('github.com%2Fgithub.png');

        // 3. Change to a DIFFERENT allowed-host avatar; API + UI both follow.
        const afterB = await putProfileOk(request, token, { avatar: AVATAR_OCTOCAT });
        expect(afterB.avatar).toBe(AVATAR_OCTOCAT);
        expect((await getFreshProfile(request, token)).avatar).toBe(AVATAR_OCTOCAT);

        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        const avatarImgB = page.locator(`img[alt="${username}"]`).first();
        await expect(avatarImgB).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(async () => (await avatarImgB.getAttribute('src')) ?? '', { timeout: 15_000 })
            .toContain('octocat.png');
    });
});

test.describe('Profile identity — avatar validation (fresh user)', () => {
    test('non-URL avatar is rejected (4xx); a disallowed-host URL is a valid URL and is stored', async ({
        request,
    }) => {
        // Fresh user so the disallowed-host avatar we persist never leaks into the
        // shared seeded session (which other specs render).
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // 1. A non-URL avatar fails @IsUrl validation → 400 with the real message.
        const garbage = await putProfile(request, token, { avatar: 'not-a-url' });
        expect(garbage.status()).toBeGreaterThanOrEqual(400);
        expect(garbage.status()).toBeLessThan(500);
        expect(await messageOf(garbage)).toContain('avatar must be a URL address');

        // 2. An empty string is likewise not a URL → 400.
        const empty = await putProfile(request, token, { avatar: '' });
        expect(empty.status()).toBeGreaterThanOrEqual(400);
        expect(empty.status()).toBeLessThan(500);

        // 3. The rejected avatars left the field untouched (still null on a fresh user).
        expect((await getFreshProfile(request, token)).avatar ?? null).toBeNull();

        // 4. A VALID URL on a host next/image does not allow still passes @IsUrl,
        //    so the API STORES it (200). The render would fall back to initials
        //    (DashboardSidebar onError → avatarError), but API persistence is the
        //    contract under test here — assert it regardless of render.
        const stored = await putProfileOk(request, token, { avatar: AVATAR_DISALLOWED_HOST });
        expect(stored.avatar).toBe(AVATAR_DISALLOWED_HOST);
        expect((await getFreshProfile(request, token)).avatar).toBe(AVATAR_DISALLOWED_HOST);

        // 5. Switching back to an allowed-host URL also persists, proving the field
        //    is freely re-writable regardless of host allowlisting.
        const allowed = await putProfileOk(request, token, { avatar: AVATAR_GITHUB });
        expect(allowed.avatar).toBe(AVATAR_GITHUB);
        expect((await getFreshProfile(request, token)).avatar).toBe(AVATAR_GITHUB);
    });
});
