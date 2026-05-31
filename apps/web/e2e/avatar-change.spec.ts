import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { getProfileFresh, updateProfileViaAPI } from './helpers/profile';

/**
 * Avatar — real change + render integration flow.
 *
 * User ask: "when the user changes their avatar, that avatar really changes."
 *
 * The user avatar is a stored URL (PUT /api/auth/profile { avatar }, @IsUrl()).
 * next/image only permits a few hosts (github.com, *.googleusercontent.com,
 * avatars.githubusercontent.com — see next.config.ts), so we use real, stable,
 * loadable GitHub org avatars. The test changes the avatar twice and asserts:
 *   - the API persists each new URL (GET /api/auth/profile/fresh), and
 *   - the dashboard sidebar re-renders the user avatar <img> with the new src,
 *     replacing the initial-letter fallback (DashboardSidebar.tsx).
 */

// Allowed-host, real, cacheable avatar images (stable GitHub org/user PNGs).
const AVATAR_A = 'https://github.com/github.png';
const AVATAR_B = 'https://github.com/octocat.png';

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Avatar — change + render', () => {
    test('changing the avatar URL persists and re-renders the sidebar avatar image', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const me = await getProfileFresh(request, token);
        const username = me.username;

        // 1. Set avatar A via the profile API; persistence is authoritative.
        const afterA = await updateProfileViaAPI(request, token, { avatar: AVATAR_A });
        expect(afterA.avatar).toBe(AVATAR_A);
        expect((await getProfileFresh(request, token)).avatar).toBe(AVATAR_A);

        // 2. The dashboard renders the avatar <img> (next/image) for this user.
        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        const avatarImg = page.locator(`img[alt="${username}"]`).first();
        await expect(avatarImg).toBeVisible({ timeout: 30_000 });
        // next/image encodes the source URL into the optimizer src.
        await expect
            .poll(async () => (await avatarImg.getAttribute('src')) ?? '', { timeout: 15_000 })
            .toContain('github.com%2Fgithub.png');

        // 3. Change to a DIFFERENT avatar and confirm both API + UI follow.
        const afterB = await updateProfileViaAPI(request, token, { avatar: AVATAR_B });
        expect(afterB.avatar).toBe(AVATAR_B);
        expect((await getProfileFresh(request, token)).avatar).toBe(AVATAR_B);

        await page.goto('/works', { waitUntil: 'domcontentloaded' });
        const avatarImg2 = page.locator(`img[alt="${username}"]`).first();
        await expect(avatarImg2).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(async () => (await avatarImg2.getAttribute('src')) ?? '', { timeout: 15_000 })
            .toContain('octocat.png');
    });

    test('API: avatar must be a valid URL (rejects garbage)', async ({ request }) => {
        const token = await seededToken(request);
        const res = await request.put(`${API_BASE}/api/auth/profile`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { avatar: 'not-a-url' },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
