import { type APIRequestContext, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * Profile helpers (username, avatar, committer identity).
 *
 * Verified against a live stack:
 *   - PUT /api/auth/profile { avatar }   — avatar MUST be a valid URL
 *       (@IsUrl()); returns the updated user with the `avatar` field set.
 *   - GET /api/auth/profile/fresh        — force-refresh; reflects the new avatar.
 *
 * The user avatar is a stored URL (not a binary upload), so an avatar change
 * is fully deterministic and CI-safe: PUT a URL, then assert the rendered
 * <img src> in the dashboard chrome reflects it.
 */

export interface ProfileUser {
    id: string;
    username: string;
    email: string;
    avatar?: string | null;
}

export async function getProfileFresh(
    request: APIRequestContext,
    token: string,
): Promise<ProfileUser> {
    const res = await request.get(`${API_BASE}/api/auth/profile/fresh`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return body.user ?? body;
}

export async function updateProfileViaAPI(
    request: APIRequestContext,
    token: string,
    patch: { username?: string; avatar?: string; committerName?: string; committerEmail?: string },
): Promise<ProfileUser> {
    const res = await request.put(`${API_BASE}/api/auth/profile`, {
        headers: authedHeaders(token),
        data: patch,
    });
    expect(res.status(), `updateProfile body=${await res.text().catch(() => '')}`).toBeLessThan(
        300,
    );
    const body = await res.json();
    return body.user ?? body;
}
