'use client';

import { useTranslations } from 'next-intl';
import type { TaskChatMessage } from '@/lib/api/tasks';

/**
 * The keys a stored post may name: the delivery chain's thread posts (`deliveryPosts.*`), and
 * nothing else — a key is a pointer into OUR copy, never a way to render arbitrary messages.
 */
const POST_KEY_RE = /^deliveryPosts\.[a-z][A-Za-z0-9]*$/;
const PLACEHOLDER_RE = /\{\s*([A-Za-z0-9_]+)\s*[,}]/g;

/** APW-06's failure outcome codes → `dashboard.tasksPage.delivery.outcome.*` leaves. */
const OUTCOME_LEAVES: Record<string, string> = {
    failed: 'failed',
    rolled_back: 'rolledBack',
    rollback_failed: 'rollbackFailed',
    live_with_warnings: 'liveWithWarnings',
};

type Translate = ReturnType<typeof useTranslations<'dashboard.tasksPage'>>;

/**
 * APW-08 T54 (FR-43) — the text of one Task-thread message in the READER's locale.
 *
 * A keyed platform post (`messageKey`, `messageParams`) is rendered from our copy; anything that
 * cannot be rendered faithfully — no key, a key outside `deliveryPosts.*`, a key this build does
 * not have, a placeholder without its value — falls back to `body`, which the server always
 * writes in English. A message a person, an agent or an integration wrote has no key and shows
 * its `body` exactly as before.
 */
export function taskChatMessageText(
    t: Translate,
    message: Pick<TaskChatMessage, 'body' | 'messageKey' | 'messageParams'>,
): string {
    const key = (message.messageKey ?? '').trim();
    if (!key || !POST_KEY_RE.test(key)) return message.body;
    try {
        if (!t.has(key as never)) return message.body;
        const raw = t.raw(key as never);
        if (typeof raw !== 'string') return message.body;
        const params: Record<string, string | number> = { ...(message.messageParams ?? {}) };
        for (const [, name] of raw.matchAll(PLACEHOLDER_RE)) {
            if (params[name] === undefined || params[name] === null) return message.body;
        }
        if (typeof params.outcome === 'string') {
            const leaf = OUTCOME_LEAVES[params.outcome];
            const outcomeKey = `delivery.outcome.${leaf}`;
            if (leaf && t.has(outcomeKey as never)) params.outcome = t(outcomeKey as never);
        }
        return t(key as never, params as never);
    } catch {
        return message.body;
    }
}

/** {@link taskChatMessageText} as a component, for the Task page's conversation list. */
export function TaskChatMessageText({
    message,
}: {
    message: Pick<TaskChatMessage, 'body' | 'messageKey' | 'messageParams'>;
}) {
    const t = useTranslations('dashboard.tasksPage');
    return <>{taskChatMessageText(t, message)}</>;
}
