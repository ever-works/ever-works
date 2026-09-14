'use server';

import {
    CHANGELOG_LIMITS,
    CHANGELOG_SLUG_PATTERN,
    isChangelogCategory,
    type ChangelogListResponseDto,
} from '@ever-works/contracts/api';
import { changelogAPI } from '@/lib/api/changelog';

/**
 * What's new (AW-14) — server actions behind the top-bar control and panel.
 *
 * Every action returns a `{ success, …, error }` result and never throws, so
 * a failing API degrades to a state the panel can render (an error with a
 * retry, or a silently dropped read mark) rather than an error boundary.
 *
 * No `revalidatePath`: read state only changes the badge, which the client
 * updates from the response, and re-rendering the whole dashboard tree for a
 * read mark would reset the screen behind the panel (spec FR-29).
 */

export interface ChangelogListResult {
    success: boolean;
    data?: ChangelogListResponseDto;
    error?: string;
}

export interface ChangelogCountResult {
    success: boolean;
    unreadCount?: number;
    error?: string;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

/** One page of entries. Unknown categories and malformed cursors are dropped, not sent. */
export async function getChangelog(
    params: { category?: string; limit?: number; cursor?: string } = {},
): Promise<ChangelogListResult> {
    try {
        const data = await changelogAPI.list({
            category: isChangelogCategory(params.category) ? params.category : undefined,
            limit: params.limit,
            cursor:
                params.cursor && CHANGELOG_SLUG_PATTERN.test(params.cursor)
                    ? params.cursor
                    : undefined,
        });
        return { success: true, data };
    } catch (error) {
        console.error("Failed to load What's new entries:", error);
        return { success: false, error: errorMessage(error, 'Failed to load updates') };
    }
}

/** The reader's current unread count. */
export async function getChangelogUnreadCount(): Promise<ChangelogCountResult> {
    const count = await changelogAPI.unreadCount();
    if (count === null) {
        return { success: false, error: 'Failed to load the unread count' };
    }
    return { success: true, unreadCount: count };
}

/** Record entries as read; returns the fresh unread count. */
export async function markChangelogRead(slugs: string[]): Promise<ChangelogCountResult> {
    const valid = Array.isArray(slugs)
        ? [...new Set(slugs.filter((slug) => typeof slug === 'string'))]
              .filter((slug) => CHANGELOG_SLUG_PATTERN.test(slug))
              .slice(0, CHANGELOG_LIMITS.markReadBatchMax)
        : [];
    if (valid.length === 0) {
        return { success: false, error: 'No valid entries to mark read' };
    }
    try {
        const response = await changelogAPI.markRead(valid);
        return { success: true, unreadCount: response.unreadCount };
    } catch (error) {
        console.error("Failed to mark What's new entries read:", error);
        return { success: false, error: errorMessage(error, 'Failed to mark updates read') };
    }
}

/** Mark every visible entry read, regardless of any filter on screen. */
export async function markAllChangelogRead(): Promise<ChangelogCountResult> {
    try {
        const response = await changelogAPI.markAllRead();
        return { success: true, unreadCount: response.unreadCount };
    } catch (error) {
        console.error("Failed to mark all What's new entries read:", error);
        return { success: false, error: errorMessage(error, 'Failed to mark all updates read') };
    }
}
