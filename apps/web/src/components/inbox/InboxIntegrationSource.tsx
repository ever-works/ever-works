'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { isIntegrationItem, type InboxItem } from '@/lib/api/inbox.shared';
import { safeHttpsUrl } from '@/lib/utils/safe-link';

const BADGE_CLASS =
    'rounded-full border px-1.5 py-0.5 text-[11px] bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300 border-teal-200 dark:border-teal-500/25';

/** A badge never runs past one short line, whatever the integration sent. */
const LABEL_MAX_CHARS = 80;

function labelOf(item: InboxItem, fallback: string): string {
    const label = item.sourceLabel?.trim();
    return label ? label.slice(0, LABEL_MAX_CHARS) : fallback;
}

/**
 * Where an INTEGRATION item came from (integration inbox push): another
 * product (Ever Gauzy first) put one of its own Inbox items here for you.
 *
 * Two shapes, like `InboxFleetSource`: `compact` is the badge on the list row
 * (the integration's `sourceLabel`, e.g. "Ever Gauzy"); the default is the line
 * under the detail title with the same badge, when it happened there, and a
 * link back to the item in that product. Renders nothing for every other item,
 * so it can be dropped in unconditionally.
 *
 * Everything the integration sent is rendered as TEXT. The link is the one
 * value that becomes markup, and only through `safeHttpsUrl`: the API already
 * refuses anything but an `https:` URL without credentials, and a value that
 * still is not one (an older row, a bad proxy) renders no link at all.
 */
export function InboxIntegrationSource({
    item,
    compact = false,
}: {
    item: InboxItem;
    compact?: boolean;
}) {
    const t = useTranslations('dashboard.inbox');
    if (!isIntegrationItem(item)) return null;
    const label = labelOf(item, t('integrationSource.fallbackLabel'));

    if (compact) {
        return (
            <span className={BADGE_CLASS} data-testid="inbox-integration-source-badge">
                {label}
            </span>
        );
    }

    const href = safeHttpsUrl(item.sourceUrl);
    return (
        <p
            className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary dark:text-text-secondary-dark"
            data-testid="inbox-integration-source"
        >
            <span className={BADGE_CLASS} data-testid="inbox-integration-source-badge">
                {label}
            </span>
            {item.occurredAt && (
                <span data-testid="inbox-integration-source-occurred">
                    {t('integrationSource.occurredAt')}: <ShowDateTime value={item.occurredAt} />
                </span>
            )}
            {href && (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    data-testid="inbox-integration-source-link"
                >
                    {t('integrationSource.open', { source: label })}
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
            )}
        </p>
    );
}

/**
 * The header block of a `kind: 'email'` integration item — from, to, subject
 * and when it arrived — above the body. Plain text: an email header is
 * whatever the sender wrote, so none of it is ever markup. Renders nothing for
 * any other item.
 */
export function InboxEmailHeader({ item }: { item: InboxItem }) {
    const t = useTranslations('dashboard.inbox');
    const email = item.kind === 'email' ? item.email : null;
    if (!email) return null;
    const receivedAt = email.receivedAt?.trim() || null;
    const receivedIsDate = !!receivedAt && Number.isFinite(Date.parse(receivedAt));
    const rows: Array<[string, React.ReactNode, string]> = [
        [t('integrationSource.email.from'), email.from, 'from'],
    ];
    if (email.to) rows.push([t('integrationSource.email.to'), email.to, 'to']);
    rows.push([t('integrationSource.email.subject'), email.subject, 'subject']);
    if (receivedAt) {
        rows.push([
            t('integrationSource.email.received'),
            receivedIsDate ? <ShowDateTime value={receivedAt} /> : receivedAt,
            'received',
        ]);
    }
    return (
        <dl
            className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-border dark:border-border-dark bg-surface-secondary dark:bg-white/4 px-4 py-3 text-xs"
            data-testid="inbox-email-header"
        >
            {rows.map(([term, value, key]) => (
                <div key={key} className="contents">
                    <dt className="text-text-secondary dark:text-text-secondary-dark">{term}</dt>
                    <dd
                        className="min-w-0 break-words text-text dark:text-text-dark"
                        data-testid={`inbox-email-header-${key}`}
                    >
                        {value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
