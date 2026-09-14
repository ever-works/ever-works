'use server';

import type { FeedActorsDto, FeedPageDto } from '@ever-works/contracts';
import { feedAPI, type GetFeedPageParams } from '@/lib/api/feed';
import { ApiResponseError } from '@/lib/api/server-api';
// Security: defense-in-depth authn guard, mirroring actions/activity-log.ts.
// Server actions are reachable as POST endpoints, so UI gating is not a
// security boundary; the API stays the real authz boundary.
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Why a feed read failed, as a stable code the client branches on. Raw error
 * text never crosses the server/client boundary.
 */
export type FeedLoadErrorCode = 'invalid-cursor' | 'too-many-agents' | 'load-failed';

export type FeedActionResult<T> =
    | { success: true; data: T }
    | { success: false; error: FeedLoadErrorCode };

function toErrorCode(error: unknown): FeedLoadErrorCode {
    if (error instanceof ApiResponseError && error.statusCode === 400) {
        const code = error.details?.error;
        if (code === 'invalid-cursor' || code === 'too-many-agents') return code;
    }
    return 'load-failed';
}

export async function getFeedPage(
    params?: GetFeedPageParams,
): Promise<FeedActionResult<FeedPageDto>> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return { success: true, data: await feedAPI.page(params) };
    } catch (error) {
        console.error('Failed to get the live feed:', error);
        return { success: false, error: toErrorCode(error) };
    }
}

export async function getFeedActors(
    windowHours?: number,
): Promise<FeedActionResult<FeedActorsDto>> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        return { success: true, data: await feedAPI.actors(windowHours) };
    } catch (error) {
        console.error('Failed to get the live feed agents:', error);
        return { success: false, error: 'load-failed' };
    }
}
