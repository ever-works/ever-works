'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { isSessionAttention, type InboxItem } from '@/lib/api/inbox.shared';

const BADGE_CLASS =
    'rounded-full border px-1.5 py-0.5 text-[11px] bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 border-amber-200 dark:border-amber-500/25';

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
};

/**
 * Where a SESSION item came from (FL-05 P2, spec §5.8) — beside
 * `InboxFleetSource`. A `fleet-session` item is a session on one of the
 * owner's computers waiting on them: the chip **From a session**, and the
 * provenance line "build-01 · api tests · Claude Code" with a link to the
 * session. Answering here types the answer into the session (the Inbox reply
 * routes it). Renders nothing for every other source type. Every value is
 * rendered as TEXT.
 */
export function InboxSessionSource({
    item,
    compact = false,
}: {
    item: InboxItem;
    compact?: boolean;
}) {
    const t = useTranslations('dashboard.inbox');
    if (!isSessionAttention(item)) return null;
    if (compact) {
        return (
            <span className={BADGE_CLASS} data-testid="inbox-session-source-badge">
                {t('sessionSource.badge')}
            </span>
        );
    }
    const meta = item.sourceMeta ?? {};
    const parts = [
        meta.nodeName?.trim() || null,
        meta.sessionTitle?.trim() || null,
        meta.provider ? (PROVIDER_NAMES[meta.provider] ?? meta.provider) : null,
    ].filter((part): part is string => !!part);
    const sessionId = meta.sessionId?.trim() || null;
    return (
        <p
            className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary dark:text-text-secondary-dark"
            data-testid="inbox-session-source"
        >
            <span className={BADGE_CLASS} data-testid="inbox-session-source-badge">
                {t('sessionSource.badge')}
            </span>
            {parts.length > 0 && (
                <span data-testid="inbox-session-source-provenance">{parts.join(' · ')}</span>
            )}
            {sessionId && (
                <Link
                    href={ROUTES.DASHBOARD_FLEET_SESSION(sessionId)}
                    className="text-primary hover:underline"
                    data-testid="inbox-session-source-open"
                >
                    {t('sessionSource.open')}
                </Link>
            )}
        </p>
    );
}
